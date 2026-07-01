# 错误处理与展示系统 · Error Handling & Surfacing

> Relay 三层栈（Next.js web · Hono/Bun api · FastAPI/LangGraph agents）的统一错误处理与展示规范。这是一个 **产品级模块** —— 用户读得懂、能复制、能上报；工程能跨三层一键定位根因。
>
> 关联文档：[`system-overview.md`](system-overview.md) · [`agent-harness.md`](agent-harness.md) · [`cicd-aiops-harness.md`](cicd-aiops-harness.md) · [`vantage-ui-mapping.md`](vantage-ui-mapping.md)

---

## 0. 为什么需要这份设计

现状审计结论（2026-06）：三层都有**强积木**——Bun 有 `AppError` 类型层级、Python 有 `_error_envelope()` + redaction、Web 有 `ApiError` 多形状 parser——但**没有拼起来**。具体表现：

- `auth/login` 路由 `c.json({ error: 'Invalid input' }, 400)` 绕过统一 `onError`，前端拿到的不是类型化信封
- `requestId` 只在 Bun 日志里，`X-Trace-Id` 只在 Python 响应头里，**两个 ID 不连通**，support 无法跨层查
- web 端 `t('error.generic') = "Something went wrong"`、Bun 端 `"Internal server error"`、Python 端 `"Something went wrong on our side..."` —— **同一概念三种文案**，全无 i18n
- `ApiError.traceId` 在前端能拿到，但**从不展示给用户**，用户也就无从提供给 support
- 今天遇到的 `Cannot use a pool after calling end on the pool` 原样穿到 500 响应里 —— 工程错误信号当成用户态文案

**目标**：把一次错误从「客户端冒泡的英文乱码 + 500」变成「**用户读得懂、能复制、能上报；工程能跨三层定位到根因**」的事件。

---

## 1. 五条不可让步的原则

| # | 原则 | 操作含义 |
|---|---|---|
| **P1** | **每一个 user-facing 错误都是产品，不是异常** | 每个 `code` 在 i18n 里有 title + body + action，禁止直接渲染 `err.message` |
| **P2** | **trace_id 是用户的求救凭证** | 用户看到短码（`R-3F8K`），support 一键还原全链路；让用户**能复制**，不要让用户**记住** |
| **P3** | **跨三层用同一个信封** | web / api / agents 三层 JSON 形状一致，前端只写一套 parser |
| **P4** | **能恢复的错误优于能解释的错误** | 每个 code 必带推荐 `action`（retry / re-login / contact / fix-input / none），UI 渲染 CTA 而不只是文字 |
| **P5** | **降级永远比 500 友好** | api 层 PG/Redis/LLM 死了不能裸 500，要给特定 code 触发"维护中"全局横幅而不是页面崩溃 |

---

## 2. 统一错误信封

跨 Bun / FastAPI / Web 同一个 schema —— 这是整套系统的基石。

### 2.1 JSON Schema

```ts
type ErrorEnvelope = {
  error: {
    code:        ErrorCode;           // 机器可读，稳定不翻译
    message:     string;              // 英文兜底（messageKey 缺失时降级用）
    messageKey?: string;              // 例 "errors.auth.invalidCredentials"
    traceId:     string;              // UUID v7,跨三层 propagate
    traceCode:   string;              // 用户友好短码,例 "R-3F8K"
    requestId?:  string;              // 入口网关 ID（Bun 注入）
    timestamp:   string;              // ISO 8601
    details?:    Record<string, unknown>;  // 结构化补充（retryAfter,fields…）
    action?:     ErrorAction;         // UI 行为意图
    cause?:      { code: ErrorCode; layer: 'web'|'api'|'agents'|'pg'|'redis'|'llm' };
  }
}

type ErrorAction =
  | { kind: 'retry'; after?: number }                              // 指数退避或固定秒
  | { kind: 'reauth'; redirect: string }                           // 引到登录页
  | { kind: 'contact'; channel: 'email'|'in-app' }                 // 走支持
  | { kind: 'wait'; until: string; reason: string }                // 维护窗口
  | { kind: 'fix-input'; fields: { name: string; msg: string }[] } // 表单错
  | { kind: 'none' };
```

### 2.2 两个 ID 一定要分清

| 字段 | 形态 | 用途 | 谁生成 |
|---|---|---|---|
| `traceId` | UUID v7（时间有序） | 跨三层 propagate；工程检索的真值 | 入口（web 或 Bun）首次生成 |
| `traceCode` | `'R-' + base32(traceId 高位 3 字节)` 形如 `R-3F8K` | trace 的**可读别名**；UI 上让用户复制 | 任一层渲染时计算 |
| `requestId` | UUID v4 | 单次 HTTP 请求标识；与 trace 不同（一个 trace 可包含多个 request） | Bun 入口生成 |

**单一规则**：trace 在最靠近用户的入口生成，全程用同一个值；request 每次 HTTP 调用新生成。

### 2.3 设计取舍

- **不直接展示 `traceId`**（36 字符 UUID），因为用户复制贴错率高、视觉吵
- **不在文案 body 里嵌入 trace** —— trace 由独立 `<ErrorDetails>` 组件渲染，便于工程升级展示形态而不动文案
- **`cause` 是工程线索，不渲染给用户**，但会写入 Sentry/Langfuse breadcrumb

---

## 3. ErrorCode 字典（Stable Taxonomy）

