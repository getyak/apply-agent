# Agent Event Stream · 实时步骤流协议设计

> Relay agent loop 的每一步（reasoning / tool call / tool result / file edit / browser snapshot / HITL）实时流到前端的统一协议、传输、渲染设计。
>
> **路线决策（2026-06-29）**：直接装 AG-UI SDK（`ag-ui-protocol` + `ag-ui-langgraph` + `@ag-ui/client`）；不装 CopilotKit，React 层自写 SSE consumer；agents 侧同期接入 Playwright MCP Chrome Extension 让 `browser_snapshot` 有真实事件源。
>
> 关联：[`agent-harness.md`](agent-harness.md) · [`vantage-ui-mapping.md`](vantage-ui-mapping.md) · [`error-handling.md`](error-handling.md) · [`client-side-delivery.md`](client-side-delivery.md) · [`cicd-aiops-harness.md`](cicd-aiops-harness.md)

---

## 0. TL;DR

```
agents (FastAPI+LangGraph)              api (Hono+Bun)              web (Next.js)
┌──────────────────────────┐            ┌──────────────┐            ┌────────────────────┐
│ LangGraph astream_events │            │              │            │  @ag-ui/client     │
│    │                     │            │              │            │  SSE consumer      │
│    ▼                     │            │              │            │    │               │
│ ag-ui-langgraph adapter  │  SSE +     │ /ask/stream  │  SSE +     │    ▼               │
│    │  AG-UI events       │  trace_id  │ pure pass-   │  trace_id  │ event reducer      │
│    ▼                     │ ───────▶   │ through      │ ───────▶   │    │               │
│ ag-ui-protocol Python    │            │ + auth +     │            │    ▼               │
│ encoder → SSE frames     │            │ rate limit   │            │ Zustand step map   │
│                          │            │              │            │    │               │
│ + Playwright MCP tools   │            │              │            │    ▼               │
│   → CUSTOM events        │            │              │            │ <StepTimeline />   │
│   (file_edit, browser)   │            │              │            │   per-step lazy    │
└──────────────────────────┘            └──────────────┘            └────────────────────┘
```

**核心数据流**：每个 agent step（plan/thinking/tool/file_edit/browser/hitl）在前端被收敛成一个 `Step` 对象，event 是 step 的增量更新。前端按 `step_id` 维护 `Map<id, Step>`，UI 渲染 `steps[]`，不直接渲染 raw events。

---

## 1. 为什么不沿用现有自造 SSE

现状（见 [`vantage-ui-mapping.md`](vantage-ui-mapping.md) §1.4 与本仓库 SSE 实测）：

- 13 个事件名散落在 `agents/api/server.py:600–943` 与 `agents/coordinator/dock_agent.py`
- 5 个映射阶段在 `api/src/routes/ask.ts:254–516`，event → NDJSON kind 一对多翻译
- 前端 17 个 `DockMsgKind` 分支在 `dock.tsx` 各处分散匹配
- HITL 字段形状每次都靠 `toHitlNdjson()` 推断

**痛点**：
1. 没有事件 ID / seq / parent_id —— 客户端无法去重、保序、关联父子
2. `task_graph` 全量推 —— 任一字段变动重传整张图
3. step 生命周期不显式 —— `queued / running / review / done` 由前端推断
4. event 元数据稀薄 —— 没有时间戳、duration、correlation
5. AG-UI 生态（CopilotKit、langchain ag-ui 适配、未来更多 IDE/dashboard 工具）想接接不上

**升级路径决策**：直接对齐 AG-UI 协议层 + 接官方 SDK，一次性把上面 5 个痛点全解决。

---

## 2. 协议选型：AG-UI

### 2.1 AG-UI 是什么

