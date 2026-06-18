// Map raw API application.status → tracker column + Vantage-style pill tokens.
// Centralised so today-view, tracker-view, and any future status-aware surfaces
// stay visually in lockstep.

export type AppColumn = "applied" | "interviewing" | "outcome";

export interface StatusVisual {
  /** Column this status belongs to in the kanban tracker. */
  column: AppColumn;
  /** Short label shown on the pill. */
  label: string;
  /** Tailwind classes for `text-* bg-*` pairs (Vantage tokens only). */
  pillClass: string;
}

/**
 * Map the API's free-form status string to a kanban column and pill style.
 * Unknown statuses fall through to a neutral "applied" pill so the UI never
 * blanks out on a server-side schema bump.
 */
export function statusVisual(rawStatus: string): StatusVisual {
  const s = (rawStatus || "").toLowerCase();

  if (s === "offer" || s === "accepted") {
    return { column: "outcome", label: "Offer", pillClass: "text-green bg-green-bg" };
  }
  if (s === "rejected" || s === "closed" || s === "ghosted") {
    return {
      column: "outcome",
      label: s === "rejected" ? "Closed" : s.charAt(0).toUpperCase() + s.slice(1),
      pillClass: "text-ink-muted bg-[#F3F0EB]",
    };
  }

  if (s === "interview" || s === "interviewing" || s === "screen" || s === "onsite") {
    return { column: "interviewing", label: "Interview", pillClass: "text-amber bg-gold-bg" };
  }

  if (s === "submitted") {
    return { column: "applied", label: "Submitted", pillClass: "text-brown bg-cream" };
  }
  if (s === "draft" || s === "review" || s === "prepared") {
    return { column: "applied", label: "Draft", pillClass: "text-ink-light bg-[#F3F0EB]" };
  }
  return { column: "applied", label: rawStatus || "Applied", pillClass: "text-ink-light bg-[#F3F0EB]" };
}
