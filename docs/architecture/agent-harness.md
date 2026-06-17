# Agent Harness · LangGraph 执行框架

> 可交互版本见 [`assets/agent-execution-deep-diagrams.html`](../assets/agent-execution-deep-diagrams.html)。

## 设计理念

**自研 Harness，基于 LangGraph 包装**。LangGraph 提供底层能力（ReAct 循环、状态图、checkpoint、interrupt），Harness 在其上封装业务层逻辑（成本控制、权限系统、审计、缓存、context 压缩）。两层职责：

```
┌─────────────────────────────────────────────┐
│  Relay Harness（自研封装层）                   │
│  cost tracking · token budget · audit log    │
│  cache · permissions · context compression   │
├─────────────────────────────────────────────┤
│  LangGraph（底层引擎）                         │
│  create_react_agent · StateGraph · interrupt │
│  checkpointer · Command · hooks             │
└─────────────────────────────────────────────┘
```

- **单 agent**：`create_react_agent` 提供 ReAct 循环 → Harness 通过 `pre_model_hook` / `post_model_hook` 注入 guard 逻辑
- **多 agent 编排**：LangGraph `StateGraph` 提供图引擎 → Harness 定义具体 workflow 拓扑 + saga 补偿
- **HITL**：LangGraph `interrupt()` + `Command(resume=...)` → Harness 封装 `@requires_approval` 装饰器 + WebSocket 通知
- **持久化**：LangGraph checkpointer → Harness 配置 PostgresSaver 连接已有 PG

**不使用 legacy LangChain `AgentExecutor`。**

## 已知风险与应对（来自调研）

