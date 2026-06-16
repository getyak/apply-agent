# 贡献指南 · Contributing to Relay

感谢你对 Relay 的兴趣。这个项目目前处于**设计规格阶段**,最有价值的贡献是对产品方向、架构决策和设计的思考,以及认领模块做参考实现。

## 你可以怎么参与

### 1. 讨论设计与架构
- 对任何文档有不同意见?开一个 issue,标 `discussion`。
- 我们尤其欢迎对**客户端投递方案**、**数据飞轮**、**面试情报采集**这些核心赌注的挑战。

### 2. 认领参考实现
按模块拆分,每块都可独立实现:
- `extension/` — 浏览器扩展(Manifest V3),表单检测 + 填充
- `backend/` — Web 账户 + LLM API 端点 + 数据库
- `agents/` — 各 agent 的实现(resume / match / interview / trend)
- `web/` — Web 控制台(简历管理 / 投递追踪 / 趋势)

在对应 issue 下评论认领,避免重复劳动。

### 3. 补充 ATS 适配清单
不同 ATS(Greenhouse / Lever / Ashby / Workday / iCIMS ...)的表单结构各异。维护一份**字段映射规则库**是高价值的社区工作。见 `docs/architecture/client-side-delivery.md`。

### 4. 改进文档与设计
- 文档的清晰度、准确性、补充案例
- 设计原型、组件、可访问性改进

## 开发约定(参考实现阶段)

- **Commits**:遵循 [Conventional Commits](https://www.conventionalcommits.org/)(`feat:` `fix:` `docs:` `refactor:` ...)
- **分支**:`feat/xxx` `fix/xxx` `docs/xxx`,从 `main` 切出
- **PR**:小而聚焦,描述清楚动机;关联对应 issue
- **代码风格**:TypeScript 优先,遵循仓库内 linter 配置

## 核心价值红线

贡献必须符合 Relay 的核心原则,以下内容**不会被接受**:

- ❌ 大规模批量自动投递(无用户审核的 spray-and-pray)
- ❌ 绕过平台反爬/风控、模拟绕过 CAPTCHA
- ❌ 对 LinkedIn / Boss直聘 等的登录态自动投递(除非有明确风险告知 + 用户显式 opt-in 的设计)
- ❌ 在用户不知情下采集或外传个人数据
- ❌ 编造简历内容(AI 只能诚实重述,不能虚构经历)

## 行为准则

参与即同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## License

提交贡献即表示你同意以 [MIT License](LICENSE) 授权你的贡献。
