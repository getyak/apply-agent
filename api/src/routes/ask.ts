// Ask Vantage proxy — TS gateway between the web dock and the Python
// LangGraph host (agents/api/server.py /ask/stream).
//
// Translation contract:
//   FastAPI side sends classic SSE: "data: {event, …}\n\n" frames with
//   event ∈ { thinking, intent, result, error, done }.
//   The web dock (web/src/lib/ask-stream.ts) consumes line-delimited
//   JSON (application/x-ndjson) with kind ∈ { text, agent_start,
//   agent_done, agent_failed, result, done, error }.
//
// We do the protocol bridge here so neither side has to change. The
// dock sees one consistent shape regardless of how many agent layers
// sit behind it. The FastAPI side is free to evolve its event names
// without breaking the web client.

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { config } from "../config";
import { query } from "../db";
import { authMiddleware } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import type { AppEnv } from "../types";

// Surfaces map 1:1 to the document-scoped conversation channels described
// in vantage-ui-mapping.md §2.6. The dock is the cross-surface lifetime
// thread; resume_studio is the per-résumé vibe chat. Anything else falls
// through to the dock channel server-side.
const SURFACES = ["dock", "resume_studio", "mock_studio", "applications"] as const;

const AskBody = z.object({
  prompt: z.string().min(1).max(8_000),
  thread_id: z.string().min(1).max(200),
  surface: z.enum(SURFACES).optional(),
});

const AGENT_HUMAN_LABEL: Record<string, string> = {
  resume_agent: "RÉSUMÉ AGENT",
  jobmatch_agent: "SCOUT AGENT",
  interview_agent: "INTERVIEW AGENT",
  appprep_agent: "APPLICATION AGENT",
  trend_agent: "TREND AGENT",
  coordinator: "COORDINATOR",
};

const routes = new Hono<AppEnv>();

// Lifetime ask_vantage session id resolver. Per docs/architecture/
// vantage-ui-mapping.md §1.2, every user has exactly one ask_vantage
// session — enforced by idx_sessions_ask_vantage_per_user (migration
// 012). We INSERT with ON CONFLICT DO NOTHING and follow up with a SELECT
// so the resolver works whether or not the session already exists. The
// thread_id the dock keeps in localStorage (`ask_vantage:{userId}`)
// drives LangGraph's checkpointer; the conversation_sessions row drives
// our own history rail (the dock's RECENT list).
async function ensureAskVantageSession(userId: string): Promise<string> {
  const insert = await query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (user_id, session_type, agent_type, title, status)
     VALUES ($1, 'ask_vantage', 'coordinator', 'Ask Vantage', 'active')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId],
  );
  if (insert.rows.length > 0) return insert.rows[0].id;
  // Conflict path: row already existed — fetch it.
  const sel = await query<{ id: string }>(
    `SELECT id FROM conversation_sessions
      WHERE user_id = $1 AND session_type = 'ask_vantage'
      LIMIT 1`,
    [userId],
  );
  if (sel.rows.length === 0) {
    // Should be unreachable: the unique partial index guarantees the
    // INSERT only conflicts when the row exists. Defensive throw so we
    // surface schema drift rather than silently dropping history.
    throw new Error("ensureAskVantageSession: row vanished after conflict");
  }
  return sel.rows[0].id;
}

// Strip a stored anchor to ~80 chars without slicing a multi-byte char in
// half. Used for both the user-prompt preview and the assistant content
// rail. The DB still has the full text — we only truncate at read time.
function previewText(s: string, max = 80): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  // Iterate codepoint-by-codepoint via the iterator so we don't cut a
  // surrogate pair (emoji, some CJK runs).
  let out = "";
  for (const ch of trimmed) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out + "…";
}

// PT3 (round-10): the round-10 audit pointed out that this gateway
// stored the assistant buffer into conversation_messages.content with
// no truncation, while the Python persister capped each row at 8000
// chars. Mirror the same cap here so a 50KB+ tailored-résumé reply
// doesn't bloat the conversation_messages row past what the dock
// will ever render. The trailing marker matches the Python helper so
// readers (audit, support, the rail preview) can tell truncation apart
// from "the user actually typed an ellipsis".
const PERSIST_TURN_MAX_CHARS = 8000;
const PERSIST_TRUNC_MARKER = "…(truncated)";
function truncateForHistory(text: string): string {
  if (!text) return "";
  // Same codepoint-safe iteration pattern as previewText so an emoji
  // sitting on the boundary doesn't split into half a surrogate pair.
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > PERSIST_TURN_MAX_CHARS - PERSIST_TRUNC_MARKER.length) {
      return out + PERSIST_TRUNC_MARKER;
    }
    out += ch;
  }
  return out;
}

