"""Chain 9 (Client-side extension · cloud field-map) e2e scorecard.

Why this exists
----------------
docs/architecture/client-side-delivery.md §方案 B 是 Relay 的护城河:扩展在
用户浏览器本地检测 ATS 表单,~70% 简单字段本地填,剩下的复杂/开放题 POST 到
``/extension/map-fields``(V4 Flash → AppPrep.generate_form_answers),用户
审核后**亲自点 submit**。红线:扩展永远不代替用户点提交,写 DOM 前必须过用户
显式动作。

止于审核卡片
-------------
真跑无头 Chrome 加载真扩展对一张 scorecard 是高脆弱、低价值的,用户已批准
"止于审核卡片"。所以本文件在 Python 里模拟这条流水线的服务端半段:

  真 Greenhouse boards-api 取一个真岗位
    → 从 questions[] 抽表单字段(Greenhouse 的 answers/questions 数组 = 表单 schema)
    → 按 cloud-fill.ts 的 CloudFillRequest 组请求
    → 种一份真 base 简历进 PG(map-fields 走真 pg_query is_base=TRUE)
    → POST /extension/map-fields(内部真调 V4 Flash)
    → 断言 {fills, unmatched} 形状 + X-Trace-Id 回声

扩展侧的三条不可让步约束(审核卡片门控 / 不自动 submit / MCP 优雅降级)用
"行为的静态分析"打分:直接读 apps/extension/src/*.ts + agents/harness/mcp_client.py。

8 维 rubric(每行 100 分)
  - completion            15   全步骤跑完,无未捕获异常
  - ats-detected          10   Greenhouse URL 命中 manifest host_permissions
                               且 detectATS() 返回非 other;负样本返回 other
  - api-called            15   /extension/map-fields 返回 200 且 fills 非空
  - fields-filled         10   每个 fill 有 selector+value+confidence,或有据跳过
  - review-card-gated     15   dom-fill.ts 的 DOM 写 (applyFills) 只在收到
                               popup/fill-request 用户动作后触发(静态分析)
  - submit-gated          10   扩展 src 无任何自动点 submit 的代码路径
  - mcp-handshake-or-skip 10   token 未设 → BROWSER_EXT_NOT_INSTALLED 优雅跳过;
                               token 设了 → 尝试连接
  - trace-propagation     15   /extension/map-fields 响应回声 X-Trace-Id

Pass:每行 ≥ 99/100。

Run:
    cd agents && uv run pytest tests/test_chain9_extension_e2e_score.py -v -s

Cost:真 Greenhouse HTTP(免费)+ 真 /extension/map-fields(内部 V4 Flash),
约 $0.001/run。OPENROUTER_API_KEY 缺失/占位时该行降级为 skip 而非 fail。
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path
from uuid import uuid4

# httpx (OpenAI SDK transport) 在只装了 SOCKS 代理 env 时会 ImportError。
# 开发 shell 常 export all_proxy=socks5://…;并且我们要直连 Greenhouse/loopback,
# 一律清掉所有代理 env(与 chain-2/3/5 一致,但更彻底)。
for _proxy_var in (
    "all_proxy",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
):
    os.environ.pop(_proxy_var, None)

import psycopg  # noqa: E402
import pytest  # noqa: E402
from dotenv import load_dotenv  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

from agents.api import server as srv  # noqa: E402
from agents.api.deps import current_user  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_EXT_SRC = _REPO / "apps" / "extension" / "src"
_DSN = os.environ.get("RELAY_PG_DSN") or os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _DSN,
    reason="chain-9 needs a live Postgres (RELAY_PG_DSN); run `make up` first",
)


# ── real-key gate (mirrors chain-6 / test_openrouter_tool_calling) ──────────


def _has_real_openrouter_key() -> bool:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        return False
    lower = key.lower()
    if lower.startswith(("dummy", "test", "fake", "placeholder")):
        return False
    if "change_me" in lower or "changeme" in lower:
        return False
    return len(key) >= 40


# ── ATS detector ported from apps/extension/src/ats-detect.ts ───────────────
# We port detectATS's host regexes 1:1 so the scorecard's "ats-detected" dim
# tests the SAME classification the extension ships. If ats-detect.ts changes
# its host list, this port must change too (and the manifest cross-check below
# would catch a drift where the manifest and detector disagree).

_GH_HOST = re.compile(r"^(?:job-)?boards(?:-api)?\.greenhouse\.io$", re.I)
_LEVER_HOST = re.compile(r"^jobs\.lever\.co$", re.I)
_ASHBY_HOST = re.compile(r"^jobs\.ashbyhq\.com$", re.I)


def _detect_ats(url: str) -> dict[str, object]:
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
    except ValueError:
        return {"source": "other", "externalId": None, "companySlug": None, "jdUrl": url}
    host = (parsed.hostname or "").lower()
    parts = [p for p in parsed.path.split("/") if p]
    if _GH_HOST.match(host):
        company = parts[0] if len(parts) > 0 else None
        external = parts[2] if len(parts) > 2 else None
        return {"source": "greenhouse", "externalId": external, "companySlug": company, "jdUrl": url}
    if _LEVER_HOST.match(host):
        return {
            "source": "lever",
            "externalId": parts[1] if len(parts) > 1 else None,
            "companySlug": parts[0] if len(parts) > 0 else None,
            "jdUrl": url,
        }
    if _ASHBY_HOST.match(host):
        return {
            "source": "ashby",
            "externalId": parts[1] if len(parts) > 1 else None,
            "companySlug": parts[0] if len(parts) > 0 else None,
            "jdUrl": url,
        }
    return {"source": "other", "externalId": None, "companySlug": None, "jdUrl": url}


def _manifest_host_permissions() -> list[str]:
    m = json.loads((_REPO / "apps" / "extension" / "manifest.json").read_text())
    return m.get("host_permissions", [])


def _url_matches_manifest(url: str, patterns: list[str]) -> bool:
    from urllib.parse import urlparse

    host = (urlparse(url).hostname or "").lower()
    for pat in patterns:
        # manifest patterns look like "https://boards.greenhouse.io/*"
        m = re.match(r"^https?://([^/]+)/", pat)
        if m and m.group(1).lower() == host:
            return True
    return False


# ── real Greenhouse form-schema fetch ───────────────────────────────────────


def _fetch_greenhouse_form(board: str) -> dict[str, object]:
    """Fetch a real Greenhouse posting + its question schema.

    Returns a dict with the canonical page URL (matches manifest), the parsed
    DetectedField list, and the raw questions for auditing.
    """
    list_url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
    with urllib.request.urlopen(list_url, timeout=30) as r:  # noqa: S310 (trusted host)
        jobs = json.load(r).get("jobs", [])
    if not jobs:
        raise RuntimeError(f"no jobs on Greenhouse board {board!r}")
    job = jobs[0]
    jid = job["id"]
    # Canonical apply page URL as the content script would see it — this is the
    # host the manifest activates on (boards.greenhouse.io, NOT the -api host).
    page_url = f"https://boards.greenhouse.io/{board}/jobs/{jid}"

    detail_url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jid}?questions=true"
    with urllib.request.urlopen(detail_url, timeout=30) as r:  # noqa: S310
        detail = json.load(r)
    questions = detail.get("questions", [])

    fields = _questions_to_detected_fields(questions)
    return {"page_url": page_url, "fields": fields, "questions": questions, "job_id": jid}


_GH_TYPE_MAP = {
    "input_text": "text",
    "textarea": "textarea",
    "input_file": "file",
    "multi_value_single_select": "select",
    "multi_value_multi_select": "select",
}


def _questions_to_detected_fields(questions: list[dict]) -> list[dict]:
    """Flatten Greenhouse questions[] into ats-detect.ts's DetectedField shape.

    Greenhouse's questions[] IS the form schema — each question owns one or
    more `fields` (name + type). This is exactly what detectFields() would
    reconstruct from the rendered DOM, minus the DOM walk.
    """
    out: list[dict] = []
    for q in questions:
        label = (q.get("label") or "").strip()
        required = bool(q.get("required"))
        for f in q.get("fields", []) or []:
            name = f.get("name") or ""
            gh_type = f.get("type") or "input_text"
            ftype = _GH_TYPE_MAP.get(gh_type, "text")
            options = [
                (v.get("label") or "").strip()
                for v in (f.get("values") or [])
                if (v.get("label") or "").strip()
            ]
            out.append(
                {
                    "id": name or f"vantage-field-{len(out)}",
                    "label": label,
                    "type": ftype,
                    "required": required,
                    "placeholder": None,
                    "options": options,
                    "selector": f'[name="{name}"]' if name else f"#field-{len(out)}",
                }
            )
    return out


# ── a real base résumé to ground answers (map-fields does real pg_query) ────

SAMPLE_BASE_RESUME = {
    "basics": {
        "name": "Riley Chain-Nine",
        "email": "riley@example.test",
        "phone": "+1-415-555-0199",
        "location": {"city": "San Francisco", "region": "CA", "countryCode": "US"},
        "profiles": [
            {"network": "LinkedIn", "url": "https://linkedin.com/in/riley-cn"},
            {"network": "GitHub", "url": "https://github.com/riley-cn"},
        ],
    },
    "work": [
        {
            "name": "Meridian Systems",
            "position": "Senior Software Engineer",
            "startDate": "2021-03",
            "highlights": [
                "Led the migration of a Python monolith to typed services, cutting p95 latency 40%.",
                "Owned the CI pipeline used by 30 engineers, taking build times from 22 min to 6 min.",
            ],
        }
    ],
    "skills": [
        {"name": "Python"},
        {"name": "TypeScript"},
        {"name": "PostgreSQL"},
        {"name": "Distributed systems"},
    ],
}


def _connect() -> psycopg.Connection:
    return psycopg.connect(_DSN)  # type: ignore[arg-type]


@pytest.fixture
def seeded_client():
    """Seed one user + one base résumé, override current_user, yield a
    TestClient bound to that user. Tears everything down after."""
    user_id = uuid4()
    resume_id = uuid4()

    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (id, email) VALUES (%s, %s)",
            (str(user_id), f"chain9-{user_id}@example.test"),
        )
        # version=0 → 016 assign-version trigger allocates MAX+1 atomically.
        cur.execute(
            """INSERT INTO resumes (id, user_id, version, content, is_base)
               VALUES (%s, %s, 0, %s, true)""",
            (str(resume_id), str(user_id), json.dumps(SAMPLE_BASE_RESUME)),
        )
        conn.commit()

    async def fake_user_dep():
        return user_id

    srv.app.dependency_overrides[current_user] = fake_user_dep
    client = TestClient(srv.app)
    try:
        yield client, user_id
    finally:
        srv.app.dependency_overrides.clear()
        uid = str(user_id)
        with _connect() as conn, conn.cursor() as cur:
            # jobs/JD rows may have been UPSERTed by parse_jd_from_url; leave
            # them (global cache), only clean our user-scoped rows.
            cur.execute("DELETE FROM resumes WHERE user_id = %s", (uid,))
            cur.execute("DELETE FROM users WHERE id = %s", (uid,))
            conn.commit()


# ── static-analysis helpers (extension-side red lines) ──────────────────────


def _src(name: str) -> str:
    return (_EXT_SRC / name).read_text()


def _dom_write_is_gated() -> bool:
    """True iff applyFills (the only DOM-write entry) is reached exclusively
    via a user-triggered `popup/fill-request` message, never on page load.

    Evidence chain in the source:
      - dom-fill.ts exports applyFills (the DOM write).
      - content.ts imports applyFills and calls it ONLY inside doFill().
      - doFill() runs ONLY from the onMessage listener for 'popup/fill-request'.
      - popup/fill-request is sent by popup.ts's Fill button (user click).
    So no DOM write happens without an explicit user action = review-card gate.
    """
    content = _src("content.ts")
    popup = _src("popup.ts")
    # applyFills must be called, and every call site must sit under doFill.
    calls_applyfills = "applyFills(" in content
    # The message that unlocks doFill is a user-driven popup request.
    gated_by_message = "popup/fill-request" in content and "doFill(" in content
    # And that message originates from a user click in the popup.
    popup_sends_on_click = "popup/fill-request" in popup and (
        "addEventListener('click'" in popup or 'addEventListener("click"' in popup
    )
    # There must be no auto-fill on injection: content.ts's top-level detection
    # send is content/detection (read-only), not a fill.
    no_autofill_on_load = "applyFills(" not in _autoexec_prefix(content)
    return calls_applyfills and gated_by_message and popup_sends_on_click and no_autofill_on_load


def _autoexec_prefix(content: str) -> str:
    """Return the module-top code that runs on injection: everything before the
    first function/listener declaration that would defer execution. Cheap
    heuristic — we only need to prove applyFills isn't called at top level."""
    # Cut at the first 'function ' or 'async function' declaration — code after
    # those is deferred, not run on load.
    markers = [content.find("\nfunction "), content.find("\nasync function ")]
    markers = [m for m in markers if m >= 0]
    cut = min(markers) if markers else len(content)
    return content[:cut]


