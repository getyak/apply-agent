# Vantage 本地体验与 Agent 智能审计

审计对象: `http://localhost:3000/`

审计日期: 2026-06-19

范围: 首页、移动端首屏、注册/登录入口、工作区可达性、聊天体验、Ask Vantage agent 流、产品闭环、工程质量门禁。本文区分“实测证据”和“代码/架构审阅推断”。

## 1. 执行摘要

当前产品已经有清晰的定位: “用户在自己的浏览器中审核和提交，agent 负责找岗位、改简历、准备投递包、面试准备”。首页表达完整，安全边界也较明确。但本地体验存在一个阻塞问题: 根页可加载，`/auth` 多次 HTTP 超时，导致无法从匿名用户完成登录/注册进入 workspace 的端到端闭环。

最高优先级不是继续加功能，而是先把“可进入、可恢复、可诊断”的基础体验打稳。建议按 P0 稳定性、P1 onboarding 和聊天闭环、P2 agent 智能体验、P3 产品增长和高级体验四层推进。

## 2. 测试环境与方法

### 2.1 环境

- 前端: Next.js 16.2.9, React 19.2.4, Bun
- 本地 Web: `http://localhost:3000/`
- API 默认端口: `3001`
- 机器时区: Asia/Shanghai
- 浏览器测试: Codex in-app browser + DOM snapshot + 控制台日志
- 命令行测试: `curl`, `bun run typecheck`, `bun run lint`

### 2.2 实测步骤

1. 打开 `http://localhost:3000/`。
2. 采集首页 DOM snapshot 和控制台错误。
3. 切换到 390x844 移动视口，采集移动端 DOM 和关键元素尺寸。
4. 访问 `/auth`，验证注册/登录入口可用性。
5. 尝试启动备用端口，确认 Next dev 单实例锁和端口占用行为。
6. 读取关键代码: `web/src/app/page.tsx`, `web/src/app/auth/page.tsx`, `web/src/components/views/chat-view.tsx`, `web/src/components/ask-vantage/dock.tsx`, `web/src/lib/ask-stream.ts`, `api/src/routes/ask.ts`, `agents/api/server.py`。
7. 执行 `bun run typecheck` 和 `bun run lint`。

## 3. 关键发现

### P0: `/auth` 超时，阻断新用户闭环

实测现象:

- `GET /` 可加载，标题为 `Vantage — Your job hunt, run by agents`。
- `curl --max-time 20 http://127.0.0.1:3000/auth` 超时，0 bytes received。
- 浏览器 direct navigation 到 `/auth` 也出现导航超时。
- 因为 `/app/*` 依赖 token guard，匿名用户无法完成“首页 -> 注册 -> workspace -> 上传简历/聊天”的核心路径。

影响:

- 这是产品体验 P0。用户看到首页后无法开始。
- 也让聊天、Today、应用跟踪、简历工作室等页面无法做真实端到端测试。

建议:

1. 先定位 `/auth` route 卡死原因: 对比 `/` 与 `/auth` 的 server log、RSC payload、middleware/proxy 行为。
2. 给 `/auth` 加一个 Playwright 或 `curl` smoke test: 10 秒内必须返回 HTML，并包含 `Welcome back.` 或 `Start your hunt.`。
3. 开发环境启动前增加健康检查: `GET /`, `GET /auth`, `GET /app` redirect 三条必须通过。

### P0: 当前 lint 失败，不能作为可发布基线

实测结果:

- `bun run typecheck`: 通过。
- `bun run lint`: 失败。

失败项:

- `web/src/components/screens/resume-view.tsx:1674`: `react-hooks/set-state-in-effect`
- `web/src/components/views/tracker-view.tsx:472`: `react-hooks/set-state-in-effect`
- `web/src/components/screens/mock-interview.tsx:155`: `modeDescriptor` 未使用警告

建议:

1. 修复两个 React 19 hook 规则错误，避免隐藏的级联渲染风险。
2. 将 lint 放入 PR gate，不允许带错误合并。
3. 针对 `AskVantageDock` 这类复杂状态组件，补一个最小 render regression test，防止再次出现历史日志中的 infinite loop。

### P1: 首页信息完整，但移动首屏过长，首个可操作体验被推迟

实测移动视口 390x844:

- body scrollWidth 378，无明显横向溢出。
- 首页首屏 section 高约 1205px。
- H1 高约 328px。
- 主 CTA 在 y=690 附近，仍在首屏底部；`HeroConsole` 的 Upload/Chat/Paste/Link 起始在 y=936，首屏不可见。

影响:

- 文案说“Chat is the interface”，但移动端第一屏看不到可试的聊天/上传模拟控件。
- 对求职焦虑型用户来说，首屏应该尽快进入“我能把简历/目标放进去”的状态。

建议:

1. 移动端缩短 H1 与 hero copy，减少首屏 hero 高度。
2. 把 `HeroConsole` 的第一个交互控件提前到首屏内，至少露出顶部和一个可点击 chip。
3. CTA 文案从单纯 “Start free” 改为更任务化: “Upload resume” / “Start with chat”。