**强制收敛到约 30 个 code**，按 HTTP-status × 域分组。新增 code 必须经 review —— 这是字典，不是 enum。每加一个就要在 i18n、UI 处理、运维 runbook 三处同步。

### 3.1 完整列表

```
# 输入/校验  (400)
VALIDATION_FAILED             一个或多个字段验证失败,details.fields 给具体
INPUT_FORMAT_UNSUPPORTED      文件格式/编码不对（PDF 加密/损坏等）

# 认证/授权 (401/403)
AUTH_REQUIRED                 未登录
AUTH_INVALID_CREDENTIALS      邮箱/密码错
AUTH_SESSION_EXPIRED          session 过期(action=reauth)
AUTH_FORBIDDEN                越权
AUTH_EMAIL_NOT_VERIFIED       邮箱未验证

# 资源 (404/409/410)
RESOURCE_NOT_FOUND
RESOURCE_CONFLICT             乐观锁失败、唯一约束等
RESOURCE_GONE                 软删后访问

# 限流/配额 (429)
RATE_LIMITED                  details.retryAfterSeconds
QUOTA_EXCEEDED                配额（与限流分开,场景与文案不同）

# 上游/服务 (502/503/504)
UPSTREAM_TIMEOUT              下游超时
UPSTREAM_UNAVAILABLE          下游 5xx
DB_UNAVAILABLE                PG/pool 死 ← 2026-06-28 遇到的
CACHE_UNAVAILABLE             Redis 死
LLM_UNAVAILABLE               OpenRouter / 模型不可用
LLM_BUDGET_EXHAUSTED          成本闸门（详见 agent-harness.md Loop Guards）
LLM_CONTENT_REFUSED           模型拒绝（政策/安全）
LLM_FABRICATION_BLOCKED       Relay 红线 fabrication_guard 拦截（详见 vantage-ui-mapping.md §2.3）

# Agent / HITL
AGENT_TIMEOUT                 LangGraph recursion 上限
AGENT_INTERRUPT_PENDING       HITL 等审批（state,不是 error,走 envelope 复用）
AGENT_TASK_FAILED             通用 agent 失败

# 客户端/网络
NETWORK_OFFLINE               navigator.onLine === false
NETWORK_BLOCKED               fetch 被本机代理/插件拦截 ← clash/v2ray 场景
CLIENT_VERSION_STALE          前端缓存旧,需刷新

# 未分类
INTERNAL                      最后兜底,工程看到这个就是 bug
```

### 3.2 命名规则

- 全大写 + 下划线
- 第一个段是**域**（AUTH / DB / LLM / NETWORK …），第二段是**子类**
- 不含 HTTP status 数字（status 由 envelope 携带）
- 不含产品名（不要 `RELAY_AUTH_FAILED`）

---

## 4. 三层实现

### 4.1 API 层（Bun / Hono）

**职责**：网关。生成 `traceId` + `requestId`，统一信封，把 PG/Redis 错误翻译成 `DB_UNAVAILABLE` / `CACHE_UNAVAILABLE`。

#### 4.1.1 统一抛出

```ts
// api/src/errors.ts —— 重构后
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
    public messageKey?: string,
    public action?: ErrorAction,
  ) { super(message) }
}

export const Errors = {
  invalidCreds: () => new AppError(
    'AUTH_INVALID_CREDENTIALS', 401,
    'Invalid email or password',
    undefined,
    'errors.auth.invalidCredentials',
    { kind: 'none' },
  ),
  sessionExpired: () => new AppError(
    'AUTH_SESSION_EXPIRED', 401,
    'Session expired',
    undefined,
    'errors.auth.sessionExpired',
    { kind: 'reauth', redirect: '/auth' },
  ),
  dbUnavailable: (cause?: Error) => new AppError(
    'DB_UNAVAILABLE', 503,
    'Database temporarily unavailable',
    { cause: cause?.message?.slice(0, 200) },
    'errors.system.dbUnavailable',
    { kind: 'retry', after: 5 },
  ),
  // …
}
```

#### 4.1.2 中间件顺序

```ts
app.use('*', traceIdMiddleware())     // 生成或继承 X-Trace-Id
app.use('*', requestIdMiddleware())   // 入口 X-Request-Id
app.use('*', errorBudgetMiddleware()) // 5xx 计数,触发熔断
app.onError(errorHandler)             // 信封序列化 + 翻译 PG/Redis 错
```

#### 4.1.3 错误翻译矩阵（核心）

解决今天 `Cannot use a pool after calling end` 那种穿到用户面前的问题：

```ts
function translateInfraError(err: unknown): AppError | null {
  if (!(err instanceof Error)) return null
  if (/Cannot use a pool after calling end/i.test(err.message))
    return Errors.dbUnavailable(err)
  if (/Connection terminated unexpectedly/i.test(err.message))
    return Errors.dbUnavailable(err)
  if (err.name === 'TimeoutError')
    return Errors.upstreamTimeout(err)
  if (/Connection is closed/i.test(err.message) && err.message.includes('redis'))
    return Errors.cacheUnavailable(err)
  return null
}
```

#### 4.1.4 强制约束

- **所有路由禁止直接 `c.json({error: "..."}, 401)`**，全部 `throw AppError`，由 `onError` 统一序列化
- ESLint rule 禁止 `c.json` 第二参 `>= 400`
- `auth.ts` 现存的 `c.json({ error: 'Invalid input' }, 400)` 等全部下线（W1 范围）

