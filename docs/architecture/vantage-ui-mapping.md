# Vantage UI · Agent Teams 映射

> Vantage 是 Relay 在 UX 层的产品代号(claude.ai/design 导出的设计稿包名)。本文把 Vantage 的三个核心 UI 模块映射到 [`agent-architecture.md`](agent-architecture.md) 定义的 5 个 agent 上,讲清楚每条 chat 消息背后跑的是哪张 LangGraph,哪些 tool 会被调用,哪里要 HITL `interrupt()`,哪些数据落 PG 哪些进 Redis。
>
> Caller: `CLAUDE.md` References 段引用本文件;前端工程 PR review、agent 节点修改 PR review、prompt 改动 PR review 时必读。
>
> 相关交叉引用:[`system-overview.md`](system-overview.md) · [`agent-architecture.md`](agent-architecture.md) · [`agent-harness.md`](agent-harness.md) · [`client-side-delivery.md`](client-side-delivery.md) · [`../product-spec.md`](../product-spec.md)

---

## 0. 三个不可让步的设计决策

读完设计稿(`untitled/chats/chat2.md`)定稿的三条:

1. **Ask Vantage = 持久 dock**,不是 page。跨所有内容页驻留在左侧(248px 导航 → 372px dock → 主区),收起态 54px slim launcher。Mock live 自动收起 dock 进入沉浸模式。
2. **Résumé 视图 = 纯文档 + 版本时间轴**,**没有独立 chat**。所有"改简历"对话都走 Ask Vantage(产品官网原话:"Vantage is one conversation")。
3. **Mock interview = 可插拔模式**,不是一条 chat。`Mode = { 进场情报 × 追问行为 × 反馈风格 × 闭环方式 }`,4 个内置模式 + 用户自定义。

这三条同时决定了后端架构:Ask Vantage 是 Coordinator 的对话式入口(LangGraph StateGraph 模式 B),不是第 6 个 agent;Résumé view 是后端 ResumeAgent 的纯渲染面;Mock 是 InterviewAgent 的 4 tool × mode 配置编排。

---

## 1. Ask Vantage(持久 dock)

### 1.1 在 5-agent 架构里的位置

```
[User dock input] ──▶ ask_vantage_router (Coordinator)
                          │
                          ├─ intent: "find jobs"      ──▶ jobmatch_agent
                          ├─ intent: "tailor resume"  ──▶ resume_agent.customize
                          ├─ intent: "draft cover"    ──▶ appprep_agent
                          ├─ intent: "mock me"        ──▶ build_mock_graph(mode)
                          ├─ intent: "trends today"   ──▶ trend_agent
                          └─ intent: "build resume"   ──▶ build_from_scratch (固定 workflow)
```

**Ask Vantage ≠ 新 agent**,它是 `agents/coordinator/router.py` 的对话式 entry。所有领域 agent 仍然是 5 个,Ask Vantage 只是它们的统一对话外壳。

### 1.2 thread_id 模型(终身对话)

每个用户终身一个对话:`thread_id = ask_vantage:{user_id}`,落进 LangGraph PostgresSaver。这是数据飞轮的"用户上下文"载体 —— 用户用得越久,Ask Vantage 越懂他的求职史。

PG 上由 `conversation_sessions` 表承载,012 migration 加了 `session_type = 'ask_vantage'` 枚举和 `idx_sessions_ask_vantage_per_user` 部分唯一索引,保证一个用户最多一条 ask_vantage session。

### 1.3 意图分类的成本控制

不要每条 user message 都跑 LLM 分类。两层策略:

| 层 | 命中率 | 成本/条 | 实现 |
|----|--------|---------|------|
| Layer 1: 关键词 + 正则 | 预期 ~70% | $0 | `agents/coordinator/router.py` 里的 `cheap_intent_classifier()` |
| Layer 2: V4 Flash classifier | 剩下 ~30% | ~$0.0001 | 输出固定 JSON `{intent, confidence, args}` |

