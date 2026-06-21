"""JobMatchAgent — JD ingestion + matching (active piece for the delivery loop).

Caller: agents/coordinator/router.py routes `find_jobs` and the
`prepare_application` workflow's first stage hits `parse_jd_from_url`.

Phase 1 scope per docs/architecture/delivery-loop-plan.md § 3 Task T2 :
- detect ATS from URL (greenhouse / lever / ashby / other)
- pull canonical JD payload (public JSON endpoint when ATS exposes one,
  HTML scrape otherwise)
- run LLM (V4 Flash via OpenRouter) over the JD text → canonical `parsed`
  JSONB shape (skills / level / salary / locations / remote / must_haves /
  nice_to_haves / responsibilities / tech_stack)
- UPSERT into the jobs table (UNIQUE(source, external_id) auto-dedups)
- return ParsedJD with the new job_id

Out of scope here (later tasks):
- daily cron-based bulk ingestion (TrendAgent)
- semantic match scoring (currently in api/src/routes/jobs.ts `/:id/match`)

Network failures are isolation-friendly: when `RELAY_JD_FIXTURE_DIR` is set
the fetcher reads `{ats}_{external_id}.html` (or `.json`) from disk first
so CI / eval gates can run hermetically.

Schema reference: infra/postgres/migrations/005_jobs.sql
"""
from __future__ import annotations

import ipaddress as _ipaddress
import json
import os
import re
import socket as _socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from uuid import UUID

import httpx
import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.harness.audit import audit, redact_exception_text
from agents.harness.llm import pick_model

log = structlog.get_logger("agents.nodes.jobmatch")


PROMPT_DIR = Path(__file__).parent.parent / "prompts" / "jobmatch"
FIXTURE_DIR_ENV = "RELAY_JD_FIXTURE_DIR"

ATSSource = Literal["greenhouse", "lever", "ashby", "manual", "other"]


# ─── public surface ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ParsedJD:
    """Return shape from parse_jd_from_url (UI / workflow facing)."""

    job_id: UUID | None  # None when persist=False
    source: ATSSource
    external_id: str | None
    company: str
    role_title: str
    jd_text: str
    parsed: dict[str, Any]
    url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": str(self.job_id) if self.job_id else None,
            "source": self.source,
            "external_id": self.external_id,
            "company": self.company,
            "role_title": self.role_title,
            "jd_text": self.jd_text,
            "parsed": self.parsed,
            "url": self.url,
        }


async def parse_jd_from_url(
    url: str,
    user_id: UUID,
    *,
    persist: bool = True,
    http_client: httpx.AsyncClient | None = None,
) -> ParsedJD:
    """Detect ATS → fetch raw JD → LLM parse → optional UPSERT into jobs.

    Args:
        url: ATS job page URL (Greenhouse / Lever / Ashby supported natively;
             unknown ATS falls back to HTML scrape).
        user_id: caller; recorded on the audit row.
        persist: when False, skips the DB UPSERT and returns job_id=None.
                 Used by eval gates that don't want to pollute jobs table.
        http_client: optional injection for tests / hermetic eval (uses
                     fixtures under $RELAY_JD_FIXTURE_DIR when set).

    Raises:
        JDFetchError if the ATS page is unreachable or returns malformed
        payload that the parser can't tolerate.
    """
    async with audit(user_id, "jobmatch_agent", "parse_jd_from_url") as record:
        source, external_id = _detect_ats(url)
        record.input_params = {"url": url, "source": source, "external_id": external_id}

        raw = await _fetch(url, source, external_id, http_client=http_client)
        record.output_result = {
            "fetched_bytes": len(raw.body),
            "company": raw.company,
            "role_title": raw.role_title,
        }

        parsed = await _llm_parse_jd(raw.jd_text, raw.company, raw.role_title, source)

        job_id: UUID | None = None
        if persist:
            job_id = await _upsert_job(
                source=source,
                external_id=external_id,
                company=raw.company,
                role_title=raw.role_title,
                jd_text=raw.jd_text,
                url=url,
                parsed=parsed,
            )

        return ParsedJD(
            job_id=job_id,
            source=source,
            external_id=external_id,
            company=raw.company,
            role_title=raw.role_title,
            jd_text=raw.jd_text,
            parsed=parsed,
            url=url,
        )