### P1: 主聊天页存在两个聊天体系，用户心智可能分裂

代码证据:

- `web/src/components/views/chat-view.tsx` 有 `chatLog/sendChat/runFlow` 的演示流，也有 `sendRealChat/chatMessages` 的真实 API 流。
- 空输入提交会调用 `sendChat()`，有输入才调用 `sendRealChat()`。
- `AskVantageDock` 又是另一个 persistent chat surface。

影响:

- 用户可能不清楚“主 Chat 页”和右侧 Ask Vantage Dock 的关系。
- 空输入触发演示流容易制造“它真的扫描了岗位”的错觉。
- 真实 agent 状态、演示状态、历史消息状态混在同一页面，后续维护成本高。

建议:

1. 将主 Chat 页统一为 Ask Vantage 的完整页面模式，Dock 只是同一线程的紧凑入口。
2. 删除空输入触发演示流，改成禁用 send 或选中建议 chip 后发送真实 prompt。
3. 保留 demo 只能在未登录 marketing hero 里出现，并标记为 product preview。

### P1: Agent 流式协议设计方向正确，但缺少面向用户的可恢复错误态

代码证据:

- `api/src/routes/ask.ts` 已做 FastAPI SSE -> 前端 NDJSON 的协议桥接。
- `web/src/lib/ask-stream.ts` 有 120s idle watchdog 和 disconnect/timeout 分类。
- API 网关在 agent host 不可达时返回 `AGENT_UNREACHABLE` 和 hint。

问题:

- 前端 `runAskStream` 对非 2xx 只抛 `/api/ask/stream returned ${status}`，没有读取 JSON body 里的 `hint`。
- 用户最终看到的可能是通用 “Lost connection to Vantage. Try again.”，不能知道是 agent host 没启动、鉴权失败、还是上游执行错误。

建议:

1. 非 2xx 时读取 body，优先展示 `hint`。
2. 在 Dock 中提供“Retry last message”和“Copy debug info”。
3. agent_start/agent_done 增加 step id、duration、cost estimate，让用户知道不是普通聊天机器人，而是可审计的 agent workflow。

### P1: 工作区进入路径强依赖 auth/API，缺少离线 demo 或降级体验

代码证据:

- `web/src/app/app/layout.tsx` 先 `getToken()`，无 token 直接 `router.replace("/auth")`。
- 有 token 后必须 `authApi.me()` 成功，才能 setReady。
- 若 API 网络卡住，8 秒后跳回 `/auth?reason=session_timeout`。

影响:

- 当前 `/auth` 卡住时，所有工作区页面都不可用。
- 对本地开发和演示不友好，无法快速体验产品价值。

建议:

1. 增加 `NEXT_PUBLIC_DEMO_MODE=1`，允许无后端体验 Today/Chat/Resume 的假数据闭环。
2. 工作区 loading 超时页不要只 redirect，应提供 “Retry / Open diagnostics / Continue demo”。
3. API 健康状态在 UI 中显式显示: Web OK, API OK, Agents OK, Redis/PG OK。

### P2: Agent 设计需要从“5 个 agent 名称”升级为“可解释任务图”

当前架构文档定义了 5 个 agent: Resume, JobMatch, Interview, AppPrep, Trend，并强调 Coordinator 编排、共享 DB、Redis Streams。这是合理的职责拆分。

优化方向:

1. Coordinator 不只分类 intent，还要生成 task graph:
   - 用户目标
   - 必需上下文
   - 要调用的 agent
   - HITL 中断点
   - 可回滚的副作用
2. 每个 agent 输出统一 artifact:
   - `artifact_type`: resume_version, job_match_set, application_package, interview_session
   - `confidence`
   - `source_evidence`
   - `needs_user_review`
   - `next_actions`
3. UI 展示“任务卡”而不是只展示“thinking/done”:
   - 找岗位: 数据源、筛选条件、排除原因
   - 改简历: 修改前后 diff、真实性风险
   - 投递包: AI 生成字段高亮、必须人工确认字段
   - 面试: 问题来源、评估维度、下一轮训练建议

### P2: 产品体验应围绕“今日动作”而不是功能导航

现有信息架构包含 Today、Chat、Applications、Resume、Mock、Settings 等，功能完整，但用户真正关心的是“今天我该做什么”。

建议重组:

1. Today 作为默认首页，按优先级展示:
   - 3 个最值得投的岗位
   - 1 个需要补充材料的投递包
   - 1 个面试准备任务
   - 1 个市场/技能提醒
2. Chat 不作为孤立页面，而是所有任务的命令层。
3. Applications 不只是看板，要有下一步状态:
   - waiting
   - follow-up due
   - prep interview
   - close loop
4. Resume Studio 要和每个 job/application 强绑定，避免用户在“通用简历”和“岗位简历”之间迷路。

### P2: 智能体验要增加“诚实边界”和“依据展示”