阈值:Layer 1 confidence >= 0.85 才采用;否则升级 Layer 2。

### 1.4 UI agent task card ↔ LangGraph 节点

设计稿里 chat 显示的"agent 执行卡片",每张对应一个 LangGraph 节点的进入/退出事件:

| UI 文案 | 节点 | 模型 |
|---------|------|------|
| `SCOUT AGENT · running` → `· 8 matches` | jobmatch_agent.find_matches | V4 Flash |
| `RÉSUMÉ AGENT · drafting v7` | resume_agent.customize | GLM-4.7 |
| `APPLICATION AGENT · preparing` | appprep_agent workflow | GLM-4.7 + V4 Flash |
| `INTERVIEW AGENT · loading intel` | interview_agent.fetch_intel | V4 Flash |
| `TREND AGENT · scanning today` | trend_agent.daily_snapshot | V4 Flash |

实现:FastAPI `/ask/stream` 以 SSE 推送 LangGraph 的 `astream_events` 事件,前端按 `event.name` 渲染卡片状态(spinner → check → result)。

### 1.5 「从零搭简历」固定 workflow

不是自由对话,是 [agent-architecture.md § 模式 A](agent-architecture.md) 的"固定 workflow":

```
ask_target_role → ask_recent_role → ask_top_3_wins → draft_v1 → hitl_review
```

每问一题给 **chip 候选答案**,避免空白焦虑。`hitl_review` 节点调 `interrupt()` 让用户审 v1。落码在 `agents/coordinator/workflows.py`。

---

## 2. Résumé(文档 + 版本时间轴)

### 2.1 形态

```
v1 ─ v2 ─ v3 ─ v4 ─ v5 ─ v6 ─ v7 (current)
              │
              └── "Sharpen for Stripe" (tailored)

[Live résumé document] — 编辑器
[Diff vs v6] — AI 生成段标珊瑚橙,需用户过目
[Upload new résumé] [Compare] [Export]
```

**这里没有 chat input**。改简历必须去左侧 dock 说。

### 2.2 数据流

```
用户 dock 里说 "Sharpen for Stripe"
   │
   ▼
ask_vantage_router → intent="tailor_resume", args={job: "stripe-..."}
   │
   ▼
resume_agent.customize(jd_id=stripe_jd_id, base_id=v6.id)
   │  ├─ Redis cache lookup: resume:tailored:{user}:{job}:{v6_hash}
   │  ├─ miss → GLM-4.7 生成
   │  └─ fabrication_guard: named entities ⊆ base
   ▼
INSERT INTO resumes (version=7, parent_version=v6.id, tailored_for_job=stripe.id)
   │
   ▼
event_bus.publish("resume:updated", {user_id, version: 7})
   │
   ▼
WebSocket → 前端时间轴长出 v7 (current),dock 出 result card "v7 saved · Open résumé"
```

### 2.3 Fabrication Guard(vision.md 红线)

`resume_agent.customize` 在 `post_model_hook` 里强制跑一次 NER 比对:

- v7 的 (公司名 ∪ 年份 ∪ title ∪ 量化数字) 必须是 base v6 的子集
- 不在集合内的新增 entity 视为 fabrication,reject → 重生成(最多 2 次)
- 仍失败 → 失败事件 + 不写 v7,UI 给 "Couldn't tailor without fabricating — try editing manually"

实现:`agents/nodes/resume_agent.py::fabrication_guard()`。

### 2.4 Upload new résumé 入口(绕过 dock)

设计稿后期补的入口:Résumé view 右上角 "Upload new" 按钮,直接走 `POST /resume/upload` → `resume_agent.parse` → 新建 `is_base = true` 的简历(时间轴新分支)。

不走 dock 是因为上传是个**物理动作**,语义上没必要塞进对话。

### 2.5 与 client-side-delivery 的衔接