class JDFetchError(RuntimeError):
    """Raised when the ATS page cannot be retrieved or is malformed."""


# ─── ATS detection ─────────────────────────────────────────────────────


_GH_RE = re.compile(r"^(?:job-)?boards(?:-api)?\.greenhouse\.io$")
_LEVER_RE = re.compile(r"^jobs\.lever\.co$")
_ASHBY_RE = re.compile(r"^jobs\.ashbyhq\.com$")


def _detect_ats(url: str) -> tuple[ATSSource, str | None]:
    """Return (source, external_id) for a raw URL.

    external_id is the ATS-native job id when extractable, else None.
    """
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    path_parts = [p for p in parsed.path.split("/") if p]

    if _GH_RE.match(host):
        # https://boards.greenhouse.io/{company}/jobs/{id}
        if len(path_parts) >= 3 and path_parts[1] == "jobs":
            return "greenhouse", path_parts[2]
        return "greenhouse", None

    if _LEVER_RE.match(host):
        # https://jobs.lever.co/{company}/{id}
        if len(path_parts) >= 2:
            return "lever", path_parts[1]
        return "lever", None

    if _ASHBY_RE.match(host):
        # https://jobs.ashbyhq.com/{company}/{uuid}
        if len(path_parts) >= 2:
            return "ashby", path_parts[1]
        return "ashby", None

    return "other", None


# ─── fetch (public JSON endpoint or HTML scrape) ───────────────────────


@dataclass
class _RawJD:
    body: bytes
    jd_text: str
    company: str
    role_title: str


async def _fetch(
    url: str,
    source: ATSSource,
    external_id: str | None,
    *,
    http_client: httpx.AsyncClient | None,
) -> _RawJD:
    """Pull the JD; consult $RELAY_JD_FIXTURE_DIR first so eval is hermetic."""
    fixture = _load_fixture(source, external_id)
    if fixture is not None:
        log.info("jobmatch.fixture_hit", source=source, external_id=external_id)
        return _parse_fixture(fixture, source, url)

    if source == "greenhouse" and external_id:
        return await _fetch_greenhouse(external_id, url, http_client)
    if source == "lever" and external_id:
        return await _fetch_lever(external_id, url, http_client)
    return await _fetch_html(url, http_client)


def _load_fixture(source: ATSSource, external_id: str | None) -> bytes | None:
    """Return raw fixture bytes from disk if RELAY_JD_FIXTURE_DIR is set."""
    fixture_dir = os.environ.get(FIXTURE_DIR_ENV)
    if not fixture_dir or not external_id:
        return None
    base = Path(fixture_dir)
    for ext in ("json", "html"):
        candidate = base / f"{source}_{external_id}.{ext}"
        if candidate.is_file():
            return candidate.read_bytes()
    return None


def _parse_fixture(body: bytes, source: ATSSource, url: str) -> _RawJD:
    """Parse a fixture file as if it had come off the wire."""
    try:
        decoded = body.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — fixture parse is best-effort
        decoded = ""
    # JSON fixture for greenhouse / lever endpoints — same shape we expect live.
    if decoded.lstrip().startswith("{"):
        try:
            data = json.loads(decoded)
            if source == "greenhouse":
                return _shape_greenhouse(data, body)
            if source == "lever":
                return _shape_lever(data, body)
        except json.JSONDecodeError:
            pass
    # Otherwise treat as HTML.
    return _shape_html(decoded, body, fallback_url=url)


