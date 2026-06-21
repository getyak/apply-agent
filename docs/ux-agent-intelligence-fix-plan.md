# Vantage 本地体验与 Agent 智能 - 深度修复方案

配套审计文档：[`ux-agent-intelligence-audit-localhost-3000.md`](ux-agent-intelligence-audit-localhost-3000.md)

起始日期：2026-06-19

本文是审计的"行动篇"。审计列了 P0–P3 问题清单，本文给每条一个落地方案；已实施的明确标注；未实施的给出"分解、验收、影响面"。

## 1. 阶段总览

| 阶段 | 目标 | 状态 | 关键产物 |
|---|---|---|---|
| P0 稳定线 | lint/typecheck 干净 + 入口路由可达 + smoke 防回归 | ✅ 已完成 | resume-view/tracker-view/mock-interview 修复；`scripts/web-route-smoke.mjs` |
| P1 入口闭环 | 聊天体系不再分裂；agent 错误可恢复 | ✅ 已完成 | ask-stream 新增 `unreachable` 分支；空输入不再触发 demo flow |
| P2 智能感 | task graph UI；artifact schema；证据链 | ✅ 已落地（详见 §4） | TaskGraphCard、ArtifactCard、resume change_log+guard |
| P3 求职旅程 | Today action queue；application 状态联动；data 飞轮入口 | ✅ 已落地（详见 §5） | /api/today/queue、015 migration + deriveNextAction、LogRealInterviewModal |

## 2. P0 已实施细节

### 2.1 React 19 `react-hooks/set-state-in-effect`

#### `web/src/components/screens/resume-view.tsx` (SourceDrawer)

**问题**：effect body 顶部三连 setState（`setLoading(true) / setError(null) / ...`）触发级联渲染告警。

**修复手法**：
1. 把 `(url, loading, error)` 三个 useState 合并成一个 `DownloadState` 单 slice。
2. 在父组件渲染 `<SourceDrawer>` 处加 `key={doc._source.fileId}`：React 在 fileId 变化时彻底卸载/重挂载，初始 state slice 自动 reset，effect 不再需要主动 reset。
3. effect 只保留"发起异步 download → 写终态"两条路径。

**为什么不用 useReducer**：单文件局部，三态合一已经够。useReducer 增加阅读成本，不值得。

**为什么不用 functional setState**：rule 不看 setter 是 functional 还是值更新；它只看是不是在 effect body 顶部裸调。`key` 是 React 官方推荐的「reset state when prop changes」模式。

#### `web/src/components/views/tracker-view.tsx`

**问题**：`useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [...])` 是典型的 reconcile-in-effect 反模式。

**修复手法**：删除整个 effect。drawer 渲染条件本就是 `selected !== null`，行进自动；selection ID 留着意味着如果 row 被 transient drop 又回来，drawer 自动重现 —— 这是更好的语义。

**行为变化**：「drawer 在 row 永久消失后不再返回」→ 「drawer 在 row 暂时消失后自动恢复」。这是改进。

#### `web/src/components/screens/mock-interview.tsx`

**问题**：`modeDescriptor()` 死代码警告。

**修复手法**：直接删除该 helper（无调用者）。

### 2.2 入口 smoke：`scripts/web-route-smoke.mjs`

**为什么单独写**：现有 `web-hydration-smoke.mjs` 走 Playwright，量级太重，且 `/auth` 如果连 HTTP 200 都拿不到，Playwright 报错信息会混淆「页面 hung」和「playwright 找不到 chromium」。HTTP 层 smoke 是入口路由保活的最低成本守门。

**契约**（per route）：
```
status === 200
body bytes ≥ minBytes（防 SSR shell 半截）
body 含 markers 任一（防 5xx body 也是 200）
全程 ≤ TIMEOUT_MS（默认 10s）
```

**输出**：JSON Lines 一行一 route，最后一行 summary。CI 可以 grep `"pass":false` 找失败。

**接线**：
- 已挂 `web/package.json` 的 `smoke:route` 脚本。
- CI 接入留作单独 PR（避免改 `.github/workflows/ci.yml`）。
- lefthook pre-push 接入需要后端 dev server 处于运行态，是开发者本地决策，不强加。

### 2.3 关于 `/auth` 超时

审计实测当时 `/auth` HTTP 超时。本次 fix 中：

1. 代码层面 `web/src/app/auth/page.tsx` 已经按 Next 16 要求把 `useSearchParams()` 包了 `<Suspense>`（line 30–36），SSR 层不应再卡。
2. 因为本地 dev server 当下没在运行（`curl /` 返回 502），无法复现「页 hung」。route-smoke 脚本就是为了这种情况下 CI 也能 catch 回归。

