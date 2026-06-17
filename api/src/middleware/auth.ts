import type { Context, Next } from "hono";
import { jwtVerify, SignJWT } from "jose";
import type { AppEnv } from "../types";

const secret = () =>
  new TextEncoder().encode(process.env.JWT_SECRET || "dev-secret-change-me");

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
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }
  try {
    const token = header.slice(7);
    const { payload } = await jwtVerify(token, secret());
    c.set("userId", payload.sub as string);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
