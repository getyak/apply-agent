import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { query } from "../db";
import { signToken, authMiddleware } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

// Brute-force defense: /login and /register are rate-limited by client IP. We
// pin the actor to the IP header explicitly (not the default actor key) so a
// mid-burst successful login can't reset the counter by switching to user:<id>.
const authLimiter = rateLimit({
  scope: "auth",
  limit: 10,
  windowSeconds: 60,
  keyFor: (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    return `ip:${ip}`;
  },
});

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  displayName: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

app.post("/register", authLimiter, async (c) => {
  const body = await c.req.json();
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }
  const { email, password, displayName } = parsed.data;

  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length > 0) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const hash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at`,
    [email, hash, displayName || null],
  );
  const user = result.rows[0];
  const token = await signToken(user.id);
  return c.json({ token, user }, 201);
});

app.post("/login", authLimiter, async (c) => {
  const body = await c.req.json();
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input" }, 400);
  }
  const { email, password } = parsed.data;

  const result = await query(
    "SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = $1",
    [email],
  );
  if (result.rows.length === 0) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const user = result.rows[0];
  if (!user.password_hash) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const token = await signToken(user.id);
  const { password_hash: _, ...safeUser } = user;
  return c.json({ token, user: safeUser });
});

app.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const result = await query(
    "SELECT id, email, display_name, preferences, quota, created_at FROM users WHERE id = $1",
    [userId],
  );
  if (result.rows.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json({ user: result.rows[0] });
});

export default app;
