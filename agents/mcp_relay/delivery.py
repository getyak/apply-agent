"""Browser-delivery target classification and batch safety contracts."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse


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
            "job-platform login or password prompt",
            "CAPTCHA, device verification, or anti-bot challenge",
            "unsupported demographic, legal, salary, sponsorship, or eligibility question",
            "final Submit/Apply action until this application is approved",
        ],
    }


def batch_safety_contract(item_count: int) -> dict[str, Any]:
    return {
        "item_count": item_count,
        "preparation_only": True,
        "blanket_submit_approval": False,
        "approval_granularity": "one_application",
        "parallel_final_submission": False,
        "resume_approval_required_per_compilation": True,
        "final_submit_confirmation_required_per_application": True,
        "stop_entire_batch_on": [
            "CAPTCHA or anti-bot challenge",
            "account warning, rate limit, or platform risk signal",
            "job-platform login is required",
        ],
    }
