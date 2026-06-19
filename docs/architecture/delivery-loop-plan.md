# 投递闭环 · Delivery Loop 作战计划

> 这是把 [`vision.md` 北极星](../vision.md) 与 [`product-spec.md` § 功能 5](../product-spec.md) 转译成可执行任务的施工说明。
>
> 上游设计：[`agent-architecture.md`](agent-architecture.md) · [`client-side-delivery.md`](client-side-delivery.md) · [`vantage-ui-mapping.md`](vantage-ui-mapping.md) · [`agent-harness.md`](agent-harness.md)

## 0. 为什么是这条路

调研结论（[`client-side-delivery.md`](client-side-delivery.md) 第 0 段，3 vs 0 票确认）：**纯 autofill 已被 Simplify / Jobright 免费占据**。Relay 必须直接做"方案 B / B+"——客户端执行 + 云端 LLM 智能填充 + Playwright MCP 远程操作浏览器，否则没有差异化。

而要让"方案 B+"真正跑起来，需要 5 个 agent 协作：

```
[user 在 dock 输入 JD URL]
    │
    ▼
JobMatch.parse_jd ──▶ ResumeAgent.customize ──▶ AppPrep.prepare_package
    │                       │                          │
    │                       │                          ▼
    │                       │                  Cover letter + form answers
    │                       │                          │
    ▼                       ▼                          ▼
                Audit + cost tracking (harness)        │
                                                       ▼
                                           [扩展打开 ATS → 填好 70%+25% 字段]
                                                       │
                                                       ▼
                                              [用户审核 → 亲自 Submit]
                                                       │
                                                       ▼
                                          application_drafts.status = submitted
                                                       │
                                                       ▼
                                            事件总线：application:submitted
                                                       │
                                                       ▼
                                   InterviewAgent 预热该 company+role 的题库
                                   TrendAgent 把这次匹配数据回写飞轮
```

这一条链跑通 = Relay 从 "demo" 变 "可用产品"。本计划围绕这条链组织任务。

## 1. 生产级验证指标 · North-Star Metric

**TTAR · Time-To-Application-Ready**

> 用户从 "粘贴一条 JD URL" 到 "扩展打开浏览器、表单填好、可以点 Submit" 的端到端耗时与质量。

### 1.1 为什么是 TTAR

- **覆盖整条链**：JD 抓取（JobMatch）→ 简历定制（Resume）→ 包准备（AppPrep）→ 扩展填表（Extension）。任一环节失败、慢、质量差，TTAR 都暴露。
- **直接服务北极星**：[`vision.md`](../vision.md) "≤3 次点击完成投递"用 TTAR 量化。
- **不可作弊**：把"返回 200"改成"返回真实可用结果"才有意义——任何环节 mock 出来都会被下游卡住。
- **强制对齐"AI 先做、用户后审"**：分子是 AI 工作时间，分母是用户决定的次数。

### 1.2 TTAR 三个子指标

| 子指标 | 目标（Phase 1 出货线） | 备注 |
|--------|--------------------|------|
| **TTAR-latency** · p95 端到端耗时 | ≤ 45s | JD 抓取 + customize + cover + form ≤ 35s；扩展打开 + 填表 ≤ 10s |
| **TTAR-success** · 完整跑通比例 | ≥ 85% | 任一节点失败、fabrication_guard 拒绝、扩展无法识别 ATS 都算失败 |
| **TTAR-quality** · 用户审核通过率 | ≥ 70% | "AI 填的字段中用户没改的比例"；按字段而非按 application 计算 |

### 1.3 TTAR 怎么测

- **CI 强制 gate**：`eval/delivery-loop/` 放 10 条 golden JD URL（Greenhouse / Lever / Ashby 各 3–4 条），每次 PR 跑完整链，TTAR-latency p95 退化 > 20% 则 fail；TTAR-success < 85% fail
- **生产实时**：Langfuse trace 中每条 application 都打 `ttar.*` 三个 attribute；Grafana 看每日 p95 / 成功率 / 质量分曲线
- **用户面**：在 review UI 里追踪"用户改了 AI 填的几个字段"→ 反推 TTAR-quality

### 1.4 反指标（不刷分用）

- **Fabrication rate**：fabrication_guard 拦截率 — 单独追踪，**不能为了 TTAR 提速而放松红线**
- **HITL rejection rate**：用户在审核时拒绝整次投递的比例 — 高了说明 AI 干得不够好，TTAR-quality 没真起作用
- **Cost / TTAR**：单次成功投递的 LLM 成本，Phase 1 目标 ≤ $0.005

---

## 2. Agent Team 协作设计

调研结论（[`agent-architecture.md`](agent-architecture.md) 已确认，2 vs 1 票）："默认 single-agent，按需拆分"。本计划遵守此原则——**不为每个新功能拆 agent**，而是把"投递闭环"映射到既有 5 个 agent + Coordinator 上。