- 起源：CopilotKit 团队 2024 末提出，2025 中独立成 [`ag-ui-protocol`](https://github.com/ag-ui-protocol/ag-ui) 仓库
- 当前状态（2026-06 调研）：SDK 0.x，spec 在收敛但未 1.0
- 传输：**SSE** 为主（也支持 WebSocket，但 SSE 是默认）
- 编码：JSON event，每条 `data: {...}\n\n`
- 16 类标准事件，覆盖 lifecycle / reasoning / text / tool / state / interrupt / custom

### 2.2 已知风险（落地前必读）

| 风险 | 来源 | 落地策略 |
|---|---|---|
| `ag-ui-langgraph==0.0.42` 并发 tool call event 乱序 / 丢失 | [#871](https://github.com/ag-ui-protocol/ag-ui/issues/871)，未修 | dock_agent 暂时强制 ReAct 串行 tool 调用（`config={"max_concurrency": 1}`）；写 e2e 测试断言事件保序 |
| 命名 churn（Thinking → Reasoning 6 月内才改） | spec 演进 | 锁版本 `ag-ui-protocol==X.Y.Z`、`ag-ui-langgraph==X.Y.Z`、`@ag-ui/client@X.Y.Z`，升级前跑 e2e |
| `@ag-ui/react` 不存在 | spec 设计 | 不装 CopilotKit，web 端自写 SSE consumer 消费 `@ag-ui/client`（纯协议库，无 React） |
| Python 端无 FastAPI helper | spec 设计 | `ag-ui-protocol` Python 包提供 event 序列化，FastAPI SSE response 手写 |
| `CUSTOM` kind 自定义部分（file_edit / browser_snapshot）不在 spec | spec 限制 | 定义 `kind: "relay.file_edit"` / `kind: "relay.browser_snapshot"` 命名空间，文档化 |
| `ag-ui-protocol` 重大版本升级 | 0.x → 1.0 | 留 `protocol_version` 字段在 envelope，前端按版本路由 reducer |

### 2.3 不直接装 AG-UI 的反方案（已否决）

> 这条留作历史记录：之前调研时推荐"对齐命名但自造"的中间路线，被用户拒绝。原因是用户希望一次到位、接生态。本节存档以便回溯决策。

---

## 3. 事件 Schema（权威定义）

所有事件共享一个 envelope，payload 按 `type` 类型化。

### 3.1 Envelope

```ts
// web/src/lib/agent-events/schema.ts

export type AgentEvent =
  | LifecycleEvent
  | ReasoningEvent
  | TextEvent
  | ToolCallEvent
  | StateDeltaEvent
  | InterruptEvent
  | CustomEvent

interface EventBase {
  /** ULID,单调可排序、可去重 */
  id: string
  /** 一次 dock turn 的根 ID */
  run_id: string
  /** 所属 step 的稳定 ID(同一 step 的多条 event 共享) */
  step_id?: string
  /** 父 step ID(嵌套场景,如 tool 属于 plan_step) */
  parent_step_id?: string
  /** 同 run_id 内单调自增,客户端用于保序 */
  seq: number
  /** wall-clock ms */
  ts: number
  /** 串到 error-handling.md 的 traceId */
  trace_id: string
  /** AG-UI 协议版本号(0.x 频繁变更时按版本路由 reducer) */
  protocol_version: string
}
```

### 3.2 事件类型矩阵

| AG-UI type | Relay 用途 | step_id 行为 | payload 关键字段 |
|---|---|---|---|
| `RUN_STARTED` | dock turn 开始 | 创建 root step | `{user_msg, intent, model}` |
| `RUN_FINISHED` | dock turn 结束 | 关闭 root step | `{duration_ms, total_cost_cents, total_tokens}` |
| `RUN_ERROR` | 异常终止 | root step → failed | `{code, message, trace_code}` |
| `REASONING_START` | 模型开始思考 | 新建 thinking step | `{model}` |
| `REASONING_CONTENT` | 思考 delta | 追加到 step.reasoning_text | `{delta}` |
| `REASONING_END` | 思考结束 | 关闭 thinking step | `{duration_ms}` |
| `TEXT_MESSAGE_START` | 助手回复开始 | 新建 assistant_text step | `{role: "assistant"}` |
| `TEXT_MESSAGE_CONTENT` | 文本 delta | 追加到 step.text | `{delta}` |
| `TEXT_MESSAGE_END` | 助手回复结束 | 关闭 step | `{duration_ms}` |
| `TOOL_CALL_START` | 工具调用开始 | 新建 tool step | `{tool_name, tool_call_id, parent_message_id}` |
| `TOOL_CALL_ARGS` | 工具参数流式增量 | 追加到 step.args | `{delta}` |
| `TOOL_CALL_END` | 工具调用发出 | step.status → running | `{}` |
| `TOOL_CALL_RESULT` | 工具结果 | step.status → done，设 step.result | `{result, status: success/error}` |
| `STATE_SNAPSHOT` | 全量状态（初始或恢复时） | 重建 plan steps | `{state}` |
| `STATE_DELTA` | 状态增量（JSON Patch RFC 6902） | 更新 plan steps 的子字段 | `{patch: JsonPatch[]}` |
| `MESSAGE_SNAPSHOT` | 消息历史快照 | 重建消息时间线 | `{messages}` |
| `INTERRUPT` | HITL 等待用户决策 | 新建 hitl step | `{kind: ask_user/diff/approval, payload}` |
| `RESUME` | 用户决策回传 | 关闭 hitl step | `{value}` |
| `CUSTOM` | Relay 扩展事件 | 见 §3.3 | `{kind: "relay.*", payload}` |

### 3.3 Relay CUSTOM 事件命名空间

`kind` 字段强制 `relay.` 前缀，避免与未来 AG-UI 标准事件名冲突。

| kind | step kind | payload schema |
|---|---|---|
| `relay.file_edit` | `file_edit` | `{path: string, language: string, hunks: Hunk[], applied: boolean}` |
| `relay.file_edit.preview` | 同 step | `{path: string, before: string, after: string}` |
| `relay.browser_snapshot` | `browser` | `{url, screenshot_url, viewport: {w,h}, accessibility_tree?: object}` |
| `relay.browser_action` | 同 step | `{action: "click"\|"fill"\|"navigate", target: string, value?: string}` |
| `relay.narrator` | `narrator` | `{text: string}` (沿用现有思考-aloud 设计) |
| `relay.partial_artifact` | `artifact` | `{artifact_id: string, snapshot: object}` |
| `relay.heartbeat` | — | `{}` (替代 ping) |
| `relay.plan_step_change` | — | `{step_id, status, title}` (作为 STATE_DELTA 的语义化补充，可选) |

> 设计意图：`CUSTOM` 走 AG-UI 标准通道，客户端 reducer 见 `type==CUSTOM` 后按 `payload.kind` 二次分发。**spec 升级如果未来收纳 file_edit / browser_snapshot 进标准事件，Relay reducer 改一处路由即可**。

### 3.4 Step 模型（前端聚合）

```ts
// web/src/lib/agent-events/step.ts

export type StepKind =
  | "run"               // root,整个 dock turn
  | "plan"              // 来自 propose_plan 工具
  | "thinking"          // REASONING_* 聚合
  | "assistant_text"    // TEXT_MESSAGE_* 聚合
  | "tool"              // TOOL_CALL_* 聚合
  | "file_edit"         // CUSTOM:relay.file_edit
  | "browser"           // CUSTOM:relay.browser_snapshot
  | "hitl"              // INTERRUPT / RESUME
  | "narrator"          // CUSTOM:relay.narrator
  | "artifact"          // CUSTOM:relay.partial_artifact

export type StepStatus =
  | "queued"            // plan 里声明但还没跑
  | "running"           // 进行中
  | "review"            // HITL 等用户审
  | "done"              // 完成
  | "failed"            // 失败
  | "skipped"           // 用户跳过

export interface Step {
  id: string
  run_id: string
  parent_step_id?: string
  kind: StepKind
  status: StepStatus
  title: string
  started_at: number
  finished_at?: number
  duration_ms?: number

  // kind 特定字段（都可选，按 kind 出现）
  reasoning_text?: string
  text?: string
  tool?: {
    name: string
    args: unknown
    result?: unknown
    error?: { code: string; message: string }
  }
  file?: { path: string; language: string; hunks: Hunk[]; applied: boolean }
  browser?: { url: string; screenshot_url: string; viewport: { w: number; h: number } }
  hitl?: { kind: "ask_user" | "diff" | "approval"; payload: unknown; decision?: unknown }
  artifact?: { id: string; snapshot: object }

  // 原始 event 流（展开调试用，默认不渲染）
  events: AgentEvent[]
}
```

---

## 4. 传输与中间层

### 4.1 SSE 选择（不换 WebSocket）

理由：
- AG-UI 默认 SSE
- 现有 `/ask/stream` 全链路已经在 SSE 上跑通（心跳、重连、Bun 透传、Next.js 客户端）
- WebSocket 需要额外的连接管理 / 鉴权 / 反向代理配置，投入回报比低
- HITL resume 用单独 POST `/ask/resume` 代替 client-to-server WebSocket frame —— 已经在用

### 4.2 帧格式

```
event: agui                                 ← 固定值，标识 AG-UI 帧
id: <ULID>                                  ← 客户端 reconnect 时 Last-Event-Id 用
data: {<AgentEvent JSON>}\n\n
```

心跳 15s 一次：`event: heartbeat\ndata: {}\n\n`（不走 AG-UI envelope，纯 keepalive）。

### 4.3 跨层 traceId 一致性

按 [`error-handling.md`](error-handling.md) §5 的端到端 trace 规则，web 不主动发 `X-Trace-Id`，Bun 入口生成，FastAPI 继承并在每条 `AgentEvent.trace_id` 中携带。前端 dock 上的步骤详情、错误展开都能直接拷贝 `traceCode`。

### 4.4 错误处理（对接 error-handling.md）

| 场景 | AG-UI 事件 | error envelope |
|---|---|---|
| dock turn 内 LLM/工具失败 | `RUN_ERROR` | payload 含 `{code, message, trace_code}`，客户端按 [§4.3.2 error-router](error-handling.md) 渲染 toast/inline |
| SSE 连接断 | （无 event） | 客户端按 `runAskStream` 现有重连逻辑（Last-Event-Id） |
| HITL 超时 | `RUN_ERROR` with `code: AGENT_INTERRUPT_TIMEOUT` | 同上 |

---

## 5. agents 实现

### 5.1 依赖

```toml
# agents/pyproject.toml 新增
"ag-ui-protocol == X.Y.Z"     # 锁定具体版本,升级走专门 PR
"ag-ui-langgraph == X.Y.Z"    # 同上
# Playwright MCP 走 mcp 标准客户端
"mcp == X.Y.Z"
```

> 版本号待选型时填入。CI 加 `pip-compile` lockfile 锁死，升级需独立 PR + e2e。

### 5.2 emitter 改造

```python
# agents/harness/events.py（新）

from ag_ui import (
    EventEncoder, RunStartedEvent, RunFinishedEvent,
    ReasoningStartEvent, ReasoningContentEvent, ReasoningEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
    StateDeltaEvent, InterruptEvent, CustomEvent,
)
import ulid

class RelayEmitter:
    """统一 emitter,负责 ULID + seq + trace_id + parent_step_id 注入"""

    def __init__(self, run_id: str, trace_id: str):
        self.run_id = run_id
        self.trace_id = trace_id
        self.seq = 0
        self.encoder = EventEncoder()

    def emit(self, event_cls, *, step_id=None, parent_step_id=None, **payload):
        self.seq += 1
        evt = event_cls(
            id=str(ulid.new()),
            run_id=self.run_id,
            step_id=step_id,
            parent_step_id=parent_step_id,
            seq=self.seq,
            ts=int(time.time() * 1000),
            trace_id=self.trace_id,
            protocol_version=AGUI_PROTOCOL_VERSION,
            **payload,
        )
        return self.encoder.encode(evt)   # → SSE frame bytes
```

### 5.3 LangGraph 适配

```python
# agents/coordinator/dock_agent.py 改造

from ag_ui_langgraph import LangGraphAGUIAdapter

async def run_dock_turn(messages, thread_id, trace_id):
    run_id = str(ulid.new())
    emitter = RelayEmitter(run_id=run_id, trace_id=trace_id)

    yield emitter.emit(RunStartedEvent, intent=intent, model=model_id)

    adapter = LangGraphAGUIAdapter(
        graph=graph,
        emitter=emitter,
        # 强制串行 tool 调用以规避 #871
        config={"max_concurrency": 1, "configurable": {"thread_id": thread_id}},
    )

    async for frame in adapter.astream({"messages": messages}):
        yield frame  # adapter 内部已经发 REASONING/TEXT/TOOL_CALL_* 事件

    yield emitter.emit(RunFinishedEvent, duration_ms=..., total_cost_cents=...)
```

### 5.4 CUSTOM 事件源：Playwright MCP 工具

```python
# agents/tools/browser.py（新）

from mcp.client.session import ClientSession

@tool(level="APPROVE")
async def browser_fill_form(url: str, fields: dict, emitter: RelayEmitter, step_id: str):
    """填充用户浏览器 tab 的表单。需要 HITL approve。"""
    async with ClientSession.connect("playwright-mcp-chrome-ext") as mcp:
        # 1. 截图当前状态
        snap = await mcp.call_tool("browser.snapshot", {"url": url})
        yield emitter.emit(CustomEvent, step_id=step_id, kind="relay.browser_snapshot",
                           payload={"url": url, "screenshot_url": snap.screenshot,
                                    "viewport": snap.viewport,
                                    "accessibility_tree": snap.a11y_tree})

        # 2. 逐字段填充
        for field_name, value in fields.items():
            await mcp.call_tool("browser.fill", {"selector": f"[name={field_name}]", "value": value})
            yield emitter.emit(CustomEvent, step_id=step_id, kind="relay.browser_action",
                               payload={"action": "fill", "target": field_name, "value": value})

        # 3. 填充后再截图
        snap2 = await mcp.call_tool("browser.snapshot", {"url": url})
        yield emitter.emit(CustomEvent, step_id=step_id, kind="relay.browser_snapshot",
                           payload={"url": url, "screenshot_url": snap2.screenshot,
                                    "viewport": snap2.viewport})
```

```python
# agents/tools/file.py（新）

@tool(level="NOTIFY")
async def edit_resume_bullet(resume_id, bullet_id, new_text, emitter, step_id):
    """编辑简历某条 bullet。"""
    before = await db.get_bullet(resume_id, bullet_id)

    # 先发 preview 事件,给前端渲染 diff
    yield emitter.emit(CustomEvent, step_id=step_id, kind="relay.file_edit.preview",
                       payload={"path": f"resume:{resume_id}#{bullet_id}",
                                "before": before.text, "after": new_text})

    # 应用变更
    await db.update_bullet(resume_id, bullet_id, new_text)

    # 发最终 file_edit 事件
    yield emitter.emit(CustomEvent, step_id=step_id, kind="relay.file_edit",
                       payload={"path": f"resume:{resume_id}#{bullet_id}",
                                "language": "markdown",
                                "hunks": [{"before": before.text, "after": new_text}],
                                "applied": True})
```

### 5.5 FastAPI 出口

```python
# agents/api/server.py 改造

@app.post("/ask/stream")
async def ask_stream(req: AskRequest):
    trace_id = request.state.trace_id

    async def gen():
        async for frame in run_dock_turn(req.messages, req.thread_id, trace_id):
            yield frame
            # heartbeat 由 _with_heartbeat 包裹,保留现有逻辑

    return StreamingResponse(
        _with_heartbeat(gen(), interval=15),
        media_type="text/event-stream",
        headers={"X-Trace-Id": trace_id, "Cache-Control": "no-cache"},
    )
```

---

## 6. api gateway（Bun）纯透传

```ts
// api/src/routes/ask.ts 重构

app.post('/api/ask/stream', async (c) => {
  await rateLimit(c)
  await authRequired(c)

  const upstream = await fetch(`${AGENTS_URL}/ask/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id': c.var.traceId,
      'X-Request-Id': c.var.requestId,
      'X-Relay-Locale': c.req.header('X-Relay-Locale') ?? 'en',
    },
    body: JSON.stringify(await c.req.json()),
  })

  // 透传所有 SSE 帧，不解析、不翻译
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Trace-Id': upstream.headers.get('X-Trace-Id') ?? c.var.traceId,
    },
  })
})
```

**关键**：gateway 不再解析 / 翻译 / 重组事件。所有事件名、字段、扩展直接由 agents 决定。

> 旧 `task_graph` 合成、`hitl` 推断、`thinking` → `agent_start` 映射全部废弃。Gateway 回到"网关本职"：鉴权、限流、trace 注入、透传。

---

## 7. web 实现

### 7.1 依赖

```json
// web/package.json 新增
"@ag-ui/client": "^X.Y.Z"
```

**不引入** `@copilotkit/*`。React 层完全自写。

### 7.2 SSE consumer

```ts
// web/src/lib/agent-events/consumer.ts（替换 web/src/lib/ask-stream.ts）

import { AgUiClient } from '@ag-ui/client'
import type { AgentEvent } from './schema'

export interface ConsumerCallbacks {
  onEvent: (event: AgentEvent) => void
  onHeartbeat: () => void
  onConnectionError: (err: Error) => void
}

export async function consumeAgentStream(
  url: string,
  body: unknown,
  cb: ConsumerCallbacks,
  signal: AbortSignal,
) {
  const client = new AgUiClient({
    transport: 'sse',
    url,
    headers: { 'Content-Type': 'application/json' },
  })

  for await (const event of client.stream({ body, signal })) {
    if (event.type === 'heartbeat') {
      cb.onHeartbeat()
      continue
    }
    cb.onEvent(event as AgentEvent)
  }
}
```

### 7.3 Reducer + Zustand store

```ts
// web/src/lib/agent-events/reducer.ts

export function applyEvent(steps: Map<string, Step>, evt: AgentEvent): Map<string, Step> {
  const next = new Map(steps)

  switch (evt.type) {
    case 'RUN_STARTED': {
      next.set(evt.run_id, makeStep({ id: evt.run_id, kind: 'run', status: 'running', ... }))
      break
    }
    case 'REASONING_START': {
      const id = evt.step_id!
      next.set(id, makeStep({ id, kind: 'thinking', status: 'running', parent_step_id: evt.run_id, ... }))
      break
    }
    case 'REASONING_CONTENT': {
      const step = next.get(evt.step_id!)!
      next.set(step.id, { ...step, reasoning_text: (step.reasoning_text ?? '') + evt.payload.delta })
      break
    }
    case 'TOOL_CALL_START': {
      const id = evt.step_id!
      next.set(id, makeStep({
        id, kind: 'tool', status: 'running',
        tool: { name: evt.payload.tool_name, args: undefined },
        ...
      }))
      break
    }
    case 'TOOL_CALL_RESULT': {
      const step = next.get(evt.step_id!)!
      next.set(step.id, {
        ...step,
        status: evt.payload.status === 'success' ? 'done' : 'failed',
        tool: { ...step.tool!, result: evt.payload.result },
        finished_at: evt.ts,
      })
      break
    }
    case 'CUSTOM': {
      return applyCustom(next, evt)   // 见 §7.4
    }
    case 'STATE_DELTA': {
      return applyJsonPatch(next, evt.payload.patch)
    }
    // ... 其它分支
  }

  // 所有 event 落进对应 step 的 events 数组（调试用）
  const step = next.get(evt.step_id ?? evt.run_id)
  if (step) next.set(step.id, { ...step, events: [...step.events, evt] })

  return next
}
```

```ts
// web/src/lib/agent-events/custom.ts

export function applyCustom(steps: Map<string, Step>, evt: CustomEvent) {
  const next = new Map(steps)
  switch (evt.payload.kind) {
    case 'relay.file_edit': {
      const id = evt.step_id!
      const existing = next.get(id)
      next.set(id, existing ? { ...existing, file: evt.payload, status: 'done' }
                            : makeStep({ id, kind: 'file_edit', status: 'done', file: evt.payload, ... }))
      break
    }
    case 'relay.browser_snapshot': {
      const id = evt.step_id!
      const existing = next.get(id)
      // 多次 snapshot 累积为快照数组（支持回看）
      const snapshots = existing?.browser?.snapshots ?? []
      next.set(id, /* 累加 snapshot */)
      break
    }
    case 'relay.narrator': /* ... */
    case 'relay.partial_artifact': /* ... */
  }
  return next
}
```

```ts
// web/src/lib/agent-events/store.ts