async def _fetch_greenhouse(
    external_id: str, url: str, client: httpx.AsyncClient | None
) -> _RawJD:
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    company = parts[0] if parts else "unknown"
    api = f"https://boards-api.greenhouse.io/v1/boards/{company}/jobs/{external_id}"
    body = await _http_get(api, client)
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise JDFetchError(f"greenhouse api returned non-json: {exc}") from exc
    return _shape_greenhouse(data, body)


def _shape_greenhouse(data: dict[str, Any], body: bytes) -> _RawJD:
    title = (data.get("title") or "").strip()
    company_obj = data.get("company") or {}
    company = (company_obj.get("name") or data.get("company_name") or "").strip() or "Unknown"
    content_html = data.get("content") or ""
    return _RawJD(
        body=body,
        jd_text=_strip_html(content_html),
        company=company,
        role_title=title or "Untitled Role",
    )


async def _fetch_lever(
    external_id: str, url: str, client: httpx.AsyncClient | None
) -> _RawJD:
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    company = parts[0] if parts else "unknown"
    api = f"https://api.lever.co/v0/postings/{company}/{external_id}"
    body = await _http_get(api, client)
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise JDFetchError(f"lever api returned non-json: {exc}") from exc
    return _shape_lever(data, body)


def _shape_lever(data: dict[str, Any], body: bytes) -> _RawJD:
    title = (data.get("text") or "").strip() or "Untitled Role"
    company = (data.get("categories", {}).get("team") or "Unknown").strip()
    description_html = data.get("description") or ""
    # Lever includes additional lists by section — append for completeness.
    lists_html = "\n\n".join(
        section.get("text", "") + "\n" + section.get("content", "")
        for section in data.get("lists", [])
    )
    return _RawJD(
        body=body,
        jd_text=_strip_html(description_html + "\n\n" + lists_html),
        company=company,
        role_title=title,
    )


async def _fetch_html(url: str, client: httpx.AsyncClient | None) -> _RawJD:
    body = await _http_get(url, client)
    return _shape_html(body.decode("utf-8", errors="replace"), body, fallback_url=url)


def _shape_html(html: str, body: bytes, *, fallback_url: str) -> _RawJD:
    # Title tag is the most-portable signal across SSR'd ATS pages.
    title_match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    role_title = (title_match.group(1) if title_match else "Untitled Role").strip()
    # Heuristic: take everything inside <main>...</main> or the body if absent.
    main_match = re.search(r"<main[^>]*>(.*?)</main>", html, re.IGNORECASE | re.DOTALL)
    chunk = main_match.group(1) if main_match else html
    return _RawJD(
        body=body,
        jd_text=_strip_html(chunk),
        company=_company_from_url(fallback_url),
        role_title=role_title,
    )


def _company_from_url(url: str) -> str:
    """Last-ditch company name from path: hosts like jobs.ashbyhq.com/{co}/..."""
    parts = [p for p in urlparse(url).path.split("/") if p]
    return parts[0].replace("-", " ").title() if parts else "Unknown"



# JD3+JD5 (round-7) — round-7 audit flagged two reliability/security gaps
# in the JD fetcher: SSRF via user-supplied URL (pasting
# http://169.254.169.254 / http://localhost:5432 / http://10.0.0.5 would
# happily reach the agent's network) and unbounded response size (a 200MB
# HTML response would soak up RAM and LLM tokens). These constants and
# helpers gate every fetch in _http_get below.
_JD_MAX_BYTES = 10 * 1024 * 1024  # 10 MiB — well above any real JD HTML
_JD_ALLOWED_SCHEMES = {"http", "https"}


