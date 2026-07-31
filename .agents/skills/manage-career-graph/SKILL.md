---
name: manage-career-graph
description: Manage Relay's evidence-backed Career Graph and compile review-gated résumés for specific job descriptions. Use when Codex should import or update career facts, create a résumé, tailor a résumé to a JD, publish an approved résumé, prepare one or many browser application handoffs, or help with a job application while preserving provenance and human approval.
---

# Manage Career Graph

Treat the Career Graph as the source of truth and every résumé as a compiled
artifact. Use the `relay-career` MCP tools for graph state, revisions,
compilations, publication, and browser handoff.

## Preflight

1. Call `relay_status`.
2. Stop if Relay identity is not configured. Never pass or guess a `user_id`.
3. Call `list_career_graphs`; reuse the intended graph or create one through a
   proposal.
4. Read [references/graph-contract.md](references/graph-contract.md) before
   constructing graph operations.

## Import or update career facts

1. Call `list_source_resumes`. When the intended résumé already exists in
   Relay, call `propose_resume_import`; use manual operations only for attached
   or newly stated facts.
2. Extract only facts stated by the user or present in an attached source.
3. Give every node stable IDs and provenance. Never infer employers, titles,
   dates, metrics, technologies, credentials, or outcomes.
4. Ask for missing facts when an ambiguity would change meaning. Otherwise omit
   the fact.
5. Call `propose_career_graph_changes` for manual facts. This creates a pending
   change only.
6. Call `get_career_graph_change` and show:

   - nodes and edges added, changed, or removed;
   - provenance for each material fact;
   - ambiguities or facts deliberately omitted.

7. Ask the user to type exactly
   `APPROVE CAREER CHANGE <change_set_id>` or
   `REJECT CAREER CHANGE <change_set_id>`.
8. Call the corresponding approval tool only after that exact text appears in
   the user's own message. A generic “yes”, prior standing permission, or a
   model-generated phrase is insufficient.

## Compile for a JD

1. Obtain the complete JD from the user, a file, or a page the user authorized
   Codex to read.
2. Call `get_career_graph_evidence_report`. Explain that outcome ranking is
   correlation, not causation; JD relevance remains primary and rejections do
   not automatically penalize a fact.
3. Call `compile_resume_for_jd` against an approved graph revision.
4. Call `get_resume_compilation`.
5. Present the draft, graph revision, selected and omitted evidence, and
   `guard_report`. Do not rewrite the compiled facts outside Relay.
6. Ask the user to type exactly `APPROVE RESUME <compilation_id>` or
   `REJECT RESUME <compilation_id>`.
7. Call the decision tool only after the exact user-authored phrase.

For multiple JDs, compile all drafts first and present a compact comparison.
Approval remains per compilation; never silently approve a batch.

## Publish

Publish only when the user explicitly asks for a public read-only link.

1. Require an approved compilation.
2. Explain that the URL is public to anyone holding it.
3. Ask the user to type `PUBLISH <compilation_id>`.
4. Call `publish_resume_compilation` only after the exact phrase.

Publishing a résumé is not submitting a job application.

## Prepare and execute a browser application

1. When the user intends to apply, call `create_application_draft` with the
   approved compilation, company, role, and exact job URL. This creates only a
   Relay-local tracking row and makes later outcome feedback attributable.
2. Call `prepare_application_handoff` and verify it returns the same
   `application_id`.
3. Use the connected Codex Chrome or Browser capability so execution happens
   in the user's logged-in browser. Do not use a server-side application
   submitter.
4. Never request, store, reveal, or type a job-platform password. Let the user
   log in directly.
5. Never solve or bypass CAPTCHA or anti-bot challenges.
6. Fill only fields supported by the approved package or facts the user
   supplies in the current conversation.
7. Stop on unsupported demographic, legal, salary, sponsorship, or
   eligibility questions and ask the user.
8. Before the final Submit/Apply click, show the platform, role, résumé
   compilation ID, generated answers, and unresolved warnings. Ask for explicit
   approval for that application.
9. Click the final button only after that approval. Repeat the gate for every
   application in a batch.

If the site blocks automation, preserve the prepared package and hand control
to the user. Do not evade the block.

## Completion report

Report graph revision, compilation ID, publication URL if any, and browser
handoff/submission status separately. Never claim “submitted” from a prepared
handoff alone.
