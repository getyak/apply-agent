# Chat & Agent 体系 · 深度分析与重设计方向

> 作者视角：从源码、流式协议、5-agent 抽象、harness、HITL、数据飞轮六个层面把当前实现还原成机制；对照 Claude Code / Hermes / OpenClaw 等成熟 agent 框架的核心做法；给出问题清单和分阶段重设计方向。
>
> 这是 **设计文档**（design），不是已落盘事实。事实层在 `docs/architecture/`（system-overview / agent-architecture / agent-harness / vantage-ui-mapping）。本文引用它们但不重复。
>
> 受众：负责 chat / agent 这条链路的工程师，以及做 PR review 时需要判断"这个改动有没有偏离 chat-agent 体系"的人。
>
> 写作日期：2026-06-21。

---

## 0. 一页结论

**当前状态**：单 thread 终身对话（Ask Vantage dock）+ 5 个领域 agent + 两层 regex/LLM intent router + SSE/NDJSON 协议桥接 + LangGraph checkpoint/interrupt 已经成形；harness 已封装 token/cost/error guards、context 摘要、审计；但 chat 真正能"干活"的链路在路由层和 agent action 上严重不对等：9 个意图里只有 `tailor_resume` / `mock_me` / `build_resume` / `list_applications` 真的有 backend 行为，其余 6 个全部 `not_implemented_yet`。chat-view（demo 页）和 dock（真实页）两条并存的聊天路径让用户认知断裂。

**核心问题 4 条**：

1. **路由不是规划**：当前 router 把"用户一句话 → 单 agent 单 action"作为唯一模型，缺少 plan-then-execute、缺少 multi-step、缺少 self-correction loop。`task_graph` 还是 TS 网关静态合成的模板，不是真规划。
2. **chat 是一条管道而非一个 agent loop**：dock 没有 ReAct 循环、没有 tool use、没有 reasoning trace 反馈到下一轮；它本质是「一次 LLM 调用 → 一次 dispatch → 一次回复」的 1.5 turn 协议。真正的 agent loop 只活在 mock_graph / build_resume_graph / prepare_application_graph 三个内嵌 workflow 里，普通对话从来没机会进入循环。
3. **HITL 是结构性能力，没在 chat 表面**：interrupt + Command(resume=…) 已就绪、build_resume 和 mock 已实测能用；但日常对话里的"我想 tailor 简历，给我看看 diff 再决定"这种自然 HITL 还需要走完整的 navigate → studio → review 路径，dock 内置 HITL（卡片审批 / 内联 diff）没接通。
4. **数据飞轮设计在但没驱动 chat**：interview_question_pool / weak_points / user_memories 表都在；agent 输出 → flywheel 写入这一段有；flywheel → 下次 chat 的 system context 注入这一段薄（只有 resume_studio surface 注入 active resume，dock 没有"用户记忆/历史投递/弱项"上下文）。

**4 个落地方向**（详见 §5）：

| 方向 | 一句话 | 优先级 |
|---|---|---|
| A. Dock 升级为 ReAct loop | 让 dock 自己成为一个 ReAct agent，不再走静态 dispatch；router 退化为 system prompt + tool registry 的一部分 | P0 |
| B. 真规划：Plan-then-Execute + 动态 task_graph | coordinator 出一个真 plan，gateway 不再静态合成；plan 步骤可在执行中被 self-correction 改写 | P0 |
| C. 内嵌 HITL：dock 内审批 + diff + chip 回应 | artifact 卡片承担轻量 HITL，不必跳页；structured action 走 `Command(resume=…)` | P1 |
| D. Context engineering 体系化：memory + retrieval + scope | 把 user_memories / weak_points / 投递历史用 retrieval 注入每轮 system prompt；按 surface 决定 scope | P1 |

---

## 1. 现状还原：chat 怎么工作（机制层）

### 1.1 三层物理结构

