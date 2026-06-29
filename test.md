# Relay · Agent 自循环评分测试链路设计

> **目标**：让 Relay 的每个 agent（以及 5-agent 编排链路）在一条可重放、可打分、可自动迭代的测试通道里跑，agent 通过自身循环不断校验自己的输出，**直到对每条 goal 都拿到满分（或在预算耗尽前逼近满分），并把分数固化进 CI gate**。
>
> 这不是"再写一遍 pytest"。pytest / Promptfoo / TTAR gate 都是这套体系的子集；本文档把它们组织成一个 **Generator → Evaluator → Refiner → Verifier** 的闭环，让 agent 在 CI 里"对着 rubric 自我修复"，与 Relay 已有的 `eval/delivery-loop`、`agents/harness/ttar.py`、`agents/harness/guards.py`、`fabrication_guard`、AG-UI `RelayEmitter` 无缝拼合。
>
> 关联：[`docs/architecture/agent-harness.md`](docs/architecture/agent-harness.md) · [`docs/architecture/agent-architecture.md`](docs/architecture/agent-architecture.md) · [`docs/architecture/cicd-aiops-harness.md`](docs/architecture/cicd-aiops-harness.md) · [`docs/architecture/vantage-ui-mapping.md`](docs/architecture/vantage-ui-mapping.md) · [`eval/delivery-loop/run.py`](eval/delivery-loop/run.py)

---

## 0. 一页总览

```
                ┌───────────────────────────────────────────────────┐
                │   GOAL · 单个测试场景（goal + rubric + budget）     │
                │   eval/agent-loops/<agent>/<goal>.yaml             │
                └────────────────────────┬──────────────────────────┘
                                         ↓
       ┌─────────────────────────────────────────────────────────────┐
       │  ROUND 0 · GENERATE                                          │
       │  agent.run(input)  →  Artifact_v0                            │
       │  RelayEmitter 收集 AG-UI 事件 / TTARRecord 收集 stage 延迟    │
       └────────────────────────┬────────────────────────────────────┘
                                ↓
       ┌─────────────────────────────────────────────────────────────┐
       │  EVALUATE · 评分管线（rubric-driven, 多 judge 投票）          │
       │  ① 硬约束（must_pass）— fabrication / PII / contract / cost   │
       │  ② LLM-as-judge（V4 Pro, 三视角:correctness/safety/UX）       │
       │  ③ 行为指标（TTAR / latency / event ordering / hitl latency） │
       │  → Score_v0 = {axis: {score, evidence, deductions[]}}        │
       └────────────────────────┬────────────────────────────────────┘
                                ↓
                  ┌─────── score ≥ goal.target_score? ────────┐
                  │ YES                                       │ NO
                  ↓                                           ↓
       ┌──────────────────┐         ┌────────────────────────────────────┐
       │  VERIFY · 对抗   │         │  REFINE                              │
       │  adversarial    │         │  agent.refine(prev_artifact, score) │
       │  judge × 3      │         │  prompt 注入 deductions[] 让 agent  │
       │  全票通过才 PASS │         │  自我修复;budget 计数 +1            │
       └─────────┬────────┘         └────────────────────┬────────────────┘
                 ↓                                       │
              PASS                                       │ refine_round < max
                                                         ↓
                                              回到 EVALUATE
```

**核心理念**：
- **goal = 测试合同**。每个 goal 文件声明输入、rubric（多轴权重）、目标分、预算上限、必通硬门。
- **rubric = 行为契约**，不是模糊的"质量好不好"。每条 rubric 项都有 evidence_query（机器可读断言）+ judge_prompt（LLM 判官）。
- **闭环 = 自我修复**。score < target 时，把 deductions 注入下一轮 prompt，让 agent 自己改，不是测试框架伪造数据。
- **满分不是终点，verify 才是**。达到 target 后必须过 adversarial verifier（多 judge 投票）才算 PASS，避免"刷分但实际错"。
- **预算优先于满分**。`max_refine_rounds` / `cost_ceiling` / `latency_ceiling` 是硬上限；超额则记录"最高分但未达标"并 fail CI。

---