routes.use("/stream", authMiddleware);
routes.post("/stream", validateBody(AskBody), async (c) => {
  const { prompt, thread_id, surface } = c.get("validatedBody") as z.infer<
    typeof AskBody
  >;
  const userId = c.get("userId") as string;
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/ask/stream`;

  // History persistence — kept best-effort. If the conversation_messages
  // INSERTs fail we still want the dock to get its stream; the chat
  // remains usable, we just lose the RECENT anchor for that turn. Log so
  // we notice in dev / staging.
  //
  // We only persist for the lifetime ask_vantage thread (the default
  // surface). resume_studio / mock_studio / applications surfaces are
  // per-document scopes that don't share the dock's RECENT rail, so
  // routing their messages here would pollute the rail with content the
  // user can't navigate to from the dock.
  const persistHistory = !surface || surface === "dock";
  let askSessionId: string | null = null;
  let userMessageId: string | null = null;
  if (persistHistory) {
    try {
      askSessionId = await ensureAskVantageSession(userId);
      const ins = await query<{ id: string }>(
        `INSERT INTO conversation_messages
           (session_id, role, content)
         VALUES ($1, 'user', $2)
         RETURNING id`,
        [askSessionId, truncateForHistory(prompt)],
      );
      userMessageId = ins.rows[0].id;
    } catch (err) {
      console.warn("[ask] history persist (user) failed:", err);
      askSessionId = null;
      userMessageId = null;
    }
  }

  // OBS1 (round-12): the round-12 observability audit found that the
  // gateway's request_id was generated and echoed to the browser, but
  // not forwarded to the Python agent host — so any agent_tasks /
  // structlog line emitted downstream had no breadcrumb back to the
  // originating request. requestId middleware (api/src/middleware/
  // observability.ts) sets c.var.requestId on every request; passing
  // it through here lets server.py rebind structlog context and write
  // it into audit rows.
  const requestId = c.get("requestId");
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Trust boundary: the gateway already verified the JWT in
        // requireAuth. We pass user_id through as a header that
        // agents/api/server.py reads as its UserDep so the FastAPI
        // side doesn't re-verify (and doesn't need the JWT secret).
        "X-Relay-User-Id": userId,
        "X-Relay-Thread-Id": thread_id,
        // surface identifies which UI panel is asking — dock vs the
        // per-document vibe chats (resume_studio etc.). Server-side it
        // changes thread-scoping and lets the router decide what context
        // to load. Default to "dock" upstream if absent, so older clients
        // keep working unchanged.
        ...(surface ? { "X-Relay-Surface": surface } : {}),
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      body: JSON.stringify({ message: prompt }),
    });
  } catch (err) {
    // Most common cause in dev/CI: the Python LangGraph host isn't
    // running. The dock catches `code` and renders the `hint` verbatim
    // instead of "Upstream error", so the user knows it's a setup
    // issue, not a product bug.
    return c.json(
      {
        error: "agent_unreachable",
        code: "AGENT_UNREACHABLE",
        hint: "Vantage's reasoning engine is offline. Try again in a moment — if this persists, check that the agents host is running.",
        detail: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.warn(
      "[ask] upstream not ok:",
      { target, status: upstream.status, hasBody: !!upstream.body, detail: detail.slice(0, 200) },
    );
    return c.json(
      {
        error: "agent_failed",
        code: "AGENT_FAILED",
        hint: "Vantage's reasoning engine returned an error. We're looking into it.",
        status: upstream.status,
        detail,
      },
      502,
    );
  }

  return stream(c, async (out) => {
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seenAgents = new Set<string>();
    // Accumulate everything we emit as { kind: "text" } so we can persist
    // the final assistant turn once the stream settles. Mirrors what the
    // dock concatenates into m.text on the client.
    let assistantBuf = "";
    // Synthesised task_graph (P2.1). Emitted once, on the first `intent`
    // frame, based on a static plan template. When the Python coordinator
    // grows a real planner it will start emitting `event: "task_graph"`
    // itself; we'll let those override the synthesis (TODO once the
    // upstream event lands).
    let graphEmitted = false;
    // Inline-detail upgrade: tool_start arrives as an SSE `thinking` frame
    // carrying { tool, args }; tool_end arrives as a `tool_trace` frame
    // carrying { tool, result }. We stash the args from the start frame
    // here keyed by tool name so the matching trace frame can pick them up
    // and emit a single NDJSON tool_trace with BOTH input + output. If a
    // tool runs twice in a turn the second start overwrites the first
    // (LangGraph never interleaves the same tool name within one
    // create_react_agent step, so this is safe in practice).
    const pendingToolArgs = new Map<string, unknown>();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines ("\n\n").
        let split = buf.indexOf("\n\n");
        while (split >= 0) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          split = buf.indexOf("\n\n");
          const payload = parseSseFrame(frame);
          if (!payload) continue;
          // Real plan from the Python dock_agent (P0-B): it emits
          // `event: "task_graph"` carrying a plan dict shaped just like
          // PlanForIntent's output. When we see it, we forward it
          // verbatim and disable the synthesis fallback below — the
          // synthesised plan would otherwise overwrite the real one on
          // the next `intent` frame.
          if (payload.event === "task_graph") {
            const graph = payload.graph as SynthGraph | undefined;
            if (graph && Array.isArray(graph.plan)) {
              graphEmitted = true;
              await out.write(
                JSON.stringify({
                  kind: "task_graph",
                  graph: {
                    task_id:
                      typeof graph.task_id === "string"
                        ? graph.task_id
                        : `dock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    user_goal:
                      typeof graph.user_goal === "string"
                        ? previewText(graph.user_goal, 100)
                        : previewText(prompt, 100),
                    plan: graph.plan,
                  },
                }) + "\n",
              );
              continue;
            }
          }
          // Forward the dock_agent's streaming text deltas as `text`
          // NDJSON frames so existing clients (which already render
          // `text`) get them for free without us having to ship a new
          // frame kind. The legacy `intent` → "Routing to X" line still
          // fires below when the legacy path is on; in the dock-agent
          // path the intent event is absent, so the assistant prose is
          // the only `text` the dock sees.
          if (payload.event === "delta") {
            const text =
              typeof payload.text === "string" ? (payload.text as string) : "";
            if (text) {
              await out.write(JSON.stringify({ kind: "text", delta: text }) + "\n");
              assistantBuf += text;
            }
            continue;
          }
          // Reasoning lane. dock_agent emits `event: "reasoning"` when the
          // upstream provider (DeepSeek V4 Pro / GLM-4.7 via OpenRouter's
          // extended-thinking passthrough) returns a chain-of-thought
          // delta. The dock paints these inside the "Thinking" body so the
          // user can watch the model's reasoning stream live. We don't
          // append to assistantBuf — reasoning is *not* the user-visible
          // turn message; only `text` deltas belong to the history record.
          if (payload.event === "reasoning") {
            const text =
              typeof payload.text === "string" ? (payload.text as string) : "";
            if (text) {
              await out.write(
                JSON.stringify({ kind: "reasoning_delta", text }) + "\n",
              );
            }
            continue;
          }
          // Step 1 — Narrator chip. dock_agent emits `event: "narrator"`
          // when the LLM calls the `narrate(thought)` tool right before an
          // execution tool. We forward it as a `narrator` NDJSON frame.
          // Clients that don't know about the kind drop it silently; the
          // dock UI renders it as an italic "thought-aloud" line.
          if (payload.event === "narrator") {
            const line = narratorNdjson(payload.text);
            if (line) await out.write(line + "\n");
            continue;
          }
          // Step 3 — Tool console line. Emitted alongside the existing
          // result event for every visible execution tool. The dock
          // renders it as a one-line collapsible "console" row.
          if (payload.event === "tool_trace") {
            // Hydrate args from the matching prior `thinking` frame (if
            // any). Consumed once so a re-emitted trace doesn't claim
            // stale args. The result field already rides on the trace
            // frame itself — toolTraceNdjson forwards it verbatim.
            const toolName =
              typeof payload.tool === "string"
                ? (payload.tool as string)
                : "";
            if (
              toolName &&
              payload.args === undefined &&
              pendingToolArgs.has(toolName)
            ) {
              payload.args = pendingToolArgs.get(toolName);
              pendingToolArgs.delete(toolName);
            }
            const line = toolTraceNdjson(payload);
            if (line) await out.write(line + "\n");
            continue;
          }
          // Step 5 — Partial artifact preview. In-flight snapshots that
          // the dock merges into a single live card by artifact_id.
          if (payload.event === "partial_artifact") {
            const line = partialArtifactNdjson(payload);
            if (line) await out.write(line + "\n");
            continue;
          }
          // HITL surface (P1-C): dock_agent emits `event: "hitl"` with
          // the LangGraph interrupt value. We forward it as an
          // ask_user/diff/approval NDJSON frame depending on the
          // interrupt payload shape. The dock UI work to render these
          // lives in a separate PR; we ship the protocol now so the
          // wire format is stable.
          if (payload.event === "hitl") {
            const hitlLine = toHitlNdjson(payload.value, thread_id);
            if (hitlLine) {
              await out.write(hitlLine + "\n");
            }
            continue;
          }
          // First `intent` frame is our cue to synthesise the plan
          // (legacy path only — when graphEmitted is already true,
          // we got the real plan above and skip synthesis).
          if (!graphEmitted && payload.event === "intent") {
            const intent = (payload.intent as string) || "";
            const graph = planForIntent(intent, prompt);
            if (graph) {
              graphEmitted = true;
              await out.write(JSON.stringify({ kind: "task_graph", graph }) + "\n");
            }
          }
          // Inline-detail upgrade: when the upstream emits a `thinking`
          // frame for a tool_start it stamps `tool` + `args` on the
          // envelope (see api/server.py::_dock_event_to_sse). We stash
          // them so the upcoming matching tool_trace frame can carry
          // BOTH input + output. The frame itself still goes through
          // toNdjson below — args are silently ignored there because the
          // legacy agent_start record has no field for them.
          if (payload.event === "thinking") {
            const toolName =
              typeof payload.tool === "string"
                ? (payload.tool as string)
                : "";
            if (toolName && payload.args !== undefined) {
              pendingToolArgs.set(toolName, payload.args);
            }
          }
          for (const line of toNdjson(payload, seenAgents)) {
            // Peek the frame so we can build a faithful assistant text
            // record for history without re-parsing later. We accumulate
            // before writing — order doesn't matter since both branches
            // run synchronously per frame.
            try {
              const parsed = JSON.parse(line) as { kind?: string; delta?: string };
              if (parsed.kind === "text" && typeof parsed.delta === "string") {
                assistantBuf += parsed.delta;
              }
            } catch {
              /* line is always valid JSON from toNdjson — guard is defensive */
            }
            await out.write(line + "\n");
          }
        }
      }
    } catch (err) {
      await out.write(
        JSON.stringify({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    } finally {
      try {
        reader.cancel();
      } catch {
        // Already cancelled if the upstream finished.
      }

      // Persist the assistant half + roll up session counters. Best-effort
      // again — if it fails we already streamed to the user; the only
      // visible degradation is "this turn won't appear in RECENT" which
      // is recoverable on the next message.
      if (askSessionId && assistantBuf.trim().length > 0) {
        try {
          await query(
            `INSERT INTO conversation_messages
               (session_id, role, content, metadata)
             VALUES ($1, 'assistant', $2, $3)`,
            [
              askSessionId,
              truncateForHistory(assistantBuf),
              JSON.stringify({ agent: "coordinator", surface: surface ?? "dock" }),
            ],
          );
          await query(
            `UPDATE conversation_sessions
               SET last_active_at = NOW(),
                   message_count = message_count + 2
             WHERE id = $1`,
            [askSessionId],
          );
        } catch (err) {
          console.warn("[ask] history persist (assistant) failed:", err);
        }
      } else if (askSessionId && userMessageId) {
        // We at least logged the user prompt; still bump message_count
        // for the lone user row so the rail count stays honest. This
        // covers cases where the stream errored before any assistant
        // text accumulated.
        try {
          await query(
            `UPDATE conversation_sessions
               SET last_active_at = NOW(),
                   message_count = message_count + 1
             WHERE id = $1`,
            [askSessionId],
          );
        } catch (err) {
          console.warn("[ask] history persist (count bump) failed:", err);
        }
      }
    }
  });
});

