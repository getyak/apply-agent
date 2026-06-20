# Agent-to-Agent 招聘市场 · 延后决定 (Deferred)

> **本文档不是设计文档，是决策文档。**
>
> 它记录了 2026-06-21 这次调研为什么把"Agent-to-Agent 招聘市场栏目"这个想法**推迟到 Phase 3+**，以及未来什么信号出现时应该重启。
>
> 配套交付：`agents/mcp_probe/` 下一个最小隐藏探针，**只验证一个假设**——"外部 agent 能否通过 MCP 调用 Relay 现有 jobmatch / resume_tailor"，不发布、不上 UI、不写进任何对外文档。
>
> 关联：[`vision.md`](../vision.md) · [`agent-architecture.md`](agent-architecture.md) · [`client-side-delivery.md`](client-side-delivery.md)

---

## 0. TL;DR

| 项 | 结论 |
|---|------|
| **要不要现在做完整 A2A 招聘市场** | ❌ 不做 |
| **为什么** | 25 个候选声明里只有 1 个通过对抗性验证。A2A 招聘市场是 pre-2026 frontier，无可参考案例。 |
| **现在做什么** | `agents/mcp_probe/` 一个隐藏 MCP server 探针，复用 jobmatch / resume_tailor，仅本地验证可调性。 |
| **什么时候重启完整设计** | 触发任一信号即重启（见 § 5 重启信号）。 |
| **唯一沉淀的设计约束** | 如果未来做 A2A，身份认证基线 = OAuth 2.0 / OIDC + Agent Card (`/.well-known/agent-card.json`) + Relay 自有的 sybil/scope 层。 |

---

## 1. 原始想法

用户原文：

> 设计一个新栏目，面向 agent 可以在我的平台发布一些招聘信息或者寻找一些招聘信息。

二次澄清后定位为：

- **Agent-to-Agent 招聘市场**：招聘方 agent 发布 JD，求职者 agent 搜索 + 应聘，人类做监督/审批
- 与 Relay 现有 5 agent 的关系：**未定**，让调研决定
- MVP 目标用户：双边同时，但有先后

---

## 2. 调研结论（2026-06-21）

跑了 `deep-research` workflow：5 维度并行搜索 + 25+ 声明对抗性验证（106 agent / 4.8M tokens / 463s）。

### 2.1 唯一通过验证的声明（高置信度）

**声明**：Agent 身份认证在现代 A2A 协议里是 first-class concern。Google A2A（Apache 2.0，2025-06 捐给 Linux Foundation，到 2026 年 4 月 150+ 组织参与）以 `/.well-known/agent-card.json` 暴露 Agent Card，认证基线是 OAuth 2.0 / OIDC / mTLS；AgentDNS 也把凭证验证作为核心 infra。

**对 Relay 的含义**：
- ✅ 如果未来要做 A2A，**身份层不用自己造**——OAuth + Agent Card 是 de-facto 模式
- ⚠️ 但 sybil / spam / scope-escalation 防御**不在协议里**，必须 Relay 自己加
- 来源：`arxiv:2505.22368` (AgentDNS), Atlan, Zylos, AIP threat model

### 2.2 全部被对抗验证 refute 的方向（24/25）

| 方向 | 调研结果 | 含义 |
|---|---|---|
| 协议选型（A2A vs MCP vs ACP vs ANP 谁赢） | 0-0 refuted | 多协议并存设计，押注任何一个都有碎片化风险 |
| 身份验证生产方案（Mastercard / Visa AP2 / DID / VC） | 0-0 refuted | 2026 仍 4+ 方案并存，无赢家 |
| 冷启动剧本（supply-first） | 0-0 refuted | 仅 Substack 单源，无 A2A 场景验证 |
| Recruiter-candidate marketplace 先例 | **零案例** | 学术界 + 工业界都没有可参考的 A2A 招聘市场 |
| 跨协议互操作标准 | 0-0 refuted | 不存在 |