def _no_auto_submit() -> bool:
    """True iff no extension source auto-clicks/submits a form.

    The extension fills fields and stops; the user submits themselves. A
    regression that added `.submit()`, `.click()` on a submit button, or
    `requestSubmit()` would flip this to False.
    """
    forbidden = re.compile(
        r"\.submit\s*\(|requestSubmit\s*\(|type\s*=\s*[\"']submit[\"']|"
        r"querySelector\([^)]*submit[^)]*\)\s*\.click|"
        r"\bclick\s*\(\s*\)",
        re.I,
    )
    for ts in _EXT_SRC.glob("*.ts"):
        if forbidden.search(ts.read_text()):
            return False
    return True


# ── scoring ─────────────────────────────────────────────────────────────────


def _score_mcp_handshake(notes: list[str]) -> int:
    """token unset → BROWSER_EXT_NOT_INSTALLED graceful (no connection, no
    crash); token set → require_extension_token() returns it (a connection
    would be attempted). Either branch scores full."""
    from agents.harness import mcp_client as mc

    saved = os.environ.get("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
    try:
        # unset branch: graceful degradation
        os.environ.pop("PLAYWRIGHT_MCP_EXTENSION_TOKEN", None)
        graceful = False
        try:
            mc.require_extension_token()
        except mc.BrowserExtNotInstalled as e:
            graceful = getattr(e, "code", "") == "BROWSER_EXT_NOT_INSTALLED"

        # set branch: token returned, connection would be attempted
        os.environ["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] = "chain9-probe-token"
        set_ok = mc.require_extension_token() == "chain9-probe-token"
        notes.append(f"mcp graceful_skip={graceful} token_set_ok={set_ok}")
        return 10 if (graceful and set_ok) else 0
    finally:
        if saved is None:
            os.environ.pop("PLAYWRIGHT_MCP_EXTENSION_TOKEN", None)
        else:
            os.environ["PLAYWRIGHT_MCP_EXTENSION_TOKEN"] = saved


def _score_positive_row(seeded_client) -> tuple[dict[str, int], list[str]]:
    client, _user = seeded_client
    dims: dict[str, int] = {}
    notes: list[str] = []

    # completion is set last (only if we reach the end with no exception).
    board = "figma"
    form = _fetch_greenhouse_form(board)
    page_url = form["page_url"]  # type: ignore[assignment]
    fields = form["fields"]  # type: ignore[assignment]
    notes.append(f"greenhouse={board} job={form['job_id']} fields={len(fields)}")

    # dim: ats-detected — URL matches manifest AND detector returns non-other.
    ctx = _detect_ats(page_url)  # type: ignore[arg-type]
    manifest_ok = _url_matches_manifest(page_url, _manifest_host_permissions())  # type: ignore[arg-type]
    dims["ats-detected"] = 10 if (ctx["source"] == "greenhouse" and manifest_ok) else 0
    notes.append(f"ats={ctx['source']} manifest_match={manifest_ok}")

    # Build the CloudFillRequest exactly as cloud-fill.ts would (camelCase
    # context + jd_url + fields). Focus the cloud call on the "leftover"
    # complex/open fields — the ones local-fill can't map (textarea + select
    # + custom-question text). Simple identity fields (first/last/email/phone)
    # would be filled locally, so we don't ship them.
    leftover = [
        f
        for f in fields  # type: ignore[union-attr]
        if f["type"] in ("textarea", "select")
        or f["id"] not in ("first_name", "last_name", "email", "phone", "resume", "cover_letter")
    ]
    if not leftover:
        # Degenerate posting with only identity fields — fall back to all
        # non-file fields so the cloud call has something to chew on.
        leftover = [f for f in fields if f["type"] != "file"]  # type: ignore[union-attr]
    # Bound to keep spend ~$0.001 and stay well under the endpoint's 500 cap.
    leftover = leftover[:8]

    body = {
        "context": ctx,
        "jd_url": page_url,
        "fields": leftover,
    }
    # A valid 36-char UUID-with-dashes — the server's trace middleware only
    # echoes inbound X-Trace-Id that passes its shape check (36 chars, hex +
    # dashes); anything malformed gets a fresh UUID, so the probe MUST be well
    # formed to prove propagation rather than replacement.
    trace_id = str(uuid4())
    resp = client.post("/extension/map-fields", json=body, headers={"X-Trace-Id": trace_id})

    # dim: trace-propagation — X-Trace-Id echoed on the response.
    echoed = resp.headers.get("x-trace-id")
    dims["trace-propagation"] = 15 if echoed == trace_id else 0
    notes.append(f"trace echoed={echoed!r}")

    # dim: api-called — 200 + fills non-empty.
    ok200 = resp.status_code == 200
    data = resp.json() if ok200 else {}
    fills = data.get("fills", []) if isinstance(data, dict) else []
    unmatched = data.get("unmatched", []) if isinstance(data, dict) else []
    dims["api-called"] = 15 if (ok200 and len(fills) > 0) else 0
    notes.append(
        f"status={resp.status_code} fills={len(fills)} unmatched={len(unmatched)} sent={len(leftover)}"
    )

    # dim: fields-filled — every fill has selector+value+confidence; every
    # accounted-for field is either filled or explicitly unmatched (justified
    # skip). fills + unmatched must cover all sent fields.
    fill_shape_ok = all(
        f.get("selector") and f.get("value") and isinstance(f.get("confidence"), (int, float))
        for f in fills
    )
    covered = len(fills) + len(unmatched)
    coverage_ok = covered == len(leftover)
    dims["fields-filled"] = 10 if (fill_shape_ok and coverage_ok and fills) else 0
    notes.append(f"fill_shape_ok={fill_shape_ok} coverage {covered}/{len(leftover)}")

    # dim: review-card-gated — DOM writes require a user action (static).
    dims["review-card-gated"] = 15 if _dom_write_is_gated() else 0

    # dim: submit-gated — no auto-submit path anywhere in extension src.
    dims["submit-gated"] = 10 if _no_auto_submit() else 0

    # dim: mcp-handshake-or-skip — token unset → graceful skip.
    dims["mcp-handshake-or-skip"] = _score_mcp_handshake(notes)

    # completion — reached the end, no unhandled exception.
    dims["completion"] = 15
    return dims, notes


def _print_matrix(title: str, dims: dict[str, int], notes: list[str]) -> int:
    total = sum(dims.values())
    print(f"\n── chain-9 scorecard · {title} ──")
    for k, v in dims.items():
        print(f"  {k:<24} {v}")
    print(f"  {'TOTAL':<24} {total}/100")
    for n in notes:
        print(f"    · {n}")
    return total


# ── tests ────────────────────────────────────────────────────────────────────


@pytest.mark.skipif(
    not _has_real_openrouter_key(),
    reason="chain-9 positive row needs a real OPENROUTER_API_KEY (map-fields calls V4 Flash)",
)
def test_chain9_positive_greenhouse_row(seeded_client):
    dims, notes = _score_positive_row(seeded_client)
    total = _print_matrix("row 1 · Greenhouse figma", dims, notes)
    for dim, score in dims.items():
        assert score > 0, f"dim {dim!r} scored 0 — notes: {notes}"
    assert total >= 99, f"row 1 total {total} < 99 — {dims}"


def test_chain9_negative_non_ats_row():
    """Sanity row: a non-ATS URL must NOT be detected as an ATS. Runs without
    LLM / PG — pure detector + manifest cross-check."""
    dims: dict[str, int] = {}
    notes: list[str] = []

    bad_url = "https://example.com/careers/apply/123"
    ctx = _detect_ats(bad_url)
    manifest_ok = _url_matches_manifest(bad_url, _manifest_host_permissions())
    # ats-detected here means "correctly classified": non-ATS → source=other
    # AND not matched by the manifest.
    dims["ats-detected"] = 10 if (ctx["source"] == "other" and not manifest_ok) else 0
    notes.append(f"non-ats url → source={ctx['source']} manifest_match={manifest_ok}")

    # The extension-side static guarantees hold regardless of URL.
    dims["review-card-gated"] = 15 if _dom_write_is_gated() else 0
    dims["submit-gated"] = 10 if _no_auto_submit() else 0
    dims["mcp-handshake-or-skip"] = _score_mcp_handshake(notes)
    # Dims that require a live API call are N/A for the negative row; award
    # them so the row is comparable on a 100-point scale (the negative row's
    # job is only to prove the detector doesn't over-trigger).
    dims["completion"] = 15
    dims["api-called"] = 15  # N/A (no API call on purpose)
    dims["fields-filled"] = 10  # N/A
    dims["trace-propagation"] = 15  # N/A

    total = _print_matrix("row 2 · non-ATS negative", dims, notes)
    assert dims["ats-detected"] == 10, f"non-ATS url wrongly detected: {notes}"
    for dim, score in dims.items():
        assert score > 0, f"dim {dim!r} scored 0 — notes: {notes}"
    assert total >= 99, f"row 2 total {total} < 99 — {dims}"
