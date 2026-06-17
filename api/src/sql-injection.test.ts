/**
 * SQL injection prevention tests (SEC-007).
 *
 * Two-pronged approach:
 *
 * A) White-box unit tests on the SQL-building helpers that receive user input
 *    (parsePagination allowlist, the ownership query builder).  These prove the
 *    parameterisation contract without needing a live DB.
 *
 * B) Black-box HTTP tests on the Hono app.  The DB wrapper (`db.ts`) exports a
 *    single `query` function that wraps `pg.Pool.query`.  Because ESM named
 *    exports are read-only we cannot monkey-patch `dbModule.query` at runtime.
 *    Instead we stub the underlying `pg.Pool` instance (the default export of
 *    `db.ts`) so all `query(sql, params)` calls land on our spy.  This lets us
 *    inspect every SQL string the route actually builds and assert that payload
 *    strings only appear in the params array, never in the SQL text.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";

// ─── A. Unit: SQL-building helpers ───────────────────────────────────────────

import { parsePagination } from "./pagination";
import { fetchOwned } from "./ownership";
import { ValidationError } from "./errors";

describe("parsePagination — sort/order SQL injection prevention", () => {
  const opts = { sortable: ["created_at", "version"] as const };

  it("rejects an unknown sort column", () => {
    expect(() =>
      parsePagination({ sort: "1;DROP TABLE users--" }, opts),
    ).toThrow(ValidationError);
  });

  it("rejects any order value that is not ASC or DESC", () => {
    expect(() =>
      parsePagination({ sort: "created_at", order: "EVIL" }, opts),
    ).toThrow(ValidationError);
  });

  it("only allows exact allowlist members as the sort value", () => {
    // Payload that looks like a valid column name suffix.
    expect(() =>
      parsePagination({ sort: "created_at;--" }, opts),
    ).toThrow(ValidationError);
  });

  it("returns the first allowlist entry as a safe default when sort is absent", () => {
    const { sort, order } = parsePagination({}, opts);
    expect(sort).toBe("created_at");
    expect(order).toBe("DESC");
  });

  it("returns valid sort/order for legitimate input", () => {
    const { sort, order } = parsePagination(
      { sort: "version", order: "asc" },
      opts,
    );
    expect(sort).toBe("version");
    expect(order).toBe("ASC");
  });
});

describe("fetchOwned — id/userId binding (ownership.ts)", () => {
  interface FakeResult {
    rows: Array<Record<string, unknown>>;
  }
  const captured: { text: string; params: unknown[] }[] = [];

  function fakeQuery(rows: FakeResult["rows"]) {
    return async (text: string, params: unknown[]) => {
      captured.push({ text, params });
      return { rows };
    };
  }

  beforeEach(() => captured.splice(0));

  it("binds id and userId as positional params — never interpolates them", async () => {
    const payload = "' OR '1'='1";
    await fetchOwned("resumes", payload, payload, "*", fakeQuery([]));
    expect(captured).toHaveLength(1);
    const { text, params } = captured[0];
    // The payload must live in params, not in the SQL text.
    expect(text).not.toContain(payload);
    expect(params[0]).toBe(payload);
    expect(params[1]).toBe(payload);
    // The template must use positional placeholders.
    expect(text).toContain("$1");
    expect(text).toContain("$2");
  });

  it("does not interpolate a null-byte payload", async () => {
    const payload = "\x00";
    await fetchOwned("user_files", payload, payload, "*", fakeQuery([]));
    expect(captured[0].text).not.toContain(payload);
    expect(captured[0].params).toContain(payload);
  });
});

// ─── B. Black-box HTTP: stub pg.Pool so routes run without a real DB ─────────
//
// `db.ts` calls `pool.query(text, params)`.  We stub the pool's `.query`
// method — a plain property on a class instance — which IS writable, unlike
// the ESM-exported named function.

import pool from "./db"; // the pg.Pool default export
import type { QueryResult, QueryResultRow } from "pg";

const CLASSIC_PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE users;--",
  "\x00",
  "admin'--",
];

interface CallRecord {
  text: string;
  params: unknown[];
}

let poolCalls: CallRecord[] = [];
// pg.Pool.query is overloaded; cast to the simplest usable signature.
type PoolQueryFn = (text: string, params?: unknown[]) => Promise<QueryResult<QueryResultRow>>;
let originalPoolQuery: PoolQueryFn;

function stubPool() {
  poolCalls = [];
  originalPoolQuery = (pool as { query: PoolQueryFn }).query.bind(pool);

  (pool as { query: PoolQueryFn }).query = async (
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<QueryResultRow>> => {
    poolCalls.push({ text, params: params ?? [] });
    // COUNT(*) queries must return one row or routes reading rows[0].total
    // will throw.  All other queries return an empty set.
    const rows: QueryResultRow[] = text.includes("COUNT(*)") ? [{ total: 0, recent: 0 }] : [];
    return {
      rows,
      rowCount: rows.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as QueryResult<QueryResultRow>;
  };
}

function restorePool() {
  (pool as { query: PoolQueryFn }).query = originalPoolQuery;
}

function assertPayloadNotInSqlText(payload: string) {
  for (const call of poolCalls) {
    expect(call.text).not.toContain(payload);
  }
}

async function getApp() {
  const { default: app } = await import("./index");
  return app;
}

async function makeToken(userId = "test-user-00000000") {
  const { signToken } = await import("./middleware/auth");
  return signToken(userId);
}

async function authedFetch(
  app: { fetch: (r: Request) => Response | Promise<Response> },
  url: string,
  init: RequestInit = {},
  token?: string,
) {
  const tok = token ?? (await makeToken());
  return app.fetch(
    new Request(`http://localhost${url}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
  );
}

describe("HTTP endpoints — SQL injection via pg.Pool stub", () => {
  beforeEach(stubPool);
  afterEach(restorePool);

  // ── 1. Auth login — email field ──────────────────────────────────────────

  describe("POST /api/auth/login — email field", () => {
    for (const payload of CLASSIC_PAYLOADS) {
      it(`payload never appears in SQL text: ${JSON.stringify(payload)}`, async () => {
        const app = await getApp();
        const res = await app.fetch(
          new Request("http://localhost/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: payload, password: "hunter2" }),
          }),
        );

        // Never 500 (db panic or constraint leak).
        expect(res.status).not.toBe(500);
        assertPayloadNotInSqlText(payload);

        // No SQL error text in the response body.
        const body = await res.text();
        expect(body).not.toContain("syntax error");
        expect(body).not.toContain("relation \"");
        expect(body).not.toContain("DROP TABLE");
      });
    }
  });

  // ── 2. Jobs list — search query param ────────────────────────────────────

  describe("GET /api/jobs?search=… — search parameter", () => {
    for (const payload of CLASSIC_PAYLOADS) {
      it(`payload bound as param, not in SQL text: ${JSON.stringify(payload)}`, async () => {
        const app = await getApp();
        const res = await authedFetch(
          app,
          `/api/jobs?search=${encodeURIComponent(payload)}`,
        );

        expect(res.status).not.toBe(500);
        assertPayloadNotInSqlText(payload);

        // If an ILIKE clause was built, it must use $N placeholder.
        const ilikeCalls = poolCalls.filter((c) => c.text.includes("ILIKE"));
        for (const call of ilikeCalls) {
          expect(call.text).toMatch(/\$\d/);
        }
      });
    }
  });

  // ── 3. Applications list — status filter ─────────────────────────────────

  describe("GET /api/applications?status=… — status filter", () => {
    for (const payload of CLASSIC_PAYLOADS) {
      it(`status bound as param: ${JSON.stringify(payload)}`, async () => {
        const app = await getApp();
        const res = await authedFetch(
          app,
          `/api/applications?status=${encodeURIComponent(payload)}`,
        );

        expect(res.status).not.toBe(500);
        assertPayloadNotInSqlText(payload);

        // Any query that filters on ad.status must use a $N placeholder.
        const statusCalls = poolCalls.filter((c) => c.text.includes("ad.status"));
        for (const call of statusCalls) {
          expect(call.text).toMatch(/ad\.status = \$\d/);
        }
      });
    }
  });

  // ── 4. Resumes list — sort/order allowlist ───────────────────────────────

  describe("GET /api/resumes?sort=… — sort column allowlist", () => {
    it("rejects unknown sort column with 400; no SQL issued", async () => {
      const app = await getApp();
      const res = await authedFetch(app, "/api/resumes?sort=1%3BDROP%20TABLE");
      expect(res.status).toBe(400);
      // parsePagination throws before any DB call is made.
      for (const call of poolCalls) {
        expect(call.text).not.toContain("DROP");
      }
    });

    it("rejects invalid order with 400", async () => {
      const app = await getApp();
      const res = await authedFetch(app, "/api/resumes?order=EVIL");
      expect(res.status).toBe(400);
    });
  });
});