Tailored 版本必须**镜像到 `chrome.storage.local`**,扩展投递时从本地读,服务端只保留最新一份用于 audit。这是客户端执行链路的最后一公里。

---

## 3. Mock interview(可插拔模式 = 四象限)

### 3.1 Mode = 四象限组合

```
Mode = {
    intel:    none | jd_based | crowdsourced | recruiter_specific
    pressure: encourage_only | one_follow_up | chained_to_stuck
    feedback: rating_1to5 | three_perspective_translation | one_line_per_answer
    loop:     standalone | save_to_card | replay_real_interview
}
```

**4 个内置模式**(由 `infra/postgres/migrations/013_seed_interview_modes.up.sql` 种入):

| Mode | intel | pressure | feedback | loop |
|------|-------|----------|----------|------|
| Scene recreation | crowdsourced | one_follow_up | three_perspective | save_to_card |
| Pressure drill | jd_based | chained_to_stuck | three_perspective + stuck_replay | save_to_card |
| Warm-up | none | encourage_only | three_perspective(soft) | standalone |
| Rapid fire | none | encourage_only | one_line_per_answer | save_to_card |

用户自定义 mode 落 `interview_modes` 表(user_id IS NOT NULL)。

### 3.2 4 个 tool 把模式四维落地

```python
# agents/nodes/interview_agent.py

@tool(level="AUTO")
def fetch_intel(company, role, round_type, mode) -> IntelBrief
# 实现 mode.intel:
#   none → 直接返回 None
#   crowdsourced → 查 interview_question_pool (vector + filter)
#   jd_based → 用 V4 Flash 从 JD 提"真正考点"
#   recruiter_specific → LinkedIn 公开信息(Phase 2)

@tool(level="AUTO")
def ask_question(state, mode) -> Question
# 实现 mode.pressure:
#   encourage_only → 用上一题答案温和切下一题
#   one_follow_up → state.last_answer 没被追问过就追问
#   chained_to_stuck → 连环追问到 state.stuck_count >= 2

@tool(level="AUTO")
def translate_feedback(answer, question, mode) -> Feedback
# 实现 mode.feedback:
#   three_perspective → V4 Pro 推断 "面试官听到的"+GLM-4.7 重写"建议改成"
#   one_line_per_answer → V4 Flash 单行评分
#   rating_1to5 → 兼容 real_prep,纯打分

@tool(level="NOTIFY")
def save_to_card(session_id, mode) -> InterviewCard
# 实现 mode.loop:
#   standalone → 不入库,只在 session 内可见
#   save_to_card → 落 interview_sessions+interview_questions+weak_points
#   replay_real_interview → 同时把题目脱敏后合进 interview_question_pool
```

### 3.3 动态 StateGraph

```python
def build_mock_graph(mode: InterviewMode) -> CompiledGraph:
    g = StateGraph(MockState)

    if mode.intel_strategy != "none":
        g.add_node("intel_brief", fetch_intel_node)
        g.set_entry_point("intel_brief")
        g.add_edge("intel_brief", "ask_question")
    else:
        g.set_entry_point("ask_question")

    g.add_node("ask_question", ask_question_node)
    g.add_node("await_answer", await_user_input)  # interrupt() 等用户答
    g.add_node("translate_feedback", translate_feedback_node)

    g.add_edge("ask_question", "await_answer")
    g.add_edge("await_answer", "translate_feedback")
    g.add_conditional_edges("translate_feedback", route_next_step, {
        "follow_up": "ask_question",
        "next_q":    "ask_question",
        "debrief":   "save_to_card",
    })
    g.add_node("save_to_card", save_to_card_node)
    g.add_edge("save_to_card", END)

    return g.compile(checkpointer=postgres_checkpointer)
```

`route_next_step()` 读 `mode.pressure` 决定下一跳:`encourage_only` 永远不 follow_up;`one_follow_up` 看 `state.last_was_follow_up`;`chained_to_stuck` 看 `state.stuck_count`。

