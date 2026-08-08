export interface ComparableWork {
  name?: string;
  position?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
}

const COMMON_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "built",
  "build",
  "developed",
  "created",
  "improved",
  "optimized",
  "using",
  "through",
  "service",
  "services",
]);

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9%+.]+/g, " ").trim();
}

function facts(value: string): { numbers: string[]; words: Set<string> } {
  const text = normalized(value);
  return {
    numbers: text.match(/\d+(?:\.\d+)?%?/g) ?? [],
    words: new Set(
      text
        .split(" ")
        .filter((word) => word.length >= 3 && !COMMON_WORDS.has(word)),
    ),
  };
}

function likelyRewriteOf(base: string, candidate: string): boolean {
  const left = normalized(base);
  const right = normalized(candidate);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;

  const baseFacts = facts(base);
  const candidateFacts = facts(candidate);
  if (
    baseFacts.numbers.length > 0 &&
    baseFacts.numbers.every((number) => candidateFacts.numbers.includes(number))
  ) {
    return true;
  }
  if (baseFacts.words.size === 0) return false;
  const shared = [...baseFacts.words].filter((word) =>
    candidateFacts.words.has(word),
  ).length;
  return shared / baseFacts.words.size >= 0.55;
}

function sameRole(left: ComparableWork, right: ComparableWork): boolean {
  const leftCompany = normalized(left.name ?? "");
  const rightCompany = normalized(right.name ?? "");
  const leftRole = normalized(left.position ?? "");
  const rightRole = normalized(right.position ?? "");
  return (
    Boolean(leftCompany && rightCompany && leftCompany === rightCompany) ||
    Boolean(leftRole && rightRole && leftRole === rightRole)
  );
}

/**
 * Build the right-hand Compare document without hiding source bullets that a
 * derived version accidentally omitted. Rewritten bullets occupy the source
 * bullet's position; untouched/omitted source bullets remain visible, and
 * genuinely new derived bullets are appended.
 */
export function mergeCompareWork<T extends ComparableWork>(
  derived: T[],
  base: ComparableWork[],
): T[] {
  const merged = derived.map((role) => ({ ...role })) as T[];

  for (const baseRole of base) {
    const derivedIndex = derived.findIndex((role) => sameRole(role, baseRole));
    if (derivedIndex < 0) {
      merged.push({ ...baseRole } as T);
      continue;
    }
    const derivedHighlights = derived[derivedIndex]?.highlights ?? [];
    const consumed = new Set<number>();
    const highlights: string[] = [];

    for (const baseBullet of baseRole.highlights ?? []) {
      const rewriteIndex = derivedHighlights.findIndex(
        (candidate, index) =>
          !consumed.has(index) && likelyRewriteOf(baseBullet, candidate),
      );
      if (rewriteIndex >= 0) {
        consumed.add(rewriteIndex);
        highlights.push(derivedHighlights[rewriteIndex]!);
      } else {
        highlights.push(baseBullet);
      }
    }
    derivedHighlights.forEach((bullet, index) => {
      if (!consumed.has(index)) highlights.push(bullet);
    });
    merged[derivedIndex] = {
      ...merged[derivedIndex],
      summary:
        merged[derivedIndex]?.summary?.trim() ||
        baseRole.summary?.trim() ||
        undefined,
      highlights,
    };
  }

  return merged;
}
