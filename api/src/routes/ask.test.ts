// Unit tests for the HITL NDJSON coercion in /api/ask/stream.
//
// Verifies the contract documented in src/routes/ask.ts § "HITL frame
// coercion": each shape the Python dock_agent might emit from
// LangGraph's interrupt() must produce exactly one valid NDJSON line of
// the matching kind, with resume_token always populated.

import { describe, expect, it } from "bun:test";
import {
  narratorNdjson,
  partialArtifactNdjson,
  toHitlNdjson,
  toolTraceNdjson,
} from "./ask";

function parse(line: string | null): Record<string, unknown> | null {
  if (line === null) return null;
  return JSON.parse(line) as Record<string, unknown>;
}

describe("partialArtifactNdjson", () => {
  it("returns null when artifact_id is missing or empty", () => {
    expect(partialArtifactNdjson({})).toBeNull();
    expect(partialArtifactNdjson({ artifact_id: "" })).toBeNull();
    expect(partialArtifactNdjson({ artifact_id: 42 })).toBeNull();
  });

  it("emits a canonical partial_artifact frame", () => {
    const line = partialArtifactNdjson({
      artifact_id: "tailor-1",
      kind: "resume_bullet",
      title: "Tailored draft",
      sub: "Bullet 2 of 5",
      progress: 0.4,
      payload: { items: ["a", "b"] },
    });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.kind).toBe("partial_artifact");
    expect(parsed.artifact_id).toBe("tailor-1");
    expect(parsed.artifact_kind).toBe("resume_bullet");
    expect(parsed.title).toBe("Tailored draft");
    expect(parsed.sub).toBe("Bullet 2 of 5");
    expect(parsed.progress).toBe(0.4);
    expect(parsed.payload).toEqual({ items: ["a", "b"] });
  });

  it("falls back to 'snapshot' when kind is missing", () => {
    const line = partialArtifactNdjson({ artifact_id: "x" });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.artifact_kind).toBe("snapshot");
  });

  it("clamps progress to [0,1] and converts percentages", () => {
    // Caller sent 65 (percentage) — must be normalised to 0.65.
    const pct = partialArtifactNdjson({ artifact_id: "x", progress: 65 });
    const parsedPct = JSON.parse(pct!) as Record<string, unknown>;
    expect(parsedPct.progress).toBeCloseTo(0.65, 5);
    // Caller sent -1 — clamp to 0.
    const neg = partialArtifactNdjson({ artifact_id: "x", progress: -1 });
    const parsedNeg = JSON.parse(neg!) as Record<string, unknown>;
    expect(parsedNeg.progress).toBe(0);
  });

  it("omits payload when missing (not null)", () => {
    const line = partialArtifactNdjson({ artifact_id: "x" });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect("payload" in parsed).toBe(false);
  });
});

describe("toolTraceNdjson", () => {
  it("returns null when tool name is missing", () => {
    expect(toolTraceNdjson({})).toBeNull();
    expect(toolTraceNdjson({ tool: "", agent: "x" })).toBeNull();
    expect(toolTraceNdjson({ agent: "applications", status: "ok" })).toBeNull();
  });

  it("emits a tool_trace NDJSON frame with the canonical shape", () => {
    const line = toolTraceNdjson({
      tool: "list_my_applications",
      agent: "applications",
      action: "list",
      status: "ok",
      summary: "ok · 3 items",
    });
    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.kind).toBe("tool_trace");
    expect(parsed.tool).toBe("list_my_applications");
    expect(parsed.agent).toBe("applications");
    expect(parsed.action).toBe("list");
    expect(parsed.status).toBe("ok");
    expect(parsed.summary).toBe("ok · 3 items");
  });

  it("normalises unknown status values to 'ok'", () => {
    // Status must be either 'ok' or 'error' — anything else maps to 'ok'
    // so the dock UI never has to worry about a third axis.
    const line = toolTraceNdjson({
      tool: "find_jobs",
      agent: "jobmatch_agent",
      status: "weird",
    });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
  });

  it("preserves error status verbatim", () => {
    const line = toolTraceNdjson({
      tool: "find_jobs",
      agent: "jobmatch_agent",
      status: "error",
      summary: "OpenRouter timeout",
    });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(parsed.summary).toBe("OpenRouter timeout");
  });

  it("clamps summary at 160 chars", () => {
    const long = "x".repeat(500);
    const line = toolTraceNdjson({
      tool: "tailor_resume",
      agent: "resume_agent",
      summary: long,
    });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect((parsed.summary as string).length).toBe(160);
  });

  it("defaults agent to 'coordinator' when missing", () => {
    const line = toolTraceNdjson({ tool: "weird_tool" });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.agent).toBe("coordinator");
  });

  it("passes plan_step through verbatim when present", () => {
    // Step 4: dock UI uses this to highlight the matching task-graph row.
    const line = toolTraceNdjson({
      tool: "list_my_applications",
      agent: "applications",
      plan_step: "fetch_apps",
    });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.plan_step).toBe("fetch_apps");
  });

  it("omits plan_step when missing (no empty key)", () => {
    const line = toolTraceNdjson({ tool: "list_my_applications" });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect("plan_step" in parsed).toBe(false);
  });

  it("drops non-string plan_step (defensive)", () => {
    const line = toolTraceNdjson({
      tool: "list_my_applications",
      plan_step: 42,
    });
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect("plan_step" in parsed).toBe(false);
  });
});

