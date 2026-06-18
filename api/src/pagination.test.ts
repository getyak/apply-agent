import { describe, expect, test } from "bun:test";
import { parsePagination, paginated } from "./pagination";
import { ValidationError } from "./errors";

const OPTS = { sortable: ["created_at", "version"] as const, defaultLimit: 20 };

describe("parsePagination", () => {
  test("applies defaults when params absent", () => {
    expect(parsePagination({}, OPTS)).toEqual({
      limit: 20,
      offset: 0,
      sort: "created_at",
      order: "DESC",
    });
  });

  test("clamps limit to maxLimit", () => {
    const p = parsePagination({ limit: "9999" }, { ...OPTS, maxLimit: 100 });
    expect(p.limit).toBe(100);
  });

  test("floors limit at 1 and offset at 0", () => {
    const p = parsePagination({ limit: "0", offset: "-5" }, OPTS);
    expect(p.limit).toBe(1);
    expect(p.offset).toBe(0);
  });

  test("rejects a non-integer limit", () => {
    expect(() => parsePagination({ limit: "abc" }, OPTS)).toThrow(ValidationError);
  });

  test("rejects a sort field outside the allowlist", () => {
    expect(() => parsePagination({ sort: "password" }, OPTS)).toThrow(ValidationError);
  });

  test("accepts an allowlisted sort and normalizes order", () => {
    const p = parsePagination({ sort: "version", order: "asc" }, OPTS);
    expect(p.sort).toBe("version");
    expect(p.order).toBe("ASC");
  });

  test("rejects an invalid order", () => {
    expect(() => parsePagination({ order: "sideways" }, OPTS)).toThrow(ValidationError);
  });
});

describe("paginated", () => {
  test("computes nextOffset when more rows remain", () => {
    const env = paginated([1, 2, 3], 10, { limit: 3, offset: 0 });
    expect(env.page).toEqual({ total: 10, limit: 3, offset: 0, nextOffset: 3 });
  });

  test("nextOffset is null on the last page", () => {
    const env = paginated([9, 10], 10, { limit: 3, offset: 8 });
    expect(env.page.nextOffset).toBeNull();
    expect(env.data).toEqual([9, 10]);
  });
});