#### 4.1.5 降级横幅

`DB_UNAVAILABLE` / `CACHE_UNAVAILABLE` / `LLM_UNAVAILABLE` 在错误信封外，再通过 `X-Relay-Health: degraded` 响应头广播给前端，前端展示**全局横幅**"系统暂时降级中"，避免用户在每个页面都看到独立 toast。

### 4.2 Agents 层（FastAPI / LangGraph）

**职责**：propagate `X-Trace-Id`（缺失则生成），LangGraph 节点失败翻译成 `AGENT_TASK_FAILED` / `LLM_*`，HITL 暂停翻译成 `AGENT_INTERRUPT_PENDING`（state 不是 error，走同一 envelope，前端按 code 分发）。

#### 4.2.1 统一异常处理器

```python
# agents/api/server.py
@app.exception_handler(Exception)
async def unified_error_handler(request: Request, exc: Exception) -> JSONResponse:
    trace_id = request.state.trace_id
    if isinstance(exc, BudgetExhausted):
        env = error_envelope(
            code='LLM_BUDGET_EXHAUSTED', status=402,
            message_key='errors.llm.budgetExhausted',
            details={'spentCents': exc.spent_cents},
            action={'kind': 'contact', 'channel': 'in-app'},
            trace_id=trace_id,
        )
    elif isinstance(exc, FabricationBlocked):
        env = error_envelope(
            code='LLM_FABRICATION_BLOCKED', status=422,
            message_key='errors.llm.fabricationBlocked',
            details={'rejectedEntities': exc.entities[:5]},
            action={'kind': 'fix-input', 'fields': [...]},
            trace_id=trace_id,
        )
    elif isinstance(exc, GraphRecursionError):
        env = error_envelope(code='AGENT_TIMEOUT', status=504, ...)
    elif isinstance(exc, OpenRouterError):
        env = error_envelope(code='LLM_UNAVAILABLE', status=503, ...)
    elif isinstance(exc, HTTPException):
        env = error_envelope(code=http_to_code(exc.status_code), ...)
    else:
        logger.exception('unhandled', trace_id=trace_id)
        env = error_envelope(code='INTERNAL', status=500, ...)
    return JSONResponse(env.body, status_code=env.status,
                        headers={'X-Trace-Id': trace_id})
```

#### 4.2.2 SSE 错误帧

流已经在跑、不能改 HTTP status：

```
event: error
data: {"code":"LLM_BUDGET_EXHAUSTED","message":"...","traceId":"...","traceCode":"R-3F8K","action":{"kind":"contact","channel":"in-app"}}
```

前端在 EventSource `error` 监听器里走和 fetch 错误**同一条**翻译/展示路径，不另起一套。

#### 4.2.3 Redact 升级

用结构化 redaction（spaCy NER + 自定义 regex 链）代替单一 regex。加单测断言：

- `OPENROUTER_*` API key 必被擦除
- `postgres://user:pwd@host` DSN 必被擦除
- 绝对路径（`/Users/...`、`/home/...`、`C:\...`）必被擦除
- 多行 stack trace 整段保留 type/message，丢弃 frames（保留 1 行 root cause）

### 4.3 Web 层

四层职责切干净：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: api-client          parse envelope → ApiError  │
│ Layer 2: error-router        ApiError → ResolvedError   │
│ Layer 3: presentation        toast / inline / boundary  │
│ Layer 4: telemetry           console + sentry + breadcrumb │
└─────────────────────────────────────────────────────────┘
```

#### 4.3.1 Layer 1 — api-client（已存在，补强）

- 始终读 `X-Trace-Id`、`X-Request-Id`、`X-Relay-Health` 响应头并塞进 ApiError
- **NETWORK_BLOCKED 自动判定**：fetch reject 且 `navigator.onLine === true` → 判定为代理/插件拦截（clash 场景），不再混作 `NETWORK_OFFLINE`
- **自动重试**：仅当 `code ∈ {DB_UNAVAILABLE, CACHE_UNAVAILABLE, UPSTREAM_TIMEOUT}` 且 method ∈ {GET, HEAD} 时，做 1 次指数退避重试；POST 永远不自动重试（避免重复 mutation）

#### 4.3.2 Layer 2 — error-router（新增，核心）

```ts
// web/src/lib/errors/resolve.ts
type ResolvedError = {
  surface:   'toast' | 'inline' | 'banner' | 'full-page' | 'silent'
  severity:  'info' | 'warning' | 'error' | 'critical'
  title:     string                  // t(messageKey + '.title')
  body:      string                  // t(messageKey + '.body', { ...details })
  ctas:      Cta[]                   // from action
  traceCode: string
  copyable:  { traceId: string; traceCode: string; timestamp: string; code: string }
  raw:       ApiError                // 工程模式可展开
}

