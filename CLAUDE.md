# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Relay** (codename) is an open-source AI job-search copilot system design. It covers the full resume lifecycle: discover jobs → tailor resume → apply (client-side) → interview prep → track & accumulate data.

**Current status: design-spec only — no runnable code yet.** The repo contains product specs, architecture docs, data models, and design guidelines as a blueprint for implementation.

## Key Architectural Decisions

- **Client-side execution model**: Job applications happen in the user's own browser (extension), using their real login session/IP/fingerprint. The user always clicks submit manually. This is the core anti-ban strategy — never use server-side automation for job submission.
- **5 single-responsibility agents**: ResumeAgent, JobMatchAgent, InterviewAgent, AppPrepAgent, TrendAgent. Agents communicate via shared DB state + Redis event bus, never direct function calls.
- **Agent Harness (ReAct loop)**: All agents share a common execution framework with loop guards (max 20 iterations, 80k token budget, $0.50 cost limit, 300s timeout, 3 consecutive errors).
- **Three-tier field filling**: ~70% simple fields (local rules, $0) → ~25% complex fields (cloud LLM map-fields, Haiku) → ~5% open-ended questions (cloud LLM, Sonnet).
- **Data flywheel**: Interview Q&A data accumulates per-user and (opt-in) aggregates into a crowdsourced question bank — this is the moat, not automation.
- **HITL (Human-in-the-loop)**: `submit_form`, `send_email`, `delete_*`, `purchase_*` always require user approval. Submit is never automatic.

## Planned Tech Stack

```
Frontend:  Next.js 15 + Shadcn/ui + TailwindCSS
Extension: Manifest V3 + TypeScript
Backend:   Node.js (Bun) / FastAPI
DB:        Supabase (PostgreSQL) + Redis + DuckDB
LLM:       Claude API (Opus/Sonnet/Haiku) via function calling
Deploy:    Vercel + Railway/Fly + GitHub Actions
```

## Five-Layer Architecture

1. **UI Layer**: Next.js web console + browser extension (Manifest V3)
2. **API + Orchestration**: API Gateway + Agent Coordinator + Redis event bus + cache
3. **Agent Layer**: 5 core agents (Resume, JobMatch, Interview, AppPrep, Trend)
4. **Shared Services**: Auth (Supabase), Notification, Audit Logger, LLM Router, Worker Pool (Bull)
5. **Data + External**: PostgreSQL, Redis, DuckDB, Claude API, Job board APIs (Greenhouse/Lever/Ashby)

## Planned Module Structure

```
extension/   — Browser extension (Manifest V3), form detection + filling
backend/     — Web accounts + LLM API endpoints + database
agents/      — Agent implementations (resume/match/interview/appprep/trend)
web/         — Web console (resume management / application tracking / trends)
```

## Data Model

Core schema uses [JSON Resume](https://jsonresume.org/) as the resume backbone. Key tables: User, Resume (versioned with optimistic locking), Job, ApplicationDraft, InterviewSession, InterviewQuestion. Analytics tables (DuckDB): TrendSnapshot, SkillTrend.

## Non-Negotiable Rules

- **No batch spray-and-pray**: Quality over quantity — never build mass auto-apply without user review.
- **No server-side account automation**: Never operate user accounts from server IP/fingerprint.
- **No resume fabrication**: AI may only rephrase and emphasize real experience, never invent.
- **No credential storage**: Never store user passwords for job platforms.
- **No LinkedIn/Boss直聘 login-state automation** unless explicit risk disclosure + user opt-in.
- **No CAPTCHA bypass or anti-crawl circumvention**.

## Development Conventions

- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- Branch naming: `feat/xxx`, `fix/xxx`, `docs/xxx` from `main`
- TypeScript preferred for all new code
- PRs should be small, focused, and reference the related issue

## Documentation

Full docs in `docs/`. Key reading order:
1. `docs/vision.md` — principles and what we don't do
2. `docs/architecture/system-overview.md` — five-layer architecture
3. `docs/architecture/agent-architecture.md` — 5 agents + event-driven coordination
4. `docs/architecture/client-side-delivery.md` — core client-side execution design
5. `docs/architecture/agent-harness.md` — ReAct loop, guards, HITL checkpoints
6. `docs/data-model.md` — schema design
7. `docs/product-spec.md` — 6 features with priority matrix

Interactive architecture diagrams and UI prototypes are in `docs/assets/` (open HTML files in browser).