// GET /api/ask/recent — list the user's most recent prompts from the
// lifetime ask_vantage thread, newest first. Used by the dock's RECENT
// rail (vantage-ui-mapping.md §1.2 anchors-only model). We deliberately
// only return user rows; the rail jumps to "where the user last asked
// X", not "where Vantage said Y". `limit` is capped server-side so a
// crafted client can't pull the entire history.
routes.use("/recent", authMiddleware);
routes.get("/recent", async (c) => {
  const userId = c.get("userId") as string;
  const limitRaw = c.req.query("limit");
  const limit = Math.max(
    1,
    Math.min(50, limitRaw ? Number.parseInt(limitRaw, 10) || 10 : 10),
  );

  // Single query joining session → messages; gives us "" rows if the
  // user has no session yet (LEFT JOIN). Cheap because the unique partial
  // index keeps at most one ask_vantage session per user.
  const result = await query<{
    id: string;
    content: string;
    created_at: string;
  }>(
    `SELECT m.id, m.content, m.created_at
       FROM conversation_sessions s
       JOIN conversation_messages m
         ON m.session_id = s.id
      WHERE s.user_id = $1
        AND s.session_type = 'ask_vantage'
        AND m.role = 'user'
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );

  return c.json({
    items: result.rows.map((r) => ({
      id: r.id,
      preview: previewText(r.content),
      createdAt: r.created_at,
    })),
  });
});

function parseSseFrame(frame: string): Record<string, unknown> | null {
  // Each SSE frame is a sequence of `field: value` lines; we only care
  // about `data:`. Multiple `data:` lines concatenate with newlines.
  const lines = frame.split("\n");
  const data = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Map the FastAPI event vocabulary onto the dock's NDJSON contract.
// Returns 0..N lines per upstream frame.
function toNdjson(
  payload: Record<string, unknown>,
  seenAgents: Set<string>,
): string[] {
  const event = payload.event as string | undefined;
  if (!event) return [];

  if (event === "thinking") {
    const agent = (payload.agent as string) || "coordinator";
    if (seenAgents.has(agent)) return [];
    seenAgents.add(agent);
    // Step 4 — pass plan_step (when the Python translator stamped one) so
    // the dock can tie this agent row to the corresponding plan row.
    const planStep =
      typeof payload.plan_step === "string" ? (payload.plan_step as string) : "";
    return [
      JSON.stringify({
        kind: "agent_start",
        agent,
        label: `${AGENT_HUMAN_LABEL[agent] ?? agent.toUpperCase()} · thinking`,
        ...(planStep ? { plan_step: planStep } : {}),
      }),
    ];
  }

  if (event === "intent") {
    const intent = (payload.intent as string) || "";
    const text = `Routing to ${intent.replace(/_/g, " ")} (via ${payload.via}).`;
    return [JSON.stringify({ kind: "text", delta: text + "\n\n" })];
  }

  if (event === "result") {
    const agent = (payload.agent as string) || "coordinator";
    const out: string[] = [];
    const planStep =
      typeof payload.plan_step === "string" ? (payload.plan_step as string) : "";
    if (seenAgents.has(agent)) {
      out.push(
        JSON.stringify({
          kind: "agent_done",
          agent,
          statusText: "done",
          ...(planStep ? { plan_step: planStep } : {}),
        }),
      );
    }
    // Smalltalk replies arrive as { agent: 'coordinator', action: 'reply', text }
    if (typeof payload.text === "string" && payload.text) {
      out.push(JSON.stringify({ kind: "text", delta: payload.text }));
    }
    const action = payload.action as string | undefined;
    if (action && action !== "reply") {
      const route = routeFor(agent, action);
      const artifact = buildArtifact(agent, action, payload, route ?? undefined);
      if (artifact) {
        out.push(JSON.stringify({ kind: "artifact", artifact }));
      } else {
        // Fallback to the legacy result frame when we don't yet have an
        // artifact template for this (agent, action) — keeps strange or
        // not-yet-categorised actions visible instead of silently
        // dropping them.
        out.push(
          JSON.stringify({
            kind: "result",
            title: humanizeAction(agent, action),
            sub: describeAction(payload),
            action: ctaFor(agent, action),
            ...(route ? { route } : {}),
          }),
        );
      }
    }
    return out;
  }

  if (event === "error") {
    // SSE4 (round-9): forward the Python global exception envelope
    // (round-5 API1/API2) fields through to the frontend so the dock
    // can branch on `code` rather than regexing the user-facing
    // `message`. trace_id is the support correlation id we want to
    // surface in error UI without having to ask the user.
    return [
      JSON.stringify({
        kind: "error",
        message: (payload.message as string) || "Upstream error",
        ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        ...(typeof payload.trace_id === "string"
          ? { trace_id: payload.trace_id }
          : {}),
      }),
    ];
  }

  if (event === "done") {
    return [JSON.stringify({ kind: "done" })];
  }

  return [];
}

function humanizeAction(agent: string, action: string): string {
  if (agent === "resume_agent" && action === "customize") return "Tailored résumé ready";
  if (agent === "resume_agent" && action === "update_field") return "Résumé update queued";
  if (agent === "interview_agent" && action === "build_mock_graph") return "Mock session ready";
  if (agent === "trend_agent" && action === "daily_snapshot") return "Today's market snapshot";
  if (agent === "jobmatch_agent" && action === "find_matches") return "Matching roles found";
  if (agent === "appprep_agent" && action === "draft_cover_letter") return "Cover letter drafted";
  return `${agent.replace(/_/g, " ")} → ${action}`;
}

function describeAction(payload: Record<string, unknown>): string {
  const status = payload.status as string | undefined;
  if (status === "not_implemented_yet") return "Coming soon — wired up but not generating yet.";
  if (status === "needs_clarification") return "Tell me which field to update.";
  return "Open it to keep going.";
}

function ctaFor(agent: string, action: string): string {
  if (agent === "resume_agent") return "Open résumé";
  if (agent === "interview_agent") return "Open mock";
  if (agent === "trend_agent") return "View trends";
  if (agent === "jobmatch_agent") return "See matches";
  if (agent === "appprep_agent") return "Open prep";
  void action;
  return "Open";
}

function routeFor(agent: string, action: string): string | null {
  if (agent === "resume_agent") return "/app/studio/resume";
  if (agent === "interview_agent" && action === "build_mock_graph")
    return "/app/studio/mock";
  if (agent === "trend_agent") return "/app/today";
  if (agent === "jobmatch_agent") return "/app/applications";
  if (agent === "appprep_agent") return "/app/applications";
  return null;
}

// ─── Artifact envelope (P2.2) ──────────────────────────────────────────
//
// One shape for every agent output. Per audit §4.2 — the front-end
// renders a single ArtifactCard for all artifact_types; the agent
// declares confidence, evidence, HITL gate and primary actions inline.
// We synthesise from the existing upstream `result` payload so the
// Python agents don't need to ship a new contract first.

interface ArtifactSource {
  label: string;
  route?: string;
}
interface ArtifactAction {
  kind: "approve" | "tweak" | "discard" | "open";
  label: string;
  route?: string;
}
interface ArtifactOut {
  artifact_type:
    | "resume_version"
    | "job_match_set"
    | "application_package"
    | "interview_session"
    | "cover_letter"
    | "market_snapshot";
  id: string;
  title: string;
  sub: string;
  confidence?: number;
  needs_user_review?: boolean;
  source_evidence?: ArtifactSource[];
  next_actions?: ArtifactAction[];
}

export function buildArtifact(
  agent: string,
  action: string,
  payload: Record<string, unknown>,
  route: string | undefined,
): ArtifactOut | null {
  const id =
    (payload.artifact_id as string) ??
    `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = humanizeAction(agent, action);
  const sub = describeAction(payload);
  const confidence =
    typeof payload.confidence === "number" ? (payload.confidence as number) : undefined;
  // Evidence may come back from the agent (preferred) or get synthesised
  // when not present — keep at least a "View source" anchor on every
  // artifact so the audit's "可解释" goal isn't lost on day one.
  const evidenceFromPayload = Array.isArray(payload.source_evidence)
    ? (payload.source_evidence as Array<{ label?: string; route?: string }>)
        .filter((e): e is { label: string; route?: string } => typeof e?.label === "string")
        .map((e) => ({ label: e.label, route: e.route }))
    : undefined;

  // Per-action template. Add new ones as agents start emitting them.
  if (agent === "resume_agent" && action === "customize") {
    return {
      artifact_type: "resume_version",
      id,
      title,
      sub,
      confidence,
      needs_user_review: true,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "Open résumé", route: route ?? "/app/studio/resume" },
        { kind: "tweak", label: "Tweak in studio", route: "/app/studio/resume" },
      ],
    };
  }
  // update_field deliberately omits ``route`` so the dock card
  // acknowledges the intent in place — no "Open résumé / Tweak in
  // studio" jump (user feedback 2026-06-22: jumping out of the dock for
  // a clarification is noise). The card still renders so the user can
  // see the agent picked up the ask; field collection happens inline in
  // the next turn.
  if (agent === "resume_agent" && action === "update_field") {
    return {
      artifact_type: "resume_version",
      id,
      title,
      sub,
      confidence,
      needs_user_review: true,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "Open résumé" },
        { kind: "tweak", label: "Tweak in studio" },
      ],
    };
  }
  if (agent === "appprep_agent" && action === "draft_cover_letter") {
    return {
      artifact_type: "cover_letter",
      id,
      title,
      sub,
      confidence,
      needs_user_review: true,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "Open draft", route: route ?? "/app/applications" },
        { kind: "discard", label: "Discard", route: undefined },
      ],
    };
  }
  if (agent === "appprep_agent") {
    return {
      artifact_type: "application_package",
      id,
      title,
      sub,
      confidence,
      needs_user_review: true,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "Open prep", route: route ?? "/app/applications" },
      ],
    };
  }
  if (agent === "jobmatch_agent") {
    return {
      artifact_type: "job_match_set",
      id,
      title,
      sub,
      confidence,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "See matches", route: route ?? "/app/applications" },
      ],
    };
  }
  if (agent === "interview_agent") {
    return {
      artifact_type: "interview_session",
      id,
      title,
      sub,
      confidence,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "Open mock", route: route ?? "/app/studio/mock" },
      ],
    };
  }
  if (agent === "trend_agent") {
    return {
      artifact_type: "market_snapshot",
      id,
      title,
      sub,
      confidence,
      source_evidence: evidenceFromPayload,
      next_actions: [
        { kind: "open", label: "View trends", route: route ?? "/app/today" },
      ],
    };
  }
  return null;
}

