#!/usr/bin/env node
/**
 * Seed a fully-populated test user against the running API.
 *
 * Solves test.md § 5.2 (database state pain) + § 5.4 step 3 (seeded-data
 * scenario): a new account had no résumé / applications / interviews, so
 * every page that depends on real data (tracker kanban, today trends,
 * résumé timeline) could only ever render its empty state. This script
 * fans out the auth + résumé + applications endpoints to land a coherent
 * starter dataset in ~3 seconds, then emits a browser snippet you can
 * paste into DevTools to inherit the new session immediately.
 *
 * Two-step contract:
 *   1. POST /api/auth/register  → user + JWT
 *   2. POST /api/resumes         → base résumé (JSON Resume shape)
 *   3. POST /api/applications/prepare × 2 against the seeded jobs from
 *      scripts/seed.sql (which the developer has already loaded via
 *      `make db-shell` + `\i scripts/seed.sql`, or via `bun api seed`)
 *
 * If the seed jobs aren't present we degrade honestly: the user + résumé
 * still land, the script prints a hint to run scripts/seed.sql first.
 *
 * Usage:
 *   node scripts/seed-test-user.mjs                       # uses defaults
 *   node scripts/seed-test-user.mjs --api-url http://127.0.0.1:3001
 *   node scripts/seed-test-user.mjs --display-name "QA"   # override
 *
 * Output: a JSON blob to stdout, exit 0 on success / 1 on failure. The
 * blob includes the token and a `browserSnippet` field — copy that into
 * DevTools Console while pointed at the web app to instantly log the
 * fresh user in (sets localStorage + cookie just like web/src/lib/api.ts
 * setToken does).
 */

const args = parseArgs(process.argv.slice(2));
const API_URL = (args["api-url"] ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const STAMP = String(Date.now());
const EMAIL = args.email ?? `seed-${STAMP}@example.com`;
const PASSWORD = args.password ?? "seed-test-password-1234";
const DISPLAY_NAME = args["display-name"] ?? "Seed User";

// Seeded job ids from scripts/seed.sql. Pinned here so the script is
// deterministic — if the developer's DB has been re-seeded these UUIDs
// are exactly the ones the SQL fixture exposes.
const SEEDED_JOB_IDS = [
  "a0000000-0000-0000-0000-000000000001", // Linear · Senior Frontend Engineer
  "a0000000-0000-0000-0000-000000000002", // Ramp · Full-Stack Engineer
];

// Minimal but realistic JSON Resume body — enough to drive the tracker /
// today / résumé timeline through their non-empty branches without
// having to call the LLM parse pipeline.
const RESUME_CONTENT = {
  basics: {
    name: DISPLAY_NAME,
    label: "Senior Software Engineer",
    email: EMAIL,
    phone: "+1-555-0100",
    location: { city: "San Francisco", region: "CA" },
    summary:
      "Shipped a real-time collaboration redesign used by 40k teams, cutting handoff time 60%. Reads as senior because every claim has a number behind it.",
  },
  work: [
    {
      name: "Acme Co",
      position: "Senior Software Engineer",
      startDate: "2023-04",
      endDate: "Present",
      summary: "Owned the collaboration platform end-to-end.",
      highlights: [
        "Cut handoff time 60% on a redesign that 40k teams use daily.",
        "Recovered onboarding activation +40% after owning a regression.",
      ],
    },
    {
      name: "Beta Labs",
      position: "Full-Stack Engineer",
      startDate: "2021-01",
      endDate: "2023-03",
      highlights: [
        "Designed a payment ledger that processed $80M with zero data loss.",
      ],
    },
  ],
  skills: [
    { name: "Frontend", keywords: ["React", "TypeScript", "Next.js"] },
    { name: "Backend", keywords: ["Node", "PostgreSQL", "Redis"] },
  ],
  education: [
    {
      institution: "UC Berkeley",
      area: "Computer Science",
      studyType: "B.S.",
      startDate: "2017",
      endDate: "2021",
    },
  ],
};

async function jsonRequest(path, init = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function run() {
  const result = {
    apiUrl: API_URL,
    email: EMAIL,
    displayName: DISPLAY_NAME,
    user: null,
    token: null,
    resume: null,
    applications: [],
    warnings: [],
  };

  // 1. Register — primary outcome is the JWT we'll send in subsequent calls.
  const reg = await jsonRequest("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME }),
  });
  result.user = reg.user;
  result.token = reg.token;

  const auth = { Authorization: `Bearer ${result.token}` };

  // 2. Create a base résumé. Persisting via POST /api/resumes (not parse)
  // skips the LLM — content is hand-authored above.
  const resumeRes = await jsonRequest("/api/resumes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ content: RESUME_CONTENT, isBase: true }),
  });
  result.resume = {
    id: resumeRes.resume.id,
    version: resumeRes.resume.version,
  };

  // 3. Prepare a draft application against each seeded job. We catch
  // 404 / FK errors per-job: a developer might not have loaded the SQL
  // fixture, in which case we still want the user + résumé to be usable.
  for (const jobId of SEEDED_JOB_IDS) {
    try {
      const appRes = await jsonRequest("/api/applications/prepare", {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": `seed-${STAMP}-${jobId}` },
        body: JSON.stringify({ jobId, resumeId: result.resume.id }),
      });
      result.applications.push({
        id: appRes.application.id,
        jobId,
        status: appRes.application.status,
      });
    } catch (err) {
      result.warnings.push(
        `Skipped application for job ${jobId}: ${err.message}. ` +
        `If the message mentions a foreign-key violation, load scripts/seed.sql first.`,
      );
    }
  }

  // 4. Browser snippet — copy/paste in DevTools Console pointed at the
  // web app to inherit the session without manually typing the token.
  // Mirrors the dual-write done by web/src/lib/api.ts setToken().
  const snippet =
    `(() => {\n` +
    `  const t = ${JSON.stringify(result.token)};\n` +
    `  localStorage.setItem("vantage_token", t);\n` +
    `  document.cookie = "vantage_token=" + encodeURIComponent(t) +\n` +
    `    "; Path=/; Max-Age=2592000; SameSite=Lax";\n` +
    `  location.assign("/app/today");\n` +
    `})();`;
  result.browserSnippet = snippet;

  return result;
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message ?? String(err) }, null, 2));
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