```
┌──────────────────────────────────────────────────────────────────┐
│  Web (Next.js)                                                   │
│  - components/views/chat-view.tsx        ← /app/chat,demo + 真实双轨 │
│  - components/ask-vantage/dock.tsx       ← 持久 dock,跨页驻留     │
│  - lib/ask-vantage-store.ts              ← Zustand,messages/agentEvents/taskGraph/artifact │
│  - lib/ask-stream.ts                     ← NDJSON 客户端 + 8 种 frame kind │
└──────────────────────┬───────────────────────────────────────────┘
                       │ POST /api/ask/stream (NDJSON)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  TS Gateway (Hono + Bun)                                         │
│  - routes/ask.ts        ← SSE → NDJSON 协议桥接                  │
│  - 静态合成 task_graph (PLAN_TEMPLATES,不是真规划)              │
│  - artifact 模板按 (agent, action) 派发                          │
│  - 用户 prompt + assistant 文本镜像写 conversation_messages      │
└──────────────────────┬───────────────────────────────────────────┘
                       │ POST /ask/stream (SSE)
                       │ Headers: X-Relay-User-Id / X-Relay-Thread-Id / X-Relay-Surface / X-Request-Id
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Python Agent Host (FastAPI + LangGraph)                         │
│  - api/server.py        ← endpoints + global exception envelope  │
│  - coordinator/router.py ← regex(70%) → V4 Flash(30%) → dispatch │
│  - coordinator/workflows.py ← build_from_scratch + prepare_application │
│  - nodes/{resume,interview,jobmatch,appprep}_agent.py            │
│  - harness/{llm,guards,context,permissions,audit,checkpointer}.py│
│  - tools/{auto,notify,approve,applications}.py                   │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 SSE/NDJSON 协议（事实）

FastAPI 端发 5 个 event：`thinking` / `intent` / `result` / `error` / `done`。
TS gateway 翻译成 dock 消费的 8 种 NDJSON frame：

| Frame | 触发源 | 用途 |
|---|---|---|
| `text` | Python `result.text` 或 gateway 合成的"Routing to X"行 | 流式追加到 assistant 气泡 |
| `task_graph` | gateway 在第一次看到 `intent` 时静态合成 | 卡片化展示"接下来会发生什么" |
| `agent_start` / `agent_done` / `agent_failed` | `thinking` 和 `result` 的派生 | 每个 agent task card 的生命周期 |
| `result` | legacy 路径，artifact 模板缺时的兜底 | 旧版结果卡 |
| `artifact` | gateway 按 (agent, action) 套用 artifact 模板 | 统一的产物卡（confidence / evidence / next_actions） |
| `done` / `error` | 1:1 转发 | 流终止 |

**协议层第一观察**：客户端的 frame schema 已经是一个相当成熟的"agent 输出抽象"（artifact + task_graph + 流式 text），但**产生这些 frame 的服务端没有对应的语义模型**。task_graph 是 gateway 假装合成的，artifact 是 gateway 按表派的，agent_start/done 来自 thinking/result 的派生。**前端在等一个会规划的 agent，后端给的是一个会查表的 router**。

### 1.3 路由两层 + dispatch

```python
# agents/coordinator/router.py
async def classify_intent(message):
    cheap = cheap_intent_classifier(message)           # 14 条 regex 规则
    if cheap and cheap.confidence >= 0.85:
        return cheap
    return await llm_intent_classifier(message)        # V4 Flash JSON 输出