**下一步建议**（不在本 PR）：
- 把 route-smoke 纳入 CI：workflow 里 `cd web && bun run dev &` → 等 8s → `bun run smoke:route` → kill。
- 如果再出现 `/auth` hung，对比 `_next/static/` chunks 是否完成、`getToken()` 是否触发 ssr/csr 错位。

## 3. P1 已实施细节

### 3.1 Agent 流式错误恢复（`web/src/lib/ask-stream.ts`）

**问题**：网关已经按 `{ code, hint, status, detail }` 结构返回 503 / 502，前端 `!res.ok` 时却只抛 `returned ${status}`，hint 永远到不了用户。

**修复手法**：
1. `AskStreamCallbacks.onError` kind 联合从 3 类扩到 4 类：`"frame" | "timeout" | "disconnect" | "unreachable"`。
2. 新增 `readErrorPayload(res)` helper：失败时尝试 JSON.parse body，提取 `hint`。
3. 非 2xx 且 payload 含 hint → 走 `onError("unreachable", hint)` 直接传给 dock；否则 fallback 到原来的通用 disconnect。
4. dock 包装层针对 `unreachable` 单独渲染：`_${hint}_`（hint 已经是 user-facing 文案）。

**为什么不在前端做 Retry 按钮**：审计建议但需要 Dock store 加 `lastPrompt` / `lastThreadId` 字段，触及多个组件。本次先把「能看到原因」这条线做透，Retry/Copy debug info 留作 P2 task graph 一起设计（result card 一并加 retry handle）。

### 3.2 主聊天页 demo 分支移除（`web/src/components/views/chat-view.tsx`）

**问题**：form onSubmit 和 ⌘↵ 两处都有 `if (chatInput.trim()) sendRealChat(); else sendChat();`。空输入路径调 `sendChat()` → `runFlow("find")` 是纯演示，无 LLM 调用，但 UI 看起来像真在跑 agent。

**修复手法**：两处空输入分支改为 noop，并加注释解释。chip onClick 上 `runFlow(s.id)` 暂保留（chip demo 价值还在；下一步 P2 会把 chip 改成真 prompt → ask-stream，统一）。

**未连带改的**：
- `useVantage` 的 `sendChat` action 本身保留（store 层 cleanup 风险大，可能被 onboarding 路径间接用）。
- 移除 chat-view 对它的引用即可，避免 `no-unused-vars` 告警。

## 4. P2 待办深度方案

### 4.1 Coordinator → Task Graph

**当前状态**：`agents/coordinator/router.py` 还是「intent → 一个 agent」的浅路由。

**目标**：每次 ask_vantage 调用产生一份 task graph：

```jsonc
{
  "task_id": "...",
  "user_goal": "Tailor my résumé for Stripe staff role",
  "required_context": ["resume:current", "job:stripe-staff-eng"],
  "plan": [
    { "step": "fetch_jd",          "agent": "jobmatch_agent" },
    { "step": "customize_resume",  "agent": "resume_agent",
      "requires_review": true },
    { "step": "draft_cover_letter","agent": "appprep_agent",
      "requires_review": true }
  ],
  "hitl_checkpoints": [1, 2],
  "rollbackable": true
}
```

**为什么用图而不是 sequence**：未来 jobmatch_agent + trend_agent 可以并行（前者找当前匹配，后者补技能缺口分析），sequence 表达不出依赖。

**前端**：dock 的 agent 卡片升级为 task graph mini-view：未开始（灰）→ 跑中（spinner）→ 完成（✓ + artifact 链接）→ 待审核（黄 ◯）。

**验收**：
- 后端：`/api/ask/stream` 在 thinking 阶段先 emit 一帧 `{ kind: "task_graph", graph: {...} }`。
- 前端：dock 接到此帧后渲染 plan 概览，再消费后续 agent_start/agent_done 时更新对应 step 状态。
- 用户能在 graph emit 时点 cancel/edit plan（cancel 已有，edit 是 P3）。

### 4.2 Artifact 统一 schema

**问题**：现在每个 agent 自由发挥输出。投递包是文本、简历定制是 JSON、面试 session 是另一种结构。前端要写多个 result card 渲染。

**方案**：所有 agent 输出包成 Artifact envelope：

```ts
type Artifact = {
  artifact_type: "resume_version" | "job_match_set" | "application_package" | "interview_session";
  id: string;
  confidence: number;          // 0–1
  source_evidence: SourceRef[];
  needs_user_review: boolean;
  next_actions: Action[];
  payload: ArtifactPayload;    // discriminated union by artifact_type
};
```

**前端**：通用 `<ArtifactCard>` 组件按 type 派发到具体渲染器。所有 card 都自带 confidence pill、"View evidence" 链、"Approve / Tweak / Discard" 三按钮。

**验收**：
- 现存 result frame `{ title, sub, action, route }` 扩成 artifact frame。route 仍走 isSafeRoute 校验。
- 至少 customize_resume 和 draft_cover_letter 两个落地。

