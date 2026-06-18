import { llm as defaultLlm, LLMUnavailableError, LLMClient } from "./llm";

// Resume parsing: raw resume text → structured JSON Resume (https://jsonresume.org).
// This is the data spine of the whole product (product-spec feature 1). The LLM
// only STRUCTURES what's in the text — it must not invent anything (vision red
// line). Uses the `fast` tier (DeepSeek V4 Flash) per the architecture doc:
// extraction is high-volume and doesn't need deep reasoning.
//
// When the LLM is unavailable, callers get a clear LLMUnavailableError rather
// than a fabricated resume — we never fake the user's experience.

/** Minimal JSON Resume shape we depend on downstream (the rest is passthrough). */
export interface JsonResume {
  basics?: {
    name?: string;
    label?: string;
    email?: string;
    phone?: string;
    summary?: string;
    location?: { city?: string; region?: string; countryCode?: string };
    profiles?: { network?: string; url?: string; username?: string }[];
  };
  work?: {
    name?: string;
    position?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    highlights?: string[];
  }[];
  education?: {
    institution?: string;
    area?: string;
    studyType?: string;
    startDate?: string;
    endDate?: string;
  }[];
  skills?: { name?: string; level?: string; keywords?: string[] }[];
  projects?: { name?: string; description?: string; highlights?: string[] }[];
  [key: string]: unknown;
}

const PARSE_SYSTEM =
  "You convert a raw resume into structured JSON Resume format " +
  "(https://jsonresume.org schema). " +
  "Return ONLY a JSON object with these top-level keys where present: " +
  '"basics" (name,label,email,phone,summary,location{city,region,countryCode},profiles[]), ' +
  '"work" (name,position,startDate,endDate,summary,highlights[]), ' +
  '"education" (institution,area,studyType,startDate,endDate), ' +
  '"skills" (name,level,keywords[]), "projects" (name,description,highlights[]). ' +
  "Dates use ISO YYYY-MM (or YYYY) when known. " +
  "CRITICAL: Extract ONLY information explicitly present in the resume text. " +
  "Do NOT invent names, employers, dates, metrics, skills, or achievements. " +
  "If a field is absent from the text, omit it — never guess. " +
  "Leave skills levels empty unless the resume states proficiency.";

export interface ParseResult {
  resume: JsonResume;
  /** The raw extracted text we parsed from. ALWAYS preserved so the user's
   * upload is never lost — even when the LLM choked, the text is the v1 base. */
  raw: string;
  /** Per-section issues that the UI surfaces as a "help me fill these in"
   * banner. Empty array = clean parse. */
  warnings: string[];
  /** True when we couldn't get structured JSON out of the LLM and the resume
   * is empty-shape; the raw text is still saved so the user can keep going. */
  usedFallback: boolean;
  meta: { model: string; costCents: number };
}

/**
 * Parse resume text into a JSON Resume object. Designed to *never* lose the
 * user's upload: if the LLM is unavailable, returns unparseable output, or
 * produces a shape we don't recognise, we still return a ParseResult with the
 * raw text + warnings so callers can persist a usable v1 base. Callers should
 * treat `warnings` as user-visible nudges, not errors.
 */
