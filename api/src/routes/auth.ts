import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { query } from "../db";
import { signToken, authMiddleware } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { Errors } from "../errors";
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

// Why we don't use shared validateBody middleware here: auth routes are
// the EARLIEST surface a brand-new user hits, so spending the bytes on a
// crisp inline error is a UX win — and we want fix-input action hints
// pointing at specific fields, which validateBody doesn't synthesize.
function fieldsFromZod(issues: z.ZodIssue[]): { name: string; msg: string }[] {
  return issues
    .map((i) => ({ name: i.path.join("."), msg: i.message }))
    .filter((f) => f.name.length > 0);
}

app.post("/register", authLimiter, async (c) => {
  const body = await c.req.json();
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    throw Errors.validation(
      "Invalid registration input",
      parsed.error.issues,
      fieldsFromZod(parsed.error.issues),
    );
  }
  const { email, password, displayName } = parsed.data;

  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length > 0) {
    throw Errors.conflict("Email already registered");
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
    throw Errors.validation(
      "Invalid login input",
      parsed.error.issues,
      fieldsFromZod(parsed.error.issues),
    );
  }
  const { email, password } = parsed.data;

  const result = await query(
    "SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = $1",
    [email],
  );
  // We deliberately surface the same code (AUTH_INVALID_CREDENTIALS) for
  // both "user doesn't exist" and "password mismatch" — disclosing which
  // one is wrong is a user-enumeration vector.
  if (result.rows.length === 0) {
    throw Errors.invalidCreds();
  }
  const user = result.rows[0];
  if (!user.password_hash) {
    throw Errors.invalidCreds();
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw Errors.invalidCreds();
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
    // A valid JWT for a missing user means the row was deleted
    // out-of-band — force a re-auth instead of returning a vague 404.
    throw Errors.sessionExpired();
  }
  return c.json({ user: result.rows[0] });
});

export default app;