export function resolveError(err: unknown, ctx: ErrorContext): ResolvedError
```

#### 4.3.3 Surface 决策矩阵（产品决定，工程实现）

| code 类 | 默认 surface | 原因 |
|---|---|---|
| `VALIDATION_*` | `inline` | 字段旁边显示，别用 toast 抢焦点 |
| `AUTH_INVALID_CREDENTIALS` | `inline`（表单下方）| 登录场景 |
| `AUTH_SESSION_EXPIRED` | `banner` + 自动 redirect | 全局影响 |
| `RATE_LIMITED` / `QUOTA_EXCEEDED` | `toast`（持久）| 不阻塞页面 |
| `DB_UNAVAILABLE` / `CACHE_UNAVAILABLE` | `banner`（全局）| 一次显示一处 |
| `LLM_*`（dock/mock 内）| `inline`（对话气泡里）| 对话流中 |
| `AGENT_INTERRUPT_PENDING` | 不是 error 是 state | 走 HITL UI 而不是 error UI |
| `INTERNAL` | `toast` + 错误边界备用 | 兜底 |
| `NETWORK_BLOCKED` | `banner` + 指引 | 提示代理设置 |

`ctx` 包含当前页 / 当前 action / locale。同一个 `code` 在不同上下文可微调 copy（例：登录页的 `RATE_LIMITED` 文案 vs trends 页的）。

#### 4.3.4 Layer 3 — Presentation 组件

最少四个组件，从原子到分子：

```
<ErrorInline   />   字段下/对话气泡内,只渲染 body+小号 trace
<ErrorToast    />   sonner,带 "Copy details" 按钮
<ErrorBanner   />   贴顶,持久,可手动关闭
<ErrorFullPage />   error.tsx / global-error.tsx 用,Relay logo + trace + 主页 CTA
```

**`<ErrorDetails copyable={...} />`**（共享 sub-component）：
- 默认折叠，只显示 `Reference: R-3F8K`
- 点开显示完整 `traceId / timestamp / code / messageKey`
- "Copy" 按钮一键复制 markdown 块（用户贴给 support 即可）

#### 4.3.5 错误边界（覆盖 React 渲染错）

- `app/error.tsx` —— 路由级，渲染 `<ErrorFullPage />`，提供"返回 Today / Reload / Report"
- `app/global-error.tsx` —— 应用级，最小化静态 HTML 不依赖任何 i18n
- dock / mock 等沉浸场景另装局部 boundary，避免炸整个应用

#### 4.3.6 Layer 4 — Telemetry

- 每个被渲染的错误打一条 `error_shown` 事件（含 code、surface、page、traceId）
- 用户点 "Copy details" 也打事件（说明真的去找支持了）
- 接 Langfuse / Sentry：`traceId` 作为 cross-system join key

---

## 5. Trace 端到端贯通

**单一规则**：trace 在最靠近用户的入口生成，全程用同一个值。

```
[browser]
  └─ 不主动发 X-Trace-Id（每次请求由网关生成,避免前端伪造）
       ↓
[Bun gateway]
  ├─ middleware traceId(): incoming X-Trace-Id || uuidv7()
  ├─ ctx.set('traceId', tid)
  ├─ logger child binding { traceId: tid, requestId: rid }
  ├─ fetch(agents, { headers: { 'X-Trace-Id': tid, 'X-Request-Id': rid } })
  └─ response headers X-Trace-Id, X-Request-Id
       ↓
[FastAPI]
  ├─ middleware: request.state.trace_id = req.headers['x-trace-id'] || uuid()
  ├─ structlog bind(trace_id=tid)
  ├─ LangGraph state['trace_id'] = tid
  ├─ checkpoint metadata 持久化 tid → 后续审计能反查
  └─ JSONResponse headers X-Trace-Id
       ↓
[Bun] forward trace 到响应给 web
       ↓
[Web] ApiError.traceId = response.headers['x-trace-id']
      → ErrorEnvelope.traceCode 渲染
```

**Langfuse / Sentry 关联**：所有三层日志、所有 LLM span、所有 React 错误事件，**用同一个 `traceId` 作为 attribute**，一处搜全链路。

### 5.1 端到端 trace 烟测（W4.2 落地后可复跑）

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
TID="01935f4e-aaaa-bbbb-cccc-deadbeef1234"

# 1) 直击 agents,验证 X-Trace-Id 透传 + 响应回声
curl -sS --noproxy '*' -i http://localhost:8000/healthz -H "X-Trace-Id: $TID" | grep -i x-trace-id
# expect: x-trace-id: 01935f4e-aaaa-bbbb-cccc-deadbeef1234

# 2) 经 Bun 网关 → agents:观察 envelope v2 完整字段
curl -sS --noproxy '*' -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Trace-Id: $TID" \
  -d '{"email":"probe@example.com","password":"wrong"}' | python3 -m json.tool
# expect: error.traceId == $TID, traceCode == R-XXXX 短码

# 3) 验证 agents structlog 把同 trace 写进每条日志
grep -F "$TID" .relay-stack/logs/agents.log
# expect: 多条 log line 全部 trace_id=$TID
```

通过条件:三段都见到同一个 traceId,traceCode 与 [`traceCodeFromTraceId`](../../api/src/errors.ts) 输出一致。

---

## 6. i18n 文案约定

文案文件示例：

