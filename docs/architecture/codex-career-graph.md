# Codex × Career Graph 原生集成

> 状态：Career Graph 本地闭环、远程 OAuth 身份、现有简历导入审阅 UI、
> 可复现 PDF/DOCX 导出和 Greenhouse/Lever/Ashby 目标站 fill-only 回归已实现；
> 真实用户最终提交仍在后续范围内。
>
> 核心决定：Relay 拥有 Career Graph、编译和反馈；Codex 拥有交互式编排与
> 用户浏览器执行。Relay 不造服务器端投递器。

## 1. 为什么现有“简历版本”不够

迁移 017 已经提供 `original / optimized / tailored` track、bullet stable ID
和建议栈，但它仍把整份 JSON Resume 当作主要事实载体。这样有四个结构性问题：

1. 同一段经历在多份简历中被复制，纠错无法可靠传播。
2. JD 定制容易退化为整篇改写，证据和输出字段无法一一追溯。
3. 版本记录的是“文档变了”，不是“哪条职业事实变了、谁批准的”。
4. 投递结果只能关联某个 résumé row，无法回流到具体经历/技能证据。

Career Graph 把稳定事实和渲染产物分开：

```text
用户/文件证据
    │
    ▼
pending change set ──人工批准──► immutable Career Graph revision
                                      │
                              JD selection + ordering
                                      │
                                      ▼
                              draft compilation
                                      │
                                 人工批准
                           ┌──────────┴──────────┐
                           ▼                     ▼
                      public résumé       browser handoff
                                                │
                                           人工提交
```

## 2. 所有权边界

| 能力 | Relay 拥有 | Codex/浏览器拥有 |
|---|---:|---:|
| 经历事实、来源、关系 | ✅ | 读取/提出修改 |
| 不可变 revision、变更审计 | ✅ | 请求批准 |
| JD 编译、选择 manifest | ✅ | 提供 JD、解释差异 |
| 简历公开链接 | ✅，批准后 | 发起明确请求 |
| 登录招聘平台 | ❌ | 用户本人 |
| 填表与页面导航 | ❌ | 用户授权的 Chrome/Browser |
| CAPTCHA / 反自动化绕过 | ❌ | ❌ |
| 最终 Submit/Apply | ❌ | 用户逐次批准后在浏览器执行 |