### 2.1 各 agent 在闭环中的职责

| Agent | 当前状态 | 闭环里要新增的能力 | 模型 |
|-------|---------|------------------|------|
| **Coordinator** | 路由 + 工作流 ✅ | 新增 `prepare_application` 固定 workflow（StateGraph 模式 A） | — |
| **JobMatch** | 占位 | `parse_jd_from_url(url)` 抓 JD + 用 LLM 结构化 + 写入 jobs 表 | V4 Flash |
| **Resume** | parse/customize/optimize/analyze ✅ | 无新增——customize 已就位，闭环里直接调 | GLM-4.7 |
| **AppPrep** | 占位 | `generate_cover_letter` + `generate_form_answers` + `prepare_package` | GLM-4.7 + V4 Flash |
| **Interview** | 单机 mock ✅ | 闭环里被动方：监听 `application:interview_scheduled` 事件，预热题库（先打事件，不消费） | V4 Pro |
| **Trend** | 占位 | 闭环里被动方：每次 submit 后写一条 `application_submitted_signal`，供未来 ETL（先打事件，不消费） | V4 Flash |

### 2.2 不拆新 agent 的理由

可能有人想拆"ApplicationOrchestrator agent"或"FormFiller agent"。**不要**：
- "ApplicationOrchestrator" = Coordinator 的工作流，是图而非节点
- "FormFiller" = 扩展里的本地代码 + 远程 MCP 调用，不是 agent
- 拆 = O(N²) 协调成本 + 多一份 audit/cost/guard，不偿付

### 2.3 失败补偿

按 [`agent-architecture.md` § Saga 补偿](agent-architecture.md) 的 conditional edge 模式：

```
prepare_application 工作流：
  parse_jd_from_url
    └─ fail → coordinator 返回友好错误，不进 customize
  customize_resume
    └─ fabrication 3 次仍失败 → 标 prepare_failed_fabrication，不继续 cover
  generate_cover_letter
    └─ fail → 用模板兜底（标 fallback=true），继续 form
  generate_form_answers
    └─ fail → 仅给字段映射不给答案，继续到扩展
  hitl_review (interrupt)
    └─ reject → 整次扔掉，状态留 draft 供下次重试
```

每一级失败都有兜底，**不让一条链在中间断裂用户看到 spinner 永远转**。

---

## 3. 任务序列（围绕 TTAR 驱动）

按依赖排序。每个任务都明确 **Done 标准**（不写"完成"二字，而是写"什么状态才算 Done"），并标注它**改善 TTAR 的哪个子指标**。

### 任务 T1 · TTAR 度量基础设施（**先做这个**） ✅

没有度量就没有改进。第一步先让 TTAR 可观测。

**Done 标准**：
- `agents/harness/ttar.py` 提供 `with measure_ttar(application_id) as t:` context manager
- `application_drafts` 表新增 `ttar_metrics JSONB` 字段（迁移 014）：`{started_at, completed_at, latency_ms, success, stages: {parse_jd_ms, customize_ms, cover_ms, form_ms}, fabrication_attempts}`
- 端到端 e2e 测试 `agents/tests/test_ttar_measure.py` 跑一次空 workflow，验证 ttar_metrics 写入
- **改善的子指标**：所有三个（这是观测前提）

### 任务 T2 · JobMatch.parse_jd_from_url ✅

**Done 标准**：
- `agents/nodes/jobmatch_agent.py` 实现 `parse_jd_from_url(url: str) -> ParsedJD`
- 支持 Greenhouse / Lever / Ashby 三家（先用 httpx 拉 HTML，BeautifulSoup 抽公开字段；陌生 ATS 走 V4 Flash 抽取）
- 出参符合 jobs 表 `parsed JSONB` schema：`{skills, level, salary_min/max, locations, remote}`
- 写入 jobs 表 + 返回 `job_id`
- prompt `agents/prompts/jobmatch/parse_jd.v1.md`
- 单测 + 3 个真实 URL fixture 端到端测试
- **改善的子指标**：TTAR-latency（决定整条链能不能开始）

### 任务 T3 · AppPrep.prepare_package（工作流核心） ✅

**Done 标准**：
- `agents/nodes/appprep_agent.py` 实现 `generate_cover_letter(resume, jd) -> CoverLetter` 和 `generate_form_answers(resume, jd, fields) -> dict[field, answer]`
- `agents/coordinator/workflows.py` 新增 `build_prepare_application_graph()` 串起 parse_jd → customize → cover → form → hitl_review
- Saga 补偿按 §2.3 各级兜底
- API: `POST /api/applications/prepare` 改为真实跑（当前是占位 INSERT）
- prompt `agents/prompts/appprep/{cover_letter,form_answers}.v1.md` — 必须含红线"绝不虚构经历"
- **改善的子指标**：TTAR-success + TTAR-quality

