from __future__ import annotations

from agents.mcp_relay.delivery import (
    assess_browser_checkpoint,
    batch_safety_contract,
    classify_application_target,
)


def test_classifies_supported_public_ats_hosts_exactly() -> None:
    assert (
        classify_application_target("https://job-boards.greenhouse.io/example/jobs/123")["platform"]
        == "greenhouse"
    )
    assert classify_application_target("https://jobs.lever.co/example/abc")["platform"] == "lever"
    assert (
        classify_application_target("https://jobs.ashbyhq.com/example/abc")["platform"] == "ashby"
    )
    # Similar-looking attacker domains must not inherit a supported policy.
    assert (
        classify_application_target("https://jobs.lever.co.attacker.test/abc")["platform"]
        == "other"
    )
    assert (
        classify_application_target("https://evilmyworkdayjobs.com/example")["platform"] == "other"
    )


def test_boss_is_prepare_only_and_stops_for_login() -> None:
    target = classify_application_target("https://www.zhipin.com/job_detail/example.html")
    assert target["platform"] == "boss_zhipin"
    assert target["support"] == "user_login_and_manual_handoff"
    assert target["login_expected"] is True
    assert any("login" in stop for stop in target["automation_stops"])


def test_batch_contract_never_grants_blanket_submit() -> None:
    contract = batch_safety_contract(5)
    assert contract["preparation_only"] is True
    assert contract["blanket_submit_approval"] is False
    assert contract["approval_granularity"] == "one_application"
    assert contract["parallel_final_submission"] is False
    assert contract["dom_button_state_is_authorization"] is False


def test_public_ats_application_paths_are_safe_to_fill_but_never_submit() -> None:
    cases = [
        (
            "https://job-boards.greenhouse.io/example/jobs/123",
            "https://job-boards.greenhouse.io/example/jobs/123",
        ),
        (
            "https://jobs.lever.co/example/abc",
            "https://jobs.lever.co/example/abc/apply",
        ),
        (
            "https://jobs.ashbyhq.com/example/abc",
            "https://jobs.ashbyhq.com/example/abc/application",
        ),
    ]
    for expected, observed in cases:
        result = assess_browser_checkpoint(
            expected_job_url=expected,
            observed_url=observed,
            visible_text="Application form",
        )
        assert result["status"] == "ready_for_fill"
        assert result["safe_to_fill"] is True
        assert result["safe_to_submit"] is False
        assert result["submission_gate"]["dom_button_state_is_authorization"] is False


def test_submit_checkpoint_requires_review_even_when_dom_button_is_enabled() -> None:
    result = assess_browser_checkpoint(
        expected_job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        visible_text="Submit application",
        stage="before_submit",
    )
    assert result["status"] == "review_required"
    assert result["safe_to_fill"] is False
    assert result["safe_to_submit"] is False


def test_semantic_job_identity_is_required_and_normalized_conservatively() -> None:
    expected = "https://jobs.lever.co/openai/backend-123"
    missing = assess_browser_checkpoint(
        expected_job_url=expected,
        observed_url=f"{expected}/apply",
        expected_company="OpenAI, Inc.",
        expected_role_title="Senior Backend Engineer",
    )
    assert missing["status"] == "stop"
    assert missing["job_identity"]["verified"] is False
    assert any("not supplied" in reason for reason in missing["stop_reasons"])

    matching = assess_browser_checkpoint(
        expected_job_url=expected,
        observed_url=f"{expected}/apply",
        expected_company="OpenAI, Inc.",
        expected_role_title="Senior Backend Engineer",
        observed_company="OpenAI",
        observed_role_title="Backend Engineer, Sr.",
    )
    assert matching["status"] == "ready_for_fill"
    assert matching["job_identity"]["verified"] is True
    assert matching["job_identity"]["matches"] == {
        "company": True,
        "role_title": True,
        "ats_job_id": True,
    }


def test_same_url_with_reused_job_content_stops_before_fill() -> None:
    url = "https://job-boards.greenhouse.io/glossgenius/jobs/6681936003"
    result = assess_browser_checkpoint(
        expected_job_url=url,
        observed_url=url,
        expected_company="GlossGenius",
        expected_role_title="Senior Software Engineer",
        observed_company="Genius AI",
        observed_role_title="Software Engineer - All Levels",
        visible_text="Job Application for Software Engineer - All Levels at Genius AI",
    )
    assert result["status"] == "stop"
    assert result["safe_to_fill"] is False
    assert result["job_identity"]["verified"] is False
    assert result["job_identity"]["matches"]["company"] is False
    assert result["job_identity"]["matches"]["role_title"] is False


def test_stale_redirected_and_security_check_pages_stop_the_batch() -> None:
    stale = assess_browser_checkpoint(
        expected_job_url="https://jobs.ashbyhq.com/example/abc",
        observed_url="https://jobs.ashbyhq.com/example/abc",
        visible_text="Job not found",
    )
    redirected = assess_browser_checkpoint(
        expected_job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/attacker/abc/apply",
    )
    boss = assess_browser_checkpoint(
        expected_job_url="https://www.zhipin.com/job_detail/abc.html",
        observed_url=("https://www.zhipin.com/napi/zpssrseo/job_detail/abc.html?_security_check=1"),
        visible_text="登录/注册 输入手机号 验证码",
    )
    for result in (stale, redirected, boss):
        assert result["status"] == "stop"
        assert result["safe_to_fill"] is False
        assert result["safe_to_submit"] is False
        assert result["stop_entire_batch"] is True
        assert result["stop_reasons"]


def test_listing_pages_and_origin_changes_are_not_job_application_identity() -> None:
    cases = [
        (
            "https://jobs.lever.co/example",
            "https://jobs.lever.co/example",
        ),
        (
            "https://jobs.ashbyhq.com/example",
            "https://jobs.ashbyhq.com/example",
        ),
        (
            "https://job-boards.greenhouse.io/example",
            "https://job-boards.greenhouse.io/example",
        ),
        (
            "https://jobs.lever.co/example/abc",
            "http://jobs.lever.co/example/abc/apply",
        ),
        (
            "https://jobs.lever.co/example/abc",
            "https://jobs.lever.co:444/example/abc/apply",
        ),
    ]
    for expected, observed in cases:
        result = assess_browser_checkpoint(
            expected_job_url=expected,
            observed_url=observed,
        )
        assert result["status"] == "stop"
        assert result["safe_to_fill"] is False
