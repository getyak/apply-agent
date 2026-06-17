<!--
Purpose: tell researchers how to report; tell users what we protect.
When to edit: when SLA changes, when contact channels change.
-->

# Security Policy

Relay handles deeply personal data (resumes, interview transcripts, application history) and operates on behalf of users on third-party job platforms. We take security seriously.

> Architectural baseline: Relay submits applications **from the user's own browser session** via a Manifest V3 extension. We never hold credentials for job platforms. See [docs/architecture/client-side-delivery.md](../docs/architecture/client-side-delivery.md).

## Supported versions

The `main` branch is the only supported version while in pre-1.0. Once tagged releases ship, we will support the latest minor.

## Reporting a vulnerability

**Please do not open public issues for security problems.**

Use **GitHub Security Advisories**: <https://github.com/cubxxw/apply-agent/security/advisories/new>

If you cannot use GHSA, email: **xiong3293172751@outlook.com** with subject `[SECURITY] Relay …`. PGP key available on request.

Please include:

- Description and impact
- Reproduction steps or PoC
- Affected component (agent / api / web / extension / infra)
- Your assessment of severity

## Response SLA

| Stage | Target |
|---|---|
| Acknowledgement | 24 hours |
| Triage + severity classification | 72 hours |
| Initial remediation plan | 7 days |
| Fix for critical issues | 14 days |
| Fix for high issues | 30 days |
| Public disclosure | Coordinated, typically 90 days after fix |

## What we protect

| Data class | Sensitivity | Storage |
|---|---|---|
| User resumes (JSON Resume + originals) | High (PII) | Encrypted at rest; user may opt for local-only |
| Interview Q&A transcripts | High (PII + reputational) | Encrypted; opt-in for aggregation |
| Application history | Medium-high | Encrypted at rest |
| Job descriptions | Low (public data) | Cached only |
| LLM prompts | Low | Logged with PII scrubbing |

## Architectural security commitments

- **No password storage for job platforms.** Submission happens in the user's own browser session via the extension. We never hold credentials for Greenhouse, Lever, LinkedIn, Boss直聘, or any job board. See [client-side-delivery.md](../docs/architecture/client-side-delivery.md).
- **No CAPTCHA bypass / anti-bot evasion.** Out of scope on principle.
- **No resume fabrication.** AI rephrases existing experience; it cannot invent.
- **HITL on irreversible actions.** `submit_form`, `send_email`, `delete_*` always pause for explicit user approval via LangGraph `interrupt()`. See [agent-harness.md](../docs/architecture/agent-harness.md).
- **Cost guards.** Per-session budget caps prevent runaway LLM spend in case of compromise. See [cicd-aiops-harness.md § 2.6](../docs/architecture/cicd-aiops-harness.md).
- **Sandboxed agent execution.** Server-side tools run in per-session Docker containers with dropped privileges.

## Out of scope

- Vulnerabilities in third-party services (OpenRouter, Supabase, Vercel) — report to them directly.
- Self-XSS, social engineering of operators.
- Issues requiring physical access to a user's device.

## Recognition

We maintain a `SECURITY-THANKS.md` for researchers who report responsibly (opt-in).
