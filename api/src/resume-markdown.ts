// JSON Resume → canonical Markdown (the human-readable "main track" per
// docs/design/resume-original-vs-optimized-vibe-design.md §11.3).
//
// Why Markdown is the main track and JSON is the side index:
//   - the LLM produces/edits Markdown directly (no nested-array index juggling),
//   - line-level diffs are clean (§5.1 coral highlight is a line diff),
//   - one `.resume-prose` theme renders every résumé — no per-résumé templates.
//
// This module is a PURE structural transform: it only rearranges what's already
// in the JSON Resume. It NEVER invents text (vision.md red line) — every output
// token comes verbatim from an input field.
//
// Bullet-line contract: every work highlight renders as exactly ONE Markdown
// list line, in work/highlight order. That 1:1 line mapping is what lets
// bullet_index stable IDs anchor to a Markdown line for vibe edits (§4.3).

import type { SupportedLocale } from "./locale";
import { DEFAULT_LOCALE } from "./locale";
import type { JsonResume } from "./resume-parse";

/** One résumé section as Markdown lines. Joined with blank lines between blocks. */
type Block = string;

/**
 * Localized labels for section headings and structural date words.
 * The résumé *content* (bullets, company names, JD text) is never translated
 * — that's the artifact-locale axis (vantage-ui-mapping.md). What we localize
 * here is the canonical chrome the renderer adds around that content:
 * section titles ("## Experience" vs "## 工作经历"), the open-ended date
 * sentinel ("Present" vs "至今"), and month abbreviations on parsed YYYY-MM
 * inputs (free-text dates are passed through verbatim — see formatDate).
 */
type LabelSet = {
  summary: string;
  experience: string;
  skills: string;
  projects: string;
  education: string;
  present: string;
  months: readonly string[];
};

