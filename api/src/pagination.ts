import { ValidationError } from "./errors";

// Standardized list pagination / sorting (API-021). List routes return bare
// arrays today (`{ resumes: [...] }`) with no bound on size and no sort control.
// This gives every list endpoint one offset-paginated contract:
//
//   parsePagination(c.req.query(), { sortable: ["created_at", "version"] })
//     → { limit, offset, sort, order }            (safe for SQL interpolation)
//   paginated(rows, total, params)
//     → { data, page: { total, limit, offset, nextOffset } }
//
// The sort column is validated against a per-route allowlist, so the (un-
// parameterizable) ORDER BY identifier can never be attacker-controlled.

export interface PaginationParams {
  limit: number;
  offset: number;
  /** Column to sort by — guaranteed to be a member of the route's allowlist. */
  sort: string;
  order: "ASC" | "DESC";
}

export interface PaginationOptions {
  /** Column names a route permits sorting by. First entry is the default. */
  sortable: readonly string[];
  defaultLimit?: number;
  maxLimit?: number;
  defaultOrder?: "ASC" | "DESC";
}

/** Raw query record (Hono's `c.req.query()` returns Record<string,string>). */
type RawQuery = Record<string, string | undefined>;

export function parsePagination(
  q: RawQuery,
  opts: PaginationOptions,
): PaginationParams {
  const maxLimit = opts.maxLimit ?? 100;
  const defaultLimit = opts.defaultLimit ?? 20;

  const limit = clampInt(q.limit, defaultLimit, 1, maxLimit, "limit");
  const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");

  const sort = q.sort ?? opts.sortable[0];
  if (!opts.sortable.includes(sort)) {
    throw new ValidationError(
      `Invalid sort field "${sort}"`,
      { allowed: opts.sortable },
    );
  }

  const rawOrder = (q.order ?? opts.defaultOrder ?? "DESC").toUpperCase();
  if (rawOrder !== "ASC" && rawOrder !== "DESC") {
    throw new ValidationError(`Invalid order "${q.order}" (use asc or desc)`);
  }

  return { limit, offset, sort, order: rawOrder };
}

export interface PaginatedEnvelope<T> {
  data: T[];
  page: {
    total: number;
    limit: number;
    offset: number;
    /** Offset for the next page, or null when this is the last page. */
    nextOffset: number | null;
  };
}

/** Wrap a page of rows + the unfiltered total count into the list envelope. */
export function paginated<T>(
  data: T[],
  total: number,
  params: Pick<PaginationParams, "limit" | "offset">,
): PaginatedEnvelope<T> {
  const consumed = params.offset + data.length;
  return {
    data,
    page: {
      total,
      limit: params.limit,
      offset: params.offset,
      nextOffset: consumed < total ? consumed : null,
    },
  };
}

/** Parse an integer query param, clamping to [min, max]; reject non-numerics. */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(`Invalid ${name} "${raw}" (must be an integer)`);
  }
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
