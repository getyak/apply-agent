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

## 2. Résumé(vibe chat + 文档 + 版本时间轴)

> **设计变更（2026-06-18）**：早期版本把简历改动**全部**收口到 Ask Vantage dock，Résumé view 只是渲染面。实战发现这条路径在简历微操作（改这条 bullet、加这一项、缩这一段）下交互成本太高——dock 是为跨场景全局对话设计的，被迫携带"当前在哪份简历的第几节"这种沉重 context。Résumé view 现在自带一个**当前文档作用域**的 vibe chat 面板，与 dock 各司其职（见 §2.6）。

### 2.1 形态

```
┌────────────────────────────────────────────────────────────┐
│  Resume Studio · /app/studio/resume                         │
│  ┌──────────────┬───────────────────────────────────────┐  │
│  │  Vibe chat    │  Document + Timeline                  │  │
│  │  (380px)      │  (flex 1)                             │  │
│  │               │                                       │  │
│  │  AI 推荐 chips │  v1─v2─v3─v4─v5─v6─v7(current)        │  │
│  │  ┌──────────┐ │           │                           │  │
│  │  │ 优化建议  │ │           └── "Sharpen for Stripe"     │  │
│  │  │ 职业规划  │ │                                       │  │
│  │  │ JD 微调   │ │  [Live résumé document]               │  │
│  │  │ 职业推荐  │ │  [Diff vs v6] — gold-highlighted      │  │
│  │  └──────────┘ │  [Upload new] [Compare] [Export]      │  │
│  │               │                                       │  │
│  │  对话历史      │                                       │  │
│  │  ────────     │                                       │  │
│  │  > Tighten my│                                        │  │
│  │    impact... │                                        │  │
│  │  ✓ saved v8  │                                        │  │
│  │               │                                       │  │
│  │  [输入框 + ⌘↵]│                                       │  │
│  └──────────────┴───────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**4 个推荐 chip（vibe chat 的"起点候选"）**:

| Chip | 触发的 agent 路径 | 输出落点 |
|------|------------------|---------|
| **优化建议** | `resume_agent.analyze` → top 3 弱项 + 改进建议 | 对话区列出，用户挑一条→ `resume_agent.optimize_bullet` |
| **JD 微调** | 解析剪贴板/输入的 JD → `resume_agent.customize(jd, base)` | 时间轴长出新 tailored 版本 |
| **职业规划** | `resume_agent.analyze` 提取已有 trajectory + `trend_agent.skill_gap` | 对话区给"下一站建议 + 缺什么技能" |
| **职业推荐** | `jobmatch_agent.find_matches(profile=current_resume)` top 5 | 对话区列匹配岗位 + 一键跳 /app/jobs |

### 2.2 数据流

```
用户在 Resume vibe chat 里说 "Sharpen for Stripe"  (或点 JD 微调 chip)
   │
   ▼
POST /api/ask/stream  (与 dock 同一通道,但带 surface=resume_studio + active_resume_id)
   │
   ▼
ask_vantage_router → intent="tailor_resume", args={job: "stripe-...", base: v6.id}
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
SSE event back to vibe chat 面板 → 对话区出 "v7 saved · Open" 卡片
                                  → 时间轴长出 v7 (current)
                                  → 右侧文档自动切到 v7
