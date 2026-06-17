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
  meta: { model: string; costCents: number };
}

/**
 * Parse resume text into a JSON Resume object. Throws LLMUnavailableError when
 * the model is unconfigured/unreachable or returns unparseable output, so the
 * caller can surface an honest "parsing unavailable" instead of a fake resume.
 */
export async function parseResumeText(
  text: string,
  llm: LLMClient = defaultLlm,
): Promise<ParseResult> {
  if (!llm.available) {
    throw new LLMUnavailableError(
      "Resume parsing requires an LLM (no key configured)",
    );
  }

  // Cap input so a pathological upload can't blow the token budget; a resume
  // longer than this is almost certainly padded and the head carries the signal.
  const clipped = text.slice(0, 12_000);

  const { data, meta } = await llm.chatJSON<JsonResume>(
    [
      { role: "system", content: PARSE_SYSTEM },
      { role: "user", content: `Resume text:\n\n${clipped}` },
    ],
    { tier: "fast", temperature: 0.1, maxTokens: 2000 },
  );

  // Defensive: ensure the result is an object with at least a basics or work
  // section. A model that returns {} on garbage input shouldn't pass as a parse.
  const looksValid =
    data &&
    typeof data === "object" &&
    (data.basics !== undefined || Array.isArray(data.work));
  if (!looksValid) {
    throw new LLMUnavailableError("Resume parse produced no usable structure");
  }

  return {
    resume: data,
    meta: { model: meta.model, costCents: meta.costCents },
  };
}