```json
// web/messages/en/errors.json
{
  "auth": {
    "invalidCredentials": {
      "title": "Couldn't sign you in",
      "body": "That email and password combination doesn't match our records.",
      "primaryCta": "Try again",
      "secondaryCta": "Reset password"
    },
    "sessionExpired": {
      "title": "You've been signed out",
      "body": "For your security, we sign you out after a period of inactivity. Sign in again to keep going.",
      "primaryCta": "Sign in"
    }
  },
  "system": {
    "dbUnavailable": {
      "title": "We're having a brief hiccup",
      "body": "Our database is taking a moment to respond. We'll retry automatically — usually back in a few seconds.",
      "primaryCta": "Retry now"
    }
  },
  "llm": {
    "fabricationBlocked": {
      "title": "Stopped before inventing experience",
      "body": "We blocked this draft because it would have added claims that aren't in your résumé. Edit your source résumé first if those claims are real.",
      "primaryCta": "Open résumé"
    }
  },
  "network": {
    "blocked": {
      "title": "Your network is blocking Relay",
      "body": "Looks like a proxy or VPN is in the way. Add localhost to your proxy's bypass list and try again.",
      "primaryCta": "Open setup guide"
    }
  },
  "_common": {
    "referenceLabel": "Reference",
    "copyDetails": "Copy details",
    "reportProblem": "Report a problem",
    "retry": "Retry"
  }
}
```

### 约定

- 每个 code 必须有 `title` + `body`，可选 `primaryCta` / `secondaryCta`
- `body` 文案"先说人话，再说怎么办"，不超过 2 句
- 永远不在 body 里嵌入 `traceId`（trace 由 `<ErrorDetails>` 渲染）
- Linter 跑 `find . -name '*.tsx' | xargs grep -nE 't\("errors\.[^"]+"\)'` + JSON schema 校验 key 存在，缺失文案 CI fail
- ZH 文案与 EN 同步落地，先按 [`vantage-ui-mapping.md`](vantage-ui-mapping.md) 的两维 locale（ui vs artifact）规则走，错误文案归 ui locale

---

## 7. 渐进落地（5 周）

| Week | 范围 | 验收 |
|---|---|---|
| **W1** | Bun 错误信封 + 错误翻译矩阵 + traceId 中间件 | auth/login 不再裸 500；jest 单测覆盖 `Cannot use a pool` 等 8 个翻译路径 |
| **W2** | Web Layer 1 + Layer 2 + `<ErrorToast/Inline/Banner/FullPage>` 四个组件；i18n EN+ZH | 登录失败 401 显示卡片 + 有 `R-XXXX` 可复制 |
| **W3** | FastAPI 信封对齐 + LangGraph 节点错误翻译 + SSE error frame | 触发 `LLM_BUDGET_EXHAUSTED` 在 dock 里显示友好卡片 |
| **W4** | trace 端到端：Bun→Agents→Web 三段贯通；Langfuse attribute 接入 | 故意制造一个 LLM 失败，能用 traceCode 在 Langfuse 找到 span |
| **W5** | 全局 health banner + `<ErrorBoundary>` + `error_shown` telemetry + ZH 文案审校 | DB down 时所有页面看到同一个 banner（不会每个 toast 飞一次） |

---

## 8. 用 2026-06-28 的故障做端到端验证

> `Cannot use a pool after calling end on the pool` → 用户看到 `Internal server error`
>
> 设计完成后应当变成：

### 用户态（toast / inline 二选一）

```
┌────────────────────────────────────────────────────┐
│  ⚠  We're having a brief hiccup                    │
│                                                    │
│  Our database is taking a moment to respond. We'll │
│  retry automatically — usually back in a few       │
│  seconds.                                          │
│                                                    │
│  Reference: R-3F8K               [Copy details] ⌄  │
│                                                    │
│             [ Retry now ]   [ Report a problem ]   │
└────────────────────────────────────────────────────┘
```

### 工程态

- Bun log: `{ traceId: "01HXY...", code: "DB_UNAVAILABLE", cause: "Cannot use a pool after calling end on the pool" }`
- Langfuse: 该 `traceId` 下三层 span 都能查
- Sentry: `code=DB_UNAVAILABLE` 计数 spike → 触发 PagerDuty
- Support 拿到 `R-3F8K` → 一键反查 traceId → 看到 pool 死掉那个时刻

---

## 9. 现状 → 目标 Gap 速查

> 来自 2026-06 全栈审计；落地时按此清单清零。

| # | 层 | 现状 Gap | 影响 | 修复在 |
|---|---|---|---|---|
| **G1** | Bun auth routes | 绕过 `onError`,直接 `c.json({error: "..."}, 401)` 字符串 | 前端 parse `error.code` 拿到 `undefined`,rate-limit 文案匹配脆弱 | W1 |
| **G2** | Bun → Python | 不 forward `X-Request-Id` / `X-Trace-Id` | 端到端 trace 断,support 无法跨层定位 | W4 |
| **G3** | Web UI | `ApiError.traceId` 拿到了但不渲染 | 用户报障无 reference,support 只能问"你刚刚干了啥" | W2 |
| **G4** | i18n | "Internal server error" 等 3 个变体不在 `en.json` | ZH 用户看到英文乱码 | W2 / W5 |
| **G5** | Python SSE | error frame 用 regex redact,会漏 | API key / file path 偶发外泄 | W3 |
| **G6** | Bun | PG pool dead / Redis closed 直接抛 500 | 用户态全是 `Internal server error`,工程信号当用户文案 | W1 |

---

## 10. 保留 vs 重构清单

### 保留（已经好,不要动）

- **Bun 的 `AppError` 类型层级 + `ErrorCode` enum** —— 已有 7 个子类,扩展即可
- **Python 的 `_error_envelope()` + redaction 框架** —— 信封结构对齐后即可复用
- **Web `ApiError` 类 + 多 envelope 形状 fallback** —— 继续作为 Layer 1 主力
- **rate-limit 中间件的优雅降级** —— Redis 死时不阻塞请求,继续保留
- **`agent_tasks.error_message` 的 redaction + 500 char 截断** —— 审计保留这一份

