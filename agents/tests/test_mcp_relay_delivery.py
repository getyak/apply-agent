from __future__ import annotations

from agents.mcp_relay.delivery import (
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
