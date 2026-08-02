"""Browser-delivery target classification and batch safety contracts."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Any, Literal
from urllib.parse import parse_qs, urlparse

BrowserCheckpointStage = Literal["before_fill", "before_submit"]

_ACTIVE_CHALLENGE_MARKERS = (
    "verify you are human",
    "complete the captcha",
    "captcha challenge",
    "security check",
    "device verification",
    "滑块验证",
    "安全验证",
    "验证码",
)
_LOGIN_MARKERS = (
    "sign in to apply",
    "log in to apply",
    "login to apply",
    "登录后继续",
    "登录/注册",
    "输入手机号",
    "password",
)
_MISSING_JOB_MARKERS = (
    "404 error",
    "job not found",
    "job you requested was not found",
    "no longer accepting applications",
    "职位已下线",
    "职位不存在",
)


def classify_application_target(job_url: str) -> dict[str, Any]:
    """Return a deterministic execution policy for a public job URL."""

    parsed = urlparse(job_url)
    host = (parsed.hostname or "").lower().rstrip(".")

    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"}:
        platform = "greenhouse"
        support = "public_form_fill"
        login_expected = False
    elif host == "jobs.lever.co":
        platform = "lever"
        support = "public_form_fill"
        login_expected = False
    elif host == "jobs.ashbyhq.com":
        platform = "ashby"
        support = "public_form_fill"
        login_expected = False
    elif host == "www.zhipin.com" or host.endswith(".zhipin.com"):
        platform = "boss_zhipin"
        support = "user_login_and_manual_handoff"
        login_expected = True
    elif "myworkdayjobs.com" in host:
        platform = "workday"
        support = "user_login_and_guided_fill"
        login_expected = True
    else:
        platform = "other"
        support = "inspect_before_fill"
        login_expected = None

    return {
        "platform": platform,
        "host": host,
        "support": support,
        "login_expected": login_expected,
        "execution": "user_browser_only",
        "automation_stops": [
            "job URL redirects to a different job, 404, or expired posting",
            "job-platform login or password prompt",
            "CAPTCHA, device verification, or anti-bot challenge",
            "unsupported demographic, legal, salary, sponsorship, or eligibility question",
            "final Submit/Apply action until this application is approved",
        ],
        "submission_gate": {
            "dom_button_state_is_authorization": False,
            "requires_current_turn_user_confirmation": True,
            "approval_scope": "one_application",
        },
    }


def assess_browser_checkpoint(
    *,
    expected_job_url: str,
    observed_url: str,
    visible_text: str = "",
    stage: BrowserCheckpointStage = "before_fill",
    expected_company: str | None = None,
    expected_role_title: str | None = None,
    expected_job_id: str | None = None,
    observed_company: str | None = None,
    observed_role_title: str | None = None,
    observed_job_id: str | None = None,
) -> dict[str, Any]:
    """Assess an observed browser page before filling or reviewing submission.

    This is deliberately conservative. It never authorizes the final click:
    DOM visibility/enabled state is page state, not user intent.
    """

    if stage not in {"before_fill", "before_submit"}:
        raise ValueError("stage must be 'before_fill' or 'before_submit'")

    expected = urlparse(expected_job_url)
    observed = urlparse(observed_url)
    target = classify_application_target(expected_job_url)
    reasons: list[str] = []
    identity_required = expected_company is not None or expected_role_title is not None
    resolved_expected_job_id = expected_job_id or extract_ats_job_id(
        expected_job_url,
        target["platform"],
    )
    resolved_observed_job_id = observed_job_id or extract_ats_job_id(
        observed_url,
        target["platform"],
    )

    if (
        expected.scheme not in {"http", "https"}
        or not expected.hostname
        or observed.scheme not in {"http", "https"}
        or not observed.hostname
    ):
        reasons.append("expected and observed URLs must both be absolute http(s) URLs")
    else:
        if expected.scheme.lower() != observed.scheme.lower() or (
            expected.netloc.lower() != observed.netloc.lower()
        ):
            reasons.append("browser left the expected job-platform origin")
        elif not _same_job_flow(expected_job_url, observed_url, target["platform"]):
            reasons.append("browser is no longer on the expected job application")

    company_matches: bool | None = None
    role_matches: bool | None = None
    job_id_matches: bool | None = None
    if identity_required:
        if expected_company:
            if not observed_company or not observed_company.strip():
                reasons.append("browser job company was not supplied for identity verification")
                company_matches = False
            else:
                company_matches = _company_identity(expected_company) == _company_identity(
                    observed_company
                )
                if not company_matches:
                    reasons.append("browser job company does not match the tracked application")
        if expected_role_title:
            if not observed_role_title or not observed_role_title.strip():
                reasons.append("browser job role title was not supplied for identity verification")
                role_matches = False
            else:
                role_matches = _role_identity(expected_role_title) == _role_identity(
                    observed_role_title
                )
                if not role_matches:
                    reasons.append(
                        "browser job role title does not match the tracked application"
                    )
        if resolved_expected_job_id:
            job_id_matches = resolved_expected_job_id == resolved_observed_job_id
            if not job_id_matches:
                reasons.append("browser ATS job id does not match the tracked application")

    observed_query = parse_qs(observed.query)
    if "_security_check" in observed_query or observed.path.startswith("/napi/zpssrseo/"):
        reasons.append("job platform activated a security or anti-bot check")
    if observed.path.startswith("/web/user"):
        reasons.append("job platform login is required")

    normalized_text = re.sub(r"\s+", " ", visible_text).strip().lower()[:20_000]
    if any(marker in normalized_text for marker in _ACTIVE_CHALLENGE_MARKERS):
        reasons.append("active CAPTCHA, verification, or security challenge is visible")
    if any(marker in normalized_text for marker in _LOGIN_MARKERS):
        reasons.append("login or credential entry is visible")
    if any(marker in normalized_text for marker in _MISSING_JOB_MARKERS):
        reasons.append("job posting is missing, closed, or no longer accepting applications")

    if target["support"] == "user_login_and_manual_handoff":
        reasons.append("this platform requires user login and manual handoff")
    elif target["support"] == "user_login_and_guided_fill":
        reasons.append("this platform requires user login before guided fill")
    elif target["support"] == "inspect_before_fill":
        reasons.append("this target requires manual inspection before any fill")

    reasons = list(dict.fromkeys(reasons))
    ready_for_fill = not reasons and target["support"] == "public_form_fill"
    status = (
        "stop" if reasons else "review_required" if stage == "before_submit" else "ready_for_fill"
    )
    return {
        "status": status,
        "stage": stage,
        "platform": target["platform"],
        "expected_job_url": expected_job_url,
        "observed_url": observed_url,
        "safe_to_fill": ready_for_fill and stage == "before_fill",
        "safe_to_submit": False,
        "stop_entire_batch": bool(reasons),
        "stop_reasons": reasons,
        "job_identity": {
            "required": identity_required,
            "expected": {
                "company": expected_company,
                "role_title": expected_role_title,
                "ats_job_id": resolved_expected_job_id,
            },
            "observed": {
                "company": observed_company,
                "role_title": observed_role_title,
                "ats_job_id": resolved_observed_job_id,
            },
            "matches": {
                "company": company_matches,
                "role_title": role_matches,
                "ats_job_id": job_id_matches,
            },
            "verified": identity_required
            and company_matches is not False
            and role_matches is not False
            and job_id_matches is not False
            and not any("identity verification" in reason for reason in reasons),
        },
        "submission_gate": {
            "dom_button_state_is_authorization": False,
            "requires_current_turn_user_confirmation": True,
            "approval_scope": "one_application",
        },
    }


def extract_ats_job_id(job_url: str, platform: str | None = None) -> str | None:
    """Extract a stable public ATS job id without trusting page text."""

    parsed = urlparse(job_url)
    resolved_platform = platform or classify_application_target(job_url)["platform"]
    parts = [part for part in parsed.path.split("/") if part]
    if resolved_platform == "greenhouse":
        if len(parts) >= 3 and parts[-2] == "jobs":
            return parts[-1]
        return None
    if resolved_platform in {"lever", "ashby"}:
        if len(parts) >= 2:
            return parts[1]
        return None
    return None


def _identity_tokens(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold().replace("&", " and ")
    return re.findall(r"[\w]+", normalized, flags=re.UNICODE)


def _company_identity(value: str) -> tuple[str, ...]:
    tokens = _identity_tokens(value)
    legal_suffixes = {
        "co",
        "company",
        "corp",
        "corporation",
        "inc",
        "incorporated",
        "limited",
        "llc",
        "ltd",
        "plc",
    }
    while tokens and tokens[-1] in legal_suffixes:
        tokens.pop()
    return tuple(tokens)


def _role_identity(value: str) -> Counter[str]:
    aliases = {
        "sr": "senior",
        "jr": "junior",
        "swe": "software_engineer",
        "dev": "developer",
    }
    tokens = [aliases.get(token, token) for token in _identity_tokens(value)]
    return Counter(tokens)


def _same_job_flow(expected_url: str, observed_url: str, platform: str) -> bool:
    expected = urlparse(expected_url)
    observed = urlparse(observed_url)
    expected_parts = [part for part in expected.path.split("/") if part]
    observed_parts = [part for part in observed.path.split("/") if part]

    if platform == "lever":
        return (
            len(expected_parts) >= 2
            and len(observed_parts) >= 2
            and expected_parts[:2] == observed_parts[:2]
            and observed_parts[2:]
            in (
                [],
                ["apply"],
            )
        )
    if platform == "ashby":
        return (
            len(expected_parts) >= 2
            and len(observed_parts) >= 2
            and expected_parts[:2] == observed_parts[:2]
            and observed_parts[2:]
            in (
                [],
                ["application"],
            )
        )
    if platform == "greenhouse":
        return (
            len(expected_parts) >= 3
            and len(observed_parts) >= 3
            and expected_parts[-2] == "jobs"
            and observed_parts[-2] == "jobs"
            and expected_parts == observed_parts
        )
    return expected.path.rstrip("/") == observed.path.rstrip("/")


def batch_safety_contract(item_count: int) -> dict[str, Any]:
    return {
        "item_count": item_count,
        "preparation_only": True,
        "blanket_submit_approval": False,
        "approval_granularity": "one_application",
        "parallel_final_submission": False,
        "resume_approval_required_per_compilation": True,
        "final_submit_confirmation_required_per_application": True,
        "dom_button_state_is_authorization": False,
        "stop_entire_batch_on": [
            "job URL redirects to a different job, 404, or expired posting",
            "CAPTCHA or anti-bot challenge",
            "account warning, rate limit, or platform risk signal",
            "job-platform login is required",
        ],
    }