```

9 个 intent + `other` smalltalk fallback。dispatch 落到对应 agent 的固定 action：

| Intent | 落点 | 状态 |
|---|---|---|
| `find_jobs` | jobmatch_agent.find_matches | **not_implemented_yet** |
| `tailor_resume` | resume_agent.customize | needs base + job → 让前端补 |
| `draft_cover_letter` | appprep_agent | **not_implemented_yet** |
| `mock_me` | interview_agent.build_mock_graph | ✅ 实现，HITL 工作 |
| `trends_today` | trend_agent | **not_implemented_yet** |
| `build_resume` | start_build_from_scratch | ✅ 实现，HITL 工作 |
| `update_resume` | resume_agent.update_field | **needs_clarification** |
| `review_application` | appprep_agent | **not_implemented_yet** |
| `list_applications` | applications.list_applications | ✅ 实现 |
| `move_application` / `set_application_outcome` | applications | needs_clarification（前端没接 disambiguation） |
| `other` | `_smalltalk_reply` → 一次 V4 Flash | ✅ 实现 |

**机制层第二观察**：能真正在 chat 里执行的只有 4 条：mock / build_resume / list_applications / smalltalk。其余全部以"打开 studio 页"作为承接 — 但是 dock 是持久的、跨页的，让用户离开 dock 进 studio 等于放弃了 dock 的存在价值。这是产品 UX 上"用户为什么要在 dock 里说话"的根本动机被削弱。

### 1.4 5-agent + 3 个内嵌 workflow

5 个 node：`resume_agent` / `jobmatch_agent` / `interview_agent` / `appprep_agent` / `trend_agent`。
3 个 workflow（LangGraph StateGraph）：

| Workflow | 触发 | HITL? | 持久化 |
|---|---|---|---|
| `build_from_scratch_graph` | `build_resume` intent | ✅ 3 个 interrupt() + chip 候选 + draft review | PostgresSaver |
| `build_mock_graph(mode)` | `mock_me` intent | ✅ 每题 `await_user_input` + Q&A 缓冲 | PostgresSaver |
| `prepare_application_graph` | `/applications/prepare` 直接 POST | ❌（saga 内自动） | PostgresSaver |

注意：**这些 workflow 跑在 LangGraph 里，但 chat dock 本身不跑在 LangGraph 里**。dock 的每条消息是「ask/stream → classify → dispatch → 单一 agent 调用 → 返回」一锤子，没有循环、没有 tool use、没有 ReAct。

### 1.5 Harness（已经做对的部分）

`agents/harness/` 已经覆盖了一个 production-grade agent harness 应有的 6 件事的 5 件：

| 项 | 实现 | 备注 |
|---|---|---|
| LLM 路由 + 计费 | `llm.py` 3 tier + cents_per_1M + max_retries + provider routing | ✅ |
| Token / cost / error guard | `guards.py` post_model_hook + BudgetExhausted | ✅，但只挂在通过 `create_react_agent` 的路径，**dock 的 `_smalltalk_reply` 和 router 的 V4 Flash 调用不走 guard** |
| Context 压缩 | `context.py` maybe_compact，超 60k 触发摘要 | ✅，但同上：只对走 graph 的路径有效 |
| Permission 4 级 + interrupt | `permissions.py` @requires_approval 装饰器 | ✅ |
| 审计 | `audit.py` async context manager → agent_tasks 表 + 异常 redaction | ✅，覆盖 node-level，**router-level 没覆盖** |
| **HITL 编排** | LangGraph interrupt + `Command(resume=…)` | ✅ 在 workflow 里。**chat dock 没有对应的"内联 HITL"UX** |

**机制层第三观察**：harness 是这套系统里最干净的一层。问题不在 harness 的能力，而在 chat dock 这个调用方**没有用到 harness 的循环 / context 管理 / HITL 能力**——它只用了 LLM 路由和最外层异步入口。

### 1.6 数据飞轮的当前形状

数据飞轮已经成形的部分：

- `interview_question_pool`（pgvector，crowdsourced）由 `save_to_card(loop="replay_real_interview")` 写入
- `interview_sessions.weak_points` 由 `_distil_weak_points()` 写入
- `application_drafts` + `application:submitted` Redis Streams 事件由 `/applications/{id}/submitted` 发出
- `user_memories` 表（migration 008，pgvector）schema 已经在，但 chat 链路里**没有写**也**没有读**

数据飞轮**没接通的部分**（核心问题）：

- **写**：dock 对话里没有沉淀 user_memories（用户偏好、目标公司、规避公司、薪资底线、风格偏好 ……）
- **读**：每次 dispatch 进入 `_smalltalk_reply` 时，system prompt 只挂"You are Vantage"+ 可选 resume_studio 的 active_resume_block，没有按"和这条 message 语义相关的 user_memories / past applications / weak_points" 做 RAG 注入

---

## 2. 对标主流 agent 系统（参考层）

判断我们这套设计有没有「对齐第一性原理」，先把 Claude Code / Hermes / OpenClaw 这类已经走在前面的 agent 框架的共同抽象捋一遍。**只取共性，不复刻具体实现**——因为产品形态完全不同（IDE/CLI 助手 vs 求职 copilot）。

### 2.1 Claude Code 的核心做法（IDE / CLI agent）

我作为 Claude Code 本人此刻就在跑这套机制。可以直接报告的关键抽象：

| 抽象 | Claude Code 怎么做 | 对 Relay 的启示 |
|---|---|---|
| **Tool registry** | tool 是一等公民，每个 tool 有 JSONSchema input + 文档化的 trigger 条件（Bash / Read / Edit / Grep / Glob / Agent / Task 等） | Relay 的 4 级 permission 装饰器 + auto/notify/approve 三个文件已经在；但 router dispatch 还不是 tool-use 模型 |
| **ReAct loop in main thread** | 主对话本身就是 ReAct 循环：每轮 think → tool_use → tool_result → think → … | Relay 的 dock 还是"一锤子"，主对话不进入循环 |
| **Subagent delegation** | `Agent` tool 把整段子任务交给一个 subagent_type（Explore / general-purpose / planner / code-reviewer），子 agent 跑完返回单条 result message | Relay 的 5 个 node 应该可以以"subagent"的姿态被 dock 调用而不是被 router 调用 |
| **Hooks / settings.json** | SessionStart / PreToolUse / PostToolUse / Stop 钩子，用户可以注入约束 | Relay harness 的 pre/post_model_hook 已经在；缺一个"用户可见"的钩子层（settings） |
| **Plan mode** | 显式的 plan-then-execute：用户可以让 Claude 先出 plan 再执行 | Relay 应该把 build_from_scratch 这个 workflow 的 "guided question + draft" 范式推广到所有意图 |
| **Skills / Slash commands** | 用 `/<name>` 触发命名工作流，skill 自己声明用法 | Relay 的 chip 已经在做这件事，但还不是"用户可定义"的 |
| **Memory / CLAUDE.md** | 项目根 CLAUDE.md / 用户 ~/.claude/CLAUDE.md 在每轮自动注入 | Relay 的 user_memories 表已经有了，缺自动注入机制 |
| **Context budget + compaction** | 自动监控 context 用量，超阈值时摘要旧消息 | Relay 的 context.py 已经在，但没接到 dock |
| **TodoWrite / TaskCreate** | agent 自己维护 todo 列表，每步标记进度 | 对应到 Relay 应该是动态 task_graph：agent 自己规划自己执行 |

**Claude Code 是当前 main-loop ReAct + subagent 委托 + tool registry + plan mode 的 SOTA 范式**。Relay 已经具备很多组件，关键差距是没把它们组装成一个 main-loop ReAct，而是把 5 个 agent 各自封进 workflow 里，让 router 当"分诊台"。

### 2.2 Hermes / 函数调用范式

NousResearch 的 Hermes 系列（以及 OpenAI function calling、Gorilla 等）确立了"LLM 输出 JSON 调用 tool"的工业标准。要点：

- **Tool 用 JSONSchema 严格约束输入输出**
- **模型在 system prompt 里看到 tool registry**
- **每轮可以返回 tool_calls 或自然语言**
- **tool_result 回填到 message 序列里**

Relay 的 `@tool` 已经走这条路（LangGraph 的 tool 就是这个范式），但**只在 mock_graph / build_resume_graph 这种 sub-graph 里用，主对话不用**。把主对话也升级成 tool-use ReAct，就能消解 router 那张"9 个 intent if-else 表"。

### 2.3 OpenClaw / 多 agent 编排范式

OpenClaw（以及 AutoGen / CrewAI / MetaGPT 这一类）走的是「多 agent 协作」路线：每个 agent 是一个角色（planner / coder / reviewer / tester），通过 message passing + role prompt 协作。

**对 Relay 的启示更多是反例**：

- 多 agent 协作的协调代价是 O(N²)，错误传染严重——这点 `agent-architecture.md` § "为什么是 5 个 agent" 已经讨论过
- Relay 的 5 agent 是**按职责拆**，不是**按角色拆**；它们通过共享 DB + 事件总线松耦合，coordinator 是唯一入口——这个设计正确，不要改
- 但**单 agent 内部**应该用 ReAct + tool use 把"领域 agent"自己变成一个会循环、会自我修正的小 agent，而不是被 router 一次性调用的函数

### 2.4 综合：现代 agent 系统的 6 件核心装备

把上面汇总到 Relay 视角下，得到 6 件必须装备：

1. **Main-loop ReAct**：主对话本身是循环，能 think → tool_use → observe → think
2. **Tool registry as the contract**：tool 是 agent 和外界的唯一契约；意图路由让位于 tool 选择
3. **Plan-then-execute**：能力强的 agent 先出 plan 再执行；plan 可被自我修正
4. **HITL inline**：审批 / 修改 / 拒绝在对话流里完成，不跳页
5. **Context engineering**：memory + retrieval + scope，每轮系统 prompt 是上下文的智能聚合
6. **Cost / budget / audit guards**：所有 LLM 调用都过同一套 guard，所有 tool 调用都落 audit

Relay 当前命中 #6 完整、#4 在 workflow 里命中（不在 dock 里）、#3 在 build_from_scratch 命中（不普遍）、#1/#2/#5 没有命中。

---

## 3. 问题清单（diagnosis）

按"用户能感知 → 工程师能感知 → 架构隐患"三层组织。每条都标了根因和建议优先级。

### 3.1 用户能感知的问题

| # | 现象 | 根因 | 影响 | 优先级 |
|---|---|---|---|---|
| U1 | 在 dock 里问 "find me jobs today" → 回 "coming soon, wired up but not generating yet" | 6 个 intent 是 `not_implemented_yet`，dock 把网关 NDJSON 兜底 result 直接渲染出来 | 用户感到"AI 没用" | P0 |
| U2 | `/app/chat` 路由（ChatView）跟 dock 是两个独立聊天体系 | 历史遗留：早期 ChatView 走 `runFlow` demo 假流程 + `sendRealChat` 真链路并存 | 用户在不同位置说话得到不一致行为 | P0 |
| U3 | task_graph 卡片上的步骤跟实际执行不一致 | task_graph 由 gateway 静态合成；Python 端实际只跑一个 agent | 用户看到"假规划"，信任受损 | P1 |
| U4 | 在 dock 里说"把简历调整一下面向 Stripe" → 跳转到 /app/studio/resume；想看 diff 还要再点 | dispatch 返回的是导航意图，不是产物 | 多步操作变成"导航 + 重输入" | P1 |
| U5 | 中文 / 英文混杂回复（在 router 已经强制 language 一致，但只在 smalltalk fallback 生效） | 只有 `_smalltalk_reply` 加了 language directive，dispatch 出去的 agent 各自的 prompt 没 enforce | 同一 session 内体验断裂 | P2 |
| U6 | dock 里说"我之前不是说过我不想去 startup 吗" → 模型不知道 | user_memories 表没接到 chat 链路 | "AI 没记性"，违反 vision.md 的"数据飞轮"承诺 | P0 |

### 3.2 工程师能感知的问题

| # | 现象 | 根因 | 优先级 |
|---|---|---|---|
| E1 | 想加一个新 intent 要改 4 处：regex 表、`VALID_INTENTS`、`dispatch` if-else、TS 网关 `PLAN_TEMPLATES` | router 是 hard-coded switch，task_graph 是 gateway 静态表 | P0 |
| E2 | dock 没接 `pre_model_hook` / `post_model_hook` → router 那次 V4 Flash 调用绕过 cost guard 和 token 计数 | `_smalltalk_reply` 和 `classify_intent` 直接 ainvoke，没走 graph | P0 |
| E3 | 三个 workflow（build_from_scratch / mock / prepare_application）的 graph 结构是手写的；没有"可复用的 plan executor" | 一次性写一个 graph，复用率低 | P1 |
| E4 | artifact 模板写在 TS 网关 → 改 Python 端的 action 名要改 TS | 协议契约分散两端 | P1 |
| E5 | `agent_tasks` 表落 audit，但 dock router 那一层没落（只有 node-level 落） | `audit()` 装饰只覆盖 node 入口 | P2 |
| E6 | `surface = resume_studio` 是 thread 切换的唯一信号，资源数据要靠 surface 推断（如 `load_active_resume_brief`）| context 注入是 hardcode 一处一处加的，没有 retrieval 框架 | P1 |

### 3.3 架构隐患

| # | 隐患 | 风险面 |
|---|---|---|
| A1 | router/dispatch 不在 LangGraph 里 = 没有 checkpoint = chat dock 没有"暂停 + 恢复" | 出错时无法定位到 step；不能在 dock 里跑长链路 |
| A2 | 5 个 agent 通过 dispatch 单调用，缺 agent-to-agent 协作的统一通道（除了 coordinator/workflows.py 里手工拼） | 想加"先查 trends，再 tailor resume"这种串联，需要再写一个 workflow |
| A3 | task_graph 由 gateway 合成，无法表达"模型动态生成的 plan" | 一旦 Python 端开始真规划，gateway 静态表就会和真 plan 矛盾 |
| A4 | TS gateway 同时承担：protocol bridge + history persistence + task_graph 合成 + artifact 合成 + 路由白名单 | gateway 越来越胖；协议演进难 |
| A5 | HITL 只在 workflow 里通过 interrupt() 实现；dock 没有"内联审批"的 frame kind | 客户端投递、resume customize、send email 都要 hop 到对应页才能审批 |

---

## 4. 第一性原理：chat 应当是什么

回到产品愿景（vision.md）和 vantage-ui-mapping 的设计意图，再问一遍 "Ask Vantage dock 在用户的求职旅程里到底是什么"。

### 4.1 Dock 的本体

Dock 不是"一个 chatbot"。Dock 是**用户和这套 5-agent 系统的单一交互窗口**，是一个**总在场的、有记忆的、能调动后台 agent team 的执行官**。

类比 Claude Code：用户面对的不是一个聊天框，而是一个"会用工具、会规划、会暂停问你、会记住偏好"的 agent。Relay 的 dock 应该是 **求职域的 Claude Code**：

- **会用工具**：5 个领域 agent 是它的 5 类 subagent / tool
- **会规划**：tailor 简历 + 投递这种复合任务自己拆步骤
- **会暂停问你**：HITL 在对话流里完成（diff / 选择 / 确认）
- **会记住偏好**：user_memories 自动注入

### 4.2 Dock vs 领域 agent vs 工具

三层职责必须分清楚：

```
┌─────────────────────────────────────────────────────────────┐
│  Dock Agent  (Vantage)                                       │
│  - 看到用户消息 → 决定 plan                                 │
│  - 看到 plan → 决定调哪个 subagent / tool                  │
│  - 看到 tool result → 决定下一步                           │
│  - 看到 HITL 触发 → 决定怎么呈现给用户                     │
│  这个 agent 是 main-loop ReAct,跑在 LangGraph 里            │
└─────────────────────────────────────────────────────────────┘
            │ tool_use
            ▼
