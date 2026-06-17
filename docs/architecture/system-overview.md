# 系统总架构 · System Overview

> 可交互版本见 [`assets/architecture-diagrams.html`](../assets/architecture-diagrams.html)。

## 五层架构

```
┌─────────────────────────────────────────────────────────┐
│  UI LAYER                                                │
│  Next.js Web · 浏览器扩展 · (未来 Mobile / CLI)           │
├─────────────────────────────────────────────────────────┤
│  API + ORCHESTRATION LAYER                               │
│  API Gateway · Agent Coordinator · Event Bus · Cache     │
├─────────────────────────────────────────────────────────┤
│  AGENT LAYER (5 个核心 agent)                             │
│  Resume · JobMatch · Interview · AppPrep · Trend         │
├─────────────────────────────────────────────────────────┤
│  SHARED SERVICES                                         │
│  Auth · Notification · Audit · LLM Router · Workers      │
├─────────────────────────────────────────────────────────┤
│  DATA + EXTERNAL                                         │
│  PostgreSQL · Redis · DuckDB · OpenRouter API · Job Boards│
└─────────────────────────────────────────────────────────┘
```

## 各层职责

### UI Layer
- **Next.js Web 控制台**:简历管理、投递追踪、面试准备、趋势
- **浏览器扩展(Manifest V3)**:在职位页面本地填表(见客户端投递方案)
- 未来:移动端查看、CLI/API

### API + Orchestration Layer
- **API Gateway**:认证、限流、路由
- **Agent Coordinator**:编排多 agent、saga 事务、重试
- **Event Bus**(Redis Streams / Bull):事件驱动解耦
- **Cache Layer**(Redis):3 层缓存策略

### Agent Layer
5 个单一职责的 agent,详见 [Agent 架构](agent-architecture.md):

| Agent | 职责 | 主用模型 (via OpenRouter) |
|-------|------|--------------------------|
| ResumeAgent | 解析/优化/定制/分析简历 | GLM-4.7(优化/定制) + V4 Flash(解析) |
| JobMatchAgent | 抓取/解析/匹配/通知职位 | V4 Flash + Embeddings |
| InterviewAgent | 生成问题/评估/采集面试 | V4 Pro(深度评估) + GLM-4.7(生成) |
| AppPrepAgent | 求职信/表单/投递包 | GLM-4.7 + 浏览器扩展 |
| TrendAgent | ETL/技能提取/趋势/报告 | V4 Flash + DuckDB |

### Shared Services
- **Auth**(Supabase Auth):JWT、session
- **Notification**:邮件、推送
- **Audit Logger**:记录每次 agent 调用(成本、延迟、trace)
- **LLM Router**:模型选择、fallback、成本闸门
- **Worker Pool**(Bull):cron、批处理、重试

### Data + External
- **PostgreSQL**(Supabase):用户、简历、投递、面试主数据
- **Redis**:缓存、session、队列、限流
- **DuckDB**:分析型查询(趋势、技能时序)
- **OpenRouter API**:DeepSeek V4 Pro / GLM-4.7 / V4 Flash,function calling
- **Job Boards**:Greenhouse / Lever / Ashby public API

## 核心数据流

```
上传简历 → ResumeAgent.parse → 存 PostgreSQL
              ↓
[每日 cron] JobMatchAgent 抓取 → 解析 → 匹配用户 → 通知
              ↓
[用户点准备] AppPrepAgent → 定制简历 + 求职信 + 表单答案
              ↓
[用户审核] → 扩展在本地填表 → 用户亲自 submit
              ↓
[投递后] 自动进追踪 → 有面试 → InterviewAgent 生成准备
              ↓
[每日 cron] TrendAgent 聚合 → 个性化技能缺口 → 邮件简报
              ↓
            数据飞轮:全程沉淀为个人职业上下文
```

## 部署形态

- **MVP**:单体部署。Next.js on Vercel,后端单实例 on Railway/Fly,Supabase + Redis。
- **扩展时**:水平扩展后端 + worker 池,DB 读副本,详见 [路线图](../roadmap.md)。

## 设计原则

1. **关注点分离** — 每个 agent 单一职责,通过共享状态(DB)+ 事件通信,而非直接调用。
2. **可组合** — agent 可互相调用形成复杂 workflow;prompt 独立演化。
3. **可观测** — 每次调用都 logged + traced。
4. **成本与性能意识** — 每次 LLM 调用都有预算和监控;缓存是一等公民。
5. **优雅降级** — LLM 故障显示缓存结果;job board 限流则排队重试;成本飙升则降级模型(V4 Pro → V3.2 → V4 Flash)。