interface AgentStreamState {
  steps: Map<string, Step>
  rootStepId: string | null
  isStreaming: boolean
  pushEvent: (e: AgentEvent) => void
  reset: () => void
}

export const useAgentStream = create<AgentStreamState>()(
  subscribeWithSelector((set, get) => ({
    steps: new Map(),
    rootStepId: null,
    isStreaming: false,
    pushEvent: (e) => set((s) => ({
      steps: applyEvent(s.steps, e),
      rootStepId: e.type === 'RUN_STARTED' ? e.run_id : s.rootStepId,
      isStreaming: e.type !== 'RUN_FINISHED' && e.type !== 'RUN_ERROR',
    })),
    reset: () => set({ steps: new Map(), rootStepId: null, isStreaming: false }),
  }))
)

// 选择器示例（避免整列表重渲染）
export const useStep = (id: string) =>
  useAgentStream((s) => s.steps.get(id), shallow)

export const useStepIds = () =>
  useAgentStream((s) => Array.from(s.steps.values())
    .sort((a, b) => a.started_at - b.started_at)
    .map((x) => x.id), shallow)
```

### 7.4 渲染层 —— StepTimeline + 各 kind 卡片

```tsx
// web/src/components/ask-vantage/step-timeline.tsx（新）

export function StepTimeline() {
  const ids = useStepIds()
  const parent = useRef<HTMLDivElement>(null)

  const v = useVirtualizer({
    count: ids.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 64,
  })

  return (
    <div ref={parent} className="h-full overflow-auto">
      {v.getVirtualItems().map((row) => (
        <div key={row.key} style={{ height: row.size, transform: `translateY(${row.start}px)` }}>
          <StepCard id={ids[row.index]} />
        </div>
      ))}
    </div>
  )
}
```

```tsx
// web/src/components/ask-vantage/step-card.tsx