// ─── Task graph plan templates (P2.1) ─────────────────────────────────
//
// The synthesised plan we emit before the agents start running. Keeps
// the UI honest about what's about to happen even though the Python
// coordinator currently routes to a single agent per turn. Each
// template lists the agent steps in declared order; when the real
// planner ships, the upstream `event: "task_graph"` will replace this.

interface PlannedStep {
  step: string;
  agent: string;
  label: string;
  requires_review?: boolean;
}
interface SynthGraph {
  task_id: string;
  user_goal: string;
  plan: PlannedStep[];
}

// Stable plan templates per known intent. When intent is missing or
// unknown we return null and the dock will fall back to the bare
// agent_start rows — no false plan.
const PLAN_TEMPLATES: Record<string, PlannedStep[]> = {
  tailor_resume: [
    {
      step: "fetch_jd",
      agent: "jobmatch_agent",
      label: "Pull the job description and key requirements.",
    },
    {
      step: "customize_resume",
      agent: "resume_agent",
      label: "Tailor a new résumé version against the JD.",
      requires_review: true,
    },
  ],
  customize_resume: [
    {
      step: "customize_resume",
      agent: "resume_agent",
      label: "Tailor your résumé to the target role.",
      requires_review: true,
    },
  ],
  find_matches: [
    {
      step: "find_matches",
      agent: "jobmatch_agent",
      label: "Surface roles that fit your profile right now.",
    },
  ],
  daily_snapshot: [
    {
      step: "daily_snapshot",
      agent: "trend_agent",
      label: "Pull today's market snapshot for your stack.",
    },
  ],
  draft_cover_letter: [
    {
      step: "draft_cover_letter",
      agent: "appprep_agent",
      label: "Draft a cover letter grounded in your résumé.",
      requires_review: true,
    },
  ],
  build_mock_graph: [
    {
      step: "intel",
      agent: "interview_agent",
      label: "Load the company / role interview intel.",
    },
    {
      step: "mock_session",
      agent: "interview_agent",
      label: "Generate the mock session you can step through.",
      requires_review: true,
    },
  ],
  update_field: [
    {
      step: "update_field",
      agent: "resume_agent",
      label: "Apply the requested résumé edit.",
      requires_review: true,
    },
  ],
};