def _is_public_http_url(url: str) -> tuple[bool, str]:
    """Return (ok, reason) — reject SSRF-adjacent URLs.

    Rejects:
      - non-http(s) schemes (file://, gopher://, ftp://, …)
      - hosts that resolve to loopback / link-local / private / reserved IPs
      - hosts that don't resolve at all (DNS failure is a fetch failure)
    Accepts everything else, leaving robots.txt + TOS judgments to the
    caller (see audit's JD1).
    """
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        return False, f"urlparse failed: {exc}"
    if parsed.scheme.lower() not in _JD_ALLOWED_SCHEMES:
        return False, f"scheme {parsed.scheme!r} is not http/https"
    host = parsed.hostname
    if not host:
        return False, "URL has no hostname"
    try:
        infos = _socket.getaddrinfo(host, None)
    except OSError as exc:
        return False, f"DNS failure for {host!r}: {exc}"
    for info in infos:
        addr = info[4][0]
        try:
            ip = _ipaddress.ip_address(addr.split("%")[0])
        except ValueError:
            continue
        # is_global == "publicly routable" — covers loopback,
        # link-local, private, multicast, reserved in one shot.
        if not ip.is_global:
            return False, f"{host} resolves to non-public {ip}"
    return True, ""


async def _http_get(url: str, client: httpx.AsyncClient | None) -> bytes:
    ok, reason = _is_public_http_url(url)
    if not ok:
        raise JDFetchError(f"refusing to fetch {url}: {reason}")
    timeout = httpx.Timeout(15.0, connect=5.0)
    headers = {"User-Agent": "Vantage/0.1 (+https://relay.example/agent)"}
    if client is not None:
        resp = await client.get(url, timeout=timeout, headers=headers)
    else:
        async with httpx.AsyncClient(follow_redirects=True) as fresh:
            resp = await fresh.get(url, timeout=timeout, headers=headers)
    if resp.status_code >= 400:
        raise JDFetchError(f"{url} → HTTP {resp.status_code}")
    # Cheap pre-flight: trust an honest Content-Length header to short-
    # circuit obviously oversized responses before we load .content. A
    # lying / missing header falls through to the post-hoc len() guard
    # below, which catches the loaded-into-memory size.
    declared = resp.headers.get("content-length")
    if declared is not None:
        try:
            n = int(declared)
            if n > _JD_MAX_BYTES:
                raise JDFetchError(
                    f"refusing {url}: content-length {n} > {_JD_MAX_BYTES} bytes"
                )
        except ValueError:
            pass  # bad header, fall through to the post-hoc check
    body = resp.content
    if len(body) > _JD_MAX_BYTES:
        raise JDFetchError(
            f"refusing {url}: body {len(body)} > {_JD_MAX_BYTES} bytes"
        )
    return body


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[\t \xa0]+")


def _strip_html(html: str) -> str:
    """Best-effort tag strip without pulling in a BS4 dep."""
    no_tags = _TAG_RE.sub(" ", html)
    # Collapse multiple spaces but preserve newlines so LLM still sees structure.
    lines = [_WS_RE.sub(" ", line).strip() for line in no_tags.splitlines()]
    return "\n".join(line for line in lines if line)


# ─── LLM parse ─────────────────────────────────────────────────────────


def _load_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


async def _llm_parse_jd(
    jd_text: str, company: str, role_title: str, source: ATSSource
) -> dict[str, Any]:
    if not jd_text.strip():
        return _empty_parsed()
    try:
        model = pick_model("fast", temperature=0.0, max_tokens=2048)
    except RuntimeError as exc:
        # OPENROUTER_API_KEY missing — degrade rather than fail the workflow.
        log.warning("jobmatch.no_llm_key", error=redact_exception_text(str(exc)))
        return _empty_parsed()

    sys_prompt = _load_prompt("parse_jd.v1.md")
    user_payload = (
        f"Company: {company}\nRole: {role_title}\nSource: {source}\n\n"
        f"--- JD TEXT ---\n{jd_text[:18_000]}"
    )
    try:
        resp = await model.ainvoke(
            [SystemMessage(content=sys_prompt), HumanMessage(content=user_payload)]
        )
    except Exception as exc:  # noqa: BLE001 — degrade rather than fail the workflow
        log.error("jobmatch.llm_failed", error=redact_exception_text(str(exc)))
        return _empty_parsed()

    parsed = _safe_json(resp.content)
    return _normalize_parsed(parsed)


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        return json.loads(s)
    except json.JSONDecodeError:
        log.warning("jobmatch.invalid_json_response", preview=str(content)[:200])
        return {}