## 1. 设计原则（不可让步）

| # | 原则 | 操作含义 |
|---|------|----------|
| **R1** | **每个 goal 都有满分定义** | rubric 的所有轴加权 = 100；不允许"凭感觉打 8.5/10" |
| **R2** | **硬约束零容忍** | fabrication / PII 泄漏 / contract 违约 / cost 超预算 = 直接 0 分，不进 refine 循环 |
| **R3** | **judge 必须可对抗** | 单 judge 不算数；满分前 verify 阶段必须跑 ≥3 个独立判官，全票通过 |
| **R4** | **refine 是 agent 的事** | 测试框架不修改 agent 输出；只把 deductions 喂回 agent，agent 自己改 |
| **R5** | **预算硬上限** | refine_rounds ≤ 5 / session cost ≤ $0.50 / wallclock ≤ 5min；超额 fail，不无限循环 |
| **R6** | **可重放 + hermetic** | 同一 goal + 同 git sha 必须可复现；LLM 通过 cassette 或 deterministic stub 隔离 |
| **R7** | **分数固化 CI** | 每个 goal 的 target_score 进 main 分支 baseline，回退 > 5% 触发 PR block |
| **R8** | **trace 贯通** | 测试链路与生产 trace 共用 `X-Trace-Id` 模型（见 `docs/architecture/error-handling.md` §5）；Langfuse 可一键查每一轮 refine |

---

## 2. Goal 文件结构

每个 agent 的能力切片用一个 YAML 文件描述，落在 `eval/agent-loops/<agent>/<goal>.yaml`：

```yaml
# eval/agent-loops/resume_agent/customize-stripe-srm.yaml
goal:
  id: resume.customize.stripe-srm
  agent: resume_agent
  capability: customize          # parse | customize | analyze | build_from_scratch
  description: |
    给定 Alice 的 base résumé 和 Stripe Senior Reliability Engineer JD,
    生成 tailored 简历,必须:① 不编造(fabrication_guard 0 命中)
    ② summary 出现 "reliability" / "incident" 关键词 ③ skills 包含 JD 前 3 个硬技能
    ④ 总 token 成本 ≤ $0.02 ⑤ 不触发 LLM_BUDGET_EXHAUSTED

input:
  base_resume_id: alice-v3        # 来自 eval/fixtures/resumes/
  jd_fixture: stripe-srm          # 来自 agents/tests/fixtures/jd/
  user_id: 00000000-0000-0000-0000-00000000a11ce
  locale: en

# 硬约束:任一不通过 → score = 0, 不进 refine
must_pass:
  - id: no_fabrication
    type: fabrication_guard
    expect: { violations: 0 }

  - id: no_pii_leak
    type: redaction_check
    expect: { leaked_entities: 0 }

  - id: agui_event_contract
    type: agui_contract
    expect:
      starts_with: RUN_STARTED
      ends_with: [RUN_FINISHED, RUN_ERROR]
      no_orphan_step: true

  - id: cost_under_budget
    type: cost_ceiling
    expect: { max_cents: 2 }

# Rubric:加权 100;每轴有 evidence + judge_prompt
rubric:
  weight_total: 100
  axes:
    - id: jd_alignment
      weight: 30
      evidence:
        - kind: text_contains
          field: tailored.basics.summary
          terms_any: ["reliability", "incident", "on-call", "SRE"]
        - kind: jd_skill_overlap
          top_n_skills_from_jd: 3
          min_overlap: 2
      judge:
        model: deepseek/deepseek-v4-pro
        prompt_file: eval/judges/jd_alignment.v1.md
        scale: [0, 30]

    - id: honest_rephrase
      weight: 25
      evidence:
        - kind: named_entity_subset
          source: tailored
          base: base_resume          # 输出 NE ⊆ base NE
        - kind: number_subset
          tolerate_rounding: false
      judge:
        model: deepseek/deepseek-v4-pro
        prompt_file: eval/judges/honest_rephrase.v1.md
        scale: [0, 25]

    - id: structure_quality
      weight: 20
      evidence:
        - kind: jsonresume_v1_valid
        - kind: bullets_have_quant_verb
          min_ratio: 0.6
      judge:
        model: z-ai/glm-4.7
        prompt_file: eval/judges/structure_quality.v1.md
        scale: [0, 20]

    - id: latency_budget
      weight: 15
      evidence:
        - kind: ttar_stage_ms
          stage: customize_ms
          max_ms: 8000
      judge: null              # 纯指标轴, 无 LLM judge

    - id: trace_completeness
      weight: 10
      evidence:
        - kind: trace_id_propagated
          layers: [api, agents]
        - kind: audit_row_written
          table: agent_tasks
          where: { action: 'resume.customize' }
      judge: null

# 目标分(满分 100, 允许 95+ 算"satisfied")
target_score: 95
hard_fail_below: 70             # 单轮低于此分直接 fail, 不再 refine

# 自循环预算
refine:
  max_rounds: 4
  per_round_cost_cents: 0.5
  total_cost_cents: 2.0
  wallclock_seconds: 120
  # refine 时如何把 deductions 喂回 agent
  feedback_mode: structured     # structured | natural_language
  # agent 看到的反馈模板:
  feedback_template: eval/feedback_templates/resume_customize.v1.md

# Verify 阶段(目标分达成后才跑)
verify:
  judges:
    - model: deepseek/deepseek-v4-pro
      role: correctness
      prompt_file: eval/judges/verify_correctness.v1.md
    - model: z-ai/glm-4.7
      role: safety
      prompt_file: eval/judges/verify_safety.v1.md
    - model: deepseek/deepseek-v4-pro
      role: user_value
      prompt_file: eval/judges/verify_user_value.v1.md
  pass_quorum: 3                # 必须全票通过
  vote_default_on_uncertain: refute   # 不确定 = refute, 默认严格

# 基线对照(进 baseline.json, CI 检测退化)
baseline:
  key: resume.customize.stripe-srm
  metrics: [final_score, total_rounds_used, total_cost_cents, customize_ms]
  regression_tolerance:
    final_score: -3           # 比 baseline 低 3 分以上 → block
    total_cost_cents: +20%
    customize_ms: +25%
```

