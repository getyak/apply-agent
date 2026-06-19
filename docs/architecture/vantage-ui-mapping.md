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

## 2. Résumé(单栏文档 + 版本时间轴；dock 是唯一对话入口)

> **设计变更历史**
>
> - **初代（pre-2026-06-18）**：简历改动**全部**走 dock，Résumé view 只是文档渲染。问题：dock 是跨场景全局对话，每次都要带"我现在在第几版简历的 experience.items[2].highlights[0]"，微操作（改这条 bullet、缩这一段）交互成本太高。
> - **二代（2026-06-18 早间）**：Résumé view 加了一个**文档作用域**的 vibe chat 左栏，与 dock 并列。问题：用户面对两个输入框（左栏 vibe / 右栏 dock）不知道该在哪打字，左右两套推荐 chip 还语义有部分重叠（"Sharpen my résumé for Stripe" vs "JD 微调"），违反 §0 第二条不可让步原则"Vantage is one conversation"。
> - **当前（2026-06-18 合并版）**：移除左栏 vibe chat，**dock 是唯一对话入口**。在 /app/studio/resume 路径下：
>   1. dock 自动切到 `resume_studio:{user_id}:{resume_id}` thread；
>   2. greeting 顶部加一个**「This résumé」分组**承接原 vibe 的 4 个 chip（动作型短句，作用域提示"Scoped to your current version"），下面跟一个**「Explore」分组**承接全局跨场景 chip；
>   3. 主区只剩"版本时间轴 + 文档"两栏，呼吸感与版本编辑专注度都提升。

### 2.1 形态

```
┌────────────────────────────────────────────────────────────┐
│  Resume Studio · /app/studio/resume                         │
│  ┌──────────────────────────────────────┬──────────────┐   │
│  │  Document + Timeline (单栏 flex 1)    │ Ask Vantage │   │
│  │                                      │ dock         │   │
│  │  v1─v2─v3─v4─v5─v6─v7(current)        │ 持久 372px   │   │
│  │           │                           │              │   │
│  │           └── "Sharpen for Stripe"    │ Good morning,│   │
│  │                                      │   XIONG.     │   │
│  │  [Live résumé document]               │              │   │
│  │  [Diff vs v6] — gold-highlighted      │ [This résumé]│   │
│  │  [Upload new] [Compare] [Export]      │  · Find 3    │   │
│  │                                      │    weakest   │   │
│  │                                      │  · Tailor to │   │
│  │                                      │    a JD      │   │
│  │                                      │  · Map next  │   │
│  │                                      │    moves     │   │
│  │                                      │  · Surface   │   │
│  │                                      │    roles     │   │
│  │                                      │              │   │
│  │                                      │ [Explore]    │   │
│  │                                      │  · Find roles│   │
│  │                                      │  · Practise  │   │
│  │                                      │  · Market    │   │
│  │                                      │  · Cover     │   │
│  │                                      │    letter    │   │
│  │                                      │              │   │
│  │                                      │ AGENT TEAMS  │   │
│  │                                      │ @scout @…    │   │
│  │                                      │              │   │
│  │                                      │ [⌘↵ composer]│   │
│  └──────────────────────────────────────┴──────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**「This résumé」分组 — 4 个 chip（从旧 vibe chat 迁移；display ≠ prompt）**

每个 chip 的 `display`（卡面英文短句）保持紧凑，`prompt`（实际发送给 coordinator 的指令）保留旧 vibe chat 的完整自然语言版本，确保 resume_agent 看到的输入与之前一致。

| Display（卡面文案） | Prompt（实际发送） | 触发的 agent 路径 | 输出落点 |
|---|---|---|---|
| **Find my résumé's 3 weakest spots** | "Analyze this résumé and tell me the three weakest spots — be specific about which bullet or section, and what to change." | `resume_agent.analyze` → top 3 弱项 + 改进建议 | dock 对话区列出，用户挑一条→ `resume_agent.optimize_bullet` |
| **Tailor this résumé to a JD** | "I want to tailor this résumé for a specific role. Ask me to paste the JD, then customize the bullets to match — without inventing experience I don't have." | 解析输入 JD → `resume_agent.customize(jd, base)` | 时间轴长出新 tailored 版本；dock 出 result card "v7 saved · Open" |
| **Map my next 1–2 career moves** | "Read my résumé's trajectory and tell me what the next one or two career moves should look like, plus which skills I'd need to close to get there." | `resume_agent.analyze` 提取 trajectory + `trend_agent.skill_gap` | dock 对话区给"下一站建议 + 缺什么技能" |
| **Surface roles that match this résumé** | "Based on this résumé, suggest five roles that would be a strong match right now — and explain in one line why each fits." | `jobmatch_agent.find_matches(profile=current_resume)` top 5 | dock 对话区列匹配岗位 + 一键跳 /app/jobs |

**「Explore」分组 — 4 个跨场景 chip**

进入 Resume 页时这一组继续用全局 chip 子集（去掉 "Sharpen my résumé for Stripe"，因为它的语义已被 This-résumé/Tailor-to-JD 承接）：Find roles I should look at today、Practise the Stripe recruiter screen、What changed in the market this week?、Build me a cover letter for Linear。其它页面（Today / Applications / Mock setup / Trends）的 Explore 组保持完整 5 条，因为那时 This-résumé 组不渲染。

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
SSE event back to dock → 对话区出 "v7 saved · Open" 卡片
                       → 时间轴长出 v7 (current)
                       → 左主区文档自动切到 v7
```

