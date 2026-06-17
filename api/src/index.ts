import { Hono } from "hono";
import { cors } from "hono/cors";
import { initDb } from "./db";
import authRoutes from "./routes/auth";
import resumeRoutes from "./routes/resumes";
import jobRoutes from "./routes/jobs";
import applicationRoutes from "./routes/applications";
import interviewRoutes from "./routes/interviews";
import chatRoutes from "./routes/chat";
import trendRoutes from "./routes/trends";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (process.env.CORS_ORIGINS || "http://localhost:3000").split(","),
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

app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

app.onError((err, c) => {
  console.error(`[API Error] ${c.req.method} ${c.req.url}:`, err.message);
  return c.json({ error: "Internal server error" }, 500);
});

const port = parseInt(process.env.API_PORT || "3001");

async function start() {
  await initDb();
  console.log(`Relay API running on http://localhost:${port}`);
}

start();

export default {
  port,
  fetch: app.fetch,
};