### 设计取舍

- **goal 是文档不是脚本**：YAML 描述意图，runner 才是脚本。这样产品/PM 也能 review rubric。
- **must_pass 与 rubric 分离**：硬门（fabrication）不该是"扣 30 分"，它要么过要么 0 分。两套体系清晰。
- **judge 文件独立**：`eval/judges/*.md` 是版本化 prompt（见 `cicd-aiops-harness.md` §3.1），可独立 A/B。
- **target_score 不是 100**：100 留给 verify 通过；95 是 evaluate 阶段的"足够好"门槛。

---

## 3. Evaluator 设计（三层评分）

### 3.1 Layer 1 — 硬约束（must_pass）

零容忍，全部用代码断言（不调 LLM）：

| 类型 | 实现位置 | 已有基础设施 |
|------|----------|-------------|
| `fabrication_guard` | 复用 `agents/nodes/resume_agent.py` 现有 guard | NE 提取 + 子集校验 |
| `redaction_check` | 复用 `agents/tests/test_redaction.py` 的 redactor | API key / DSN / 路径 |
| `agui_contract` | 复用 `web/src/lib/agent-events/__tests__/contract.test.ts` 的契约校验，但跑在 Python 侧 | RUN_STARTED / RUN_FINISHED 顺序、step 闭合、ulid 严格递增 |
| `cost_ceiling` | 复用 `agents/harness/cost_tracker.py` + `BudgetExhausted` | 单 session 美元上限 |
| `hitl_contract` | 校验 `@requires_approval` 工具确实触发 `interrupt()` | LangGraph state inspection |

任一 must_pass 失败 → **score = 0，写 ScoreCard，跳过 refine，直接 fail**。这是为了避免"agent 编造内容但 LLM judge 打了 80 分"这种灾难。

### 3.2 Layer 2 — Evidence（机器可读断言）

每轴的 `evidence[]` 是无 LLM 的客观检查，是 judge 打分的"已知事实"。例：