┌─────────────────────────────────────────────────────────────┐
│  Domain Agents  (5 个 node:resume / jobmatch / interview / appprep / trend) │
│  - 每个是一个 ReAct agent,自己也有 tool                    │
│  - 接受 dock 委托,返回结构化结果                           │
│  - 不直接和用户对话                                         │
└─────────────────────────────────────────────────────────────┘
            │ tool_use
            ▼
┌─────────────────────────────────────────────────────────────┐
│  Tools  (auto/notify/approve/applications + tool registry)   │
│  - parse_jd, fetch_resume, save_resume_version, ...         │
│  - approve-level 自动触发 interrupt()                       │
└─────────────────────────────────────────────────────────────┘
```

**关键变化**：当前架构里 router/dispatch 这一层应该消失，被 Dock Agent 的 ReAct loop 吸收。5 个领域 agent 从"被 router 调用的函数"升级为"被 Dock Agent 用 Agent tool 调用的 subagent"。

### 4.3 Plan 是 first-class

按 §2.1 的 plan mode 范式，dock 应该能在执行前显式产出 plan：

```
用户: "我想投 Stripe 那个 staff eng 岗"
Dock:
  PLAN:
    1. SCOUT — pull Stripe JD, extract requirements          [auto]
    2. RESUME — tailor my v6 résumé to this JD               [needs review]
    3. APPPREP — draft cover letter, fill ATS fields         [needs review]
    4. INTERVIEW — preheat intel for the Stripe phone screen [auto, background]
  确认开始?  [Approve plan]  [Tweak]  [Discard]