export async function parseResumeText(
  text: string,
  llm: LLMClient = defaultLlm,
): Promise<ParseResult> {
  const raw = (text ?? "").trim();
  // Cap input so a pathological upload can't blow the token budget; a resume
  // longer than this is almost certainly padded and the head carries the signal.
  const clipped = raw.slice(0, 12_000);

  if (!raw) {
    // We genuinely have nothing to save. This is the only "throw" case left —
    // the upload route should have rejected an empty file before reaching us.
    throw new LLMUnavailableError("Resume text is empty");
  }

  // No LLM? Still produce a usable v1 base from the raw text. The user can
  // edit fields in the UI or have Ask Vantage fill them in over chat.
  if (!llm.available) {
    return {
      resume: emptyResume(),
      raw,
      warnings: ["AI parser is offline — your resume text was saved as-is. Use Ask Vantage to fill in structured fields."],
      usedFallback: true,
      meta: { model: "none", costCents: 0 },
    };
  }

  let data: JsonResume | undefined;
  let modelMeta = { model: "unknown", costCents: 0 };
  try {
    const out = await llm.chatJSON<JsonResume>(
      [
        { role: "system", content: PARSE_SYSTEM },
        { role: "user", content: `Resume text:\n\n${clipped}` },
      ],
      { tier: "fast", temperature: 0.1, maxTokens: 2000 },
    );
    data = out.data;
    modelMeta = { model: out.meta.model, costCents: out.meta.costCents };
  } catch (err) {
    // Most common in the wild: the model returns mixed reasoning + JSON, or
    // truncated JSON that even repairJson can't salvage. Don't lose the upload
    // — surface a warning and let the user keep the raw text.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      resume: emptyResume(),
      raw,
      warnings: [
        `AI parser failed to read this resume — your text is saved but the fields aren't structured yet. (${detail.slice(0, 140)})`,
      ],
      usedFallback: true,
      meta: modelMeta,
    };
  }

  // Even when the LLM "succeeded", some providers drift the shape (e.g. GLM-4.7
  // occasionally returns work as a string[] instead of an object[]). Normalise
  // what we can, drop what we can't, and record a warning per field.
  const { resume, warnings } = sanitiseJsonResume(data);

  return {
    resume,
    raw,
    warnings,
    usedFallback: false,
    meta: modelMeta,
  };
}

function emptyResume(): JsonResume {
  return { basics: {}, work: [], education: [], skills: [], projects: [] };
}

/**
 * Field-level salvage: enforce the JsonResume shape, demote bad entries to
 * warnings instead of throwing. Anything we can't make sense of becomes a
 * warning the UI can surface to the user.
 */
function sanitiseJsonResume(data: JsonResume | undefined): {
  resume: JsonResume;
  warnings: string[];
} {
  const warnings: string[] = [];
  const out: JsonResume = {};
  if (!data || typeof data !== "object") {
    return { resume: emptyResume(), warnings: ["AI returned no resume structure — basic fields look empty."] };
  }

  // basics: object with optional string fields.
  if (data.basics && typeof data.basics === "object") {
    out.basics = data.basics;
  } else if (data.basics !== undefined) {
    warnings.push("AI didn't return a recognisable 'basics' block — please fill in name/email yourself.");
    out.basics = {};
  }

  // work: must be array of objects. String entries get demoted to warnings.
  if (Array.isArray(data.work)) {
    const cleanWork: NonNullable<JsonResume["work"]> = [];
    let droppedWork = 0;
    for (const item of data.work) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        cleanWork.push(item as NonNullable<JsonResume["work"]>[number]);
      } else {
        droppedWork += 1;
      }
    }
    out.work = cleanWork;
    if (droppedWork > 0) {
      warnings.push(`AI couldn't structure ${droppedWork} work entr${droppedWork === 1 ? "y" : "ies"} — please review the Work section.`);
    }
  }

  if (Array.isArray(data.education)) out.education = data.education;
  if (Array.isArray(data.skills)) out.skills = data.skills;
  if (Array.isArray(data.projects)) out.projects = data.projects;

  // Spillover: keep any other top-level keys verbatim (forward-compat with
  // JSON Resume extensions like languages, awards, certificates).
  for (const k of Object.keys(data)) {
    if (!(k in out)) (out as Record<string, unknown>)[k] = data[k];
  }

  // Empty-ish? Still valid (raw text is saved), but warn so the user knows
  // they need to fill in structured fields.
  const hasContent =
    (out.basics && Object.keys(out.basics).length > 0) ||
    (Array.isArray(out.work) && out.work.length > 0) ||
    (Array.isArray(out.skills) && out.skills.length > 0);
  if (!hasContent) {
    warnings.push("AI couldn't extract structured fields from this resume — the raw text is saved; use Ask Vantage to help fill in details.");
  }

  return { resume: out, warnings };
}
