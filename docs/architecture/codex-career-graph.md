# Codex × Career Graph 原生集成

> 状态：Career Graph 本地闭环与远程 OAuth 身份已实现；现有简历导入审阅 UI
> 和真实招聘平台回归仍在后续范围内。
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

迁移 `022_career_graph` 新增四类实体：

- `career_graphs`：用户拥有的图谱入口，只指向一个当前已批准 revision。
- `career_graph_revisions`：不可变 node/edge snapshot。
- `career_graph_change_sets`：agent 提出的候选 snapshot；pending 状态不会改变图谱。
- `career_graph_compilations`：固定 graph revision + JD + résumé row +
  selection manifest + guard report。

节点有稳定 ID、类型、事实数据和 provenance；边表达 role → achievement、
achievement → skill 等关系。编译器只选择和排序节点文本，不根据 JD 生成新事实。

`selection_manifest` 把 `work.0.highlights` 等输出路径映射回 graph node ID。
这使“为什么这份 JD 简历出现这条 bullet”可被机器追踪，而不只是一段 LLM
解释。

已关联到 compilation résumé 的 `application_drafts` 会通过 manifest 回流成
evidence outcome report。排序策略有意保守：JD 相关性始终优先；面试和 offer
仅作为同等相关证据的正向次级信号；拒绝不产生负分，free-text outcome 也不会
被静默分类。该报告明确标注相关性不等于因果，且不会修改图谱事实。

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

浏览器交接只返回 package，不暴露 server-side submit tool。Skill 还要求每一份
批量申请在最终点击前单独确认；一次批量授权不会被解释为无限期许可。

用户确定要申请后，`create_application_draft` 会先幂等创建或复用 Relay 本地
`application_drafts` 记录，并把它连接到批准的 compilation résumé。它不会打开
网站或提交表单。后续 handoff 携带同一个 application ID，浏览器扩展在用户真正
提交后即可更新该记录，使结果反馈能回到 selection manifest。

## 6. 当前完成度审计

| 原始要求 | 当前证据 | 状态 |
|---|---|---|
| Career Graph 是底层资产 | migration 022 + `agents/career_graph` | ✅ v1 |
| 针对 JD 现场编译 | `compile_resume` + selection manifest | ✅ v1（选择/排序） |
| 不编造经历 | provenance 必填 + source-only compiler | ✅ 编译路径 |
| 版本追踪 | immutable revisions + optimistic base check | ✅ |
| 现有简历导入 | JSON Resume → upsert-only pending change | ✅ 本地 |
| MCP 暴露给 Codex | STDIO + OAuth Streamable HTTP | ✅ |
| Repo skill 编排 | `manage-career-graph` | ✅ |
| 人工确认闸门 | change / compilation / publish 独立确认 | ✅ |
| Codex 登录 | ChatGPT 登录态 → skill → live MCP → PG 多轮验证 | ✅ Codex 侧 |
| Relay 多用户登录集成 | OAuth subject → owner scope；Web consent | ✅ |
| 简历公开发布 | approved compilation → `/r/<token>` | ✅ |
| 真实浏览器填表 | approved package handoff | ⚠️ 尚未做目标站回归 |
| 申请跟踪连接 | approved compilation → idempotent local draft/compact batch queue → just-in-time handoff | ✅ v1 |
| Boss 直聘批量投递 | 每份必须单独确认，无绕 CAPTCHA | ❌ 尚未实现/验证 |
| 结果反馈驱动下一次编译 | application stage → manifest → evidence tie-break | ✅ v1 |

## 7. 下一段必须完成的工作

1. **导入审阅 UI**：JSON Resume 已能转换成 pending graph change set；仍需在
   Web 中提供 node/edge diff 审批，并接入 PDF/DOCX 解析结果。
2. **编译质量**：在不改变事实的前提下增加版式、长度预算、语言和 ATS profile；
   可把“措辞建议”作为单独 change proposal，不能直接污染 graph。
3. **反馈质量**：v1 已把 compilation résumé 所关联的投递阶段映射为 evidence
   ranking；下一步补 application status history、样本置信区间和跨 JD cohort，
   仍不得自动改写事实或把相关性冒充因果。
4. **浏览器真实验证**：先验证 Greenhouse/Lever/Ashby，再对 Boss 直聘做平台条款
   和账号风险 review；任何登录、验证码或封禁信号都立即交还用户。

在这些证据完成前，不能声称“Codex 已真实跑通 Boss 批量投递全流程”。

## 8. 已验证证据

- migration 022 在临时 PostgreSQL 中完成 up/down 往返，本地基础设施健康检查
  8/8 通过。
- Python 单元与 MCP 协议测试覆盖 proposal 不落地、精确确认、不可变 revision、
  source-only 编译、反馈次级排序、发布确认和浏览器交接边界。
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
- Playwright 真实页面回归只填入 source-only 姓名、邮箱和经历字段；密码与 SSN
  保持空白，Submit 按钮未点击，页面最终仍为 `Not submitted`。这是安全边界
  验证，不等同于 Greenhouse/Lever/Ashby 或 Boss 直聘目标站回归。