### 3.4 三视角反馈(抓手 3)

这是 Mock 的核心差异化,**砍掉 1-5 评分**:

```json
{
  "you_said": "我负责了整个项目的架构设计。",
  "interviewer_heard": "他说'负责',但没说具体做了什么决策 — 可能只是挂名。我会追问。",
  "suggested_rephrase": "我主导了 X 的架构,在 A 和 B 之间选了 A,因为...",
  "stuck_replay": null
}
```

`interviewer_heard` 用 V4 Pro(深度推断 subtext),`suggested_rephrase` 用 GLM-4.7(改写)。`stuck_replay` 仅 `pressure_drill` mode 填,V4 Pro 复盘"卡在哪、该怎么接"。

**红线**:prompt 必须含"这是基于公开面试经验的推断,不代表真实面试官",落 `agents/prompts/interview/translate_feedback.v1.md`。

### 3.5 数据飞轮闭环(抓手 4)

vision.md 北极星 —— 这是 Vantage 不会被通用 AI 复制的护城河,**v1 就必须接通**:

1. **练完即沉淀**:每个 session → `interview_sessions.weak_points = [{skill: "Owning impact", confidence: 0.3, ...}]`
2. **真实面试回填**:debrief 页 "Log the real interview" → 新 session with `is_real = true`,只采集不评估
3. **下次开场反映**:新 mock 开始前,`fetch_intel` 查当前用户在该公司+角色+题型的 weak_points,开场提一句"你上次在 'Owning impact' 卡过,这次设为重点"
4. **众包题库**(opt-in):用户 opt-in 后,真实题目脱敏 → `interview_question_pool`(已带 1536-dim embedding)

### 3.6 沉浸模式 UX 约束

进 live 阶段:
- dock 自动收起到 54px launcher(state.uiHints.collapseDock)
- 侧边栏收起到 74px
- 全屏渲染 question + answer composer + 右栏 weak_points hint

退出 live(用户中止 / debrief 完成)→ 自动展开 dock,回到 setup 页。

---

## 4. 三模块协作总图

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (Next.js + WebSocket)                                 │
│  ┌──────┬──────────┬──────────────────────────────────────────┐ │
│  │ Nav  │ Ask      │ Content                                  │ │
│  │      │ Vantage  │  ├─ Today (trend snapshot)               │ │
│  │ 74-  │ dock     │  ├─ Applications (kanban)                │ │
│  │ 248px│ 54-372px │  ├─ Résumé (view + timeline, no chat)    │ │
│  │      │ 持久     │  └─ Mock (modes → intel → live → card)  │ │
│  └──────┴──────────┴──────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────────┘
                       │ SSE (/ask/stream)
                       │ WebSocket (HITL approval)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  api/ (TypeScript Hono + Bun)                                   │