这遵守 [`client-side-delivery.md`](client-side-delivery.md) 的核心约束，
也符合 Codex 官方建议：实时私有数据和受控动作放在
[MCP server](https://developers.openai.com/plugins/build/mcp-server)，重复的工具
顺序和决策点放在
[skill](https://developers.openai.com/plugins/build/skills)。

## 3. v1 数据模型

迁移 `022_career_graph` 新增四类实体，迁移
`024_career_graph_compiler_profiles` 为 compilation 固定编译器配置和质量报告：

- `career_graphs`：用户拥有的图谱入口，只指向一个当前已批准 revision。
- `career_graph_revisions`：不可变 node/edge snapshot。
- `career_graph_change_sets`：agent 提出的候选 snapshot；pending 状态不会改变图谱。
- `career_graph_compilations`：固定 graph revision + JD + résumé row +
  selection manifest + guard report + compiler config + quality report。

节点有稳定 ID、类型、事实数据和 provenance；边表达 role → achievement、
achievement → skill 等关系。编译器只选择和排序节点文本，不根据 JD 生成新事实。
一旦 résumé row 被 compilation 引用，migration 024 的数据库触发器会禁止修改其
内容、版本和派生关系；要改变产物必须创建新的 compilation 并重新经过批准。
发布 token 和发布时间等交付元数据仍可独立更新。

`selection_manifest` 把 `work.0.highlights` 等输出路径映射回 graph node ID。
这使“为什么这份 JD 简历出现这条 bullet”可被机器追踪，而不只是一段 LLM
解释。

已关联到 compilation résumé 的 `application_drafts` 会通过 manifest 回流成
evidence outcome report。migration 025 的数据库触发器把 Web、Agent、MCP 和
浏览器扩展写入统一记录为 append-only `application_outcome_events`，所以
submitted → interview → rejected 不会因当前状态变化而丢失曾到达 interview 的
证据。排序策略有意保守：JD 相关性始终优先；面试和 offer 仅作为同等相关证据的
正向次级信号；拒绝不产生负分，free-text outcome 也不会被静默分类。

报告同时给出 JD fingerprint cohort、跨 JD compiler-profile cohort 和基于已提交
样本的 95% Wilson 区间。少于 20 个 submitted 样本一律标记
`insufficient_sample`；跨 JD profile 还必须至少包含 2 个不同 JD 才能标记
`directional_only`。cohort rate 不参与自动改写或 evidence score，报告明确标注
相关性不等于因果。

## 4. 原生 Codex surface

项目 `.codex/config.toml` 注册两个互斥 surface：

- `relay-career`：默认开启的 trusted-local STDIO 开发入口。
- `relay-career-remote`：默认关闭的 Streamable HTTP + OAuth 2.1/PKCE
  多用户入口；启用后运行 `codex mcp login relay-career-remote`。

Codex 会从 `.agents/skills/manage-career-graph` 自动发现工作流 skill。

MCP 使用当前 Python SDK 的 `FastMCP` 和 typed structured output，并为工具声明
只读、写入和 open-world annotations。Codex 仍保留自己的工具确认；Relay 又在
领域层做第二道闸门：

- graph change：`APPROVE CAREER CHANGE <id>`
- résumé compilation：`APPROVE RESUME <id>`
- public publish：`PUBLISH <id>`

调用方不能传 `user_id`。本地 STDIO 模式只从 MCP server 环境读取
`RELAY_USER_ID`；远程模式只信任经过 bearer middleware 验证的 OAuth
`subject`，并把它解析为 Relay user UUID。模型参数无法切换 owner。

远程授权由 Python FastMCP 提供 OAuth 协议端点、动态客户端注册、PKCE 和令牌
校验；Relay Web/Hono 继续负责用户登录与 consent。两层只通过共享 PostgreSQL
交换短期状态：

```text
Codex ── OAuth/PKCE ──► Python MCP
                          │ pending request
                          ▼
                     shared PostgreSQL
                          ▲ approval + user UUID
                          │
Relay Web ◄── JWT ── Hono consent API
```

授权码、access token 和 refresh token 在数据库中只保存 SHA-256 摘要。access
token 有效期 1 小时，refresh token 有效期 30 天且每次刷新旋转；重放已旋转
refresh token 会撤销整个 token family。scope 分为 `career:read`、
`career:write`、`resume:publish` 与 `application:prepare`。scope 只授予调用
资格，不会跳过 graph / compilation / publish 的独立 HITL 状态机。

### Trusted-local STDIO

Codex 自身支持 ChatGPT 登录或 API key 登录；本机可用
`codex login status` 检查。Codex 登录和 Relay 数据身份是两个独立边界。

```bash
make up
export RELAY_PG_DSN='postgresql://relay:...@localhost:5433/relay'
export RELAY_USER_ID='<the signed-in Relay user UUID>'
codex
```

不启动基础设施也可以验证协议：

```bash
export RELAY_MCP_FAKE=1
codex
```

然后调用 `$manage-career-graph`。Codex 会读取项目配置并启动
`python -m agents.mcp_relay.server`。官方 Codex 支持 `codex login` 的浏览器
登录与本地会话缓存，详见
[Authentication](https://learn.chatgpt.com/docs/auth)。

### 远程 OAuth 本地回归

先执行 migration 023 并启动 API/Web，然后：

```bash
make mcp-remote
```

将 `.codex/config.toml` 中 `relay-career` 设为 `enabled = false`，
`relay-career-remote` 设为 `enabled = true`，再运行：

```bash
codex mcp login relay-career-remote
```

浏览器会进入 `/auth/mcp?request_id=...`。用户先完成 Relay 登录，再审阅 client
和 scopes；批准后才回到 Codex 的 loopback callback。生产环境必须把 issuer、
resource 和 Web URL 替换为 HTTPS，不能使用 loopback 配置。

## 5. HITL 不是一句 prompt

v1 同时使用三层保证：

1. **状态机**：proposal、draft、approved、published 分离，未批准状态不能进入
   下游。
2. **精确确认短语**：批准/发布工具拒绝普通 “yes”。
3. **Codex MCP approval policy**：项目配置对写工具和关键批准工具开启 prompt。

浏览器交接只返回 package，不暴露 server-side submit tool。每次 fill 前和最终
提交审阅前都必须调用 `assess_application_browser_checkpoint`；404、跳到其他
职位、登录、验证码或安全检查会停止整批。网页上的 Submit 按钮即使可见且 enabled
也不构成授权。Skill 要求用户在当前消息输入与 application ID 绑定的精确确认
短语；一次批量授权不会被解释为无限期许可。

用户确定要申请后，`create_application_draft` 会先幂等创建或复用 Relay 本地
`application_drafts` 记录，并把它连接到批准的 compilation résumé。它不会打开
网站或提交表单。后续 handoff 携带同一个 application ID，浏览器扩展在用户真正
提交后更新该记录，使结果反馈能回到 selection manifest。提交回写不再复用只读
`pg_query`：FastAPI 使用 owner-scoped PostgreSQL write transaction，并由
migration 025 trigger 记录 `browser_extension` 事件。按钮可见或已点击不算完成；
只有确认页、用户明确报告或招聘方消息才允许 MCP
`record_application_progress` 追加观察。

## 6. 当前完成度审计

| 原始要求 | 当前证据 | 状态 |
|---|---|---|
| Career Graph 是底层资产 | migration 022 + `agents/career_graph` | ✅ v1 |
| 针对 JD 现场编译 | `compile_resume` + selection manifest + versioned locale/length/ATS profile | ✅ v1 |
| 不编造经历 | provenance 必填 + source-only compiler | ✅ 编译路径 |
| 版本追踪 | immutable revisions + optimistic base check | ✅ |
| 现有简历导入 | JSON Resume → pending change → Web node/edge diff → exact-confirmation revision | ✅ |
| MCP 暴露给 Codex | STDIO + OAuth Streamable HTTP | ✅ |
| Repo skill 编排 | `manage-career-graph` | ✅ |
| 人工确认闸门 | change / compilation / publish 独立确认 | ✅ |
| Codex 登录 | ChatGPT 登录态 → skill → live MCP → PG 多轮验证 | ✅ Codex 侧 |
| Relay 多用户登录集成 | OAuth subject → owner scope；Web consent | ✅ |
| 简历公开发布 | approved compilation → `/r/<token>` | ✅ |
| 一/两页文件导出 | compiler profile → A4 PDF/DOCX；PDF 返回实测页数审计 | ✅ v1 |
| 真实浏览器预填 | Greenhouse/Lever/Ashby 目标站合成身份 fill-only | ✅ 未提交 |
| 申请跟踪连接 | approved compilation → idempotent local draft/compact batch queue → just-in-time handoff | ✅ v1 |
| Boss 直聘自动投递 | 命中 `_security_check`/登录即停止并手工交接 | ❌ 不自动化 |
| 结果反馈驱动下一次编译 | append-only history → manifest → evidence tie-break + confidence-bounded cohorts | ✅ v2 |

## 7. 下一段必须完成的工作

1. **真实 Office 分页兼容矩阵**：PDF 已完成 `en/zh × one/two_page` 全页回归；
   DOCX 已通过 Pandoc 重建校验、文本无损提取和 macOS Office Quick Look 预览，
   运行时仍诚实返回未知页数。后续需要在 Word/Pages/LibreOffice 中逐页建立兼容
   矩阵，不能把字符估算或 DOCX 压缩包元数据冒充实际页数。
2. **真实用户提交**：目标站 fill-only 已验证；仍需由用户选择实际职位、提供
   真实身份字段并逐份批准后，验证一份真实 application 的最终点击与状态回写。
   Boss 直聘保持登录/安全检查即停止，不把账号风险当成待绕过的工程问题。

在这些证据完成前，不能声称“Codex 已真实跑通 Boss 批量投递全流程”。

## 8. 已验证证据

- migration 022 在临时 PostgreSQL 中完成 up/down 往返，本地基础设施健康检查
  8/8 通过。
- Python 单元与 MCP 协议测试覆盖 proposal 不落地、精确确认、不可变 revision、
  source-only 编译、反馈次级排序、发布确认和浏览器交接边界。
- Relay Web 的 Career Graph 页面通过 Hono → FastAPI → PostgreSQL 真实链路
  导入两份隔离测试 résumé，逐项展示 node/edge 的 before/after 与 provenance；
  错误确认短语被拒绝，正确短语把 pending change 推进到 immutable revision 2，
  审阅队列归零。浏览器控制台无错误，隔离测试用户随后已级联清理。
- 使用本机 ChatGPT 登录态的 Codex CLI 做了真实多轮回归：读取已有 résumé、
  生成 pending import、以独立用户消息批准 graph revision、按 JD 生成 draft、
  独立批准 compilation，最后生成 `user_browser_only` handoff。
- 回归使用隔离用户和 `example.test` URL；没有发布、打开招聘站或点击提交，测试
  数据随后已级联清理。
- 真实 PostgreSQL 反馈回归验证了一份进入面试的 compilation 能把两分正向信号
  回流到所选节点；下一次中性 JD 编译用它打破同分，同时仍保持
  `source_only=true` 和原文不变。
- 本地申请草稿在真实 PostgreSQL 中完成两次调用幂等验证；handoff 返回同一
  application ID，且明确 `server_side_submission=false`。
- migration 023 为远程 MCP 增加 DCR、PKCE authorization request、摘要化
  access/refresh token 与 family revocation；Hono consent API 只在现有 JWT
  会话中绑定 Relay user UUID。
- migration 024 在隔离 PostgreSQL 中通过完整 up/down/up 往返。真实
  PostgreSQL compilation 同时持久化 `compiler_config`、`quality_report` 和
  résumé envelope 的 `artifactLocale`；API 私有预览和公开链接都优先使用该
  locale 渲染结构标签，事实文本不翻译。隔离库还验证了已关联 compilation 的
  résumé 内容更新被数据库拒绝，而 publish token 更新仍被允许；旧 compilation
  被诚实标记为 profile version 0 / `legacy_unbounded`，不会伪装成新版 profile。
- migration 025 在隔离 PostgreSQL 中通过完整 up/down/up 往返：created、
  `web_api` submit 和后续状态各形成独立事件，非生命周期字段更新不会产生噪声；
  owner 错配、直接 update/delete 均被拒绝，删除申请或账号仍能级联清理。down
  会把新终态映射回旧状态并把原含义保存在 outcome，再次 up 只生成明确标注的
  `migration_backfill` baseline。
- 真实 PostgreSQL + FastAPI + MCP 回归记录了
  `codex_mcp_prepare → browser_extension → codex_mcp_recruiter_message →
  codex_mcp_user_reported` 四个事件。提交端点重试没有把 interview 回退成
  submitted，也没有重复发布事件；清空当前 interview date 后，报告仍从历史得出
  furthest stage 为 interview、正向分数为 2，并把单样本 cohort 标为
  `insufficient_sample`。
- 本机 ChatGPT 登录态的 Codex CLI 经项目 STDIO MCP 真实调用
  `record_application_progress` 写入 recruiter-message interview，再读取 evidence
  report：返回 append-only 事件、Wilson 区间和非因果警告；Career Graph revision
  与事实原文未变化，也没有发布、打开招聘站或提交。
- 2026-08-01 使用 Playwright 对
  [Greenhouse / Genius AI](https://job-boards.greenhouse.io/glossgenius/jobs/6681936003)、
  [Lever / Until](https://jobs.lever.co/until/8c0ae3cf-6bb0-44de-b054-c3acba5a2926/apply)
  和
  [Ashby / Extend](https://jobs.ashbyhq.com/extend/a8a99013-d200-4a84-80ae-14c71a5d6657/application)
  做了真实目标站回归：只填 `example.test` 姓名/邮箱，简历、LinkedIn、资格、
  法律和开放题保持空白，最终 Submit 从未点击。三站的 Submit 按钮在不完整表单
  下仍可点击，因此 `dom_button_state_is_authorization=false` 已进入 MCP 契约。
- 同一轮中，搜索索引里 5 天前仍存在的 Lever/Ashby 职位在浏览器中已变成 404，
  证明执行时必须重新验证 exact job identity；checkpoint 会在 stale/changed job
  上停止。
- [Boss 直聘深圳列表](https://www.zhipin.com/zhaopin/35d0ab6f7f586dbf03Z_0tm_FQ~~/)
  在自动化浏览器中跳到带 `_security_check=1` 的路径，页面显示登录/手机号/
  验证码入口，继续交互后页面失效。回归按策略立即停止，没有登录、填凭据或规避
  安全检查；Boss 被固定为 `user_login_and_manual_handoff`。
- 原生 Codex CLI v0.146.0 使用 ChatGPT 登录态，经项目 STDIO MCP 和真实
  PostgreSQL owner scope 连续调用新 checkpoint：`before_fill` 返回
  `ready_for_fill`，`before_submit` 返回 `review_required`；两次都返回
  `safe_to_submit=false` 和同一 application ID 绑定的确认短语。隔离用户、职位和
  application 在验证后已删除。
- 原生 Codex CLI 使用 ChatGPT 登录态，经同一 STDIO MCP 真实调用新版
  `compile_resume_for_jd(artifact_locale=zh, length_budget=one_page,
  ats_profile=strict)`；随后独立读取 compilation，确认 profile version 1、
  `ready_for_human_review`、ATS ready、估算 1 页及 `source_only=true` 均已持久化。
  该验证只创建 draft，没有批准、发布或投递。
- 2026-08-01 新增 renderer profile v1：A4、固定 12/14 mm 边距、单/双页独立
  字号密度、无表格/图标/远程资源的 ATS 样式；PDF 渲染禁用 JavaScript 和网络，
  原始 HTML、危险协议链接及远程图片都会变成被动内容。API 使用 PDF parser
  读取实际页数，并在 `x-relay-artifact-*` 响应头返回 renderer version、目标页数、
  实际页数和是否超预算。
- 同一轮以四份只含 `example.test` 的合成 Career Graph artifact 完成
  `en/zh × one_page/two_page` PDF 全页视觉回归，四组分别稳定输出 1/2 页；修复
  了 header 软换行、职位摘要粘连、跨页孤立 bullet 和中文扩展章节仍显示英文的
  问题。DOCX reference assets 可由
  `scripts/build-resume-reference-docx.py --check` 确定性重建，输出经 Mammoth
  验证姓名、经历和项目无丢失，并把 Pandoc 私有 Symbol bullet 规范为标准
  Unicode OOXML numbering。由于本机无 Word/LibreOffice，DOCX 页数未伪造，
  API 和 skill 均要求用真实 Office renderer 打开后再批准交付格式。
- 生产 `deploy/Dockerfile.api` 已从 Alpine 切换到 Playwright 支持的 Debian Bun
  镜像，并固定安装 Pandoc、Chromium headless shell、Latin/CJK 字体；同一四案例
  校准脚本已在最终 Linux 容器内通过。API CI 现在安装相同渲染器后运行测试，
  不再因缺少 Chromium/Pandoc 而静默跳过文件回归。根级 `.dockerignore` 同时
  排除 `.env`、Git、本地依赖和校准 scratch，避免把秘密或机器状态发送到构建器。