产品红线是“不编造经历”。当前文案表达了这一点，但工作流还需要把它产品化。

建议:

1. 简历改写时每条 bullet 标注:
   - 原始依据
   - 改写类型: tighten / quantify existing / reorder / infer wording
   - 风险等级: safe / needs review / unsupported
2. JD 定制时显示:
   - JD 关键要求
   - 已满足证据
   - 缺口
   - 不建议伪装的内容
3. 开放题答案要附“使用了哪些简历事实”。
4. 投递前必须有 review checklist，且 `submit_form`, `send_email`, `delete_*` 始终 HITL interrupt。

## 4. 改进步骤

### Phase 0: 1-2 天，稳定可测试闭环

1. 修复 `/auth` 超时。
2. 修复 lint 错误。
3. 增加 smoke tests:
   - `/` returns 200
   - `/auth` returns 200
   - anonymous `/app/today` redirects to `/?source=app_redirect` 或 `/auth`
   - authenticated `/app/today` renders workspace shell
4. 增加 dev diagnostics 页面或命令，显示 Web/API/Agents/PG/Redis 状态。

### Phase 1: 3-5 天，统一聊天体验

1. 把 `ChatView` 和 `AskVantageDock` 统一到同一 conversation/session 模型。
2. 去掉空输入 demo flow。
3. 建立 prompt chips ->真实 prompt -> task graph -> result card 的闭环。
4. 非 2xx stream 错误读取 JSON hint，给用户可恢复操作。
5. Recent rail 从“锚点列表”升级为“任务历史”，至少显示状态和 artifact。

### Phase 2: 1-2 周，做出 agent 智能感

1. Coordinator 输出 task graph，并在 UI 中逐步展开。
2. Agent 事件统一 schema: start/progress/artifact/review_required/done/failed。
3. 每个 result card 都能落到一个 artifact 页面。
4. Resume/JD/Application 三者建立证据链。
5. 加入 cost/latency/token telemetry，便于优化模型路由。

### Phase 3: 2-4 周，优化核心求职旅程

1. Today 改成 action queue。
2. Application board 增加 follow-up 和面试准备触发。
3. Resume Studio 增加 diff review 和真实性标注。
4. Extension 投递流增加 dry-run、字段置信度、AI 字段高亮、最终 submit 禁止自动点击。
5. 面试模块加入 opt-in 数据飞轮入口。

## 5. 建议测试清单

### 自动化测试

- Route smoke: `/`, `/auth`, `/legal/privacy`, `/app/*` auth redirect。
- API smoke: `/api/health`, `/api/auth/register`, `/api/auth/login`, `/api/ask/stream` agent offline。
- Stream contract: FastAPI SSE frame -> gateway NDJSON frame -> Dock rendering。
- Zustand state: `AskVantageDock` render with 0/1/N agent events，不允许 infinite loop。
- Mobile layout: 390x844 无横向滚动，首屏 CTA 可见。
- HITL safety: submit/send/delete 操作必须生成 interrupt/approval state。

### 手动体验脚本

1. 新用户打开首页。
2. 点击 Start free。
3. 注册账号。
4. 上传或粘贴简历。
5. Ask Vantage: “Find roles that fit me today.”
6. 打开 Today 的第一条 match。
7. 生成投递包。
8. Review 简历 diff、cover letter、开放题答案。
9. 打开扩展 dry-run 填表。
10. 用户手动 submit。
11. Application board 出现新卡片。
12. 触发 mock interview。

## 6. 优先级矩阵

| 优先级 | 项目 | 原因 | 验收标准 |
|---|---|---|---|
| P0 | 修复 `/auth` 超时 | 阻断注册和 workspace | `/auth` 10 秒内返回 HTML |
| P0 | 修复 lint | 发布门禁失败 | `bun run lint` 通过 |
| P0 | 加 route smoke | 防止入口再次坏 | CI 覆盖 `/` 和 `/auth` |
| P1 | 统一 Chat 与 Dock | 降低用户心智负担 | 同一线程、同一历史、同一错误态 |
| P1 | 改 stream 错误展示 | agent 离线时可恢复 | 显示 AGENT_UNREACHABLE hint |
| P1 | 移动首屏压缩 | 更快进入操作 | 390x844 首屏可见一个输入/上传控件 |
| P2 | task graph UI | 提升智能感和可解释性 | 每次 agent run 有步骤、证据、结果卡 |
| P2 | resume 真实性标注 | 符合产品红线 | 每条 AI 改写可追溯 |
| P3 | Today action queue | 强化日常留存 | 默认页给出今日 3 个动作 |

## 7. 当前结论

Vantage 的方向是对的: 不做服务器端代投，不存平台密码，投递在用户浏览器完成，agent 负责准备和解释。这是产品差异化的核心。

但当前本地体验还没有达到“可稳定演示”的状态。建议先停下新增页面，优先修复 `/auth`、lint、route smoke 和聊天统一。等入口闭环稳定后，再把智能体验从“聊天回复”升级成“可解释、可审核、可恢复的 agent 任务系统”。