export function StepCard({ id }: { id: string }) {
  const step = useStep(id)
  if (!step) return null
  switch (step.kind) {
    case 'thinking':      return <ThinkingCard step={step} />
    case 'tool':          return <ToolCard step={step} />
    case 'file_edit':     return <FileEditCard step={step} />     // 折叠,点开懒加载 diff viewer
    case 'browser':       return <BrowserCard step={step} />      // 折叠,点开懒加载截图
    case 'hitl':          return <HitlCard step={step} />
    case 'narrator':      return <NarratorChip step={step} />
    case 'assistant_text':return <AssistantText step={step} />
    case 'artifact':      return <ArtifactCard step={step} />
    case 'plan':          return <PlanCard step={step} />
    case 'run':           return null   // root,不直接渲染
  }
}
```

### 7.5 性能优化（具体到点）

1. **细粒度订阅**：`useStep(id)` 配合 `subscribeWithSelector` + `shallow`，单 step 字段变化只 re-render 自己
2. **流式增量字段 RAF 节流**：`reasoning_text` / `assistant_text` 用 `useDeferredValue` + 每 16ms 提交一次
3. **虚拟化**：`@tanstack/react-virtual` 在 step 数 > 30 时启用
4. **重资产懒加载**：
   - `FileEditCard` 默认渲染标题 + 行数 + 摘要，展开才动态 import `@monaco-editor/react` 渲染 diff
   - `BrowserCard` 默认渲染 url + 缩略图，展开才加载完整 screenshot + accessibility tree
5. **事件累积上限**：每个 step 的 `events: AgentEvent[]` 软上限 200，超出后保留首尾各 50 条 + 中间一条 `_truncated` 标记
6. **reducer immutable but reuse**：Map 重新构造但内部 Step 对象只在变更字段时新建，其它对象引用复用

---

## 8. Playwright MCP Chrome Extension 集成

> 详见 [`client-side-delivery.md`](client-side-delivery.md) §方案 B+。本节只讲与事件流的衔接。

### 8.1 工程拓扑

```
agents (Python)                       用户浏览器
┌──────────────────────────┐         ┌─────────────────────────────┐
│ MCP client（agents/tools/│   MCP   │ Playwright MCP Chrome Ext   │
│ browser.py）             │ ──────▶ │  ├─ 连接当前 tab            │
│ - browser.snapshot       │ (ws +   │  ├─ accessibility snapshot  │
│ - browser.fill           │  auth)  │  ├─ DOM 操作                │
│ - browser.click          │         │  └─ 截图返回 base64         │
└─────────┬────────────────┘         └─────────────────────────────┘
          │
          │ emit CUSTOM events
          ▼
   RelayEmitter → SSE → web