```python
# eval/runner/evidence.py
def check_jd_skill_overlap(artifact, jd_parsed, top_n=3, min_overlap=2) -> EvidenceResult:
    """JD 前 N 个硬技能 ∩ 输出 skills ≥ min_overlap?"""
    jd_skills = [s.lower() for s in jd_parsed["skills"][:top_n]]
    out_skills = [s["name"].lower() for s in artifact["tailored"].get("skills", [])]
    overlap = set(jd_skills) & set(out_skills)
    return EvidenceResult(
        passed=len(overlap) >= min_overlap,
        observed=list(overlap),
        expected_min=min_overlap,
    )
```

Evidence 输出会被注入 judge prompt（"已知事实：tailored 与 JD 前 3 技能交集 = ['python', 'k8s']"），减少 judge 的幻觉空间。

### 3.3 Layer 3 — LLM-as-Judge（评分轴）

每个 rubric 轴一个 judge（轴可禁用 judge，纯指标）。Judge prompt 模板示例：

```markdown
# eval/judges/jd_alignment.v1.md

你是 Relay 求职平台的简历评审专家。本任务是评估一份"针对特定 JD 定制的简历"
在 **JD 对齐度** 这个单一维度上的得分(满分 30)。

## 输入
- 基础简历(base):{base_resume_json}
- 目标 JD:{jd_text}
- 待评简历(tailored):{tailored_resume_json}
- 已收集的客观证据:{evidence_summary}

## 评分维度
- 30 分:summary/highlight 精准命中 JD 前 3 核心要求, 且能解释"为什么这段经历对应这条要求"
- 22-29:命中 2 项 + 改写流畅
- 14-21:命中 1 项 / 仅关键字堆砌
- 0-13:与 JD 关系微弱 / 通用模板

## 输出格式(STRICT JSON, **不要**输出其他内容)
{
  "score": <0-30 整数>,
  "evidence_cited": ["...具体引用 tailored 的字段..."],
  "deductions": [
    {"axis": "jd_alignment", "what": "summary 未提及 incident response", "fix_hint": "在 summary 加一句 '...led on-call rotations...'"}
  ],
  "confidence": <0-1>
}

## 红线
- 永远不要给"无法确认 fabrication"扣分, 那是 fabrication_guard 的事
- 不要重复 evidence_summary 已经说过的事
- deductions 必须 actionable(给 agent 看的修改建议)
```

**关键**：`deductions` 是结构化的，下一轮 refine 时会原样喂给 agent。这是闭环能 work 的根本。

### 3.4 Score 合成

```python
final_score = sum(
    axis.score for axis in rubric_axes if axis.score is not None
)  # 0-100

# Tiebreak rule: 同分时, fewer_rounds > lower_cost > lower_latency
status = (
    "PASS"       if final_score >= goal.target_score and verify_passed
    else "REFINE" if final_score >= goal.hard_fail_below and rounds_left > 0
    else "FAIL"
)
```

---

## 4. Refiner 设计（agent 自我修复）

### 4.1 反馈注入

`deductions[]` 是 evaluate 阶段所有 judge 给出的扣分理由集合。Refiner 把它们组装成一个 **"修改 brief"**，喂给同一个 agent：

```python
# eval/runner/refine.py
async def refine_round(agent_fn, goal, prev_artifact, prev_score, round_idx):
    """让 agent 自己改自己的输出。"""
    deductions = collect_deductions(prev_score.rubric)
    brief = render_template(
        goal.refine.feedback_template,
        prev_output=prev_artifact,
        deductions=deductions,
        round_idx=round_idx,
        cost_remaining_cents=goal.refine.total_cost_cents - prev_score.cost_cents,
    )
    # 关键: agent 调用方式与生产链路 *完全一致*
    # 不是另开一个 "fix" 入口; 而是把 brief 当成新一轮 user message
    return await agent_fn(input=goal.input, refine_brief=brief)
```

### 4.2 Feedback template 示例

