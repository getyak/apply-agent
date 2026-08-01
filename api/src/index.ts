import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import { installDbShutdownHandlers, pingDbAtBoot } from "./db";
import { installRedisShutdownHandlers, pingRedisAtBoot } from "./redis";
import { errorHandler } from "./errors";
import { requestId, requestLogger } from "./middleware/observability";
import { traceId } from "./middleware/trace-id";
import {
  bodySizeLimit,
  resolveCorsOrigin,
  securityHeaders,
} from "./middleware/security";
import type { AppEnv } from "./types";
import authRoutes from "./routes/auth";
import resumeRoutes from "./routes/resumes";
import publicResumeRoutes from "./routes/public-resumes";
import artifactDeliveryRoutes from "./routes/artifact-deliveries";
import jobRoutes from "./routes/jobs";
import applicationRoutes from "./routes/applications";
import interviewRoutes from "./routes/interviews";
import chatRoutes from "./routes/chat";
import trendRoutes from "./routes/trends";
import fileRoutes from "./routes/files";
import healthRoutes from "./routes/health";
import userRoutes from "./routes/users";
import askRoutes from "./routes/ask";
import slashRoutes from "./routes/slash";
import todayRoutes from "./routes/today";
import mcpOAuthRoutes from "./routes/mcp-oauth";
import careerGraphRoutes from "./routes/career-graphs";
import { RESUME_ARTIFACT_AUDIT_HEADER_NAMES } from "./resume-artifact-profile";

const app = new Hono<AppEnv>();

// traceId BEFORE requestId so a single trace can span multiple
// requests (SSE stream + the agent calls it spawns) and so the
// requestLogger and errorHandler both see the trace context.
app.use("*", traceId);
app.use("*", requestId);
app.use("*", requestLogger);
app.use("*", securityHeaders);
app.use("*", bodySizeLimit);
app.use(
  "*",
  cors({
    // Echo back only allowlisted web origins + the browser extension scheme.
    origin: (origin) => resolveCorsOrigin(origin) ?? "",
    credentials: true,
    exposeHeaders: [
      "Content-Disposition",
      "X-Relay-Artifact-Compilation-Id",
      "X-Relay-Artifact-Application-Id",
      "X-Relay-Artifact-Purpose",
      ...RESUME_ARTIFACT_AUDIT_HEADER_NAMES,
    ],
  }),
);

app.route("/api/auth", authRoutes);
// OAuth consent bridge for the remote Career Graph MCP. The Python MCP
// service owns the OAuth protocol; this authenticated Hono route binds a
// pending PKCE request to the signed-in Relay user through shared PostgreSQL.
app.route("/api/mcp-oauth", mcpOAuthRoutes);
app.route("/api/resumes", resumeRoutes);
// Career Graph logic stays in the Python agent layer; Hono only verifies the
// Relay JWT and proxies the owner identity over the established HTTP boundary.
app.route("/api/career-graphs", careerGraphRoutes);
// Public résumé share links — NO auth. The token (16-byte hex) IS the
// capability. See routes/public-resumes.ts for the security posture.
app.route("/api/public/r", publicResumeRoutes);
// Short-lived application-bound file delivery. The secret enters through a
// POST body, moves to a path-scoped HttpOnly cookie for Chrome's download
// manager, and is stored in PostgreSQL only as a digest; no public résumé
// publish token or Relay login cookie is required.
app.route("/api/public/artifacts", artifactDeliveryRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/applications", applicationRoutes);
app.route("/api/interviews", interviewRoutes);
app.route("/api/chat", chatRoutes);
app.route("/api/trends", trendRoutes);
app.route("/api/today", todayRoutes);
app.route("/api/files", fileRoutes);
app.route("/api/users", userRoutes);
// Ask Vantage SSE relay → Python LangGraph host. Single mount-point;
// see routes/ask.ts for the protocol-bridge between FastAPI SSE and
// the dock's NDJSON stream.
app.route("/api/ask", askRoutes);
// Slash-command catalog (read-only): backs the dock's "/" palette which
// lists skills / prompts / memory / agent teams. See routes/slash.ts.
app.route("/api/slash", slashRoutes);
// Health/readiness routes mounted at /api so liveness/readiness probes hit the
// same prefix as the rest of the surface. See routes/health.ts for the split
// between always-200 liveness and dependency-checking readiness.
app.route("/api", healthRoutes);

app.onError(errorHandler);

// DB-bundle (round-11): wire the PG pool's lifecycle to the process
// lifecycle so SIGTERM/SIGINT drain in-flight queries instead of
// killing them mid-transaction, and so a startup with the wrong
// DATABASE_URL leaves a loud breadcrumb instead of a quiet 5xx on the
// first request. The ping is fire-and-forget — the readiness route is
// the source of truth for whether the gateway should receive traffic.
installDbShutdownHandlers();
void pingDbAtBoot();
// REDIS-bundle (round-13): same lifecycle posture as PG above —
// drain on SIGTERM/SIGINT, ping at boot. Round-11 closed the gap on
// PG; round-13 closes the parallel gap on Redis.
installRedisShutdownHandlers();
void pingRedisAtBoot();

const port = config.API_PORT;

console.log(`Relay API running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  // Bun's default idleTimeout is 10s, which kills long-lived streams
  // mid-flight — the Ask Vantage SSE relay (/api/ask) and any LLM-backed
  // /api/chat turn routinely exceed 10s, surfacing to the browser as
  // ERR_INCOMPLETE_CHUNKED_ENCODING ("Lost connection to Vantage").
  // 255 is Bun's maximum and comfortably covers a slow LLM turn while
  // still reaping genuinely dead connections.
  idleTimeout: 255,
};