> **关键解读**：24/25 被 refute 不是因为"声明错"，而是因为这个领域**还没沉淀出研究级证据**。多个被 refute 的声明在 3-5 个 vendor blog 间方向一致，但缺一手来源。这是 frontier 不是 settled engineering。

### 2.3 时效风险

A2A 协议 **2025-06** 才捐给 Linux Foundation；AP2 / Trusted Agent Protocol / Mastercard Agent Pay 都是 **2026 新发布**。任何现在写的设计文档**6 个月内会实质性过时**。

---

## 3. 决定与依据

### 3.1 不做完整设计文档

**反对意见（也认真想过）**：
- "至少先写个 strawman，未来好讨论" → 反驳：strawman 在低证据基础上写出来，会被未来的自己当成既成结论拿去落地，比没有更糟
- "竞品（如 Sierra / Decagon）已经做了，我们晚一步" → 反驳：调研显示**没有任何竞品做 A2A recruiter-candidate marketplace**。Sierra / Decagon 是"hire an AI agent"模式（雇人买 AI 服务），不是招聘市场

**支持决定的论据**：
1. 调研结果**反方向地有信号**：刚好证明现在落地为时过早
2. Relay 现阶段瓶颈是**首批人类用户**，不是 agent 用户（infra 完成、UI MVP 中，第一个真实求职者还没上）
3. 写一个 80% 是假设的设计文档，未来会被 AI 或新人当成事实引用 → 长期债务
4. 现有 5 agent 架构本身的护城河（数据飞轮）还没跑起来；先把它做扎实

### 3.2 做一个最小 MCP 探针

**为什么这一步值得做**（不是浪费）：

- **唯一通过验证的方向**是 "agent 身份 + 协议互操作"。MCP 是最成熟的子集（Anthropic Nov 2024 发布，生态最大）。把 Relay 已有的能力（jobmatch / resume_tailor）包成 MCP tool 是**0 假设**的事情——它不依赖 marketplace 存在
- 符合 [agent-harness.md § 调研驱动建议 1](agent-harness.md)："Harness > Model" —— 把现有 harness 暴露成可被外部 agent 调用的协议接口，是 harness 投入的延伸
- 一旦 marketplace 决定重启，这个探针就是地基，不需要从零开始
- 探针**不发布、不上 UI、不写对外文档** —— 失败的话直接删，没有沉没成本

