import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { agentFetch } from "../agent-fetch";
import { Errors, UpstreamError } from "../errors";
import { authMiddleware } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";
import { validateBody } from "../middleware/validate";
import {
  DecideCareerGraphChangeSchema,
  ImportCareerGraphSchema,
  type DecideCareerGraphChange,
  type ImportCareerGraph,
} from "../schemas";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();
app.use("*", authMiddleware);

const UuidSchema = z.string().uuid();

function ownedUuid(value: string | undefined): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.notFound("Career Graph resource not found");
  }
  return parsed.data;
}

async function proxyAgent(
  c: Context<AppEnv>,
  path: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
  } = {},
) {
  let response: Response;
  try {
    response = await agentFetch({
      ctx: c,
      path,
      ...init,
    });
  } catch (cause) {
    throw new UpstreamError(
      "Career Graph agent is unavailable",
      cause instanceof Error ? cause.message : undefined,
    );
  }

  const body = await response.text();
  c.header("Cache-Control", "no-store");
  return c.body(body, response.status as ContentfulStatusCode, {
    "Content-Type":
      response.headers.get("content-type") ?? "application/json; charset=UTF-8",
  });
}

app.get("/", (c) => proxyAgent(c, "/career-graphs"));

app.post(
  "/import",
  idempotency(),
  validateBody(ImportCareerGraphSchema),
  async (c) => {
    const body = c.get("validatedBody") as ImportCareerGraph;
    return proxyAgent(c, "/career-graphs/import", {
      method: "POST",
      body: JSON.stringify({
        resume_id: body.resumeId,
        graph_id: body.graphId,
        graph_label: body.graphLabel ?? "Career Graph",
      }),
    });
  },
);

app.get("/changes/:changeSetId", (c) => {
  const changeSetId = ownedUuid(c.req.param("changeSetId"));
  return proxyAgent(
    c,
    `/career-graph-changes/${encodeURIComponent(changeSetId)}`,
  );
});

app.post(
  "/changes/:changeSetId/decision",
  idempotency(),
  validateBody(DecideCareerGraphChangeSchema),
  async (c) => {
    const changeSetId = ownedUuid(c.req.param("changeSetId"));
    const body = c.get("validatedBody") as DecideCareerGraphChange;
    return proxyAgent(
      c,
      `/career-graph-changes/${encodeURIComponent(changeSetId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
);

app.get("/:graphId", (c) => {
  const graphId = ownedUuid(c.req.param("graphId"));
  return proxyAgent(c, `/career-graphs/${encodeURIComponent(graphId)}`);
});

export default app;