### 重构（W1–W5 范围）

- Bun auth routes 全部走 `throw AppError`
- Bun `onError` 加 infra error 翻译矩阵
- Python `_error_envelope` 字段对齐 `traceCode` / `messageKey` / `action`
- Web 新增 `resolve.ts` + 4 个 presentation 组件
- 3 层 trace propagation 中间件全打通
- i18n `errors.*` namespace 全量补齐 EN + ZH

---

## 11. 引用与交叉链接

- [`system-overview.md`](system-overview.md) —— 五层架构与边界
- [`agent-harness.md`](agent-harness.md) —— Loop Guards / Budget guards / HITL `interrupt()`,对应 `LLM_BUDGET_EXHAUSTED` / `AGENT_INTERRUPT_PENDING`
- [`vantage-ui-mapping.md`](vantage-ui-mapping.md) —— Fabrication Guard,对应 `LLM_FABRICATION_BLOCKED`;dock surface 决策对应错误展示位置
- [`cicd-aiops-harness.md`](cicd-aiops-harness.md) —— Langfuse self-host,Trace ID 作为 cross-system join key 的落点
- [`client-side-delivery.md`](client-side-delivery.md) —— Chrome 扩展端的错误处理需对齐同一信封(Phase 2 范围)

---

## 12. 决策日志

| 决策 | 选择 | 理由 |
|---|---|---|
| trace 长 vs 短 | 双轨：`traceId`(36 字符) + `traceCode`(6 字符) | 用户复制短码不出错;工程查 traceId 精确 |
| 信封字段 `messageKey` 还是 server 端翻译 | `messageKey` | 服务端没有 locale 上下文;web 端按 X-Relay-Locale 翻译 |
| 信封字段 `action` 还是前端推断 | server 给 `action` | code → action 映射在多端容易漂移;一处定义 |
| POST 自动重试 | 不重试 | 避免重复 mutation;前端给用户手动 Retry 按钮 |
| `INTERNAL` 是否暴露 cause | 否 | redaction 失效时不希望泄漏;cause 进 Sentry breadcrumb |
| 全局降级横幅触发 | `X-Relay-Health` 响应头而非错误信封内字段 | 降级是会话级信号,不是单次请求的事 |

---

## 13. Postmortem · 2026-06-28 故障的端到端复现

> W5.3 验收。docker stop relay-postgres → POST /api/auth/login 一次。

**Before W1**(2026-06-28 上午,本文档与代码改造前)：

```
HTTP/1.1 500 Internal Server Error
{"error": {"code": "INTERNAL", "message": "Internal server error"}}
```

— pg-pool 抛 `Cannot use a pool after calling end on the pool` 直穿到用户面前;前端拿不到 trace,文案是英文硬编码,用户态唯一信号是 "Internal server error"。

**After W1–W5**(同一故障复现于同一台机器)：

```
HTTP/1.1 503 Service Unavailable
x-trace-id: 7bd33291-b161-4ec2-bdeb-cf05739dcc55
x-request-id: 5b9189a3-793c-45a0-98da-fd01430b964f
X-Relay-Health: degraded

{
  "error": {
    "code": "DB_UNAVAILABLE",
    "message": "Database temporarily unavailable",
    "messageKey": "errors.system.dbUnavailable",
    "traceId": "7bd33291-b161-4ec2-bdeb-cf05739dcc55",
    "traceCode": "R-AB42",
    "requestId": "5b9189a3-793c-45a0-98da-fd01430b964f",
    "timestamp": "2026-06-28T07:56:17.538Z",
    "action": { "kind": "retry", "after": 5 },
    "cause": { "layer": "pg", "message": "" }
  }
}
```

工程态:`[API Error] POST … → DB_UNAVAILABLE trace=7bd33291-… cause=Error` 一行结构化日志,trace_id 与 user 看到的 R-AB42 互为别名(`traceCodeFromTraceId(7bd33291-…)` = R-AB42)。

PG 恢复后(`docker start relay-postgres`),同一个 endpoint 立即返回 401 AUTH_INVALID_CREDENTIALS,无 X-Relay-Health,前端 zustand health-store 自动 `setOk()` — 全局横幅自动消失。

**验证收口**:
- api/src/errors.test.ts:26 个 case 全过(envelope v2 + translateInfraError 5 个匹配 + traceCode + handler headers)
- api 全套 254 tests 0 fail
- agents/tests/test_redaction.py: 10 个 case 全过(API key / DSN / 路径 / 多行 trace 全擦除)
- agents 314 tests 0 fail(1 预存在 SOCKS 环境失败,与本改造无关)
- web typecheck 全程绿

---

## 14. Stream resume · SSE 断点续跑（D1–D5, 2026-07）

> **背景（用户投诉原文）**：Ask Vantage dock 里发一个稍长的问题，中途出现 `流被中断：Something went wrong on our side. We've logged this — please retry shortly.`。原因是浏览器 tab throttled / 代理抖动 / agents 重启，前端只能全量重跑一次 turn；LangGraph 生成到一半的结果就此丢失。这是 Claude Code / Manus 级 UX 的正解题：**resume by cursor**。
>
> 该系统由 5 步（D1 摸底 → D2 存储层 → D3 resume 分支 → D4 前端消费 → D5 E2E + 文档）落地。以下是最终约定，任何后续改动必须先读本节。