def _empty_parsed() -> dict[str, Any]:
    return {
        "skills": [],
        "level": "unspecified",
        "salary_min": None,
        "salary_max": None,
        "salary_currency": None,
        "locations": [],
        "remote": "unspecified",
        "must_haves": [],
        "nice_to_haves": [],
        "responsibilities": [],
        "tech_stack": [],
    }


# JD_H4 (round-12): defensive bounds on salary values. The round-12
# jobmatch-hallucination audit pointed out that _normalize_parsed used
# to pass through whatever the LLM emitted — including negative
# salaries, ones large enough to make downstream matching pointless
# (10^10), and swapped min/max where the LLM put the bigger number
# first. None of these are honest extractions, so dropping them to
# None is the safer signal: "we couldn't read a salary here", not "this
# job pays −$50,000".
_JD_SALARY_MIN_BOUND = 0
_JD_SALARY_MAX_BOUND = 5_000_000  # well above any honest annual figure


def _sanitize_salary(val: Any) -> int | None:
    if val is None:
        return None
    try:
        n = int(val)
    except (TypeError, ValueError):
        return None
    if n < _JD_SALARY_MIN_BOUND or n > _JD_SALARY_MAX_BOUND:
        return None
    return n


def _normalize_parsed(parsed: dict[str, Any]) -> dict[str, Any]:
    """Ensure every required key exists with the right type."""
    base = _empty_parsed()
    if not isinstance(parsed, dict):
        return base
    out: dict[str, Any] = {}
    for key, default in base.items():
        val = parsed.get(key, default)
        if isinstance(default, list) and not isinstance(val, list):
            val = []
        out[key] = val
    # JD_H4: sanitise numeric fields after the type/key reconciliation
    # above so the rest of the loop stays declarative.
    smin = _sanitize_salary(out.get("salary_min"))
    smax = _sanitize_salary(out.get("salary_max"))
    if smin is not None and smax is not None and smin > smax:
        # LLM swapped the order. Trust the *spread* but reorder so
        # downstream "min ≤ candidate-asks ≤ max" matching keeps working.
        smin, smax = smax, smin
    out["salary_min"] = smin
    out["salary_max"] = smax
    return out


# ─── persist ───────────────────────────────────────────────────────────


async def _upsert_job(
    *,
    source: ATSSource,
    external_id: str | None,
    company: str,
    role_title: str,
    jd_text: str,
    url: str,
    parsed: dict[str, Any],
) -> UUID | None:
    """UPSERT into jobs (UNIQUE(source, external_id)). Returns job id."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        log.info("jobmatch.skipped_persist_no_dsn", company=company, role_title=role_title)
        return None
    try:
        import psycopg
    except ImportError:
        log.error("jobmatch.psycopg_missing")
        return None

    sql = """
        INSERT INTO jobs (source, external_id, company, role_title, jd_text, url, parsed)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (source, external_id) DO UPDATE
           SET role_title = EXCLUDED.role_title,
               company    = EXCLUDED.company,
               jd_text    = EXCLUDED.jd_text,
               parsed     = EXCLUDED.parsed,
               updated_at = now()
        RETURNING id
    """
    params = (
        source,
        external_id,
        company,
        role_title,
        jd_text,
        url,
        json.dumps(parsed, default=str),
    )
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                row = await cur.fetchone()
            await conn.commit()
        return row[0] if row else None
    except Exception as exc:  # noqa: BLE001 boundary
        log.error("jobmatch.upsert_failed", error=redact_exception_text(str(exc)))
        return None