function planForIntent(intent: string, prompt: string): SynthGraph | null {
  const plan = PLAN_TEMPLATES[intent];
  if (!plan) return null;
  return {
    task_id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // Truncate the user prompt so the dock header doesn't get a wall of
    // text when someone pastes a JD. previewText is the same helper the
    // /recent rail uses, keeping copy consistent across the two surfaces.
    user_goal: previewText(prompt, 100),
    plan,
  };
}

// ─── HITL frame coercion (P1-C) ───────────────────────────────────────
//
// The Python dock_agent emits `event: "hitl"` with the value LangGraph's
// `interrupt()` was called with. We translate it to one of three NDJSON
// frame kinds the dock UI knows how to render. Shape detection is
// generous on purpose — agents are expected to evolve the payload, and
// we don't want to drop frames the dock could still display as a
// fallback approval card.
//
// Wire shapes the agents emit today:
//   { kind: "ask_user", question, chips?, free_form?, resume_token? }
//   { kind: "diff",     before, after, resume_token? }
//   { kind: "approval", action, payload, resume_token? }
//
// resume_token is auto-filled from the thread_id when the agent omitted
// it (the round-trip into POST /api/ask/resume still works since
// /ask/resume parses "{thread_id}#…" tokens).

// Step 1 — Narrator chip coercion.
//
// dock_agent emits the model's pre-tool thought via `event: "narrator"`.
// We wrap it in an NDJSON `narrator` frame the dock UI renders as a small
// italic chip. Whitespace-only and oversized inputs are filtered/clamped
// here so the gateway is the single source of truth for the chip rules —
// the Python tool also caps at 160 chars but cross-protocol drift is the
// kind of thing we want to test on this side too.
//
// Returns null for non-strings and empty payloads (the route caller
// should not write a frame in that case).
export function narratorNdjson(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const capped = trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed;
  return JSON.stringify({ kind: "narrator", text: capped });
}