### 14.1 端到端拓扑

```
[web dock] ──POST /api/ask/stream─▶ [Bun gateway] ──POST /ask/stream──▶ [FastAPI agents]
   │ track lastSeq                    │ pass-through                     │ ↕ persist_stream
   │ auto-retry 3x on drop            │ + forward Last-Event-ID          │      │
   │ Reconnecting… pill               │ + forward X-Relay-Resume         │  ┌───┴───┐
   │ Stream expired ▷ Start over      │                                  │  │  PG   │  ← ask_stream_events
   ▼                                  ▼                                  │  │       │      (24h / 1000 rows/thread)
   consumer.ts                        api/src/routes/ask.ts              │  │ Redis │  ← ask_stream:{thread_id}
                                                                         │  └───┬───┘      (Pub/Sub live tail)
                                                                         ▼      │
                                                                     resume    │
                                                                     branch    │
                                                                     replay ───┘
                                                                     + live tail
```

### 14.2 分层职责

**Storage** — `infra/postgres/migrations/021_ask_stream_events.up.sql`
- 表 `ask_stream_events(thread_id, sequence PK, event_id, run_id, trace_id, frame BYTEA, event_name, created_at)`
- `sequence` 是 per-thread 单调递增(不是 per-run,才能跨 run 续跑)
- UNIQUE `(thread_id, event_id)` 让 retry 幂等
- BRIN(created_at) 供 prune

**Writer** — `agents/harness/stream_events.py::StreamPersistence.persist()`
- pg_advisory_xact_lock 保证多写者时 sequence 单调
- `ON CONFLICT (thread_id, event_id) DO NOTHING` — 重发同一 event 返回 seq=None,caller 跳过 cursor 前进
- 成功写 PG 后 `PUBLISH ask_stream:{thread_id}` 到 Redis(fail-open,断了 caller 不 crash)

**Wrapper** — `agents/harness/stream_events.py::persist_stream(source, thread_id=...)`
- 包每个 SSE frame:先 persist → 得到 seq → 在 frame 上加两处 cursor:
  - **SSE 层:** `id: <seq>\n` 前缀(EventSource 原生 Last-Event-ID 语义)
  - **JSON 层:** 把 `rawEvent.stream_seq = seq` 塞进 payload(fetch-based 客户端读)
- persist 失败(dup / PG down)只丢 `id:` 但仍 yield frame,不阻断直播

**Resume branch** — `agents/api/server.py::_resume_stream()`
- 触发条件:`Last-Event-ID` header 或 body `last_event_id > 0`
- 先跑 `replay_frames(after_seq=cursor)`:
  - 有 frames > cursor → 按 seq 顺序全 yield(带 `id:` 行原样)
  - `expired=True`(buffer 全空 + cursor > 0) → 发一帧 `event: stream_expired\ndata: {"reason":"buffer_evicted","traceId":...}\n\n` 结束
- 再跑 `live_frames(after_seq=latest)`:订阅 Redis Pub/Sub,`RELAY_STREAM_RESUME_IDLE_S`(默认 30s,测试 0)后自动收尾
- 响应头 `X-Relay-Resume: 1` 标记该次是 resume(测试 + 前端可断言)

**Detached run** — `agents/api/server.py::_detached_run()`
- 直播路径包 `_detached_run(persist_stream(_with_heartbeat(gen())))`
- 客户端 fetch 断了 → 后台 drainer **不取消**,LangGraph 继续跑,frame 继续写 PG + Redis
- 断了的客户端下次 resume 时看到全部 missed frames

**Gateway** — `api/src/routes/ask.ts`
- 保持纯 pass-through,新增两条:
  - request:透传 `Last-Event-ID` header 到 agents 上游
  - response:透传 `X-Relay-Resume` 从 agents 下游到 web

**Web consumer** — `web/src/lib/agent-events/consumer.ts`
- 每个入手事件读 `event.rawEvent.stream_seq` → 更新 `lastSeq`
- 传输失败(非 AbortError,非 stream_expired) → 指数退避(500ms → 1500ms → 3500ms)重试 3 次,POST body 加 `last_event_id: lastSeq`,header 加 `Last-Event-ID`
- 成功重连 → `onReconnect({attempt: 0})` 清空 UI
- 3 次都失败 → `onReconnect({attempt: -N})` + `onError(err)`
- 收到 `event: stream_expired` → `onStreamExpired({traceId, reason})` 立刻停(不再 retry)

**Web store** — `web/src/lib/agent-events/store.ts`
- 新状态 `reconnectAttempt: number`(0/正/负 三态) + `streamExpired: boolean`
- `sendAsk` / `reset` 都清零
- 选择器 `useReconnectAttempt()` / `useStreamExpired()` 让 UI 只订阅需要的字段

**Web UI** — `web/src/components/ask-vantage/step-timeline.tsx`
- 三档 footer,优先级 `streamExpired > reconnecting > error`
  - `<ReconnectingFooter attempt={N} />`:黄色 pill "正在重新连接… (N/3)",aria-live=polite
  - `<StreamExpiredFooter />`:米黄卡片,"流已过期" + "重新开始" 按钮清 flag(不自动重发,让用户重新点)
