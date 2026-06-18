import { describe, expect, test } from "bun:test";
import { requireOwnership, fetchOwned, type QueryFn } from "./ownership";
import { NotFoundError } from "./errors";

// Inject a fake query fn so the guard's logic is testable without PG.
function fakeQuery(rows: Array<Record<string, unknown>>): {
  fn: QueryFn;
  calls: Array<{ text: string; params: unknown[] }>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const fn: QueryFn = async (text, params) => {
    calls.push({ text, params });
    return { rows };
  };
  return { fn, calls };
}

describe("ownership", () => {
  test("requireOwnership returns the row when owned", async () => {
    const { fn } = fakeQuery([{ id: "r1", content: { a: 1 } }]);
    const row = await requireOwnership("resumes", "r1", "u1", "*", fn);
    expect(row).toEqual({ id: "r1", content: { a: 1 } });
  });

  test("requireOwnership throws NotFound when absent or not owned", async () => {
    const { fn } = fakeQuery([]);
    await expect(requireOwnership("resumes", "r1", "u2", "*", fn)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("binds id and userId as parameters (no interpolation)", async () => {
    const { fn, calls } = fakeQuery([{ id: "r1" }]);
    await requireOwnership("application_drafts", "a1", "u1", "id", fn);
    expect(calls[0].params).toEqual(["a1", "u1"]);
    expect(calls[0].text).toContain("FROM application_drafts");
    expect(calls[0].text).toContain("WHERE id = $1 AND user_id = $2");
  });

  test("fetchOwned returns null instead of throwing on miss", async () => {
    const { fn } = fakeQuery([]);
    expect(await fetchOwned("user_files", "f1", "u1", "*", fn)).toBeNull();
  });

  test("error message uses the human table name", async () => {
    const { fn } = fakeQuery([]);
    await expect(
      requireOwnership("interview_sessions", "s1", "u1", "*", fn),
    ).rejects.toThrow("Interview session not found");
  });
});