```markdown
# eval/feedback_templates/resume_customize.v1.md

你刚才给出了一版 tailored 简历(见 prev_output)。
评分人指出了以下需要修复的问题(deductions), 请生成 **新的一版** 来修复它们,
其他部分保持稳定不变。

## 上一版 ↓
{prev_output_json}

## 必须修复的扣分项 ↓
{% for d in deductions %}
- **[{{ d.axis }}]** {{ d.what }}
  建议:{{ d.fix_hint }}
{% endfor %}

## 约束
- 仍然不允许编造任何不在 base résumé 里的事实(violation 直接 0 分)
- 总输出 token ≤ 2000
- 你还剩 {{ cost_remaining_cents }} 美分预算

## 第 {{ round_idx }}/{{ max_rounds }} 轮
```

### 4.3 Refine 终止条件

- ✅ `score ≥ target_score` 且 verify 全票通过 → PASS
- ❌ `score < hard_fail_below`(任何一轮) → 直接 FAIL, 不再 refine
- ❌ `round >= max_rounds` 仍未达标 → FAIL with `status="best_effort"`
- ❌ `total_cost_cents > goal.refine.total_cost_cents` → FAIL with `status="budget_exhausted"`
- ❌ `wallclock > goal.refine.wallclock_seconds` → FAIL with `status="timeout"`

**永远不允许"无穷循环刷分"**。Cost guard 与 R5 原则在测试层面再强化一次。

---

## 5. Verifier 设计（满分的对抗校验）

达到 `target_score` 不代表万事大吉——LLM judge 可能被 agent "刷分"骗过。Verify 阶段:

```
artifact_final ─┬─→ judge_A (correctness, V4 Pro)     ─┐
                ├─→ judge_B (safety,      GLM-4.7)     ├─→ quorum_vote(3-0)
                └─→ judge_C (user_value,  V4 Pro)      ─┘     │
                                                              ↓
                                                       PASS / REFUTED
```

- Verify judge 的 prompt **必须明确指示"默认尝试反驳; 不确定时投反对"**(与生产 fabrication_guard 同一哲学)。
- 三个 judge 视角必须**不同**(correctness / safety / user_value), 不能三个一样——否则只是冗余而非对抗。
- 任一 judge 投 refute → 回到 refine(直到预算耗尽)。
- 三票全过 → PASS, 写入 baseline。

Verify 的成本最贵(3 × V4 Pro), 所以只在 `target_score` 达成后跑一次。

---

## 6. 与现有基础设施的整合（不重写, 只编排）

| 现有组件 | 在本测试链路中的角色 |
|---------|---------------------|
| `eval/delivery-loop/run.py` + `golden.yaml` | 升级为本文档的一个 goal(`prepare_application.golden-batch.yaml`), 保留 TTAR gate |
| `agents/harness/ttar.py` | 提供 `latency_budget` 轴的原始数据(stages dict) |
| `agents/harness/cost_tracker.py` | 提供 `cost_ceiling` must_pass + `total_cost_cents` 闸门 |
| `agents/harness/guards.py` (BudgetExhausted) | refine 循环里捕获 → 触发 `budget_exhausted` FAIL |
| `agents/harness/events.py` (RelayEmitter) | 收集 AG-UI 事件流给 `agui_contract` must_pass |
| `agents/tests/contract/test_agui_compat.py` | 把它的 schema 校验逻辑抽到 `eval/runner/checks/agui.py` 复用 |
| `agents/nodes/resume_agent.py::fabrication_guard` | 直接复用, 作为 must_pass 的实现 |
| Promptfoo (cicd-aiops-harness.md §3.2) | 仍然保留作为 **prompt 改动的 gate**, 与本测试链路解耦——promptfoo 是黑盒文本 eval, 本链路是有状态多轮 agent loop |
| Langfuse(self-host) | 每一轮 refine 一个 trace, 共用 `X-Trace-Id` 模型; `final_score` 作为 trace metadata |
| LangGraph PostgresSaver | 每个 goal 跑在独立 `thread_id = eval:<goal_id>:<git_sha>:<run_id>`; 测试结束清理 |

**Runner 落点**：`eval/agent-loops/run.py`（新增），与已有 `eval/delivery-loop/run.py` 并列；后者保留为"TTAR 数值 gate"，前者是"行为契约 gate"。

