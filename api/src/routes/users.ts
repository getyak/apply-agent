import { Hono } from "hono";
import { query } from "../db";
import { NotFoundError } from "../errors";
import { authMiddleware } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { UpdateUserSchema, type UpdateUser } from "../schemas";
import type { AppEnv } from "../types";

// /api/users surface — *only* the authenticated user's own record. There is no
// `/api/users/:id` because we treat user records as private; any cross-user
// lookup goes through a purpose-specific endpoint (e.g. interview pool
// aggregates), never a generic GET.

const app = new Hono<AppEnv>();

// ── PATCH /api/users/me ──────────────────────────────────────────────────────
// Partial update of profile + preferences. We build the SET clause from only
// the fields the client sent (UpdateUserSchema.refine guarantees ≥1), so an
// unchanged column is never rewritten with its own value (keeps updated_at
// honest — the trigger only fires when something actually changed).

app.patch(
  "/me",
  authMiddleware,
  validateBody(UpdateUserSchema),
  async (c) => {
    const userId = c.get("userId");
    const input = c.get("validatedBody") as UpdateUser;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.displayName !== undefined) {
      params.push(input.displayName);
      sets.push(`display_name = $${params.length}`);
    }
    if (input.avatarUrl !== undefined) {
      params.push(input.avatarUrl);
      sets.push(`avatar_url = $${params.length}`);
    }
    if (input.preferences !== undefined) {
      // Stored as JSONB — pass a JSON string and let PG cast.
      params.push(JSON.stringify(input.preferences));
      sets.push(`preferences = $${params.length}::jsonb`);
    }
    params.push(userId);
    const result = await query(
      `UPDATE users
         SET ${sets.join(", ")}
       WHERE id = $${params.length}
       RETURNING id, email, display_name, avatar_url, preferences, quota, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) {
      // Should never happen for an authed user, but surface it cleanly so a
      // race (deleted-while-editing) returns a typed 404, not an opaque 500.
      throw new NotFoundError("User not found");
    }
    return c.json({ user: result.rows[0] });
  },
);

// ── DELETE /api/users/me ─────────────────────────────────────────────────────
// GDPR right-to-erasure entry point. Every owned table FKs to users(id) with
// ON DELETE CASCADE (verified across migrations 003–010), so a single
// authoritative DELETE here is sufficient at the PG layer — no application
// transaction needed.
//
// NB: blob deletion in MinIO + cache invalidation + LangGraph checkpoint
// purge are intentionally out of scope for this endpoint. They're tracked
// under SEC-016 (full GDPR cascading delete across PG, MinIO, Redis,
// LangGraph). What ships here is the API-014 PG layer; SEC-016 layers the
// rest on top.

app.delete("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const result = await query(
    "DELETE FROM users WHERE id = $1 RETURNING id",
    [userId],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError("User not found");
  }
  // 204 No Content — nothing more to say, and the JWT the client holds is now
  // dangling. The web client clears its token on this response.
  return c.body(null, 204);
});

export default app;
