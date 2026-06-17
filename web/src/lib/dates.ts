// Tiny date + greeting helpers used by the workspace views.
// Pure functions so they unit-test trivially and SSR cleanly.

export type Greeting = "Good morning" | "Good afternoon" | "Good evening";

/** Time-of-day greeting, defaulting to local time. */
export function greetingFor(date: Date = new Date()): Greeting {
  const h = date.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** "Good morning, Alex." — falls back to a friendly "there" when nameless. */
export function fullGreeting(firstName?: string | null, date: Date = new Date()): string {
  const who = (firstName ?? "").trim() || "there";
  return `${greetingFor(date)}, ${who}.`;
}

/** Extract the first name from a "First Last" or single-token display name. */
export function firstNameOf(fullName?: string | null): string {
  if (!fullName) return "";
  const trimmed = fullName.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/, 1)[0] ?? "";
}

/** Two-letter initials, uppercased. Falls back to "?" so the avatar never empties. */
export function initialsOf(fullName?: string | null): string {
  if (!fullName) return "?";
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.charAt(0) ?? "?").toUpperCase();
  return ((parts[0]?.charAt(0) ?? "") + (parts[parts.length - 1]?.charAt(0) ?? "")).toUpperCase() || "?";
}

/** "Wednesday · June 17, 2026" — matches the existing Vantage workspace header copy. */
export function formatToday(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })
    .format(date)
    .replace(",", " ·");
}

/** Short stamp ("June 17, 2026") used in chat composer headers. */
export function shortDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