---

## 7. 报告与 Score Card

每一次 goal 运行产出一份 `score-card.json`（CI artifact + PR comment）：

```json
{
  "goal_id": "resume.customize.stripe-srm",
  "git_sha": "e3cf808",
  "started_at": "2026-06-30T08:12:31Z",
  "status": "PASS",
  "rounds": [
    {
      "round": 0,
      "final_score": 78,
      "must_pass": { "no_fabrication": "PASS", "cost_under_budget": "PASS", "agui_event_contract": "PASS", "no_pii_leak": "PASS" },
      "axes": {
        "jd_alignment":      { "score": 18, "weight": 30, "deductions": [{"what": "summary 未提及 incident response"}] },
        "honest_rephrase":   { "score": 25, "weight": 25 },
        "structure_quality": { "score": 15, "weight": 20 },
        "latency_budget":    { "score": 15, "weight": 15 },
        "trace_completeness":{ "score": 5,  "weight": 10, "deductions": [{"what": "audit_row 未写入"}] }
      },
      "cost_cents": 0.42,
      "latency_ms": 6480
    },
    {
      "round": 1,
      "final_score": 96,
      "axes": { "...": "..." },
      "refine_brief_tokens": 410,
      "cost_cents": 0.38,
      "latency_ms": 5910
    }
  ],
  "verify": {
    "correctness": { "verdict": "approve", "confidence": 0.92 },
    "safety":      { "verdict": "approve", "confidence": 0.88 },
    "user_value":  { "verdict": "approve", "confidence": 0.95 },
    "quorum": "3-0",
    "decision": "PASS"
  },
  "baseline_delta": {
    "final_score":     "+1",    "vs": 95,
    "total_cost_cents":"-3%",   "vs": 0.82,
    "customize_ms":    "+4%",   "vs": 5687
  },
  "trace_url": "https://langfuse.relay.dev/traces/01HXYZ..."
}
```

PR comment 渲染表格 + 折叠完整 JSON，与 `eval/delivery-loop` 现有 PR comment job 对齐。

---

## 8. 覆盖矩阵 · 用一张表说"哪些 goal 必跑"

| 层 | Goal id 前缀 | 数量(初版) | 必跑条件 | 备注 |
|---|---|---|---|---|
| **Agent 单能力** | `resume.parse.*` | 3 | PR 改 `agents/nodes/resume_agent.py` | parse 是最稳的, 3 条边界 case 即可 |
|  | `resume.customize.*` | 6 | PR 改 prompt/resume_agent | 不同 JD × 不同 base résumé |
|  | `resume.analyze.*` | 2 |  |  |
|  | `interview.fetch_intel.*` | 3 | PR 改 interview_agent | 4 modes × 抽 3 |
|  | `interview.translate_feedback.*` | 4 | PR 改 prompt | 重点:不允许编造面试官内心 |
|  | `jobmatch.parse_jd.*` | 4 | PR 改 jobmatch | Greenhouse/Lever/Ashby/unknown |
|  | `appprep.cover_letter.*` | 3 | PR 改 appprep | 不同 tone |
|  | `trend.daily_snapshot.*` | 2 | nightly only | 大数据量, 跑 ETL |
| **Workflow 编排** | `prepare_application.*` | 1(继承现有 golden) | 任何 agent 改 | 升级现有 `eval/delivery-loop` |
|  | `mock_interview.*` | 4(每 mode 1) | PR 改 interview/coordinator | 沉浸模式 + HITL |
|  | `ask_vantage.intent.*` | 6 | PR 改 router | Layer 1 + Layer 2 分类正确率 |
| **跨层契约** | `agui.event_stream.*` | 5 | PR 改 events.py / web reducer | 复用 contract.test.ts |
|  | `hitl.interrupt_resume.*` | 3 | PR 改 permissions / interrupt 流 | submit_form / send_email / delete |
|  | `error_envelope.cross_layer.*` | 4 | PR 改 error-handling | DB_UNAVAILABLE / LLM_BUDGET_EXHAUSTED |