// Step 3 — Tool console line coercion.
//
// dock_agent emits a `tool_trace` SSE event alongside the existing
// result/error event whenever a non-system execution tool finishes. The
// dock renders it as one collapsible row. We translate the upstream SSE
// payload into a stable NDJSON shape:
//
//   { kind: "tool_trace", tool, agent, action, status, summary }
//
// Returns null if the payload is missing the minimal fields needed to
// render a row (so the gateway never writes a half-formed frame).
// Step 5 — Partial artifact stream coercion.
//
// Long-running tools emit incremental snapshots via the dock_agent's
// adispatch_custom_event("partial_artifact", ...) helper. The Python SSE
// translator forwards them as `event: partial_artifact`. We coerce into
// an NDJSON frame the dock UI merges by `artifact_id`.
//
// Returns null when artifact_id is missing — the dock requires it as the
// merge key, so a half-formed snapshot is unusable.
export function partialArtifactNdjson(
  payload: Record<string, unknown>,
): string | null {
  const id =
    typeof payload.artifact_id === "string"
      ? (payload.artifact_id as string)
      : "";
  if (!id) return null;
  const kind =
    typeof payload.kind === "string" ? (payload.kind as string) : "snapshot";
  const out: Record<string, unknown> = {
    kind: "partial_artifact",
    artifact_id: id,
    artifact_kind: kind,
  };
  if (typeof payload.title === "string") out.title = payload.title;
  if (typeof payload.sub === "string") out.sub = payload.sub;
  if (typeof payload.progress === "number") {
    // Clamp to [0,1] defensively in case the agent sends a percentage.
    const p = payload.progress as number;
    out.progress = p > 1 ? Math.min(p / 100, 1) : Math.max(0, p);
  }
  if (payload.payload !== undefined) out.payload = payload.payload;
  return JSON.stringify(out);
}