describe("narratorNdjson", () => {
  it("returns null for non-string inputs", () => {
    expect(narratorNdjson(null)).toBeNull();
    expect(narratorNdjson(undefined)).toBeNull();
    expect(narratorNdjson(42)).toBeNull();
    expect(narratorNdjson({ text: "x" })).toBeNull();
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(narratorNdjson("")).toBeNull();
    expect(narratorNdjson("   ")).toBeNull();
    expect(narratorNdjson("\n\t  ")).toBeNull();
  });

  it("emits a narrator NDJSON line with trimmed text", () => {
    const line = narratorNdjson("  Looking at your last Stripe apps.  ");
    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.kind).toBe("narrator");
    expect(parsed.text).toBe("Looking at your last Stripe apps.");
  });

  it("clamps text at 160 chars (cross-protocol guard)", () => {
    const long = "x".repeat(500);
    const line = narratorNdjson(long);
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect((parsed.text as string).length).toBe(160);
  });

  it("does not modify text under the 160-char limit", () => {
    const short = "x".repeat(50);
    const line = narratorNdjson(short);
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect((parsed.text as string).length).toBe(50);
  });
});

describe("toHitlNdjson", () => {
  const thread = "ask_vantage:11111111-1111-1111-1111-111111111111";

  it("returns null for nullish values", () => {
    expect(toHitlNdjson(null, thread)).toBeNull();
    expect(toHitlNdjson(undefined, thread)).toBeNull();
    expect(toHitlNdjson("not an object", thread)).toBeNull();
  });

  it("maps {kind: ask_user, question, chips, free_form, resume_token}", () => {
    const out = parse(
      toHitlNdjson(
        {
          kind: "ask_user",
          question: "Which company?",
          chips: ["Stripe", "Linear", "Anthropic"],
          free_form: false,
          resume_token: `${thread}#abc`,
        },
        thread,
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("ask_user");
    expect(out!.question).toBe("Which company?");
    expect(out!.chips).toEqual(["Stripe", "Linear", "Anthropic"]);
    expect(out!.free_form).toBe(false);
    expect(out!.resume_token).toBe(`${thread}#abc`);
  });

  it("infers ask_user from {question} alone", () => {
    const out = parse(toHitlNdjson({ question: "Target role?" }, thread));
    expect(out!.kind).toBe("ask_user");
    expect(out!.question).toBe("Target role?");
    expect(out!.free_form).toBe(true);
    expect((out!.resume_token as string).startsWith(`${thread}#hitl-`)).toBe(true);
  });

  it("clamps chips to 8 items + drops non-strings", () => {
    const out = parse(
      toHitlNdjson(
        {
          question: "Which?",
          chips: ["a", 1, "b", null, "c", "d", "e", "f", "g", "h", "i", "j"],
        },
        thread,
      ),
    );
    const chips = out!.chips as string[];
    expect(chips.length).toBe(8);
    expect(chips.every((c) => typeof c === "string")).toBe(true);
    expect(chips[0]).toBe("a");
  });

  it("maps {kind: diff, before, after}", () => {
    const out = parse(
      toHitlNdjson(
        {
          kind: "diff",
          before: { bullets: ["old"] },
          after: { bullets: ["new", "improved"] },
        },
        thread,
      ),
    );
    expect(out!.kind).toBe("diff");
    expect(out!.before).toEqual({ bullets: ["old"] });
    expect(out!.after).toEqual({ bullets: ["new", "improved"] });
  });

  it("infers diff from {before, after} alone", () => {
    const out = parse(
      toHitlNdjson({ before: "old text", after: "new text" }, thread),
    );
    expect(out!.kind).toBe("diff");
    expect(out!.before).toBe("old text");
    expect(out!.after).toBe("new text");
  });

  it("falls back to approval for anything else", () => {
    const out = parse(
      toHitlNdjson(
        {
          action: "submit_application",
          payload: { application_id: "abc-123" },
        },
        thread,
      ),
    );
    expect(out!.kind).toBe("approval");
    expect(out!.action).toBe("submit_application");
    expect(out!.payload).toEqual({ application_id: "abc-123" });
  });

  it("approval default action is 'approve'", () => {
    const out = parse(toHitlNdjson({ payload: { x: 1 } }, thread));
    expect(out!.kind).toBe("approval");
    expect(out!.action).toBe("approve");
    expect(out!.payload).toEqual({ x: 1 });
  });

  it("preserves a caller-supplied resume_token verbatim", () => {
    const out = parse(
      toHitlNdjson(
        { kind: "approval", action: "ok", resume_token: "thread:42#cp-7" },
        thread,
      ),
    );
    expect(out!.resume_token).toBe("thread:42#cp-7");
  });
});