```

### 8.2 安全约束（强制）

- 任何 `browser_fill` / `browser_click` 调用前，工具内必须先发 `INTERRUPT` 事件等用户审批（`@requires_approval` 装饰器），拒绝即终止
- 截图 base64 大于 256KB 时先上传 MinIO，event 携带 url 而非 inline
- 不存储用户密码，不替用户输入密码字段（扩展端硬拦）
- 投递 / 删除等"破坏性"操作永远不自动 submit —— UI 上展示"准备好了，请确认"

### 8.3 事件示例（完整投递流程）

```
RUN_STARTED                          run_id=R1
TEXT_MESSAGE_START                   step_id=S1
TEXT_MESSAGE_CONTENT delta="好的,我"
TEXT_MESSAGE_CONTENT delta="先打开页面"
TEXT_MESSAGE_END                     step_id=S1
TOOL_CALL_START   tool=browser.snapshot     step_id=S2 parent=R1
TOOL_CALL_RESULT  result=...                step_id=S2
CUSTOM kind=relay.browser_snapshot          step_id=S3 parent=R1
INTERRUPT kind=approval                     step_id=S4
  payload={"action": "fill_form", "fields": {...}, "preview_url": ".../snap.png"}
                                            ← 此时 web 渲染审批 UI,流暂停