export function toolTraceNdjson(payload: Record<string, unknown>): string | null {
  const tool = typeof payload.tool === "string" ? (payload.tool as string) : "";
  if (!tool) return null;
  const agent = typeof payload.agent === "string" ? (payload.agent as string) : "coordinator";
  const action = typeof payload.action === "string" ? (payload.action as string) : "";
  const rawStatus = typeof payload.status === "string" ? (payload.status as string) : "ok";
  const status: "ok" | "error" = rawStatus === "error" ? "error" : "ok";
  const summary =
    typeof payload.summary === "string" ? (payload.summary as string).slice(0, 160) : "";
  // Step 4 — pass the plan_step id through verbatim so the dock can
  // highlight the matching row in the task graph card. Only forward
  // strings; anything else is silently dropped.
  const planStep =
    typeof payload.plan_step === "string" ? (payload.plan_step as string) : "";
  // Inline-detail upgrade: forward args + result so the dock's ToolTraceRow
  // can render Input / Output blocks. Both are optional — dock_agent strips
  // huge results to 8 KiB before they ever reach us, and the gateway
  // doesn't try to validate the shape (any JSON value is fine — JsonBlock
  // on the client pretty-prints with defensive truncation).
  const args = payload.args;
  const result = payload.result;
  return JSON.stringify({
    kind: "tool_trace",
    tool,
    agent,
    action,
    status,
    summary,
    ...(planStep ? { plan_step: planStep } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(result !== undefined ? { result } : {}),
  });
}

export function toHitlNdjson(value: unknown, threadId: string): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const kindHint = typeof v.kind === "string" ? (v.kind as string).toLowerCase() : "";
  const resumeToken =
    typeof v.resume_token === "string"
      ? (v.resume_token as string)
      : `${threadId}#hitl-${Date.now()}`;

  if (kindHint === "ask_user" || typeof v.question === "string") {
    const chips = Array.isArray(v.chips)
      ? (v.chips as unknown[])
          .filter((c): c is string => typeof c === "string")
          .slice(0, 8)
      : undefined;
    return JSON.stringify({
      kind: "ask_user",
      question:
        typeof v.question === "string" ? (v.question as string) : "Vantage needs your input",
      chips,
      free_form: v.free_form !== false,
      resume_token: resumeToken,
    });
  }

  if (kindHint === "diff" || ("before" in v && "after" in v)) {
    return JSON.stringify({
      kind: "diff",
      before: v.before ?? null,
      after: v.after ?? null,
      resume_token: resumeToken,
    });
  }

  // Default: approval card with whatever metadata the agent supplied.
  return JSON.stringify({
    kind: "approval",
    action: typeof v.action === "string" ? (v.action as string) : "approve",
    payload: v.payload ?? v,
    resume_token: resumeToken,
  });
}

