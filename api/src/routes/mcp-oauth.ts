import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { query, withTransaction } from "../db";
import { Errors } from "../errors";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

const RequestIdSchema = z.string().uuid();
const DecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

type AuthorizationRow = {
  id: string;
  client_id: string;
  client_metadata: Record<string, unknown> | string;
  user_id: string | null;
  redirect_uri: string;
  state: string | null;
  scopes: string[];
  resource: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  expires_at: Date | string;
};

function parseRequestId(value: string): string {
  const parsed = RequestIdSchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.notFound("MCP authorization request not found");
  }
  return parsed.data;
}

function parseClientMetadata(
  value: AuthorizationRow["client_metadata"],
): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  }
  return value ?? {};
}

function oauthRedirect(
  redirectUri: string,
  values: Record<string, string | null>,
): string {
  // redirect_uri was already validated by FastMCP against the registered
  // client's allowlist before this row was created. Reconstructing it from
  // that server-owned row prevents a browser-supplied open redirect.
  const redirect = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) redirect.searchParams.set(key, value);
  }
  return redirect.toString();
}

function codeDigest(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function publicRequest(row: AuthorizationRow) {
  const metadata = parseClientMetadata(row.client_metadata);
  return {
    id: row.id,
    client: {
      id: row.client_id,
      name:
        typeof metadata.client_name === "string"
          ? metadata.client_name
          : "Codex MCP client",
      uri:
        typeof metadata.client_uri === "string"
          ? metadata.client_uri
          : null,
    },
    scopes: row.scopes,
    resource: row.resource,
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function loadRequest(requestId: string): Promise<AuthorizationRow | null> {
  const result = await query<AuthorizationRow>(
    `
    SELECT r.id, r.client_id, c.client_metadata, r.user_id,
           r.redirect_uri, r.state, r.scopes, r.resource,
           r.status, r.expires_at
      FROM mcp_oauth_authorization_requests r
      JOIN mcp_oauth_clients c ON c.client_id = r.client_id
     WHERE r.id = $1
    `,
    [requestId],
  );
  return result.rows[0] ?? null;
}

app.get("/requests/:requestId", async (c) => {
  c.header("Cache-Control", "no-store");
  const userId = c.get("userId");
  const requestId = parseRequestId(c.req.param("requestId"));
  const row = await loadRequest(requestId);
  if (!row || (row.user_id !== null && row.user_id !== userId)) {
    throw Errors.notFound("MCP authorization request not found");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw Errors.gone("MCP authorization request has expired");
  }
  return c.json({ request: publicRequest(row) });
});

app.post("/requests/:requestId/decision", async (c) => {
  c.header("Cache-Control", "no-store");
  const userId = c.get("userId");
  const requestId = parseRequestId(c.req.param("requestId"));
  const parsed = DecisionSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw Errors.validation("Invalid MCP authorization decision", parsed.error.issues);
  }

  const redirectUrl = await withTransaction(async (tx) => {
    const result = await tx.query<AuthorizationRow>(
      `
      SELECT r.id, r.client_id, c.client_metadata, r.user_id,
             r.redirect_uri, r.state, r.scopes, r.resource,
             r.status, r.expires_at
        FROM mcp_oauth_authorization_requests r
        JOIN mcp_oauth_clients c ON c.client_id = r.client_id
       WHERE r.id = $1
       FOR UPDATE OF r
      `,
      [requestId],
    );
    const row = result.rows[0];
    if (!row || (row.user_id !== null && row.user_id !== userId)) {
      throw Errors.notFound("MCP authorization request not found");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw Errors.gone("MCP authorization request has expired");
    }
    if (row.status !== "pending") {
      throw Errors.conflict("MCP authorization request was already decided");
    }

    if (parsed.data.decision === "deny") {
      await tx.query(
        `
        UPDATE mcp_oauth_authorization_requests
           SET user_id = $2, status = 'denied', decided_at = now()
         WHERE id = $1
        `,
        [requestId, userId],
      );
      return oauthRedirect(row.redirect_uri, {
        error: "access_denied",
        state: row.state,
      });
    }

    const authorizationCode = `relay_ac_${randomBytes(48).toString("base64url")}`;
    await tx.query(
      `
      UPDATE mcp_oauth_authorization_requests
         SET user_id = $2,
             status = 'approved',
             authorization_code_hash = $3,
             authorization_code_expires_at = now() + interval '5 minutes',
             decided_at = now()
       WHERE id = $1
      `,
      [requestId, userId, codeDigest(authorizationCode)],
    );
    return oauthRedirect(row.redirect_uri, {
      code: authorizationCode,
      state: row.state,
    });
  });

  return c.json({ redirectUrl });
});

export default app;
