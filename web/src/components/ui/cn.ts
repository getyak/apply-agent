// Minimal classnames concat — zero-dep, predictable.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