### 4.3 简历真实性标注（vision.md 红线产品化）

每条 AI 改写的 bullet 标 `change_type ∈ {tighten, quantify_existing, reorder, infer_wording}`。`infer_wording` 自动打 `needs_review: true` 黄章。

**实现**：
- `resume_agent.customize` prompt 中要求模型同时输出 `change_log: Array<{ bullet_id, change_type, source_evidence }>`.
- `fabrication_guard`（已有，agents/nodes/resume_agent.py）外扩：除了 NER subset 检查，对 `change_type === infer_wording` 的 bullet 多跑一次 LLM-as-judge 「这是否在重述用户原文」。
- 前端 `<ResumeDiff>` 每条 bullet 头部标 chip（safe / needs review / unsupported），不允许用户在 unsupported 状态下点 Approve。

## 5. P3 待办深度方案

### 5.1 Today action queue

**当前状态**：`/app/today` 是趋势 snapshot + 推荐岗位混排。

**目标**：默认页改成 action queue：

```
Today, 3 things move you forward
1. Stripe staff eng — application due in 2d   [Prepare]
2. Linear recruiter screen — Wed 10am         [Practise]
3. Rust unlocks 47 new matches                [Learn]
```

每条 action 关联一个具体 agent action（prepare/practise/learn → ask_vantage prompt or workflow）。

**实现**：
- 后端：新增 `GET /api/today/queue`，按 priority 分数排序的 action 列表。
- 前端：`/app/today` 顶部 action queue 卡片，下面才是次要 trend snapshot。

### 5.2 Application kanban 联动

每张 application card 加状态机：`waiting → follow_up_due → prep_interview → close_loop`。`follow_up_due` 自动 7 天未回信触发；`prep_interview` 有面试日程时触发。

**实现**：
- `application_drafts` 表已有 `submitted_at`/`outcome`/`interview_date`。新增 `next_action` 字段（enum）+ `next_action_due` 字段。
- 后端定时任务每天 reconcile 一次。
- 前端 kanban 把 next_action 渲染成 column 内 badge + 一键调起对应 ask_vantage prompt。

### 5.3 数据飞轮入口

InterviewAgent 已有 `interview_question_pool` schema + opt-in 字段。前端需要：
- mock interview debrief 页加 "Log the real interview" CTA。
- 走 `save_to_card` tool（NOTIFY 级权限，存到 `interview_sessions.is_real = true`）。
- 用户首次 opt-in 时弹隐私说明：脱敏后入题库，自己永远 own 数据。

## 6. 维护清单

- 每次新增页面 → `scripts/web-route-smoke.mjs` 的 ROUTES 数组加一项。
- 每次新增 agent → ask-stream 的 `AGENT_LABELS` 加一项。
- 每次改 ask-stream 协议 → `agents/api/server.py` 的 SSE emit 同步。

## 7. 回到审计的对照表

| 审计项 | 优先级 | 状态 |
|---|---|---|
| `/auth` 超时 | P0 | ✅ 代码层已 OK；route smoke 已加且接入 CI（ci.yml web job 在 prod server 上跑 smoke:route） |
| lint 失败 | P0 | ✅ 已修 |
| route smoke 缺失 | P0 | ✅ 已加脚本 + npm script + CI 接入（ci.yml web job） |
| 移动首屏过长 | P1 | 🚧 留作单独 UI PR（涉及 HeroConsole 设计稿） |
| 主聊天页两套体系 | P1 | ✅ 删除 demo 分支；chip 改成真 prompt 留 P2 |
| Agent 流式可恢复错误 | P1 | ✅ unreachable 分支落地 |
| 工作区降级体验 | P1 | 🚧 `NEXT_PUBLIC_DEMO_MODE` 需要独立 PR 设计假数据 |
| Coordinator → task graph | P2 | ✅ 已落 ask-stream task_graph + 网关合成 + Dock TaskGraphCard |
| Artifact 统一 schema | P2 | ✅ ask-stream artifact frame + 网关 buildArtifact + Dock ArtifactCard |
| 真实性标注 | P2 | ✅ prompt v2 + change_log_guard + 6 Python 单测；ResumeChangeLogPanel + 接入 Resume Studio；store `tailoredChangeLogs` map 准备接入 ask-stream artifact 通路 |
| Today action queue | P3 | ✅ GET /api/today/queue + TodayView ActionQueue 卡片 |
| Application 联动 | P3 | ✅ 015 migration + deriveNextAction + 10 单测 + Tracker NextActionBadge + reconcile-next-action.ts 脚本（含 8 单测）+ `bun run reconcile:next-action` npm script |
| 面试飞轮 | P3 | ✅ LogRealInterviewModal + crowdsourceOptIn preferences 持久 + sendAsk 接力 |