**总量 ≈ 50 条** goal，按 path-based filter 触发（`dorny/paths-filter`，与 `ci.yml` 矩阵一致），单条平均 < 20 秒。

---

## 9. CI 集成 · 触发与 gate

```yaml
# .github/workflows/agent-loops.yml(新增, 与 eval.yml 解耦)
on:
  pull_request:
  schedule: [{ cron: '0 8 * * *' }]   # nightly full sweep

jobs:
  agent-loops:
    runs-on: ubuntu-latest
    services:
      postgres:  { image: pgvector/pgvector:pg16, ports: ['5433:5432'], env: { POSTGRES_PASSWORD: ci } }
      redis:     { image: redis:7-alpine,         ports: ['6380:6379'] }
    strategy:
      matrix:
        # 按 agent 切分, parallel
        suite: [resume, interview, jobmatch, appprep, trend, workflow, contract]
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - name: Run agent loop suite
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          RELAY_EVAL_MODE: gate
        run: |
          uv run python eval/agent-loops/run.py \
            --suite ${{ matrix.suite }} \
            --report /tmp/score-${{ matrix.suite }}.json
      - name: Compare to baseline
        run: uv run python eval/agent-loops/baseline_check.py \
            --report /tmp/score-${{ matrix.suite }}.json \
            --baseline eval/agent-loops/baseline.json
      - uses: actions/upload-artifact@v4
        with: { name: score-${{ matrix.suite }}, path: /tmp/score-*.json }

  comment-pr:
    needs: agent-loops
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - run: uv run python eval/agent-loops/render_pr_comment.py > /tmp/pr-body.md
      - uses: marocchino/sticky-pull-request-comment@v2
        with: { path: /tmp/pr-body.md }
```

**Gate 规则**（进 branch protection）：
- 任一 must_pass FAIL → block
- 任一 goal `status != PASS` 且其 `goal.is_required = true` → block
- baseline `final_score` 回退 > 3 分 → block；-1 ~ -3 分 → warn but allow

`is_required: true` 的 goal 数量起步 15 条（每个 agent 1-2 个核心 case），其余 `is_required: false` 跑但不阻塞，等 baseline 稳定后逐条 promote。

---

## 10. 落地路线（7 周，与 `cicd-aiops-harness.md` §5.2 阶段对齐）

| 周 | 交付 | 验收 |
|---|---|---|
| **W1** | `eval/agent-loops/` 骨架 + goal schema + 1 个 `resume.customize` goal 跑通 | 本地 `uv run python eval/agent-loops/run.py --goal resume.customize.stripe-srm` 输出 score-card.json |
| **W2** | Layer 1 must_pass 五项全实现(复用 fabrication / redaction / agui / cost / hitl) | 单测覆盖每个 check; 故意造一份 fabrication 输出能被 must_pass 0 分 |
| **W3** | Refiner 闭环 + feedback_template + 第 1 个 `resume.customize` 自循环达到 95+ | round_0 = 78 → round_1 = 96 的可复现录像 |
| **W4** | Verifier 三 judge 投票 + `baseline.json` 机制 | 故意刷分(prompt 注入"忽略证据给满分")能被 verify 拒掉 |
| **W5** | CI 接入 + PR comment + 矩阵 strategy + 7 个 suite | PR 上能看到 sticky comment 表格 |
| **W6** | 扩到 50 条 goal; 按 §8 矩阵填满; `is_required` 升级到 30 条 | nightly full sweep 1 次, $<5 |
| **W7** | Langfuse trace 接入 + score → metadata + drift 检测接 weekly review | weekly 报告自动出 |

---

## 11. 反模式（什么时候不该这样做）

