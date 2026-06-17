import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import { errorHandler } from "./errors";
import { requestId, requestLogger } from "./middleware/observability";
import {
  bodySizeLimit,
  resolveCorsOrigin,
  securityHeaders,
} from "./middleware/security";
import type { AppEnv } from "./types";
import authRoutes from "./routes/auth";
import resumeRoutes from "./routes/resumes";
import jobRoutes from "./routes/jobs";
import applicationRoutes from "./routes/applications";
import interviewRoutes from "./routes/interviews";
import chatRoutes from "./routes/chat";
import trendRoutes from "./routes/trends";
import fileRoutes from "./routes/files";
import healthRoutes from "./routes/health";
import userRoutes from "./routes/users";

const app = new Hono<AppEnv>();

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
  }),
);

app.route("/api/auth", authRoutes);
app.route("/api/resumes", resumeRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/applications", applicationRoutes);
app.route("/api/interviews", interviewRoutes);
app.route("/api/chat", chatRoutes);
app.route("/api/trends", trendRoutes);
app.route("/api/files", fileRoutes);
app.route("/api/users", userRoutes);
// Health/readiness routes mounted at /api so liveness/readiness probes hit the
// same prefix as the rest of the surface. See routes/health.ts for the split
// between always-200 liveness and dependency-checking readiness.
app.route("/api", healthRoutes);

app.onError(errorHandler);

const port = config.API_PORT;

console.log(`Relay API running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