│  /api/ask/stream   → SSE 推 LangGraph astream_events            │
│  /api/mock/start   → 启动 build_mock_graph(mode)                │
│  /api/resume/upload → 直调 resume_agent.parse                   │
│  /api/hitl/decide  → 收 approve/reject,Command(resume=...)      │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (FastAPI)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  agents/ (Python LangGraph)                                     │
│  coordinator/                                                   │
│    ├─ router.py        ask_vantage_router(对话式 conditional)   │
│    ├─ workflows.py     build_from_scratch(固定 workflow)        │
│    └─ saga.py          补偿编排                                 │
│  nodes/                                                         │
│    ├─ resume_agent.py  parse/customize/analyze + fabrication_g  │
│    ├─ interview_agent.py 4 tools + build_mock_graph(mode)       │
│    ├─ jobmatch_agent.py find_matches/parse_jd                   │
│    ├─ appprep_agent.py prepare_package/submit                   │
│    └─ trend_agent.py   daily_snapshot/personalize               │
│  harness/                                                       │
│    ├─ llm.py           ChatOpenRouter + 模型分层 + 成本计算     │
│    ├─ guards.py        CostGuard/TokenGuard/ErrorGuard          │
│    ├─ permissions.py   @requires_approval → interrupt()         │
│    ├─ checkpointer.py  PostgresSaver(PG 5433)                   │
│    ├─ context.py       60k 压缩 (pre_model_hook)                │
│    └─ audit.py         落 agent_tasks 表                        │
└──────────────────────┬──────────────────────────────────────────┘
                       │ PostgresSaver + Redis Streams
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  PG (5433)                                                      │
│    conversation_sessions (thread_id=ask_vantage:{user_id} 终身) │
│    resumes (version, parent_version, embedding)                 │
│    interview_modes (built-in 4 + user-custom)  ← 012/013        │
│    interview_sessions (mode_id, intel_brief, weak_points) ← 012 │
│    interview_questions (feedback_translation, follow_up_of)← 012│
│    agent_tasks (cost/latency/HITL 全留痕)                       │
│  Redis (6380)                                                   │
│    intel_brief:{company}:{role}:{round} TTL 7d                  │
│    resume:tailored:{user}:{job}:{v_hash} TTL 7d                 │
│    events: resume:updated, mock:weak_point_found, intel:cached  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 落地优先级(Phase 0 MVP)

| 优先级 | 项 | 状态 |
|--------|------|------|
| P0 | Schema(012+013) | ✅ 已落盘并三段验证 |
| P0 | harness 层(llm/guards/permissions/state/checkpointer/context/audit) | 🚧 同 PR 落 |
| P0 | interview_agent 4 tools + build_mock_graph | 🚧 同 PR 落 |
| P0 | ask_vantage_router + Layer 1 关键词分类 | 🚧 同 PR 落 |
| P0 | resume_agent parse/customize + fabrication_guard | 🚧 同 PR 落 |
| P0 | FastAPI /ask/stream + /mock/start + /resume/upload | 🚧 同 PR 落 |
| P1 | jobmatch/appprep/trend agent 节点 | 下一 PR |
| P1 | Tool calling smoke test(DeepSeek/GLM via OpenRouter) | 第一周必跑 |
| P1 | build_from_scratch workflow + chip 候选答案 schema | 同 P0 一起 |
| P2 | Mock 真实面试回填 + 众包 opt-in 隐私流程 | legal review 后 |
| P2 | Next.js 工程 + dock 持久组件 | 单独 PR(前端工程独立) |

---

## 6. 测试金字塔(对齐 cicd-aiops-harness.md § 3.4)

| 层 | 工具 | 覆盖什么 |
|---|------|---------|
| Unit | pytest | 4 个 tool 的 mode → behavior 分支 |
| 节点测试 | LangGraph testing guide | 单节点 invoke + MemorySaver |
| 全图测试 | MemorySaver | build_mock_graph(mode) 端到端 + interrupt resume |
| Eval | promptfoo + DeepEval | translate_feedback 不能 fabricate;customize 不能新增 entity |
| Red-team | promptfoo redteam | simulate prompt injection in JD/resume(vision.md 红线) |
| Smoke | nightly | OpenRouter 3 个模型 × tool_calling 兼容性 |

---

## 7. 与 agent-architecture.md 的关系

agent-architecture.md 定义 "**5 个 agent + Coordinator 编排 + 共享 DB 状态 + 事件总线**" 的抽象骨架。
本文档是它在 Vantage UI 这个具体产品形态下的**绑定层**:

- 谁是入口(Ask Vantage dock)
- 谁是产物面(Résumé view)
- 谁是模式编排(Mock pluggable graph)
- 哪些 enum 落 PG(012/013)
- 哪些事件穿 Redis Streams(resume:updated / mock:weak_point_found)
- 哪些消息穿 SSE(astream_events / agent task card)

任何前端改动若涉及到改 dock 的位置 / 改 Résumé chat 这条死禁忌 / 改 mode 四维定义 —— 必须先回到本文件改设计,再改代码。
