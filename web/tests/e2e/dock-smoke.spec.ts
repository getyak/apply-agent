import { test, expect, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Dock smoke — the one E2E that proves Ask Vantage still opens, accepts input,
// and renders a message frame.
//
// NOTE on the route: the task brief says "navigate to /", but the dock is part
// of the authenticated /app shell (web/src/app/app/layout.tsx mounts
// <AskVantageDock/>). The public landing page (/) has no dock. So we:
//   1. register a throwaway user against the live API (make relay-up → :3001),
//   2. seed the returned JWT into localStorage + cookie (the two places the app
//      reads `vantage_token` — see web/src/lib/api.ts),
//   3. navigate to /app, where the dock actually lives.
//
// The "message frame" we assert on is the optimistic user card
// (data-testid="step-user"), which renders the instant submit() fires — it does
// NOT require an LLM round-trip, so this smoke stays fast and deterministic even
// if the agents layer is slow or the OpenRouter key is a stub.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const WEB_BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const TOKEN_KEY = "vantage_token";

async function seedSession(page: Page): Promise<void> {
  const email = `dock-smoke-${Date.now()}@example.com`;
  const res = await page.request.post(`${API_BASE}/api/auth/register`, {
    data: { email, password: "dock-smoke-pw-1234", displayName: "Dock Smoke" },
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    throw new Error(
      `Register failed (${res.status()}). Is the API up on ${API_BASE}? ` +
        `Run \`make relay-up\` first. Body: ${await res.text()}`,
    );
  }
  const { token } = (await res.json()) as { token: string };
  expect(token, "register should return a JWT").toBeTruthy();

  // Two separate seed channels, both required:
  //   1. context cookie — the edge proxy (web/src/proxy.ts) checks
  //      request.cookies["vantage_token"] on /app/* and 307s guests to /.
  //      This MUST be on the very first request, so it goes on the context,
  //      not via addInitScript (which runs after navigation starts).
  //   2. localStorage — the JS api client (web/src/lib/api.ts getToken()) reads
  //      localStorage; addInitScript runs before app code on every page.
  await page.context().addCookies([
    { name: TOKEN_KEY, value: token, url: WEB_BASE, sameSite: "Lax" },
  ]);
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [TOKEN_KEY, token],
  );
}

test("dock opens, accepts input, and renders a message frame", async ({ page }) => {
  await seedSession(page);

  await page.goto("/app");

  // The dock renders collapsed as a launcher button (data-tour="dock") until
  // opened. If it's already docked open (viewport-dependent), the launcher is
  // absent and the composer is directly available — handle both.
  const launcher = page.locator('[data-tour="dock"]');
  const composer = page.locator('[data-vantage-composer="1"]');

  // Wait for the workspace to finish its auth handshake (BrandLoader → chrome).
  // Either the launcher or the composer proves the dock mounted.
  await expect(launcher.or(composer).first()).toBeVisible({ timeout: 15_000 });

  if (await launcher.isVisible().catch(() => false)) {
    await launcher.click();
  }

  await expect(composer).toBeVisible({ timeout: 5_000 });
  await composer.click();
  await composer.fill("hello");

  // Submit is Cmd/Ctrl+Enter (dock.tsx onKeyDown). Use Meta on macOS, Control
  // on Linux CI runners.
  await composer.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");

  // The optimistic user card is the message frame — it appears immediately on
  // submit, independent of any backend response.
  await expect(page.getByTestId("step-user").first()).toBeVisible({ timeout: 15_000 });
});