用户: [Approve plan]
Dock: ...(开始按 plan 执行,每步产生 artifact,需要 review 的暂停问)
```

这个 plan 不是 gateway 假合成的 — 是 Dock Agent **第一次 think 时输出的**。前端用现有的 `task_graph` frame 渲染，但**数据源换成真 plan**。

### 4.4 HITL 在 dock 内完成

对应 vision.md 的核心原则 4「AI 先做，用户后审」，dock 必须把审核做到对话流里。今天 artifact 卡片已经在做这件事（`needs_user_review` + `next_actions: [approve / tweak / discard]`），但 approve/tweak/discard 还没接回 `Command(resume=…)`。

新的 frame kind 设计（向后兼容现有 8 种）：

```typescript
type StreamFrame =
  | ...existing 8 kinds...
  // 新增 3 种 — 都映射到 LangGraph interrupt() 模型
  | { kind: "ask_user"; question: string; chips?: string[]; free_form?: boolean; resume_token: string }
  | { kind: "diff"; before: any; after: any; resume_token: string }
  | { kind: "approval"; action: string; payload: any; resume_token: string }
```

用户在 dock 内点 Approve / 输入回答 → POST 一个新的 `/api/ask/resume` 接口，带 `resume_token`，触发 `Command(resume=…)`。这是 Mock workflow 已经在用的模式，把它泛化到所有 dock 交互。

### 4.5 Context engineering = 系统的记忆机能

每轮进 LLM 的 system prompt 应该是 retrieval 出来的：

```
[fixed system]
  You are Vantage. Reply in <detected language>.

