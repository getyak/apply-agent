# Codex × Career Graph 原生集成

> 状态：Career Graph 本地闭环、远程 OAuth 身份、现有简历导入审阅 UI、
> 可复现 PDF/DOCX 导出、稳定公共链接版本更新、短期审阅/上传文件交付和
> Greenhouse/Lever/Ashby 目标站 fill-only 回归已实现；真实用户最终提交仍在
> 后续范围内。
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
                      （可选公开）         （短期私有文件）
                                                │
                                           人工提交
```

## 2. 所有权边界

| 能力 | Relay 拥有 | Codex/浏览器拥有 |
|---|---:|---:|
| 经历事实、来源、关系 | ✅ | 读取/提出修改 |
| 不可变 revision、变更审计 | ✅ | 请求批准 |
| JD 编译、选择 manifest | ✅ | 提供 JD、解释差异 |
| PDF/DOCX 渲染、短期交付 | ✅ | 下载、逐页审阅、上传 |
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
`024_career_graph_compiler_profiles` 为 compilation 固定编译器配置和质量报告，
迁移 `026_resume_artifact_delivery_grants` 提供短期私有文件交付，迁移
`027_career_graph_publication_history` 提供稳定公共链接版本历史，迁移
`028_application_submission_authorizations` 记录逐 application 的短期提交授权：

- `career_graphs`：用户拥有的图谱入口，只指向一个当前已批准 revision。
- `career_graph_revisions`：不可变 node/edge snapshot。
- `career_graph_change_sets`：agent 提出的候选 snapshot；pending 状态不会改变图谱。
- `career_graph_compilations`：固定 graph revision + JD + résumé row +
  selection manifest + guard report + compiler config + quality report。
- `resume_artifact_delivery_grants`：只存下载码 SHA-256 摘要、十分钟过期时间和
  有界下载次数。`compilation_review` 可在 draft 阶段审阅真实文件；
  `application_upload` 必须绑定同 owner 的 application 与 approved/published
  compilation。
- `career_graph_publication_events`：append-only 记录 published / updated /
  revoked；只存 public token 的 SHA-256 摘要，不复制 bearer token。
- `application_submission_authorizations`：绑定 owner + application +
  compilation，保存预期 URL、观测 URL 和精确短语的 SHA-256；五分钟过期，
  重签会废止旧票据，浏览器确认页回写 submitted 时原子消费。

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
- stable public update：`UPDATE PUBLIC RESUME <source> TO <target>`
- public revoke：`REVOKE PUBLIC RESUME <id>`

调用方不能传 `user_id`。本地 STDIO 模式只从 MCP server 环境读取
`RELAY_USER_ID`；远程模式只信任经过 bearer middleware 验证的 OAuth
`subject`，并把它解析为 Relay user UUID。模型参数无法切换 owner。

真实使用不能依赖上一段对话保存 UUID。`list_resume_compilations` 和
`list_tracked_applications` 提供 owner-scoped、分页且可按 graph/status 过滤的
跨会话恢复入口：前者返回 graph revision、compiler/quality 摘要、发布状态和
application 数量，并用最长 240 字符、明确标记为 untrusted source text 的 JD
preview 帮助辨认无 job 绑定的 draft；后者返回 job、当前状态和最新 append-only
history event。两个工具都不返回 résumé 正文、表单答案、下载码或文件
capability，发现既有版本也不会改变任何状态。

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

当前实现同时使用四层保证：

1. **状态机**：proposal、draft、approved、published 分离，未批准状态不能进入
   下游。
2. **精确确认短语**：批准/发布工具拒绝普通 “yes”。
3. **短期授权票据**：最终点击前把当前页面、application、compilation 和精确短语
   绑定；票据五分钟过期，重签废止旧票据，确认页回写时只能消费一次。
4. **Codex MCP approval policy**：项目配置对写工具和关键批准工具开启 prompt。

浏览器交接只返回 package，不暴露 server-side submit tool。每次 fill 前和最终
提交审阅前都必须调用 `assess_application_browser_checkpoint`；404、跳到其他
职位、登录、验证码或安全检查会停止整批。网页上的 Submit 按钮即使可见且 enabled
也不构成授权。Skill 要求用户在当前消息输入与 application ID 绑定的精确确认
短语；随后必须调用 `authorize_application_submission` 获得相同 application /
compilation 的短期票据，才可立即点击一次。一次批量授权不会被解释为无限期许可。
票据不是 submit API，也不能证明网页已经接受申请；如果页面结果含糊，不能把
点击当作 submitted，更不能复用旧票据盲目重试。

编译后、批准前必须先调用 `prepare_resume_artifact_review`：MCP 只返回不含密钥
的 Relay 页面 URL，并把 256-bit 下载码作为独立字段返回。页面通过 POST 接收
下载码，再把它放入 HttpOnly、SameSite=Strict、仅限该下载路径且十分钟失效的
cookie，通过 303 转到浏览器可重复获取的 GET attachment。URL 与请求日志不携带
该码；数据库只保存摘要。真正投递前，
`prepare_application_handoff` 重新签发与 application + compilation 绑定的
`application_upload` grant，旧 grant 被撤销，文件无需先公开发布。复杂的
owner、状态、过期和下载次数判断由 migration 026 的单条原子消费函数完成，避免
read-then-consume 竞态。批量准备只创建紧凑的本地队列，不提前签发或丢弃整批
下载码。

用户确定要申请后，`create_application_draft` 会先幂等创建或复用 Relay 本地
`application_drafts` 记录，并把它连接到批准的 compilation résumé。它不会打开
网站或提交表单。后续 handoff 携带同一个 application ID。Codex 在最终点击前把
用户当前消息中的精确短语通过 `authorize_application_submission` 记录为五分钟
票据；数据库不保存原短语或 URL，只保存摘要。看到真实确认页后，才可通过 MCP
更新该记录，使结果反馈能回到 selection manifest；对应事件源是
`codex_mcp_browser_confirmation`，并且必须携带同一票据 ID。migration 028 的
BEFORE trigger 在状态首次进入 submitted 时原子消费
owner/application/compilation 匹配且未过期的票据，migration 025 的 AFTER
trigger 再追加历史事件。MCP 提交回写不再复用只读 `pg_query`。按钮可见、授权
票据或已点击都不算完成；只有确认页、用户明确报告或招聘方消息才允许
`record_application_progress` 追加观察。用户明确报告的手工进度与
Web/extension writer 不会被伪装成 MCP 浏览器确认。

公开简历更新不改写已发布 résumé row。目标 compilation 必须属于同一 graph、
已独立批准且尚未发布；MCP 在一个事务中把原 128-bit token 从 source résumé
转移到 target résumé，因此 `/r/<token>` 保持不变，但立即读取新版本。source
artifact、原 publication 时间和 application attribution 均保留。baseline /
published / updated / revoked 事件追加到 migration 027 的历史表，事件只保存
token digest。活动 token 是当前公开状态的权威来源；这也让迁移前状态字段不一致
的旧链接仍能被发现、更新或撤销，而不会被再次 publish 静默轮换。
通用 Hono résumé publish/revoke 路径会拒绝 Career Graph compilation，数据库
trigger 也拒绝未声明 review-gated writer 的 token 变更，避免绕过 MCP 精确确认。
撤销只清空活动 token，不删除 immutable compilation。

需要上传本地文件的表单使用连接的 Chrome；Codex 内置 Browser 当前不能自动完成
文件上传。Chrome 无法访问本地下载文件时，交还用户完成一次上传，不把文件转交给
服务器端投递器。

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
| 人工确认闸门 | change / compilation / publish / public update / revoke 独立确认；final click 为逐 application 精确短语 + 短期票据 | ✅ |
| Codex 登录 | ChatGPT 登录态 → skill → live MCP → PG 多轮验证 | ✅ Codex 侧 |
| Relay 多用户登录集成 | OAuth subject → owner scope；Web consent | ✅ |
| 跨 Codex 会话恢复 | 只读 compilation/application inventory；分页、过滤且不返回 capability | ✅ v1 |
| 简历公开发布与更新 | approved compilation → stable `/r/<token>` → exact-confirmation version transfer/revoke | ✅ v2 |
| 一/两页文件导出 | compiler profile → A4 PDF/DOCX；PDF 返回实测页数审计 | ✅ v1 |
| 批准前真实文件审阅 | draft compilation → 短期 PDF/DOCX review grant → 页面级检查 | ✅ v1 |
| 真实浏览器预填 | Greenhouse/Lever/Ashby 目标站合成身份 fill-only | ✅ 未提交 |
| 申请跟踪连接 | approved compilation → compact queue → application-bound artifact → just-in-time handoff | ✅ v1 |
| Boss 直聘自动投递 | 命中 `_security_check`/登录即停止并手工交接 | ❌ 不自动化 |
| 结果反馈驱动下一次编译 | append-only history → manifest → evidence tie-break + confidence-bounded cohorts | ✅ v2 |

## 7. 下一段必须完成的工作

1. **真实 Office 分页兼容矩阵**：PDF 与 LibreOffice DOCX 已完成
   `en/zh × one/two_page` 全页回归；DOCX 另通过 Pandoc 重建校验、文本无损提取
   和 macOS Office Quick Look 预览，运行时仍诚实返回未知页数。后续还需要在
   Word/Pages 中逐页建立兼容矩阵，不能把字符估算或 DOCX 压缩包元数据冒充实际
   页数。先用对应原生应用打开四份 DOCX 并分别导出同名 PDF，再运行下面的离线
   校验；manifest 会把源 DOCX 与导出 PDF 的 SHA-256、实际页数和文本哨兵绑定：

   ```bash
   cd api
   bun run calibrate:resume-artifacts
   mkdir -p scratch/resume-artifacts/native-office/pages
   # 用 Pages 打开四份 DOCX，将 PDF 导出到上面的目录。
   bun run verify:resume-artifacts:native -- \
     --renderer pages \
     --renderer-version 14.5
   ```

   Word 使用 `--renderer word --renderer-version <实际版本>`，默认读取
   `scratch/resume-artifacts/native-office/word`。任何缺失文件、页数漂移、文本
   哨兵丢失、PDF 解析失败，或 PDF Creator/Producer 元数据与所声明的 Pages/Word
   不符，都会保留失败 manifest 并以非零状态退出。
2. **真实用户提交**：目标站 fill-only 已验证；仍需由用户选择实际职位、提供
   真实身份字段并逐份批准后，验证一份真实 application 的最终点击与状态回写。
   当前 Chrome profile 还需在 ChatGPT browser extension 的 Details 中启用
   `Allow access to file URLs`，否则 `setFiles` 会以 `Not allowed` 失败；MCP
   handoff 已结构化返回这个 preflight，Relay 无法替用户读取或修改该权限。
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
- migration 026 在隔离 PostgreSQL 中通过完整 001→026、026 down、026 up
  往返；原子消费函数在迁移时由 PostgreSQL 解析。真实 PostgreSQL + Hono 回归
  验证 draft review 可下载、draft application upload 以统一 404 失败且不消耗
  次数，批准后同一 application-bound grant 才可下载。下载码仅以 SHA-256 摘要
  入库，PDF 实际解析为 1 页且保留姓名/PostgreSQL 文本哨兵，DOCX 为有效 ZIP
  容器，两份成功交付各原子计数一次。
- migration 027 在隔离 PostgreSQL 中通过完整 001→027、027 down、027 up
  往返；迁移前 active token 被回填为只含 64 字符 SHA-256 digest 的 baseline。
  真实 store 调用验证旧 `approved + active token` 不会被重复 publish，原 URL
  可原子转移到另一已批准 artifact，随后可撤销并另行发布新链接；历史依次保留
  baseline / updated / revoked / published。跨 owner résumé、跨 graph 事件、
  未声明 writer 的 token 变更及 event update 均被数据库拒绝。隔离库已删除。
- migration 028 在隔离 PostgreSQL 中通过完整 001→028、028 down、028 up
  往返。真实 store 回归验证：缺失、随机、过期和其他 owner 的票据都不能把 MCP
  browser-confirmed 状态推进到 submitted；正确票据在同一事务中消费并追加事件，
  同票据重试不重复写事件，直接修改已消费票据被拒绝。重签会同时废止过期票据和
  仍未使用的上一张票据；数据库只持久化 URL 与确认短语摘要，
  `server_side_submission=false` 保持不变。手工 user-reported submit 不需要伪装
  成浏览器授权路径。直接删除票据被拒绝，但删除 owner 仍可完整级联清理
  application、compilation 和票据；隔离数据库已删除。
- 真实 Hono public route 在稳定 token 更新前后分别返回 version 1 / version 2，
  URL 未变化；撤销后同一路径返回 404，两份 immutable artifact 均保留。原生
  Codex CLI 0.146.0 使用 ChatGPT 登录态在 ephemeral read-only 会话中只调用
  publication history inventory，确认 1 个 active publication、完整 published
  事件且结果不含 token digest；隔离数据库和本地服务均已清理。
- 同一交付页经连接的真实 Chrome 执行表单：POST 代码后 303 到路径限定 cookie
  GET，Chrome 将唯一命名的合成 PDF 保存到本机 Downloads。离线复核文件为
  99,487 bytes、1 页，姓名与“without a job submission”哨兵完整；未打开招聘
  站、未上传或提交。合成文件随后移入废纸篓，隔离数据库和测试服务已清理。
- 原生 Codex CLI 0.146.0 使用 ChatGPT 登录态和真实 STDIO MCP，在 read-only
  sandbox 中签发 `compilation_review` grant；数据库保持 draft、无 application
  绑定。Chrome 下载所得 PDF 为 100,841 bytes、1 页，姓名和“without
  submission”哨兵完整；一次真实保存触发两个有界 GET，后续 HEAD 探测不再消耗
  次数。文件 chooser 已到达本地合成表单，但当前扩展因未启用本地文件访问而对
  `setFiles` 返回 `Not allowed`；表单未提交，skill/MCP 现明确要求停止并提示权限
  或用户手工上传。随机下载码日志已销毁，隔离库与本地服务已清理。
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
- 跨会话 inventory 在独立的 001→026 PostgreSQL 数据库中创建两个 compilation
  版本和一份进入 interview 的 application：graph/status 过滤、limit/offset
  分页、publication URL 恢复、application→compilation 关联、三条历史事件及最新
  recruiter-message 事件均通过；另一 owner 查询为空，结果不含 résumé 正文、
  form answers、publish token、下载码或 artifact capability。MCP/工具回归
  21/21 通过。随后本机 ChatGPT 登录态的 Codex CLI 0.146.0 在 ephemeral、
  read-only 新会话中只调用两个 inventory 工具，独立确认 2 个 draft/published
  版本、1 个 interview application、最新 recruiter-message 事件以及
  `server_side_submission=false`。另一次真实 PG 映射回归确认无 job 的长 JD
  preview 严格截为 240 字符且不会导致后续列错位；所有隔离数据库均已删除。
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
- 2026-08-01 新增 renderer profile v2：A4、固定 12/14 mm 边距、单/双页独立
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
  Unicode OOXML numbering。API 运行时不内置 Office renderer，DOCX 页数不会
  被伪造，API 和 skill 均要求用真实 Office renderer 打开后再批准交付格式。
- LibreOffice 校准使用每次转换独立的用户 profile、HOME 与临时目录，避免并发
  请求共享锁或机器级配置。CI 强制把四份 DOCX 重新渲染为 PDF，验证实际页数分别
  为 1/2/1/2，并从每份首部、中部和末部提取文本哨兵；校准产物保留 Office PDF，
  供全页 PNG 视觉审阅。LibreOffice 不进入生产镜像，运行时 DOCX 审计继续返回
  `pageCount=null`，不把 CI 渲染器的结论冒充用户本机 Word/Pages 的页数。
  本地 QA 使用 Linux arm64 上的 LibreOffice 25.2.3.2 逐页审阅全部 6 页，并据此
  修复了 Pandoc 版本间列表缩进差异、中文双页溢出和跨页孤立职位标题；另在
  Ubuntu 24.04 amd64 / LibreOffice 24.2.7.2 上复核四案例仍为 1/2/1/2 页。
- 生产 `deploy/Dockerfile.api` 已从 Alpine 切换到 Playwright 支持的 Debian Bun
  镜像，并固定安装 Pandoc、Chromium headless shell、Latin/CJK 字体；同一四案例
  校准脚本已在最终 Linux 容器内通过。API CI 现在安装相同渲染器后运行测试，
  不再因缺少 Chromium/Pandoc 而静默跳过文件回归。根级 `.dockerignore` 同时
  排除 `.env`、Git、本地依赖和校准 scratch，避免把秘密或机器状态发送到构建器。