| 风险 | 来源 | 应对 |
|------|------|------|
| `post_model_hook` 不注入 InjectedState/InjectedStore 到工具调用 | [langgraph#4841](https://github.com/langchain-ai/langgraph/issues/4841)，3-0 确认 | guards 逻辑**不依赖 InjectedState**，改为在 hook 函数内直接操作 state dict；等上游修复后再迁移 |
| 多 agent 协调复杂度 O(N²) | [getmaxim.ai](https://www.getmaxim.ai/articles/multi-agent-system-reliability-failure-patterns-root-causes-and-production-validation-strategies/)，2-1 确认 | 5 agent 通过共享 DB + 事件总线解耦，不做 agent 间直接通信；coordinator 是唯一的交互点 |
| OpenRouter + 国产模型的 function calling 兼容性 | 社区反馈 | MVP 第一周写 smoke test 验证 DeepSeek/GLM 经 OpenRouter 的 tool_use 稳定性 |

## 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| ReAct 引擎 | LangGraph `create_react_agent` | 内置 ReAct 循环,5 个 agent 复用 |
| 编排引擎 | LangGraph `StateGraph` | 固定 workflow 用显式 edge,对话式用 conditional edge |
| LLM 接入 | `langchain_openai.ChatOpenAI` + OpenRouter | 通过 `base_url` 覆盖接入国产模型 |
| HITL | LangGraph `interrupt()` + `Command(resume=...)` | 工具内动态断点,配合 checkpointer |
| 持久化 | `langgraph-checkpoint-postgres` | 利用已有 PG (5433),支持 HITL resume |
| 异步事件 | Redis Streams | 跨调用的异步事件触发（LangGraph 管单次调用内，Redis 管跨调用） |
| 浏览器自动化 | browser-use (CDP) + Playwright MCP | 服务端抓取用 browser-use；客户端投递用 Playwright MCP Chrome Extension |
| 封装层 | 自研 Harness | cost/token/error guards, cache, audit, permissions |

## LLM 模型分层 (via OpenRouter)

| 层级 | OpenRouter ID | 价格($/M tokens) | 用途 |
|------|--------------|-------------------|------|
| 重推理 | `deepseek/deepseek-v4-pro` | $0.435 / $0.87 | 面试深度评估、复杂匹配 |
| 通用 | `z-ai/glm-4.7` | $0.40 / $1.75 | 简历优化/定制、求职信、问题生成 |
| 快/便宜 | `deepseek/deepseek-v4-flash` | $0.098 / $0.196 | JD 解析、技能提取、字段映射 |

## ReAct 执行循环

LangGraph `create_react_agent` 内置 ReAct 循环（THINK → tool_use → OBSERVE → 回 THINK）：

```python
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI

model = ChatOpenAI(
    model="z-ai/glm-4.7",
    api_key=os.environ["OPENROUTER_API_KEY"],
    base_url=os.environ["OPENROUTER_BASE_URL"],
)

resume_agent = create_react_agent(
    model=model,
    tools=[parse_resume, analyze_skills, optimize_resume],
    name="resume_agent",
    prompt="You rephrase, never fabricate experience.",
    checkpointer=postgres_checkpointer,
)
```

## Loop Guards（防失控）

LangGraph 仅内置 `recursion_limit`，其余 guard 通过 state + `pre_model_hook` / `post_model_hook` 实现：

| Guard | 实现方式 | 默认值 | 触发后 |
|-------|---------|--------|--------|
| max_iterations | `recursion_limit=40`（20 轮 × 2 步/轮） | 20 轮 | 抛 `GraphRecursionError` → 捕获后总结 |
| token_budget | `post_model_hook` 累加 token 计数 | 80,000 | `pre_model_hook` 中压缩旧历史 |
| cost_limit | state 中 `total_cost` 字段 + hook 检查 | $0.50/session | 暂停 + 通知 |
| timeout | `asyncio.wait_for` 包裹 invoke | 300s | 中止 |
| error_count | state 中 `consecutive_errors` 字段 | 3 连续 | 中止 |

## Context Window 管理

通过 `pre_model_hook` 在每次 LLM 调用前检查：

- 跟踪每条消息 token 用量（state 中累计）
- 超 60k：压缩旧 observation，保留 system + 最近 5 轮 + task
- 旧步骤摘要化："步骤 1–8 摘要"

## HITL Checkpoint（人在回路）

使用 LangGraph 的 **动态 `interrupt()`**（非旧版静态 `interrupt_before`）：

```python
from langgraph.types import interrupt, Command

@tool
def submit_form(job_url: str, fields: dict):
    """Submit a job application form — requires user approval."""
    decision = interrupt({
        "action": "submit_form",
        "job_url": job_url,
        "fields": fields,
        "message": "Agent 想投递到该职位,批准?",
    })
    if decision.get("type") == "approve":
        return do_submit(job_url, decision.get("fields", fields))
    return "用户取消投递"
```

恢复执行（用户审批后）：

```python
graph.invoke(
    Command(resume={"type": "approve", "fields": {...}}),
    config={"configurable": {"thread_id": session_id}},
)
```

**关键约束**：`interrupt()` 必须配 checkpointer（暂停时存盘）。`thread_id` 对应 session，复用才能 resume。

触发条件：`submit_form` `send_email` `delete_*` `purchase_*` `enter_credentials` `cost > threshold`

> 对求职 agent 尤其关键：投递不可逆，`submit` 永远需要用户确认。

## Tool 权限系统

四个风险等级，通过 `@requires_approval` 装饰器集成 `interrupt()`：

| 级别 | LangGraph 实现 | 示例 |
|------|---------------|------|
| **AUTO** | 直接注册为 tool，静默执行 | fetch_url, read_file, navigate |
| **NOTIFY** | 执行后发 WebSocket 通知 | write_file, fill_form, save_resume |
| **APPROVE** | 工具内调 `interrupt()` 暂停等确认 | submit_form, send_email, bash_write |
| **BLOCK** | 不注册进 tools 列表 | enter_credentials, purchase, rm -rf |

## Coordinator 编排（LangGraph StateGraph）

所有编排都在 LangGraph 内完成，两种模式：

### 模式 A：固定 Workflow（显式 edge）

确定性流程，不依赖 LLM 路由决策。适合已知步骤的 saga 事务：

```python
from langgraph.graph import StateGraph

# "准备投递" = resume定制 → 求职信 → 表单答案 → 用户审核
workflow = StateGraph(ApplicationState)
workflow.add_node("customize_resume", resume_agent)
workflow.add_node("generate_cover_letter", appprep_agent)
workflow.add_node("generate_form_answers", appprep_agent)
workflow.add_node("review_checkpoint", hitl_review)

workflow.add_edge("customize_resume", "generate_cover_letter")
workflow.add_edge("generate_cover_letter", "generate_form_answers")
workflow.add_edge("generate_form_answers", "review_checkpoint")
```

### 模式 B：对话式路由（conditional edge）

用户意图不明确时，LLM 决定路由到哪个 agent：

```python
def route_by_intent(state: CoordinatorState) -> str:
    """LLM 分析用户意图，返回下一个 agent 节点名"""
    intent = classify_intent(state["messages"][-1])
    return intent  # "resume_agent" | "interview_agent" | ...

coordinator = StateGraph(CoordinatorState)
coordinator.add_node("resume_agent", resume_agent)
coordinator.add_node("interview_agent", interview_agent)
coordinator.add_node("jobmatch_agent", jobmatch_agent)
# ...
coordinator.add_conditional_edges("router", route_by_intent)
```

### Saga 补偿

workflow 中任一节点失败时，通过 conditional edge 路由到补偿节点：

```python
def check_result(state):
    if state["last_error"]:
        return "compensate"
    return "next_step"

workflow.add_conditional_edges("generate_cover_letter", check_result, {
    "next_step": "generate_form_answers",
    "compensate": "rollback_resume",
})
```

### 跨调用的异步事件

**LangGraph 管单次请求内的编排，Redis Streams 管跨请求的异步触发**：

```python
# Redis Streams 监听（LangGraph 之外）
# 简历更新 → 触发新的 LangGraph workflow 调用
async def on_resume_updated(event):
    await jobmatch_workflow.ainvoke(
        {"user_id": event["user_id"]},
        config={"configurable": {"thread_id": f"rematch-{event['user_id']}"}},
    )
```

## Checkpointer（持久化）

使用 `langgraph-checkpoint-postgres`（复用已有 PG 5433）：

- HITL 暂停/恢复依赖 checkpointer（硬依赖）
- 每个 session 对应一个 `thread_id`
- 支持审计回溯（查看任意步骤的完整 state）

## Sandbox 隔离（服务器端工具）

当 agent 需要跑 bash 或服务器端浏览器时，每个 session 跑在独立 Docker container：

- 独立 network namespace（用户间不互通）
- tmpfs ephemeral 文件系统（session 结束即清除）
- `--user nobody` 最低权限 + seccomp 过滤
- cgroup 资源限制（512MB / 0.5 CPU / 100MB disk / 300s）
- session 结束 `docker rm`

> 注：**客户端投递方案不需要服务器 sandbox**——投递在用户浏览器本地完成。Sandbox 主要用于服务器端的简历解析、JD 抓取等。

## 可观测性

每次 agent 调用记录：

```json
{
  "agent": "resume_agent", "version": 2, "action": "customize",
  "user_id": "...", "latency_ms": 3200, "cost_cents": 1.45,
  "tokens_in": 4000, "tokens_out": 1200, "cache_hit": false,
  "model": "z-ai/glm-4.7", "status": "success", "trace_id": "..."
}
```

Dashboard 监控：成功率、延迟分布、成本趋势、错误模式。

## 目录结构

```
agents/
├── harness/                  # ── 自研封装层（基于 LangGraph）──
│   ├── base.py              # BaseAgent: 包装 create_react_agent + 注入 hooks
│   ├── llm.py               # ChatOpenRouter(ChatOpenAI): 模型选择/fallback/成本计算
│   ├── checkpointer.py      # PostgresSaver 工厂(复用 PG 5433)
│   ├── guards.py            # pre/post_model_hook: token/cost/error 计数 + 中止逻辑
│   ├── permissions.py       # @requires_approval 装饰器 → 自动包裹 interrupt()
│   ├── cache.py             # Redis 缓存层: hash(input) → cached result
│   ├── audit.py             # 每次调用的 cost/latency/trace 记录
│   ├── context.py           # pre_model_hook: context window 压缩(>60k 摘要旧步骤)
│   └── state.py             # 共享 state schema (TypedDict, 含 cost/token/trace)
│
├── tools/                    # ── 工具层（按权限级别组织）──
│   ├── auto.py              # AUTO: fetch_url, read_file, navigate
│   ├── notify.py            # NOTIFY: write_file, fill_form, save_resume
│   └── approve.py           # APPROVE: submit_form, send_email (含 interrupt())
│
├── nodes/                    # ── 5 个 agent（各继承 BaseAgent）──
│   ├── resume_agent.py      # ResumeAgent: 解析/优化/定制/分析
│   ├── jobmatch_agent.py    # JobMatchAgent: 抓取/匹配/通知
│   ├── interview_agent.py   # InterviewAgent: 出题/评估/题库
│   ├── appprep_agent.py     # AppPrepAgent: 投递包准备
│   └── trend_agent.py       # TrendAgent: ETL/趋势/报告
│
├── coordinator/              # ── 编排层（LangGraph StateGraph）──
│   ├── router.py            # 对话式路由: conditional edge + intent 分类
│   ├── workflows.py         # 固定 workflow: prepare_application, daily_match 等
│   └── saga.py              # Saga 补偿: conditional edge → rollback 节点
│
├── events/                   # ── 异步事件层（LangGraph 之外）──
│   └── bus.py               # Redis Streams 事件订阅/发布
│
├── prompts/                  # 版本化 prompt 文件（可热更新）
│
└── api/                      # ── FastAPI 入口 ──
    ├── server.py            # HTTP 路由 + WebSocket HITL 通知
    └── deps.py              # 依赖注入: checkpointer, llm, event_bus
```

## 浏览器自动化方案选型

基于调研（27 个来源，对抗性验证），浏览器自动化分两个场景：

### 服务端：browser-use (CDP)

用于 JobMatchAgent 抓取职位页、解析复杂 JD 等服务端任务。

- browser-use 已从 Playwright 迁移到原生 CDP（[来源](https://browser-use.com/posts/playwright-to-cdp)，3-0 确认），消除 Node.js 中继层延迟
- 50k+ GitHub stars，与 LangChain 原生集成
- 支持 DOM 提取 + vision 模型 + 多 tab + 自定义 action + 持久记忆

```python
from browser_use import Agent as BrowserAgent

browser_agent = BrowserAgent(
    task="Extract job description from this career page",
    llm=fast_model,  # DeepSeek V4 Flash
)
result = await browser_agent.run()
```

### 客户端：Playwright MCP Chrome Extension

用于 AppPrepAgent 的表单填充，运行在用户浏览器内。

- Playwright MCP 支持通过 Chrome Extension 连接用户已有浏览器（[来源](https://github.com/microsoft/playwright-mcp)，3-0 确认）
- 直接利用用户的登录态和浏览器状态 — 零封号风险
- MCP 模式适合"持久状态 + 丰富内省 + 迭代推理"的 agentic loop（[来源](https://github.com/microsoft/playwright-mcp)，3-0 确认）

```
用户浏览器
├── Playwright MCP Chrome Extension  ← agent 通过 MCP 协议控制
│   ├── 连接已有 tab（已登录 ATS）
│   ├── 读取表单字段（accessibility snapshot）
│   └── 填充字段（用户审核后）
└── 用户亲自点 Submit
```

### 备选：Stagehand v3

- Agent Mode 模型无关 + 自动缓存重复操作（[来源](https://www.browserbase.com/blog/stagehand-v3)，2-1 确认）
- Context builder 减少 token 浪费 + 自愈执行层应对 DOM 变化（2-1 确认）
- 适合 Phase 3 桌面 App 方案（CDP 直连 + Stagehand 的 act/extract/observe 原语）

## 调研驱动的设计建议

基于 110 agent / 27 来源 / 132 声明 / 10 条对抗性验证通过的调研：

### 1. Harness > Model

> "一个好的 harness + 普通模型 > 一个差的 harness + 顶级模型"（[addyosmani.com/blog/agent-harness-engineering/](https://addyosmani.com/blog/agent-harness-engineering/)）

→ 投入在 guards / context 管理 / tool 权限 / 审计上，比追求更贵的模型更值。

### 2. 默认单 agent，按需拆分

> "默认用单 agent 架构，只有在工作负载明确受益于并行化时才拆多 agent"（[getmaxim.ai](https://www.getmaxim.ai/articles/multi-agent-system-reliability-failure-patterns-root-causes-and-production-validation-strategies/)，2-1 确认）

→ 我们的 5 agent 拆分是按**职责域**而非按**并行需求**。它们通过 DB + 事件总线解耦，不做 agent 间直接通信，coordinator 是唯一交互点。这个设计符合最佳实践。

### 3. Context 压缩三级策略

> 长程 agent 执行需要：compaction（压缩旧 context）→ tool-call offloading（大 output 存文件系统）→ full context reset（撕掉 session 从 hand-off 文件重建）（[addyosmani.com](https://addyosmani.com/blog/agent-harness-engineering/)）

→ 已在 `pre_model_hook` 中实现第一级（compaction）。Phase 2 加入 offloading（tool output 超 4K 时存 Redis，只保留摘要在 context 中）。

### 4. 生成-评估分离

> "把生成和评估拆成不同 agent（planner/generator/evaluator）优于单 agent 自评"（[addyosmani.com](https://addyosmani.com/blog/agent-harness-engineering/)）

→ 已在 InterviewAgent 中天然体现（生成问题 vs 评估回答用不同模型）。AppPrepAgent 的投递包生成后也由 coordinator 触发独立的质量检查节点。

### 5. Tool Calling Smoke Test 优先

OpenRouter + 国产模型的 function calling 兼容性是最大风险。**MVP 第一周必须验证**：

```python
# smoke_test.py — 在任何 agent 代码之前运行
async def test_tool_calling():
    for model_id in ["deepseek/deepseek-v4-pro", "z-ai/glm-4.7", "deepseek/deepseek-v4-flash"]:
        model = ChatOpenAI(model=model_id, base_url=OPENROUTER_BASE_URL, api_key=OPENROUTER_API_KEY)
        agent = create_react_agent(model=model, tools=[dummy_tool])
        result = await agent.ainvoke({"messages": [("user", "Call the dummy_tool with arg='hello'")]})
        assert any(hasattr(m, "tool_calls") for m in result["messages"])
```