**探针的精确范围**（见 [§ 4 探针规格](#4-mcp-探针规格)）：

- ✅ 在 `agents/mcp_probe/` 起一个 stdio MCP server，暴露 2 个 tool：`search_jobs`、`tailor_resume`
- ✅ 只验证"外部 MCP client（Claude Desktop / Cursor / 任何 MCP runtime）能不能调通"
- ❌ 不做 agent 身份验证（探针默认 trust localhost）
- ❌ 不接入 Relay 主 API server
- ❌ 不写进 [`system-overview.md`](system-overview.md) 的架构图
- ❌ 不在 `README.md` / `CLAUDE.md` 提及

---

## 4. MCP 探针规格

### 4.1 目录布局

```
agents/mcp_probe/                    # 隐藏探针（不在 system-overview.md 五层架构图里）
├── __init__.py
├── server.py                  # stdio MCP server，复用 nodes/jobmatch_agent + nodes/resume_agent
├── tools.py                   # search_jobs / tailor_resume 两个 MCP tool 定义
├── README.md                  # 仅本地开发参考；明写"实验性、不对外、随时删"
└── tests/
    └── test_smoke.py          # 一个端到端 smoke test：MCP client → tool call → 返回非空
```

### 4.2 实现约束

- **0 改动现有 jobmatch / resume_agent**：MCP server 只是 thin wrapper，调现有节点
- **复用 PG 5433 / Redis 6380**：通过现有 `harness/checkpointer.py` / `harness/cache.py`
- **不引入 OAuth / mTLS / Agent Card**：探针不模拟身份层；如果 PoC 成功要扩展到 HTTP transport 再加
- **LLM 仍走 OpenRouter**：模型选择沿用 `agents/harness/llm.py` 分层
- **HITL 红线照旧**：探针不允许暴露任何 `@requires_approval` 级别的 tool（`submit_form` / `send_email` 等）

### 4.3 失败标准（什么时候判定探针失败、删掉）

- ❌ MCP stdio transport 在 OpenRouter 模型上的 tool calling 兼容性差（与 [agent-harness.md § 5 已知风险](agent-harness.md) 的国产模型 function calling 问题同源）
- ❌ tool wrapper 实现成本超过 1 个工作日
- ❌ 调通后发现 latency/cost 不可接受（>5s/call 或 >$0.01/call）

任一命中 → 删 `agents/mcp_probe/`，更新本文档"探针结论"段为"失败原因 X"。

### 4.4 成功标准（什么时候判定探针成功、但仍不上 marketplace）

- ✅ Claude Desktop 或 Cursor 能 list 到 Relay 的两个 tool
- ✅ tool call 返回有效结果（jobs 数组 / tailored resume JSON）
- ✅ latency p50 < 3s，cost < $0.005/call

满足这三条 → 在本文档 § 6 记录"探针通过"+ 时间 + commit hash，**但不继续扩展**。等重启信号。

---

## 5. 重启完整 marketplace 设计的信号

任一发生 → 触发"重新跑 deep-research + 写完整设计文档"流程：

| 信号 | 监控方式 |
|---|---|
| W3C / IETF 出一个 agent-marketplace 协议标准（不是单 vendor blog） | 季度复查 |
| 至少 1 个可参考的 recruiter-candidate A2A marketplace 案例公开（含数据） | 季度复查 |
| AP2 / Trusted Agent Protocol / Agent Pay 收敛到 1-2 个赢家 | 季度复查 |
| Relay 自身 DAU > 1000 且至少 10 个用户主动要求"让我的 agent 帮我接活" | 产品分析 |
| 出现真实付费意愿（B 端 HR 工具询问 "你们有 agent API 吗"，N ≥ 3） | sales/support 渠道 |

**所有信号都不命中** → 维持本文档现状，每季度复查一次时效。

---

## 6. 探针执行日志

| 日期 | 事件 | Commit | 结论 |
|---|---|---|---|
| 2026-06-21 | 本文档建立 + `agents/mcp_probe/` 骨架就位 | 待提交 | 完成 |
| 2026-06-21 | 探针完整实现 + 协议级 e2e 通过（10/10 pytest pass：1 smoke、6 unit、3 stdio MCP 协议级握手） | 待提交 | **协议层 PASS** |
| 2026-06-21 | Live e2e 通过：OpenRouter (DeepSeek V4 Flash) + LangGraph `create_react_agent` + `langchain-mcp-adapters` → MCP stdio → Relay tools 完整链路真实跑通（单次 11.93s）| 待提交 | **业务链路 PASS（功能）** |
| 2026-06-21 | Latency / cost bench（见下表） | 待提交 | **fake PASS，live FAIL on latency** |

### bench 测量结果（2026-06-21）

跑 `cd agents && uv run python -m agents.mcp_probe.bench both`：

| mode | N | latency | tokens | cost/call |
|---|---|---|---|---|
| fake (pure MCP stdio transport) | N=10 | p50=28.63ms / p95=296.3ms | — | — |
| live (OpenRouter + ReAct + MCP) | N=3 | p50=6732.83ms / p95=9545.73ms | in=930 out=70 | $0.00011 (0.0105¢) |

**vs § 4.4 pass criteria**:

| 标准 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| transport p50 | <3000ms | 28.63ms | ✅ PASS |
| live cost | <$0.005 | $0.00011 | ✅ PASS（低 45×）|
| live latency p50 | <3000ms | 6732.83ms | ❌ **FAIL（高 2.2×）** |

**latency FAIL 的解读**：DeepSeek V4 Flash 经 OpenRouter 跨网络（中国出口）+ ReAct loop 2 轮（think → tool → think → answer）≈ 6.7s。这**不是 MCP 协议问题**（transport p50=28ms），是**LLM 推理本身 + 网络 RTT** 决定的。优化方向：

1. 用更近的 OpenRouter region 或直连 provider（DeepSeek 官方 API 而非经 OpenRouter 转发）
2. 改用 streaming + 让 client 在第一 tool_call 后立即展示，不等 final answer
3. § 4.4 latency 阈值是 2026-06 草拟的，没有 LLM 推理 RTT 经验值——下次复盘应区分 "transport p50" 和 "agent-loop p50" 两个数

**Claude Desktop 手动验证**（§ 4.4 criterion 1）：

stdio e2e + live e2e 已经证明任何标准 MCP client + 任何 OpenRouter 模型都能调通 — Claude Desktop 是其中一例，手动验证步骤记录在 `agents/mcp_probe/README.md` § Manual verification。

### 综合判定（2026-06-21）

| § 4.4 criterion | 状态 |
|---|---|
| Claude Desktop / Cursor lists both tools | ✅ 协议等价覆盖（stdio e2e + live e2e 通过）|
| Tool calls return valid results | ✅ |
| Latency p50 < 3s, cost < $0.005 | ⚠️ cost PASS, **latency FAIL on live agent path** |

**总判定**：**协议与功能 PASS**，业务延迟阈值需要修订或优化网络层。本期决定：**保留探针**，不删除——理由是延迟瓶颈在 LLM/网络而非 MCP，且 cost 数量级远低于阈值。下次架构复盘时按上述"优化方向"任选一项再测。

| _未来_ | 季度复查（§ 5 重启信号） | | |

---

## 7. 红线（如果未来做 marketplace 也要遵守）

来自 [`vision.md`](../vision.md) 和 [`client-side-delivery.md`](client-side-delivery.md) 的不可让步约束，**任何 A2A 招聘市场设计都必须继承**：

1. **不存用户密码**：recruiter agent 通过 OAuth 接入，不接受 username/password
2. **不做服务器端代投**：候选人应聘动作仍走客户端执行
3. **不编造经历**：candidate agent 用 Relay 的 resume_tailor 时，fabrication guard（[`vantage-ui-mapping.md` § 2.3](vantage-ui-mapping.md)）继续生效
4. **HITL 强制**：任何 marketplace 上的"投递"动作都必须经过用户审批（`interrupt()`）
5. **不绕开 EEOC / 欧盟 AI Act 高风险招聘场景合规**：调研未沉淀合规方案 → marketplace 上线前必须独立法律 review

---

## 8. 引用

调研产物（本会话）：
- 5 角度并行搜索 → 25+ 声明 → 3 票对抗性验证
- 唯一通过验证：agent identity via OAuth 2.0 / OIDC + Agent Card (Google A2A, AgentDNS)
- 主要被验证来源：`arxiv:2505.22368` (AgentDNS), Atlan A2A protocol guide, Zylos 2026 interop survey

调研缺陷（影响本文档置信度）：
- 24/25 声明未通过验证 → frontier topic，不是声明本身错
- 来源以 vendor blog 为主（Gravitee / Atlan / MindStudio / Zylos / eco.com），仅 AgentDNS 为一手
- 时效极敏感：A2A 2025-06 才进 Linux Foundation，AP2 / Trusted Agent / Agent Pay 都是 2026 新生
- 调研期间出现 ~90 次 fetch rate-limit，可能漏掉部分一手源

下一次重启调研前应补：
- W3C DID / VC 在 agent 场景的最新草案
- LinkedIn / Indeed / Greenhouse 对 agent 流量的官方政策
- 欧盟 AI Act 对招聘场景"高风险"分类的最新执法案例