// ─── POST /api/ask/resume — HITL decision (P1-C) ──────────────────────
//
// Companion to /api/ask/stream's hitl frames. The dock collects the user
// decision and POSTs it here; we forward to the Python agent host's
// /ask/resume which uses LangGraph's Command(resume=...). We stream the
// SSE response back as NDJSON using the same toNdjson map.

const AskResumeBody = z.object({
  resume_token: z.string().min(1).max(256),
  value: z.union([
    z.string().min(1).max(10_000),
    z.array(z.string().min(1).max(2_000)).max(50),
    z.record(z.string(), z.unknown()),
  ]),
});

routes.use("/resume", authMiddleware);
routes.post("/resume", validateBody(AskResumeBody), async (c) => {
  const { resume_token, value } = c.get("validatedBody") as z.infer<
    typeof AskResumeBody
  >;
  const userId = c.get("userId") as string;
  const requestId = c.get("requestId");
  const target = `${config.AGENT_BASE_URL.replace(/\/$/, "")}/ask/resume`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-User-Id": userId,
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      body: JSON.stringify({ resume_token, value }),
    });
  } catch (err) {
    return c.json(
      {
        error: "agent_unreachable",
        code: "AGENT_UNREACHABLE",
        hint: "Vantage's reasoning engine is offline. Try again in a moment.",
        detail: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return c.json(
      {
        error: "agent_failed",
        code: "AGENT_FAILED",
        hint: "Vantage's reasoning engine returned an error.",
        status: upstream.status,
        detail,
      },
      upstream.status === 403 ? 403 : 502,
    );
  }

  return stream(c, async (out) => {
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seenAgents = new Set<string>();
    const threadId = resume_token.split("#", 1)[0];
    // Mirror of /ask/stream's pendingToolArgs: capture args from the
    // upstream `thinking` frame so the matching `tool_trace` can fold
    // them into the same NDJSON line.
    const pendingToolArgs = new Map<string, unknown>();

    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(chunk, { stream: true });
        let split = buf.indexOf("\n\n");
        while (split >= 0) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          split = buf.indexOf("\n\n");
          const payload = parseSseFrame(frame);
          if (!payload) continue;
          if (payload.event === "delta") {
            const text =
              typeof payload.text === "string" ? (payload.text as string) : "";
            if (text) {
              await out.write(JSON.stringify({ kind: "text", delta: text }) + "\n");
            }
            continue;
          }
          // Reasoning lane (resume path mirrors /ask/stream).
          if (payload.event === "reasoning") {
            const text =
              typeof payload.text === "string" ? (payload.text as string) : "";
            if (text) {
              await out.write(
                JSON.stringify({ kind: "reasoning_delta", text }) + "\n",
              );
            }
            continue;
          }
          // Step 1 — Narrator chip (resume path mirrors /ask/stream).
          if (payload.event === "narrator") {
            const line = narratorNdjson(payload.text);
            if (line) await out.write(line + "\n");
            continue;
          }
          // Step 3 — Tool console (resume path mirrors /ask/stream).
          if (payload.event === "tool_trace") {
            const toolName =
              typeof payload.tool === "string"
                ? (payload.tool as string)
                : "";
            if (
              toolName &&
              payload.args === undefined &&
              pendingToolArgs.has(toolName)
            ) {
              payload.args = pendingToolArgs.get(toolName);
              pendingToolArgs.delete(toolName);
            }
            const line = toolTraceNdjson(payload);
            if (line) await out.write(line + "\n");
            continue;
          }
          // Step 5 — Partial artifact (resume path mirrors /ask/stream).
          if (payload.event === "partial_artifact") {
            const line = partialArtifactNdjson(payload);
            if (line) await out.write(line + "\n");
            continue;
          }
          if (payload.event === "hitl") {
            const line = toHitlNdjson(payload.value, threadId);
            if (line) await out.write(line + "\n");
            continue;
          }
          // Stash tool args from `thinking` frames so tool_trace can pick
          // them up (mirrors /ask/stream).
          if (payload.event === "thinking") {
            const toolName =
              typeof payload.tool === "string"
                ? (payload.tool as string)
                : "";
            if (toolName && payload.args !== undefined) {
              pendingToolArgs.set(toolName, payload.args);
            }
          }
          for (const line of toNdjson(payload, seenAgents)) {
            await out.write(line + "\n");
          }
        }
      }
    } catch (err) {
      await out.write(
        JSON.stringify({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    } finally {
      try {
        reader.cancel();
      } catch {
        /* already cancelled */
      }
    }
  });
});

export default routes;
