# Relay 文档 · Documentation

求职 agent 系统的完整产品、架构与设计规格。

## 目录

### 产品 · Product
- [**产品愿景与原则**](vision.md) — 我们相信什么、不做什么
- [**市场分析**](market-analysis.md) — 竞争格局、机会、为什么不做批量投递
- [**产品规格**](product-spec.md) — 6 大功能的详细定义与优先级

### 架构 · Architecture
- [**系统总架构**](architecture/system-overview.md) — 五层架构总览
- [**Agent 架构**](architecture/agent-architecture.md) — 5 个核心 agent 与编排
- [**Agent Harness**](architecture/agent-harness.md) — 单 agent 执行框架(ReAct loop)
- [**客户端投递方案**](architecture/client-side-delivery.md) ⭐ — 浏览器原生投递,零封号

### 设计 · Design
- [**设计哲学**](design/design-philosophy.md) — 把"创造"变成"审核"
- [**设计系统**](design/design-system.md) — tokens、色彩、字体、组件
- [**UX 流程**](design/ux-flows.md) — 5 屏核心闭环

### 工程 · Engineering
- [**数据模型**](data-model.md) — Schema 设计
- [**隐私与安全**](privacy-security.md) — 数据处理、合规、风险边界
- [**路线图**](roadmap.md) — 分阶段实现计划

### 可交互资源 · Interactive Assets
位于 [`assets/`](assets/),用浏览器打开:
- `architecture-diagrams.html` — 系统/agent/数据流/扩展路径图
- `agent-execution-deep-diagrams.html` — ReAct/sandbox/tool/browser 深度图
- `client-side-browser-application-architecture.html` — 客户端三方案对比
- `product-ui-prototype.html` — 可交互 UI 原型(5 屏)

---

## 快速理解 Relay 的三个核心赌注

1. **质量优先 > 数量优先**
   不做批量轰炸。证据:投 11–20 份的面试转化率是投 100+ 份的三倍多;雇主已上线重复申请标记。

2. **客户端执行 = 零封号**
   投递在用户自己的浏览器/登录态/IP 下完成,用户亲自点 submit。平台无法区分人工 vs AI 辅助。

3. **数据飞轮 = 真护城河**
   自动化会被复制,但用户的简历版本 + 投递历史 + 面试问答会持续积累,越用越懂你。这是脚本无法复制的资产。
