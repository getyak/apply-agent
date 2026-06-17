# Agent 架构 · Agent Architecture

> 可交互版本见 [`assets/architecture-diagrams.html`](../assets/architecture-diagrams.html)(② Agent 架构)。

系统由 5 个单一职责的 agent 组成,通过 **Coordinator 编排** + **共享 DB 状态** + **事件总线**协作。

## 为什么是 5 个 agent（而不是 1 个、不是 10 个）

> 调研结论（[getmaxim.ai 多 agent 失败模式分析](https://www.getmaxim.ai/articles/multi-agent-system-reliability-failure-patterns-root-causes-and-production-validation-strategies/)，2-1 票确认）：**默认 single-agent，只在并行明显有收益时才拆**。agent 间协调代价是 O(N²)，错误传染、状态分歧、调试难度都随 agent 数量超线性增长。

Relay 拆 5 个 agent 不是为了"并行"，而是为了**职责分离**：

| 拆分理由 | Relay 的体现 |
|---------|-------------|
| 触发方式不同 | ResumeAgent 用户触发；JobMatchAgent/TrendAgent cron；InterviewAgent 半结构化对话 |
| 模型分层不同 | InterviewAgent 用 V4 Pro 深度评估；TrendAgent 用 V4 Flash 大批量 ETL |
| 数据飞轮不同 | InterviewAgent 是众包题库的入口，独立成长 |
| Prompt 演化节奏不同 | 简历定制周改、面试评估月改、趋势报告季改 |

**反例（不拆的场景）**：如果只是同一个用户请求里串两步 LLM 调用（先 parse 再 summarize），那是同一个 agent 的两个 tool，不该拆成两个 agent。

**红线**：未来想加第 6 个 agent 之前，先问：能不能塞进现有 5 个之一？只有当答案是"职责完全错位"才新增。

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

- 模型:GLM-4.7(优化/定制),DeepSeek V4 Flash(分析/解析)
- 框架:LangGraph `create_react_agent` + resume 相关 tools
- 缓存:`resume:tailored:{user}:{job}:{version}`,TTL 7 天
- 被 AppPrepAgent 通过 Coordinator StateGraph 组合调用

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

- 模型:DeepSeek V4 Flash(解析/匹配)
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

- 模型:DeepSeek V4 Pro(深度评估),GLM-4.7(生成问题)
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

- 通过 Coordinator 调用 ResumeAgent.customize() 获取定制简历
- 生成求职信(GLM-4.7)+ 表单答案(DeepSeek V4 Flash)
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

- 模型:DeepSeek V4 Flash(技能提取)
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