const LABELS: Record<SupportedLocale, LabelSet> = {
  en: {
    summary: "Summary",
    experience: "Experience",
    skills: "Skills",
    projects: "Projects",
    education: "Education",
    present: "Present",
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  zh: {
    summary: "概览",
    experience: "工作经历",
    skills: "技能",
    projects: "项目",
    education: "教育",
    present: "至今",
    months: ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"],
  },
};

export type RenderOptions = {
  /**
   * UI locale for chrome labels (section titles, "Present", month names).
   * Defaults to "en" so existing callers and tests keep their current output.
   */
  locale?: SupportedLocale;
};

/**
 * Render a JSON Resume document to canonical GFM Markdown.
 *
 * Layout (matches the .resume-prose theme the front-end ships):
 *   # Name
 *   _Label_                          ← role/title, italic subtitle
 *   contact · line · with · dots     ← email · phone · location · profiles
 *
 *   ## Summary
 *   paragraph
 *
 *   ## Experience
 *   ### Position — Company            ← H3 per role
 *   _Jun 2021 – Present · Location_   ← italic meta line
 *   - highlight one
 *   - highlight two
 *
 *   ## Skills
 *   **Group** — kw, kw, kw            ← one line per skill group
 *
 *   ## Education
 *   ### Degree, Area — Institution
 *   _2018 – 2022_
 *
 *   ## Projects
 *   ### Name
 *   description
 *   - highlight
 */
export function jsonResumeToMarkdown(
  resume: JsonResume | undefined | null,
  opts: RenderOptions = {},
): string {
  if (!resume || typeof resume !== "object") return "";
  const labels = LABELS[opts.locale ?? DEFAULT_LOCALE];
  const blocks: Block[] = [];

  const header = renderHeader(resume.basics);
  if (header) blocks.push(header);

  const summary = renderSummary(resume.basics, labels);
  if (summary) blocks.push(summary);

  const work = renderWork(resume.work, labels);
  if (work) blocks.push(work);

  // Skills before Projects: when a recruiter scans the document, "what stack
  // does this person use" answers itself in one glance after Experience.
  // Projects (a smaller, optional section) then leads the reader into the
  // proof. Education anchors the tail.
  const skills = renderSkills(resume.skills, labels);
  if (skills) blocks.push(skills);

  const projects = renderProjects(resume.projects, labels);
  if (projects) blocks.push(projects);

  const education = renderEducation(resume.education, labels);
  if (education) blocks.push(education);

  // Forward-compat: render common JSON Resume extensions we don't model
  // explicitly (languages, awards, certificates) as simple lists so nothing
  // silently disappears from the user's upload.
  const extras = renderExtras(resume);
  if (extras) blocks.push(extras);

  const md = blocks.join("\n\n").trim();
  return md ? md + "\n" : "";
}

function renderHeader(basics: JsonResume["basics"]): Block {
  if (!basics) return "";
  const lines: string[] = [];
  const name = clean(basics.name);
  if (name) lines.push(`# ${name}`);
  const label = clean(basics.label);
  if (label) lines.push(`_${label}_`);

  const contact = renderContact(basics);
  if (contact) lines.push(contact);

  return lines.join("\n");
}

/** email · phone · City, Region · github.com/x — a single dot-joined line. */
function renderContact(basics: NonNullable<JsonResume["basics"]>): string {
  const parts: string[] = [];
  const email = clean(basics.email);
  if (email) parts.push(email);
  const phone = clean(basics.phone);
  if (phone) parts.push(phone);

  const loc = renderLocation(basics.location);
  if (loc) parts.push(loc);

  for (const p of basics.profiles ?? []) {
    const url = clean(p?.url);
    const net = clean(p?.network);
    const user = clean(p?.username);
    if (url) {
      // Link with a readable label: prefer "network", then username, then the
      // bare URL stripped of its scheme.
      const label = net || user || stripScheme(url);
      parts.push(`[${label}](${url})`);
    } else if (net && user) {
      parts.push(`${net}: ${user}`);
    }
  }
  return parts.join(" · ");
}

function renderLocation(loc: NonNullable<JsonResume["basics"]>["location"]): string {
  if (!loc) return "";
  const bits = [clean(loc.city), clean(loc.region), clean(loc.countryCode)].filter(Boolean);
  return bits.join(", ");
}

function renderSummary(basics: JsonResume["basics"], labels: LabelSet): Block {
  const summary = clean(basics?.summary);
  if (!summary) return "";
  return `## ${labels.summary}\n\n${summary}`;
}

function renderWork(work: JsonResume["work"], labels: LabelSet): Block {
  if (!Array.isArray(work) || work.length === 0) return "";
  const out: string[] = [`## ${labels.experience}`];
  for (const w of work) {
    if (!w || typeof w !== "object") continue;
    const company = clean(w.name) || clean((w as Record<string, unknown>).company as string);
    const position = clean(w.position);
    // H3 title: "Position — Company" (em dash). Either side may be missing.
    const title = [position, company].filter(Boolean).join(" — ");
    if (title) out.push(`\n### ${title}`);

    const meta = renderDateRange(w.startDate, w.endDate, labels);
    if (meta) out.push(`_${meta}_`);

    const wsummary = clean(w.summary);
    if (wsummary) out.push(wsummary);

    for (const h of w.highlights ?? []) {
      const text = clean(typeof h === "string" ? h : String(h));
      if (text) out.push(`- ${text}`);
    }
  }
  return out.join("\n");
}

function renderProjects(projects: JsonResume["projects"], labels: LabelSet): Block {
  if (!Array.isArray(projects) || projects.length === 0) return "";
  const out: string[] = [`## ${labels.projects}`];
  for (const p of projects) {
    if (!p || typeof p !== "object") continue;
    const name = clean(p.name);
    if (name) out.push(`\n### ${name}`);
    const desc = clean(p.description);
    if (desc) out.push(desc);
    for (const h of p.highlights ?? []) {
      const text = clean(typeof h === "string" ? h : String(h));
      if (text) out.push(`- ${text}`);
    }
  }
  return out.join("\n");
}

function renderSkills(skills: JsonResume["skills"], labels: LabelSet): Block {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const lines: string[] = [`## ${labels.skills}`];
  for (const s of skills) {
    if (!s || typeof s !== "object") {
      const bare = clean(String(s));
      if (bare) lines.push(`- ${bare}`);
      continue;
    }
    const name = clean(s.name);
    const keywords = (s.keywords ?? []).map((k) => clean(k)).filter(Boolean);
    const level = clean(s.level);
    if (name && keywords.length > 0) {
      // **Group** kw, kw, kw — we deliberately drop the em-dash separator we
      // used earlier. The .resume-prose theme styles the LI as a two-column
      // grid (label · keywords), so the dash would visually duplicate the
      // grid gap and read as noise. Plain-text consumers (LLM read-back, MD
      // export) still get the bold group label followed by a single space
      // before keywords — readable without the dash.
      const tail = level ? ` (${level})` : "";
      lines.push(`- **${name}**${tail} ${keywords.join(", ")}`);
    } else if (name) {
      lines.push(`- **${name}**${level ? ` — ${level}` : ""}`);
    } else if (keywords.length > 0) {
      lines.push(`- ${keywords.join(", ")}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function renderEducation(education: JsonResume["education"], labels: LabelSet): Block {
  if (!Array.isArray(education) || education.length === 0) return "";
  const out: string[] = [`## ${labels.education}`];
  for (const e of education) {
    if (!e || typeof e !== "object") continue;
    const study = clean(e.studyType);
    const area = clean(e.area);
    const inst = clean(e.institution);
    const degree = [study, area].filter(Boolean).join(", ");
    const title = [degree, inst].filter(Boolean).join(" — ");
    if (title) out.push(`\n### ${title}`);
    const meta = renderDateRange(e.startDate, e.endDate, labels);
    if (meta) out.push(`_${meta}_`);
  }
  return out.join("\n");
}

/**
 * Render generic JSON Resume sections we don't have a bespoke layout for, so a
 * rich upload never loses content. Arrays of {name}/{title}/string become a
 * bulleted "## Title" block. Strings/objects we can't read are skipped (the
 * structural transform never guesses).
 */
function renderExtras(resume: JsonResume): Block {
  const known = new Set([
    "basics",
    "work",
    "education",
    "skills",
    "projects",
    // wrapper metadata that lives alongside the JSON Resume in storage
    "_raw",
    "_warnings",
    "_parsedAt",
    "_source",
    "_markdown",
  ]);
  const blocks: Block[] = [];
  for (const key of Object.keys(resume)) {
    if (known.has(key)) continue;
    const val = (resume as Record<string, unknown>)[key];
    if (!Array.isArray(val) || val.length === 0) continue;
    const items: string[] = [];
    for (const entry of val) {
      if (typeof entry === "string") {
        const t = clean(entry);
        if (t) items.push(`- ${t}`);
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const label = clean(
          (rec.name as string) ?? (rec.title as string) ?? (rec.language as string),
        );
        const detail = clean(
          (rec.summary as string) ??
            (rec.description as string) ??
            (rec.fluency as string) ??
            (rec.date as string),
        );
        if (label && detail) items.push(`- **${label}** — ${detail}`);
        else if (label) items.push(`- ${label}`);
      }
    }
    if (items.length > 0) {
      blocks.push(`## ${titleCase(key)}\n${items.join("\n")}`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Render a human date range from ISO-ish JSON Resume dates.
 * "2021-06" + "2024-03"  → "Jun 2021 – Mar 2024"   (en)
 *                       → "2021 6 月 – 2024 3 月"   (zh)
 * "2021"    + ""         → "2021 – Present" / "2021 – 至今"
 * Unparseable input is passed through verbatim (never fabricate a date).
 */
function renderDateRange(start: string | undefined, end: string | undefined, labels: LabelSet): string {
  const s = formatDate(start, labels);
  const e = end ? formatDate(end, labels) : "";
  if (!s && !e) return "";
  if (s && !clean(end)) return `${s} – ${labels.present}`;
  if (s && e) return `${s} – ${e}`;
  return s || e;
}

function formatDate(date: string | undefined, labels: LabelSet): string {
  const d = clean(date);
  if (!d) return "";
  // YYYY-MM or YYYY-MM-DD → localized "Mon YYYY"
  const ym = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(d);
  if (ym) {
    const month = labels.months[Number(ym[2]) - 1];
    return month ? `${month} ${ym[1]}` : ym[1];
  }
  // YYYY → "YYYY"
  if (/^\d{4}$/.test(d)) return d;
  // Anything else (free text like "Present", "2021–2024") → verbatim.
  return d;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