[from CLAUDE.md / vision.md selected by surface]
  Hard rules: no fabrication. Submit/send/delete always need user approval.

[from user_memories — pgvector retrieval by message]
  - User declined 3 startup roles in May. Prefers ≥ Series C.
  - Target comp: $250k base + $200k equity.
  - Strong areas: distributed systems, payments.

[from past applications — last 20 rows]
  - Stripe (interviewing), Anthropic (rejected), Linear (offer accepted on 06-12)

[from weak_points — latest mock session]
  - "Owning impact" came up weak last 2 sessions.

[from surface]
  - Active résumé v7 JSON …
```

这个上下文聚合层应该是个独立模块（`agents/context/`），按 surface + 当前 message + 历史 retrieval 出可注入的 block。

---

## 5. 重设计方向（roadmap）

按 P0 → P2 排序，每条给「目标 / 关键改动 / 验收 / 风险」。所有改动假设保持兼容现有 NDJSON 协议（在前端不破坏的前提下扩展）。

### 5.1 P0 / 方向 A：Dock 升级为 ReAct loop

**目标**：消除 router/dispatch 的 if-else 表，让 dock 成为一个真正的 main-loop agent。

**关键改动**：

1. 新建 `agents/coordinator/dock_agent.py`：
   - 用 `create_react_agent(model="general", tools=DOCK_TOOLS, prompt=DOCK_SYSTEM_PROMPT, checkpointer=postgres)`
   - `DOCK_TOOLS` 是把 5 个领域 agent 包成的 `Agent` 工具（接受用户意图描述，返回 agent 的产物）
   - 加 4 个直接工具：`recall_user_memory(query)` / `recall_past_applications(filter)` / `recall_weak_points()` / `propose_plan(steps)`
2. `api/server.py` 的 `/ask/stream` 改成 invoke `dock_agent.astream_events`，把 LangGraph 的 event 翻译成现有 NDJSON 协议（`tool_start` → `agent_start`，`tool_end` → `agent_done`，`on_chain_stream` 里的 text → `text` delta）
3. **路由保留作为快路径**：当 cheap regex confidence ≥ 0.95（明确的命令式短句如 "list applications" "mock me for Stripe"）时仍直接 dispatch，避免无谓的 main-loop LLM 调用
4. 领域 agent 保持现有签名 — 它们成了 dock 的 subagent，不需要改

**验收**：

- 在 dock 里说"找几个适合我的远程 staff 工程师岗，并把简历给前 3 个 tailor 一下"，dock 输出 plan → 用户 approve → 串行调 `Agent(jobmatch_agent, "find remote staff eng")` → `Agent(resume_agent, "customize for top 3")` → 输出 3 张 artifact 卡 + diff
- 路由层的 9 个 if-else 中至少 6 个能由 main-loop 自然分发

**风险**：

- Main-loop 每条消息至少 +1 次 LLM 调用，成本上升。缓解：保留 regex 快路径；用 general tier（GLM-4.7）而不是 heavy
- LangGraph `create_react_agent` 的 `recursion_limit` 要调高（dock 一次可能跑 5-8 步）；用 guards.py 的 token / cost budget 兜住

### 5.2 P0 / 方向 B：真规划 + 动态 task_graph

**目标**：让 task_graph 来自 dock agent 的真 plan，gateway 不再合成。

**关键改动**：

1. 给 dock_agent 加一个内置 tool `propose_plan(steps: list[Step]) -> "plan_id"`：模型必须先调它声明 plan，再才能调任何执行类 tool
2. `propose_plan` 把 plan 推到 state，并触发一次 `interrupt()` 让用户审核（或自动跳过简单 plan）
3. FastAPI 新增 SSE event `task_graph`，gateway 把它转成已有的 `task_graph` NDJSON frame（透传，不再合成）
4. gateway `PLAN_TEMPLATES` + `planForIntent()` 删除（或保留作"agent 没给 plan 时的最后兜底"）
5. 每个执行 tool 调用前后 emit `step_status` 更新 → `agent_start` / `agent_done` 流入前端的 task_graph 步骤

**验收**：

- task_graph 卡片的步骤跟 agent_start/done 的 agent 100% 对得上
- 复杂请求触发多步 plan；简单请求（"list applications"）跳过 plan 直接执行

**风险**：

- 模型不调 `propose_plan` 怎么办？用 system prompt 强制 + 第一步 tool_choice="propose_plan"（OpenRouter 部分模型支持）+ 兜底 fallback
- 动态 plan 跟用户 approve 的 plan 不一致：plan 修改时 emit `task_graph_patch` frame，前端按 step.id diff

### 5.3 P1 / 方向 C：内嵌 HITL

**目标**：把简历 diff / 投递审批 / 求职信 review 全部做进 dock，不跳页。

**关键改动**：

1. 扩展 NDJSON 协议加 `ask_user` / `diff` / `approval` 三种 frame（§4.4）；每种带 `resume_token`
2. 新 endpoint `POST /api/ask/resume`：body `{ resume_token, value }` → 服务端找到对应 LangGraph thread → `Command(resume={value})`
3. dock-store 增加对应消息类型，渲染：
   - `ask_user`：chip 列表 + 输入框（复用 build_from_scratch UI）
   - `diff`：左右对照 + 接受 / 修改 / 拒绝按钮
   - `approval`：单按钮卡 + reason 文本框
4. `@requires_approval` 装饰器在 dock 上下文里自动 emit `approval` frame 而非 workflow 内 interrupt（通过装饰器多态：检测当前是 dock_agent 还是 specialized workflow）

**验收**：

- "tailor my résumé for Stripe" → dock 里出现 diff 卡 → 用户点 Approve → 自动 save → artifact 卡 v8 saved
- "draft cover letter and submit to Stripe" → dock 里连续两次 approval（cover letter review + submit confirm）

**风险**：

- resume_token 的生命周期：interrupt 状态在 PostgresSaver 里，超时清理策略要定（建议 24h）
- 用户离开页面再回来还能 resume？需要把 pending HITL 列在 dock 的"等你确认"栏

### 5.4 P1 / 方向 D：Context engineering 体系化

**目标**：每轮 LLM 调用的 system prompt 是按当前消息 retrieval 出的相关上下文，不是硬编码。

**关键改动**：

1. 新建 `agents/context/` 模块：
   - `assembler.py`：按 surface + message + thread_id 决定要拉哪些 block，按优先级排序后裁剪到 token 上限
   - `retrievers/`：每种数据源一个 retriever，独立实现+独立缓存
     - `user_memory_retriever.py`（pgvector 用 message embedding）
     - `application_history_retriever.py`（按时间 + 状态）
     - `weak_point_retriever.py`（最新 mock session）
     - `surface_artifact_retriever.py`（resume_studio 场景下的 active resume）
2. 把 `_smalltalk_reply` 里的 `load_active_resume_brief` 调用挪到 assembler 里作为一种 retriever
3. dock_agent 启动时通过 assembler 拿上下文 block 列表，注入 system prompt
4. 每条 user message + assistant response 经过一个轻量 LLM 调用判断"值不值得 commit 到 user_memories"（用 V4 Flash，单次 < $0.0001）→ 写 user_memories 表（带 embedding）

**验收**：

- "我之前不是说过我不想去 startup 吗" → 回复 "对，记下来了，5 月你拒了 3 个 Series A。今天的 matching 已经过滤了 < Series C 的。"
- system prompt token 用量监控可见：基础 800 + memory 1500 + history 600 + surface 2000，超 8k 触发摘要

**风险**：

- user_memories 写入要避免噪声 → 用 LLM judge 第一道闸 + 用户在 settings 里能 review/删除
- 隐私：privacy-security.md 要更新——明确告诉用户哪些 memory 会被记住

### 5.5 P2 / 方向 E：协议契约下沉到 Python 端

**目标**：artifact / task_graph 模板都在 Python 端定义，gateway 退化为纯协议桥接。

**关键改动**：

1. Python 端定义 `ArtifactEnvelope` Pydantic schema（复用现有 `artifact_type` 6 个枚举）
2. dock_agent 的每个 tool 返回时显式构造 artifact dict
3. gateway `buildArtifact()` 删除，直接透传
4. `PLAN_TEMPLATES` 删除（被方向 B 替代）

**收益**：协议变更只改一端；artifact 形状由产生它的 agent 决定，对得上。

### 5.6 P2 / 方向 F：旧 ChatView 退役

**目标**：消除两条聊天通路，全站只有 dock。

**关键改动**：

1. `/app/chat` 路由保留但内容改为 "Use the Ask Vantage dock to chat — click anywhere"（或直接 redirect 到 `/app/today`）
2. `chat-view.tsx` 的 demo `runFlow` + `chatLog` 状态删除
3. `useVantage().chatMessages / chatLoading / chatHydrating` 状态迁移到 dock store 或删除

**收益**：用户和工程师都只有一个对话面板要维护。

---

## 6. 落地次序（建议 sprint plan）

```
Sprint 1 (2 周) — P0-A 主体 + P0-B 骨架
  □ 新建 agents/coordinator/dock_agent.py with create_react_agent
  □ 5 个领域 agent 包成 Agent tools(每个 200 行内)
  □ /ask/stream 走 astream_events,翻译 LangGraph event → NDJSON
  □ 路由 regex 快路径保留 confidence ≥ 0.95 时直接 dispatch
  □ propose_plan tool 上线,简单 plan 不触发审核
  □ gateway 静态 PLAN_TEMPLATES 标记为"deprecated, no new entries"

