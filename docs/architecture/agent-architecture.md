# Agent 架构 · Agent Architecture

> 可交互版本见 [`assets/architecture-diagrams.html`](../assets/architecture-diagrams.html)(② Agent 架构)。

系统由 5 个单一职责的 agent 组成,通过 **Coordinator 编排** + **共享 DB 状态** + **事件总线**协作。

## 编排模式

```
        ┌──────────────────────┐
        │  Agent Coordinator   │  编排 · Saga · 重试 · Audit
        └──────────┬───────────┘
     ┌──────┬──────┼──────┬───────┐
  Resume  JobMatch Interview AppPrep Trend
     └──────┴──────┼──────┴───────┘
        ┌──────────┴───────────┐
        │  共享数据层 + 事件总线  │
        └──────────────────────┘
```

agent 之间**不直接函数调用**,而是:
1. **共享 DB 状态**(PostgreSQL,用 transaction 保证一致性)
2. **事件驱动**(Redis Streams,某 agent 输出触发下一个)
3. **Coordinator 编排**(用户请求 → 协调多 agent → 聚合结果)

---

## Agent 1:ResumeAgent

**职责**:解析 / 优化 / 定制 / 分析简历,版本控制。

```
POST /api/resumes              解析上传 → JSON Resume
POST /api/resumes/:id/optimize  通用优化(可选 JD 方向)
POST /api/resumes/:id/customize 针对 JD 定制
GET  /api/resumes/:id/analyze   提取技能/指标/缺口
GET  /api/resumes/:id/versions  版本历史
```

- 模型:Sonnet(优化/定制),Haiku(分析/解析)
- 缓存:`resume:tailored:{user}:{job}:{version}`,TTL 7 天
- 被 AppPrepAgent 组合调用

---

## Agent 2:JobMatchAgent

**职责**:抓取职位 → 解析 JD → 匹配用户 → 通知。

```
GET  /api/jobs?filter=...        列表 + 过滤
POST /api/jobs/:id/match-to-user 计算匹配分
GET  /api/jobs/:id/details       完整 JD + 公司情报
```

**匹配评分**(0–1):
- 技能匹配 45%(用户技能 ∩ JD 技能)
- 级别匹配 25%
- 地点匹配 20%
- 薪资匹配 10%

- 数据源:Greenhouse / Lever / Ashby public API
- 每日 cron 增量抓取 → 匹配 → 通知

---

## Agent 3:InterviewAgent ⭐

**职责**:生成面试问题 → 评估回答 → 采集结构化面试数据。

```
POST /api/interviews/session              生成 10 题
POST /api/interviews/session/:id/answer   评估单题回答
GET  /api/interviews/company/:co/role/:r  聚合面试题库
GET  /api/interviews/insights             个人面试洞察
```

- 模型:Opus(深度评估),Sonnet(生成问题)
- **数据飞轮核心**:聚合所有用户的面试问答(opt-in),形成众包题库
- 网络效应:用户越多,题库越丰富,新用户价值越高

---

## Agent 4:AppPrepAgent

**职责**:准备投递包(简历 + 求职信 + 表单答案),半自动提交。

```
POST /api/applications/prepare    生成投递包
POST /api/applications/:id/submit 半自动提交(API/手动/邮件)
GET  /api/applications/user/:id   投递历史
PATCH /api/applications/:id       更新结果(rejected/interview/offer)
```

- 调用 ResumeAgent.customize() 获取定制简历
- 生成求职信(Sonnet)+ 表单答案(Haiku)
- 提交策略:Greenhouse/Lever/Ashby Partner API → 否则手动 checklist
- **永远 review-before-submit**

---

## Agent 5:TrendAgent

**职责**:每日 ETL → 技能提取 → 趋势聚合 → 个性化报告。

```
GET  /api/trends/today          今日快照
GET  /api/trends/skill/:name    单技能趋势
GET  /api/trends/personalized   个人技能缺口
POST /api/trends/generate-report 夜间 cron
```

- 模型:Haiku(技能提取)
- 存储:DuckDB(分析型)
- 每日 02:00 ETL → 08:00 邮件简报
- 个性化:对比用户简历 vs trending 技能 → "学了 X 多匹配 Y 个岗位"

---

## 事件驱动通信示例

```js
// 简历更新触发重新匹配
eventBus.subscribe('resume:updated', async (e) => {
  await jobMatchAgent.recomputeMatches(e.payload.user_id);
});

// 新职位触发用户通知
eventBus.subscribe('job:created', async (e) => {
  const matches = await jobMatchAgent.findMatches(e.payload.job_id);
  for (const m of matches) await notify(m.user_id);
});

// 面试作答触发反馈生成
eventBus.subscribe('interview:answered', async (e) => {
  const fb = await interviewAgent.generateFeedback(e.payload.answer);
  await db.saveFeedback(e.payload.question_id, fb);
});
```

## Agent 可演化性

- **Prompt Registry**:prompt 版本化,支持 A/B 测试,可无代码编辑
- **配置化**:每个 agent 的模型、超时、成本上限、缓存 TTL 可配置
- **可组合**:新功能通过组合现有 agent + 新 prompt 实现