### 任务 T4 · Eval gate（CI 强制 TTAR） ✅

**Done 标准**：
- `eval/delivery-loop/golden.yaml` 10 条 JD（Greenhouse 4 / Lever 3 / Ashby 3 — 真实 URL，提前拉好 HTML snapshot 作 offline fixture，避免 CI 依赖外网）
- `.github/workflows/eval.yml` 新增 step 跑 prepare_application 全链，断言：
  - TTAR-latency p95 ≤ 45s（与 main branch baseline 对比，退化 >20% fail）
  - TTAR-success ≥ 85%
  - Fabrication rate = 0（红线）
- 失败时 PR comment 出对比表
- **改善的子指标**：TTAR 三项 + 红线（持续防退化）

### 任务 T5 · 扩展骨架（MV3 + 字段检测） ✅

**Done 标准**：
- `apps/extension/` 起一个 MV3 项目（Bun + TypeScript + WXT 框架）
- content script 能识别 Greenhouse / Lever / Ashby 表单 + 抽出字段列表
- popup 显示"Detected N fields, click to fill with Vantage"
- service worker 与 api 的 `POST /api/extension/handshake` 鉴权（复用 JWT）
- 暂不实际填表——先把 ATS 探测做对
- **改善的子指标**：TTAR-latency（扩展那 10s 的子段）

### 任务 T6 · 扩展本地填充（70% 字段） ✅

**Done 标准**：
- content script 把检测到的字段映射到 user profile（name/email/phone/links/locations）
- 用人性化时序填充（每字段间随机 50–200ms）
- 高亮 AI 填充的字段（border-bottom: gold dashed）
- popup 显示"Filled X of Y fields, Z need your review"
- 不调云端 LLM，0 成本
- **改善的子指标**：TTAR-latency + TTAR-quality（这一段质量高，dock 那段就轻）

### 任务 T7 · 扩展云端 LLM 字段映射（25% 字段） ✅

**Done 标准**：
- 未匹配字段 → POST `/api/extension/map-fields` → AppPrep.generate_form_answers
- 返回字段 → 扩展填入并高亮
- 单次 API 调用，端到端 ≤ 3s
- **改善的子指标**：TTAR-quality + TTAR-success

### 任务 T8 · 投递事件总线（飞轮预埋） ✅

**Done 标准**：
- 扩展成功 submit 后回调 `POST /api/applications/:id/submitted`
- 路由发 Redis Stream 事件 `application:submitted`
- `agents/events/bus.py` 设置 2 个空消费者（interview_agent_preheat + trend_agent_signal），仅 log 不动作
- 飞轮链路打通但不做任何 ML——为 Phase 1.5 留接口
- **改善的子指标**：长期飞轮（不直接进 TTAR，但确保闭环数据不丢）

---

## 4. 出货顺序与节奏

| 顺序 | 任务 | 估时 | 阻塞关系 |
|------|------|------|---------|
| 1 | T1 度量 | 0.5 天 | 无 |
| 2 | T2 parse_jd | 1 天 | T1 |
| 3 | T3 AppPrep | 1.5 天 | T2 |
| 4 | T4 Eval gate | 1 天 | T3 |
| 5 | T5 扩展骨架 | 1 天 | T1（要打 TTAR） |
| 6 | T6 本地填充 | 1 天 | T5 |
| 7 | T7 云端字段映射 | 0.5 天 | T3 + T6 |
| 8 | T8 事件总线 | 0.5 天 | T7 |

**关键路径** ≈ 6–7 天密集开发。前 4 个任务（T1–T4）让"prepare API 真的跑得通 + CI 防退化"，是必须先一气拿下的。

---

## 5. 何时回到本文档

每个任务 Done 之后：
1. 更新本节"任务序列"对应任务的状态（在标题旁加 ✅）
2. 把当周 TTAR 三项数据补到下面的 "TTAR History" 表
3. 如果 TTAR 在某一项上没达标 → 在 §3 末尾新增分析任务 Tn+1

### TTAR History

| 日期 | latency p95 | success | quality | fabrication rate | 备注 |
|------|-------------|---------|---------|------------------|------|
| 2026-06-19 | 5–13 ms | 90.0% | n/a (no UI yet) | 0.0 | hermetic baseline — LLM 全 stub，fixture-only。T4 落地，CI ttar-gate 起跑。quality 等扩展 T5–T7 上线产生字段编辑数据再补 |
| 2026-06-19 | 9–52 ms | 90.0% | n/a (no real user yet) | 0.0 | T5–T8 + T3b 落地后回归。扩展端 70% 本地 + 25% 云端通道打通；submit → application:submitted Redis Stream 飞轮预埋；TS gateway prepare-from-jd 转发 Python。quality 等首批用户面试 ATS 表单后再 backfill。 |
