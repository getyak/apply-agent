// /api/slash — read-only catalog endpoints that back the dock's "/" command
// palette (web/src/components/ask-vantage/slash-palette.tsx).
//
// One fetch, four sources: skills (.claude/skills/*/SKILL.md), prompts
// (agents/prompts/*/*.md), memory (MEMORY.md index), and the dock's
// canonical @ agent teams. Results cached in-process for 30 s so the
// palette can re-open rapidly without re-walking the filesystem.

import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv } from "../types";

const routes = new Hono<AppEnv>();

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

interface CatalogEntry {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: "skills" | "prompts" | "memory" | "agents";
}

interface Catalog {
  skills: CatalogEntry[];
  prompts: CatalogEntry[];
  memory: CatalogEntry[];
  agents: CatalogEntry[];
  generatedAt: string;
}

let cached: { value: Catalog; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    const raw = line.slice(idx + 1).trim();
    if (!raw) continue;
    const value = raw.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function clip(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

async function loadSkills(root: string): Promise<CatalogEntry[]> {
  const skillsDir = join(root, ".claude", "skills");
  const dirs = await safeReaddir(skillsDir);
  const out: CatalogEntry[] = [];
  for (const dir of dirs) {
    if (dir.startsWith(".")) continue;
    const skillPath = join(skillsDir, dir, "SKILL.md");
    const content = await safeReadFile(skillPath);
    if (!content) continue;
    const fm = parseFrontmatter(content);
    const name = fm?.name ?? dir;
    const description = fm?.description ?? "";
    if (description.length === 0) continue;
    out.push({
      id: `skill:${dir}`,
      slug: `/${name}`,
      title: name,
      description: clip(description),
      category: "skills",
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

async function loadPrompts(root: string): Promise<CatalogEntry[]> {
  const promptsRoot = join(root, "agents", "prompts");
  const groups = await safeReaddir(promptsRoot);
  const out: CatalogEntry[] = [];
  for (const group of groups) {
    if (group.startsWith(".")) continue;
    const files = await safeReaddir(join(promptsRoot, group));
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await safeReadFile(join(promptsRoot, group, file));
      if (!content) continue;
      const lines = content.split("\n");
      let title = "";
      let description = "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!title && trimmed.startsWith("#")) {
          title = trimmed.replace(/^#+\s*/, "");
          continue;
        }
        if (title && trimmed.length > 0 && !trimmed.startsWith("#")) {
          description = trimmed;
          break;
        }
      }
      if (!title) title = file.replace(/\.md$/, "");
      out.push({
        id: `prompt:${group}/${file}`,
        slug: `/${group}/${file.replace(/\.md$/, "")}`,
        title,
        description: clip(description),
        category: "prompts",
      });
    }
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

async function loadMemory(root: string): Promise<CatalogEntry[]> {
  const indexPath = join(root, ".claude", "memory", "MEMORY.md");
  const content = await safeReadFile(indexPath);
  if (!content) return [];
  const out: CatalogEntry[] = [];
  for (const line of content.split("\n")) {
    const match = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, title, file, hook] = match;
    out.push({
      id: `memory:${file}`,
      slug: `/memory/${file.replace(/\.md$/, "")}`,
      title,
      description: clip(hook),
      category: "memory",
    });
  }
  return out.slice(0, 50);
}

const AGENT_ENTRIES: CatalogEntry[] = [
  { id: "agent:scout", slug: "@scout", title: "Scout", description: "Find / match roles", category: "agents" },
  { id: "agent:resume", slug: "@resume", title: "Résumé", description: "Parse · optimise · tailor", category: "agents" },
  { id: "agent:interview", slug: "@interview", title: "Interview", description: "Mock · feedback", category: "agents" },
  { id: "agent:apply", slug: "@apply", title: "Application", description: "Cover letters · form prep", category: "agents" },
  { id: "agent:trend", slug: "@trend", title: "Trend", description: "Market · skills movement", category: "agents" },
];

async function buildCatalog(): Promise<Catalog> {
  const root = repoRoot();
  const [skills, prompts, memory] = await Promise.all([
    loadSkills(root),
    loadPrompts(root),
    loadMemory(root),
  ]);
  return {
    skills,
    prompts,
    memory,
    agents: AGENT_ENTRIES,
    generatedAt: new Date().toISOString(),
  };
}

routes.use("/catalog", authMiddleware);
routes.get("/catalog", async (c) => {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return c.json(cached.value);
  }
  const value = await buildCatalog();
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return c.json(value);
});

export default routes;