Sprint 2 (2 周) — P0-B 完整 + P1-C HITL inline
  □ task_graph SSE event 上线,gateway 透传
  □ task_graph_patch event 上线,支持动态 plan 修改
  □ NDJSON 新增 ask_user / diff / approval 3 种 frame
  □ /api/ask/resume endpoint
  □ dock-store 渲染 3 种新 frame
  □ resume_agent.customize 第一个走 diff 卡 inline 审批

Sprint 3 (2 周) — P1-D context + P2-E 协议下沉
  □ agents/context/ 模块上线
  □ 4 个 retriever + assembler
  □ dock_agent 启动注入 retrieved context block
  □ user_memory commit 路径(LLM judge + 写入)
  □ Python 端定义 ArtifactEnvelope,gateway buildArtifact 删除

Sprint 4 (1 周) — P2-F 收尾
  □ ChatView 退役 / 转 redirect
  □ Vantage store 清理 chat* 字段
  □ docs/architecture/vantage-ui-mapping.md 更新(去掉双轨说明)
  □ 回归测试:vision.md 4 大场景全部能在 dock 内完成
```

---

## 7. 不动的事情（明确的非目标）

为了让这份设计文档可以被无歧义执行，明确"不在范围内"的事：

1. **不重构 5 agent 的职责拆分**。`agent-architecture.md` 论证过的 5 agent 划分是对的，不动。
2. **不引入 multi-agent 协作框架（AutoGen / CrewAI / MetaGPT）**。Relay 的 agent 协作通过 coordinator + 共享 DB + 事件总线，已经够了；引入新框架是加 O(N²) 协调风险。
3. **不替换 LangGraph**。LangGraph 的 ReAct + interrupt + checkpoint 已经覆盖需求；harness 围绕它写的，迁移成本不值。
4. **不替换 OpenRouter**。多 provider 兜底 + 国产模型 + 成本控制的组合还是最合适的。
5. **不动 client-side-delivery 方案**。投递在用户浏览器完成的核心约束不变；本设计只增强 dock 里 cover letter / form answers / approval 的体验。
6. **不引入第二个 LLM provider 用于规划**。Plan 用通用 tier（GLM-4.7）就够；不引入 Claude / GPT 作为"planner 专属模型"——会让成本和 vendor 复杂度上升。

---

## 8. 验证机制

每一个方向都必须配 eval（参见 cicd-aiops-harness.md § 3）。最低限度的验证清单：

| 方向 | 验证 |
|---|---|
| A. ReAct dock | 20 条 golden goal（"tailor for X","find jobs and queue 3","mock me on Stripe"）→ dock_agent 必须出 plan 且按 plan 走完，无幻觉调用不存在的 tool |
| B. 真规划 | task_graph 步骤 ↔ 实际 agent_start 一致率 ≥ 95%（自动 diff） |
| C. HITL inline | 触发 diff / approval 后,用户在 dock 内点击 Approve → 服务端 thread 状态从 `interrupted` 转 `completed` 的 e2e Playwright 测试 |
| D. Context | 5 条"AI 是否记得"测试用例（涉及偏好 / 投递历史 / 弱项），通过率 100% |
| E. 协议下沉 | gateway 代码行数从 786 降到 ≤ 400；buildArtifact 删除 |
| F. ChatView 退役 | `/app/chat` 不再产生独立的 LLM 调用（监控 OpenRouter usage attribution） |

---

## 9. 相关文档与引用

**项目内**：

- `docs/vision.md` — 产品红线（不虚构、客户端投递、AI 先做用户后审）
- `docs/architecture/system-overview.md` — 五层架构
- `docs/architecture/agent-architecture.md` — 5 agent 拆分原则
- `docs/architecture/agent-harness.md` — LangGraph 运行时 + Loop guards + HITL + 已知风险
- `docs/architecture/vantage-ui-mapping.md` — UI 模块 ↔ agent team 映射；dock 是单一入口的决策
- `docs/architecture/cicd-aiops-harness.md` — eval / observability / red-team
- `docs/architecture/client-side-delivery.md` — Plan B+ 客户端投递
- `docs/architecture/delivery-loop-plan.md` — TTAR 北极星 + saga

**外部参考**（机制级，非教程级）：

- Anthropic Claude Code agent loop / subagent / plan mode（本会话即在运行的工具集）
- NousResearch Hermes function calling 规范（tool registry as system prompt 的工业范式）
- LangChain 官方 LangGraph testing guide（`docs.langchain.com/oss/python/langgraph/test`，3 层粒度测试）
- LangGraph issue #4841（post_model_hook 不注入 InjectedState 的已知 bug，agent-harness.md 已记录应对）
- addyosmani.com/blog/agent-harness-engineering/（"a good harness + average model > bad harness + top model" 的实证）
- getmaxim.ai 多 agent 失败模式分析（O(N²) 协调代价，single-agent first 默认）

---

## 10. 写在最后

这份设计不是"推翻重做"，而是把已经有的零件（harness、5 agent、HITL、artifact 协议、interview_question_pool 飞轮）按"main-loop ReAct + plan-then-execute + inline HITL + context engineering"四个抽象重新连线。

最小可执行的第一步只有一行：**给 dock 装一个 `create_react_agent`，把 5 个领域 agent 注册为它的工具**。剩下的所有方向都是这步上的衍生。

一旦这一步走完，Relay 的 chat 就从"一个会查表的分诊台"升级成"一个真的 agent"——而这正是 vantage-ui-mapping.md §1.1 把 dock 定义为"persistent always-here agent"时设计师真正想要的样子。