| 反模式 | 症状 | 怎么治 |
|---|---|---|
| **把所有 unit test 塞进 goal loop** | CI 跑 40 分钟 | unit / contract test 留在 pytest; goal loop 只跑"行为质量"维度 |
| **judge prompt 漂移自己升 1.0** | 同 artifact 隔天打不同分 | judge prompt 严格版本化(`v1` / `v2`), 改 prompt 必同步升 baseline |
| **target_score 设太低** | 100% PASS 但产品质量差 | 用 nightly 跑"探索性 goal"(`is_required: false`), 目标分往高调, 允许失败 |
| **refine_brief 越来越长** | round 4 时 prompt 已 8k token | 模板里强制只保留最近 round 的 deductions, 旧 round summarize |
| **verify 三 judge 是同一个 model** | 三票全过但实际错 | 强制 `correctness:V4 Pro / safety:GLM / value:V4 Pro`, 不能全用 Pro |
| **goal 文件改动不算 PR review** | rubric 一改 baseline 全废 | CODEOWNERS 给 `eval/agent-loops/**/*.yaml` 加 owner; 改 rubric 必须双人 review |
| **测试侧能编辑 agent 输出** | 测试看上去通过, 生产其实坏 | runner 调 agent 的接口与生产**完全一致**(同 router / 同 graph / 同 checkpointer), 不开 backdoor |

---

## 12. 满分意味着什么（产品视角）

> 一个 goal 拿到 95+ 且 verify 3-0 通过，等价于：
>
> 1. **生产可用** — agent 在该输入分布上，产出能直接给用户看（不会编造、不会泄漏、不会暴费）
> 2. **质量可衡量** — 加权 100 分维度可解释："为什么这一版比上一版好/差"
> 3. **回退可发现** — 任何 PR 让该 goal 掉分 > 3 → CI 红 → 回滚之前不让 land
> 4. **改 prompt 可放心** — 改 prompt 不再凭"感觉变好"，必须 baseline 对照
> 5. **数据飞轮可量化** — 用户 opt-in 的真实输出可以加进 goal 的 input，看分数自然攀升或下滑
>
> 这是 Relay "Quality > Quantity"（vision.md 原则 1）在测试侧的具体落地。

---

## 13. Open questions

| Q | 当前倾向 | 何时定 |
|---|---|---|
| Judge 用 V4 Pro 还是开源 model 自部署? | 先 V4 Pro(成本可控, 3 judge × 50 goal × 5 PR/day ≈ $2/day); Phase 2 评估 Qwen2.5-72B self-host | W4 baseline 稳定后 |
| goal yaml schema 用 pydantic 还是 jsonschema 校验? | pydantic(已经在 agents/ 用) | W1 实现时定 |
| refine 时是否允许 agent 看到上轮的 judge prompt? | 不允许(避免 reward hacking); 只看 deductions | W3 实现 |
| baseline 存哪里? | `eval/agent-loops/baseline.json` 进 git; 主分支 merge 后自动 PR 更新 | W4 |
| 与 Promptfoo 的关系? | 完全解耦: Promptfoo 跑"prompt-文本-输出"黑盒; 本链路跑"多轮有状态 agent" | 已定 |
| HITL 在 goal loop 里怎么跑? | runner 注入 `decide_callback`, 自动 approve 模拟决策; `hitl.interrupt_resume.*` goal 专测拒绝/超时分支 | W2 |

---

## 14. 参考与交叉引用

- [`docs/architecture/agent-harness.md`](docs/architecture/agent-harness.md) — Loop guards / HITL / fabrication_guard 的实现根
- [`docs/architecture/agent-architecture.md`](docs/architecture/agent-architecture.md) §"为什么是 5 个 agent" — 决定了 goal 矩阵的分组
- [`docs/architecture/cicd-aiops-harness.md`](docs/architecture/cicd-aiops-harness.md) §3 — Promptfoo / DeepEval 的协作边界
- [`docs/architecture/vantage-ui-mapping.md`](docs/architecture/vantage-ui-mapping.md) — UI 触发的 agent 路径, 与 goal 输入分布对齐
- [`docs/architecture/error-handling.md`](docs/architecture/error-handling.md) §5 — Trace 端到端贯通, 被本测试链路复用
- [`eval/delivery-loop/run.py`](eval/delivery-loop/run.py) — 现有 TTAR gate, 本设计的**祖父**
- [LangGraph testing guide](https://docs.langchain.com/oss/python/langgraph/test) — 节点/全图/中段三层测试粒度
- Promptfoo red-team / DeepEval — 仍保留作为黑盒文本 eval