- i18n keys: `dock.message.reconnecting` / `dock.message.streamExpired.{title,body,cta}`,en + zh 都补齐

### 14.3 retention / prune

- 24h TTL + 每 thread 1000 行封顶,常量 `RETENTION_HOURS` / `PER_THREAD_MAX_ROWS`,与 migration docstring 同源
- FastAPI lifespan 里挂 `_prune_loop`,每 600 秒扫一次(错误自愈 60s 重试)
- 超窗判定:`replay_frames` 里 SELECT > cursor 空 AND `MAX(sequence)` 为 NULL AND cursor > 0 → `expired=True`

### 14.4 三档 UX

| 场景 | 服务端信号 | 前端处理 | 用户可见 |
|------|-----------|---------|---------|
| 短暂网络抖动 | Redis Pub/Sub 里 frames 一直流入,PG 里 sequence 涨 | `consumer.ts` 静默 3×指数退避重连,第一帧到达清 badge | 短暂看到 `正在重新连接… (1/3)` pill,然后自动继续,不打断输入 |
| agents 重启中 | 上游 fetch 立即失败,3 次全撞 502 | 3 次退避耗尽 → `onError` 显示 error footer | 看到 error footer 但仍能选择"重新开始",无缝下一 turn 走新 thread |
| 客户端离线 24h+ | `_prune_loop` 已把该 thread 全部行删了,resume 分支返回 `event: stream_expired` | `onStreamExpired` → 米黄卡片 | 看到"流已过期 · 重新开始",点击清 flag,自然发下一 turn |

### 14.5 验证收口

**agents 层**
- `agents/tests/test_stream_events.py` 21 case 全过(helpers + PG round-trip + Pub/Sub live tail + prune)
- `agents/tests/test_ask_stream_resume.py` 3 case 全过(HTTP 层 header + body cursor + expired)
- 全套 314 tests 0 fail

**Bun 网关**
- `api/src/routes/ask.test.ts` 23 case 全过(pass-through + Last-Event-ID + X-Relay-Resume)

**Web**
- `web/src/lib/agent-events/__tests__/consumer-resume.test.ts` 5 case 全过(store wiring + 帧结构)
- `bun test src/lib/agent-events/` 全 32 case 通过
- `bun run typecheck` 全绿

**手动烟测**
```bash
# 1. 触发一次正常 turn,PG 里看数据
psql -c "SELECT thread_id, sequence, event_name, length(frame) FROM ask_stream_events ORDER BY sequence DESC LIMIT 5;"

# 2. 触发 resume:seed 3 帧,resume from cursor=1
curl -sN -X POST http://localhost:3001/api/ask/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "Last-Event-ID: 1" \
  -d '{"message":""}'
# expect: X-Relay-Resume: 1 响应头,frames 只有 id:2 id:3

# 3. expired 场景:空 buffer + cursor=42
curl -sN -X POST http://localhost:3001/api/ask/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "Last-Event-ID: 42" \
  -d '{"message":""}'
# expect: event: stream_expired\ndata: {"reason":"buffer_evicted","traceId":"..."}
```

### 14.6 决策日志

| 决策 | 选择 | 理由 |
|------|------|------|
| sequence 粒度 | per-thread 单调 | Dock lifetime thread 跨多个 run;per-run seq 每次归零,cursor 失效 |
| cursor 载体 | SSE `id:` 行 + JSON `rawEvent.stream_seq` 双写 | EventSource 原生用 `id:`,fetch-based 用 JSON,后续换 EventSource 零成本 |
| expired 触发 | buffer 全空 AND cursor > 0 | 部分保留时优先给用户能收到的 frames,reducer 走 run_id reset 自愈 |
| 重试次数 | 3 次 (500/1500/3500ms) | 覆盖典型代理超时 + 短暂 agents 重启;更多会给"卡住"错觉 |
| 断开时 LangGraph | 后台 drainer 继续跑,不 cancel | 让"客户端关 tab 一分钟再回来"能 resume 到完成的 turn |
| POST body cursor 也支持 | body.last_event_id 与 header 二选一 | fetch 客户端跨 CDN / 代理时 header 可能被抹,body 是保底 |
| stream_expired 后不自动 sendAsk | 用户点"重新开始" 才发 | 静默重发用户没打完的 prompt 是更糟的 UX |
| retention 24h / 1000 行 | 中庸值 | 覆盖过夜 idle 场景,不至于让 PG 单表膨胀 |

### 14.7 引用文件清单

- `infra/postgres/migrations/021_ask_stream_events.up.sql` / `.down.sql`
- `agents/harness/stream_events.py`
- `agents/api/server.py`(_resume_stream, _detached_run, lifespan prune loop)
- `agents/tests/test_stream_events.py`, `agents/tests/test_ask_stream_resume.py`
- `api/src/routes/ask.ts`(Last-Event-ID + X-Relay-Resume 透传)
- `api/src/routes/ask.test.ts`(两条新 case)
- `web/src/lib/agent-events/consumer.ts`(带 cursor 的 3 次重试)
- `web/src/lib/agent-events/store.ts`(reconnectAttempt / streamExpired)
- `web/src/lib/agent-events/index.ts`(新 selector 导出)
- `web/src/components/ask-vantage/step-timeline.tsx`(三档 footer)
- `web/messages/en.json` / `zh.json`(dock.message.reconnecting + streamExpired)