RESUME value={"type": "approve"}            step_id=S4 status=done
TOOL_CALL_START   tool=browser.fill_form    step_id=S5 parent=R1
CUSTOM kind=relay.browser_action            step_id=S5 (多条 fill 累积)
CUSTOM kind=relay.browser_snapshot          step_id=S6 parent=R1
TOOL_CALL_RESULT  result=success            step_id=S5
RUN_FINISHED                         duration_ms=12300
```

---

## 9. 落地节奏（4 PR）

> 用户已确认"先给我一份完整设计文档，再决定"。本节为执行序列，PR1 启动需另外明确确认。

| PR | 范围 | 改动文件 | 验收 |
|---|---|---|---|
| **PR1**：schema + agents emitter | 装 ag-ui-protocol；新建 `agents/harness/events.py` `RelayEmitter`；新建 `web/src/lib/agent-events/schema.ts`（共享类型）；agents 单元测试覆盖 emitter 序列化 | `agents/pyproject.toml`、`agents/harness/events.py`（新）、`agents/tests/test_events.py`（新）、`web/src/lib/agent-events/schema.ts`（新） | `pytest agents/tests/test_events.py` 全绿；前端 typecheck 通过 |
| **PR2**：agents 集成 + Bun 透传 | dock_agent 走 LangGraphAGUIAdapter；`/ask/stream` 改 AG-UI；Bun gateway 删除翻译层改透传；旧前端临时继续工作（把 AG-UI 帧 fallback 解析成旧 kind 的薄垫片 5-10 行） | `agents/coordinator/dock_agent.py`、`agents/api/server.py:388-534,600-943`、`api/src/routes/ask.ts:134-516`、`web/src/lib/ask-stream.ts`（临时垫片） | 现有 dock 不挂；e2e 一次 `POST /api/ask/stream` 输出至少包含 `RUN_STARTED` `TOOL_CALL_*` `RUN_FINISHED` |
| **PR3**：web reducer + StepTimeline + 5 种 StepCard | 装 `@ag-ui/client` `@tanstack/react-virtual`；新建 `web/src/lib/agent-events/{consumer,reducer,store,custom}.ts`；新建 `web/src/components/ask-vantage/{step-timeline,step-card,*-card}.tsx`；dock.tsx 切换到新组件 | `web/package.json`、`web/src/lib/agent-events/*`（新）、`web/src/components/ask-vantage/*`、删除 `web/src/lib/ask-stream.ts` 的旧逻辑 | 启动后能看到 thinking / tool / assistant_text 完整流；dock 现有功能 0 回归 |
| **PR4**：Playwright MCP + file_edit / browser CUSTOM 事件 | agents 装 mcp 客户端；新建 `agents/tools/browser.py` `agents/tools/file.py`；接 Chrome Extension；`FileEditCard` `BrowserCard` 完成渲染 + 懒加载 | `agents/tools/browser.py`（新）、`agents/tools/file.py`（新）、`web/src/components/ask-vantage/file-edit-card.tsx`（新）、`web/src/components/ask-vantage/browser-card.tsx`（新） | 手动 e2e：用户授权 → agent 打开测试 ATS 页面 → 填表 → HITL 审批 → 用户点 submit；每步在 dock 可见 |

每 PR 都保持 `main` 可运行，严禁"中间状态合并"。

---

## 10. 测试策略

### 10.1 单元

- `agents/tests/test_events.py`：envelope 序列化、ULID/seq 单调性、CUSTOM 命名空间校验
- `web/src/lib/agent-events/__tests__/reducer.test.ts`：每种 event type 的 step 状态机迁移、JSON Patch 应用、CUSTOM 路由

### 10.2 协议契约（防 0.x churn）

- `agents/tests/contract/test_agui_compat.py`：用 `ag-ui-protocol` 官方 schema 校验 emitter 输出的每条 event
- `web/src/lib/agent-events/__tests__/contract.test.ts`：用同一份 fixture 校验 `@ag-ui/client` 能正确 parse
- 两端共享 fixture 文件 `agents/tests/fixtures/agui_events.jsonl`（同一文件）

### 10.3 e2e（Playwright 跑前端）

- 真起 agents + api + web 三层，触发 dock turn，断言 dock 出现 thinking → tool → assistant_text → artifact 完整时间线
- HITL 场景：断言 INTERRUPT 帧后流暂停，UI 出审批卡；点 approve 后流恢复
- 并发 tool call：在 PR2 验收时手动构造 dock 调 2 个 tool 的 prompt，确认即使 #871 未修也未丢事件（因 max_concurrency=1）

### 10.4 性能基线

- `step.events` 各 200 条、20 个 step、200KB reasoning_text：dock 滚动 60fps
- 流式 token 显示：每秒 100 token 不卡 UI

---

## 11. 可观测性（对接 cicd-aiops-harness.md）

每条 event 在 agents 端落 Langfuse span：

| Langfuse attr | 来源 |
|---|---|
| `gen_ai.operation.name` | event.type（小写） |
| `relay.run_id` | event.run_id |
| `relay.step_id` | event.step_id |
| `relay.seq` | event.seq |
| `traceId` | event.trace_id（关联跨层） |

Dashboard 加新指标：
- `dock_turn.duration_p95` 按 run_id 聚合
- `step.duration_p95` 按 kind 拆分（看 thinking / tool / file_edit 哪类最慢）
- `event_loss_rate`：web 端 `seq` gap 检测，如果一次 turn 有 gap > 0 计 1 次丢失
- `hitl.wait_lag_p95`：INTERRUPT → RESUME 间隔

---

## 12. 已知风险登记

| 风险 | 触发概率 | 影响 | 兜底 |
|---|---|---|---|
| `ag-ui-langgraph` 并发 bug | 中（并发场景必触发） | event 乱序/丢失 | max_concurrency=1 + e2e 断言保序 |
| 0.x 命名 breaking change | 中（spec 演进期） | 升级失败 | 锁版本 + contract test + 单独升级 PR |
| Playwright MCP Extension 用户拒绝安装 | 中 | browser 事件无源头 | UI 优雅降级：CUSTOM browser 帧不出现时步骤时间线无 browser kind，功能其它部分不受影响 |
| 截图 base64 过大撑爆 SSE | 低（已规约 256KB 上限） | 流卡死 | agents 端硬限制 + 自动转 MinIO url |
| `STATE_DELTA` JSON Patch 应用失败 | 低 | step 状态不一致 | reducer 内 catch + fallback 全量 `STATE_SNAPSHOT` 重建 |
| reducer 内存膨胀（长会话 + 截图） | 中（沉浸 mock 场景） | 浏览器卡 | events 软上限 + 截图懒加载 + 离开 dock 时 reset |

---

## 13. 未来路线

- **AG-UI 1.0 后**：验证 contract test 全绿后直接升级
- **CopilotKit 集成可选**：如果未来要做"嵌入式 agent"（其它产品复用 dock），可以加 `@copilotkit/react-core` 适配层，但核心 store/reducer 不变
- **服务端 LangGraph Studio 接入**：Studio 也读 AG-UI，自然 free
- **跨 thread step 索引**：Langfuse + PG 持久化所有 step，支持"看历史 dock turn 时间线"功能（目前每次 reset 丢失）

---

## 14. 引用

**AG-UI**
- 协议仓库: https://github.com/ag-ui-protocol/ag-ui
- 并发 tool call bug: https://github.com/ag-ui-protocol/ag-ui/issues/871
- CopilotKit 集成示例: https://github.com/CopilotKit/CopilotKit

**Playwright MCP**
- 仓库: https://github.com/microsoft/playwright-mcp
- Chrome Extension 设计: 同仓库 README

**仓库内交叉引用**
- [`agent-harness.md`](agent-harness.md) — LangGraph 运行时框架 / Loop Guards / HITL `interrupt()`
- [`vantage-ui-mapping.md`](vantage-ui-mapping.md) — dock 在 5-agent 架构里的位置，Resume / Mock 三模块映射
- [`error-handling.md`](error-handling.md) — 跨层 traceId 链路，error envelope
- [`client-side-delivery.md`](client-side-delivery.md) — Playwright MCP Chrome Extension 方案 B+
- [`cicd-aiops-harness.md`](cicd-aiops-harness.md) — Langfuse 接入 / OpenTelemetry GenAI semconv

---

> **本文档状态**：草案 v1，等待用户批准后启动 PR1。任何对事件 schema / Step 模型 / 落地节奏的修改必须先回到本文件再改代码。