```

**关键**: vibe chat 复用 dock 用的 `/api/ask/stream` 通道，**不新增 endpoint**。仅在请求头加 `X-Relay-Surface: resume_studio` 让 router 知道这是文档作用域对话（chip 路径上下文携带 `active_resume_id`）。后端 thread_id 用 `resume_studio:{user_id}:{resume_root_id}`（每条简历支系一个独立 thread，不污染 dock 的 lifetime thread）。

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

### 2.6 Studio vibe chat ↔ Ask Vantage dock 职责切分

两条对话通道并存，**用 surface 区分**，不互相替代：

| | Ask Vantage dock | Resume Studio vibe chat |
|---|------------------|------------------------|
| **作用域** | 跨所有页面、终身 | 当前简历支系（v6→v7→v8 同一棵树） |
| **thread_id** | `ask_vantage:{user_id}`（lifetime，§1.2） | `resume_studio:{user_id}:{resume_root_id}`（每条简历独立） |
| **携带 context** | 用户全局画像 + 上次说了什么 | + active_resume_id + 当前 viewing version |
| **典型话术** | "找一些 React 高级岗" / "今日趋势" | "把这条 bullet 改紧一点" / "给我做个 Stripe 版" |
| **结果落点** | dock 内 agent task card | vibe chat 对话区 + 时间轴 + 文档自动切版 |
| **UI 位置** | 左侧 372px 持久 dock（live mock 时收起到 54px） | Resume Studio 页内左侧 380px |
| **何时收起** | 用户主动 / mock live | 用户拖拽边界栏可折叠到 0 |

**为什么不合并**：尝试过把所有对话都收口到 dock，结果是用户每问"这条 bullet 怎么改"都得带"我现在在第几版简历的 experience.items[2].highlights[0]"——dock 不该承担这种 surface 状态。Studio vibe chat 默认知道你在看哪份简历，问题变成纯语义。

**Dock chip 在 Resume surface 下要做"减法"**（2026-06-18 落实于 `web/src/components/ask-vantage/dock.tsx::suggestionsForPath`）：

`/app/studio/resume` 路径下，dock greeting 的推荐 chip 集合 **不再** 包含 `Sharpen my résumé for Stripe` 这类文档操作——这条 chip 与 Studio vibe chat 的「优化建议 / JD 微调 / 职业规划 / 职业推荐」职责完全重叠，并排出现会让用户面对"两套 Sharpen 按钮、点哪个会发生什么"的二义性，也违反 §0 第二条不可让步原则（"Vantage is one conversation"）。dock 在该页面只保留 **跨文档的全局动作**：

- Find roles I should look at today（→ Scout）
- Practise the Stripe recruiter screen（→ Interview）
- What changed in the market this week?（→ Trend）
- Build me a cover letter for Linear（→ AppPrep）

其它页面（Today / Applications / Mock setup / Trends 等）仍展示完整 5 条默认 chip（含 Sharpen），因为那时 Studio vibe chat 不在屏幕上，dock 是用户改简历的唯一入口。Mock live 模式按 §3.6 走 collapse 策略，不会触发 chip 显示。

> **实现注记**：判定基于 `usePathname()`，不读 Studio 的内部 state。这样 dock 可以在尚未挂载任何 Studio 面板（例如 SSR 首屏 / pre-hydration）时已经选对 chip 集合，避免一次"先闪 Sharpen 再撤回"的视觉跳变。未来若别的 surface（Mock / Applications）也需要自己的 chip 减法，沿着同一 helper 拓展即可；不要把 chip 集合配置外移到 dock store——dock store 是会话状态，chip 集合是 UI 派生量，不该污染前者。

**主区标题** `VibeChatPanel.title` 同步收敛为：

- master 版本：`Sharpen your master résumé`
- tailored variant：`Refine this résumé`（早期写法是"Refine this tailored version"，"tailored"二字与上方 §2.1 的"Tailored variant"标签语义重复，删掉更紧）
- 尚无简历：`Start with your résumé`

**关键不重复**：vibe chat **不重新实现** SSE 流、不新建 endpoint、不新建 LangGraph workflow——它复用 dock 的 `/api/ask/stream` + `ask_vantage_router`，只是请求头加 `X-Relay-Surface: resume_studio`，前端拿到的 SSE 事件用 surface 字段路由到对应面板渲染。

**前端复用**：vibe chat 面板内部消化的"用户消息 + thinking 卡 + agent task card + result 卡"渲染逻辑与 dock 同源，抽到 `web/src/components/ask-vantage/conversation.tsx` 共享，避免两份 UI 漂移。

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
