// Map raw API application.status → tracker column + Vantage-style pill tokens.
// Centralised so today-view, tracker-view, and any future status-aware surfaces
// stay visually in lockstep.

export type AppColumn = "preparing" | "applied" | "interviewing" | "outcome";

export interface StatusVisual {
  /** Column this status belongs to in the kanban tracker. */
  column: AppColumn;
  /** Stable i18n key under tracker.status. */
  labelKey:
    | "draft"
    | "review"
    | "submitted"
    | "interview"
    | "offer"
    | "rejected"
    | "ghosted";
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
    return { column: "outcome", labelKey: "offer", pillClass: "text-green bg-green-bg" };
  }
  if (s === "rejected" || s === "closed" || s === "ghosted") {
    return {
      column: "outcome",
      labelKey: s === "ghosted" ? "ghosted" : "rejected",
      pillClass: "text-ink-muted bg-[#F3F0EB]",
    };
  }

  if (s === "interview" || s === "interviewing" || s === "screen" || s === "onsite") {
    return { column: "interviewing", labelKey: "interview", pillClass: "text-amber bg-gold-bg" };
  }

  if (s === "submitted") {
    return { column: "applied", labelKey: "submitted", pillClass: "text-brown bg-cream" };
  }
  if (s === "draft" || s === "review" || s === "prepared") {
    return {
      column: "preparing",
      labelKey: s === "review" || s === "prepared" ? "review" : "draft",
      pillClass:
        s === "review" || s === "prepared"
          ? "text-green bg-green-bg"
          : "text-ink-light bg-[#F3F0EB]",
    };
  }
  return { column: "preparing", labelKey: "draft", pillClass: "text-ink-light bg-[#F3F0EB]" };
}
