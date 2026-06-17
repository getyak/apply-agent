# 路线图 · Roadmap

> 分阶段从设计规格走向可运行产品。状态标记:`spec`(已设计)/ `wip`(进行中)/ `done`。

## Phase 0 · 设计规格 `done`

完整的产品 / 架构 / 设计蓝图(即本仓库)。

- [x] 市场分析与定位
- [x] 产品规格(6 大功能)
- [x] 系统 / agent / harness 架构
- [x] 客户端投递方案
- [x] 设计哲学 / 系统 / UX 流程
- [x] 数据模型 / 隐私安全

## Phase 1 · MVP `spec`(目标 8–12 周)

核心闭环:简历管理 + AI 优化 + 定制 + 面试模拟 + 客户端投递 + 基础趋势。

| 周 | 模块 | 交付 |
|----|------|------|
| 1–2 | 基础架构 | Supabase + Next.js + auth + 简历数据模型 |
| 3 | 简历管理 | 上传解析 + 编辑 + 版本控制 |
| 4 | AI 优化 | OpenRouter LLM 集成(GLM-4.7) + 优化 flow + diff |
| 5 | JD 定制 | JD 输入 + 定制简历 + 预览 |
| 6–7 | 面试模拟 | 问题生成 + 评估 + 会话保存 |
| 8 | 浏览器扩展(方案 A) | 检测 + 本地填充 + 审核 UI |
| 9 | 扩展 + 云 LLM(方案 B) | 智能字段映射 + 开放题生成 |
| 10 | 趋势分析 | 每日 ETL + 技能提取 + 邮件简报 |
| 11–12 | QA + Polish | 端到端测试 + 上架准备 |

**成功指标**:100+ 活跃用户贡献 ≥3 条面试记录(验证数据飞轮);付费转化 ≥3–5%;自报面试率高于批量投递基准。

## Phase 2 · Growth `spec`(目标 6–12 月)

| 方向 | 内容 |
|------|------|
| 扩展能力 | 更多 ATS 适配,字段映射规则库 |
| 面试题库 | 聚合众包面试题(网络效应启动) |
| 数据产品 | 向训练营 / 教练出售面试数据集(B2B2C) |
| Premium tier | $39/月:优先投递 + AI 面试教练 |
| 基础设施 | 后端水平扩展,DB 读副本,70% 缓存命中 |

## Phase 3 · Scale `spec`(目标 12–18 月)

| 方向 | 内容 |
|------|------|
| 桌面 App(方案 C) | browser-use/Stagehand + CDP 连接真实浏览器,批量/定时(power user,严格 opt-in) |
| 多 provider LLM | OpenRouter 已接入(DeepSeek/GLM) + Gemini + 本地 Ollama |
| Polyglot 存储 | PostgreSQL + ClickHouse + ElasticSearch + pgvector |
| ML 能力 | 面试表现预测、简历质量打分、推荐引擎 |
| 新功能 | 薪资谈判助手、公司文化匹配、真人教练 marketplace |

## 模块认领

参考实现按模块拆分,欢迎认领(见 [CONTRIBUTING](../CONTRIBUTING.md)):

- `extension/` — 浏览器扩展(Manifest V3)
- `backend/` — Web 账户 + LLM API + DB
- `agents/` — 各 agent 实现
- `web/` — Web 控制台

## 技术栈(参考)

```
Frontend:  Next.js 15 + Shadcn/ui + TailwindCSS
Extension: Manifest V3 + TypeScript
API:       TypeScript (Hono/Bun)
Agents:    Python (FastAPI + LangGraph)
DB:        PostgreSQL (pgvector) + Redis + DuckDB + MinIO
LLM:       OpenRouter (DeepSeek V4 Pro / GLM-4.7 / V4 Flash)
Browser:   browser-use (CDP, 服务端) + Playwright MCP (客户端)
Deploy:    Vercel + Railway/Fly + GitHub Actions
```

## 北极星指标

- 用户从"看到职位"到"投递完成" ≤ 3 次点击
- 用户持续记录面试问答(数据飞轮转动)
- 用户面试转化率显著高于批量投递基准
- **零**用户因使用 Relay 被平台封号
