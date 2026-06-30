import type { Context, Next } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { config } from "../config";
import { Errors } from "../errors";
import type { AppEnv } from "../types";

const secret = () => new TextEncoder().encode(config.JWT_SECRET);

export async function signToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
}

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    // error-handling.md §4.1.4: every user-facing error throws an AppError so
    // the onError mapper emits the unified envelope (code/traceId/traceCode/
    // messageKey/action). Bare c.json({error:"..."}, 401) bypassed that.
    throw Errors.authRequired("Missing or invalid authorization header");
  }
  try {
    const token = header.slice(7);
    const { payload } = await jwtVerify(token, secret());
    c.set("userId", payload.sub as string);
    await next();
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AppError") throw cause;
    throw Errors.sessionExpired();
  }
}