**关键**: dock 复用同一个 `/api/ask/stream` 通道，**不新增 endpoint**。`POST /api/ask/stream` body 里同时带 `thread_id: "resume_studio:{user_id}:{resume_id}"`（dock 在 Resume 路径下推导出来的 override，见 §2.6）+ `surface: "resume_studio"`，让 coordinator 知道这是文档作用域对话。后端 thread 仍是 per-résumé 独立 — 离开 Resume 页后 dock 切回 `ask_vantage:{user_id}` lifetime thread，下次回到 Resume 页 PostgresSaver 会重新加载这条 thread 的对话历史。

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

### 2.6 单一入口：dock 是唯一对话面板（2026-06-18 合并版）

> **本节是合并版**。要看"两条通道并存"那一代设计的原文，去看 git 历史（commit `1224ad6` 之前）。

合并的核心抽象：**dock 一个 UI、按页面切换 thread**。

| | 全局态（Today / Applications / Mock setup / Trends 等） | Resume 态（/app/studio/resume） |
|---|---|---|
| **dock UI** | greeting 顶部"Good morning, XIONG."；下方一个 Explore 分组（5 条全局 chip）；agent teams；composer | greeting 顶部"Good morning, XIONG."；**This résumé** 分组（4 条 scoped chip，旁边小字"Scoped to your current version"）+ **Explore** 分组（4 条全局 chip，去 Sharpen）；agent teams；composer |
| **dock 头部副标题** | `YOUR AGENT · ALWAYS HERE`（dock 的持久身份） | `TALKING ABOUT THIS RÉSUMÉ`（明示当前 thread 是 scoped） |
| **dock 走的 thread** | `ask_vantage:{user_id}`（lifetime，§1.2） | `resume_studio:{user_id}:{currentResumeId}` |
| **composer 默认行为** | 文字 → ask_vantage thread | 文字 → resume_studio thread（与 chip 一致，避免再回到"两个输入框"的混乱） |
| **chip 点击** | Explore chip → ask_vantage thread | This-résumé chip → resume_studio thread；Explore chip → 仍 ask_vantage thread（因为它们语义就是"暂时跳出当前简历谈点别的"） |
| **何时收起** | 用户主动 / mock live | 用户主动 / mock live |

**为什么把"暂时跳出当前简历"也保留在同一 dock 里？** 因为 Explore chip 的特征就是跨简历——"今天有哪些好岗位"不依赖当前简历版本。它们走 ask_vantage thread 不会破坏 resume_studio thread 的纯净度，反而让用户不用换面板就能切换话题。代价是 dock 的 messages UI 会显示 ask_vantage 历史而不是 resume_studio 历史；这是已知 trade-off，由 §2.6 末尾的"thread 切换 UX"注记承担解释。

#### 主区标题
左主区已不再有 vibe chat 面板。文档区头部的两个文案变体（`web/src/components/screens/resume-view.tsx`）保持：

- master 版本：`Master résumé` + version 行
- tailored variant：`Tailored variant` + version 行
- 尚无简历：空态卡 `NO RÉSUMÉ YET`，CTA "Upload a file" / "Talk it through with Vantage"

（早期版本里 vibe panel 顶部有 `Sharpen your master résumé` / `Refine this résumé` 这类动作型标题，合并后该语义由 dock 头部的 `TALKING ABOUT THIS RÉSUMÉ` 副标题 + This-résumé 分组的 chip 文案承接，不再在主区出现。）

#### 实现注记

- 路径判定：`usePathname()`。SSR 首屏 / pre-hydration 也能选对 chip 集合，避免"先闪 Sharpen 再撤回"的跳变。
- thread override 通过 `sendAsk(prompt, attachments, { surface: "resume_studio", threadIdOverride })` 注入，不污染 `useDock` 全局 store。dock 的 `useDock.threadId` 始终保持 `ask_vantage:{user_id}`；scoped 调用是"per-call override"，无副作用，离开页面后下一次默认调用自然回到 lifetime thread。
- 后端 `resume_studio:{user_id}:{currentResumeId}` 是每条简历独立 thread。当前用 `currentResumeId` 而非"master root id"做 stand-in；未来 store 暴露 `resume_root_id` 后再切到 root 维度（让一棵简历树共享对话历史）。
- chip 数据结构（`SuggestionChip` / `SuggestionGroup` / `chipGroupsForPath()`）保留扩展点：未来 Mock 页的"This mock"分组、Applications 页的"This application"分组沿同一 helper 加，不需要在 dock store 里塞 chip 配置。
- 删除的代码：`web/src/components/studio/vibe-chat-panel.tsx`、`web/src/lib/use-conversation-stream.ts`、`web/src/components/studio/` 目录。`useConversationStream` 当时是 dock SSE 逻辑的本地副本，dock 自身的 `sendAsk` + `runAskStream` 已经覆盖全部场景，没有别的调用方，合并时一并清理。

#### thread 切换 UX（已知 trade-off）
用户在 Resume 页 dock 里看到的对话只是 resume_studio thread。**离开 Resume 页 → dock messages 会"切走"，显示 ask_vantage thread 的历史**。这是为了语义清晰——把 resume_studio 对话混进 ask_vantage 时间轴会更脏。设计上：

- dock 头部副标题 `TALKING ABOUT THIS RÉSUMÉ` 是显式信号。
- 用户下次再回到 Resume 页，PostgresSaver 重新加载该 thread 的历史，对话视觉上"接回去"。
- 跨 thread 共享的"用户全局画像"由 router / coordinator 在后端跨 thread 读 PG（每个 thread 都共享一份 user_memories 表）。

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
