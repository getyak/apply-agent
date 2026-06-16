<div align="center">

# Relay

**一个简历全生命周期的 AI 求职副驾 · An open, client-side AI job-search copilot**

_发现职位 → 定制简历 → 一键投递 → 面试准备 → 追踪沉淀_

[![License: MIT](https://img.shields.io/badge/License-MIT-3a3fd6.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-read-0b9d7e.svg)](docs/README.md)
[![Status](https://img.shields.io/badge/status-design--spec-e8a317.svg)](docs/roadmap.md)

</div>

> **Relay 是项目代号(placeholder)。** Fork 后可替换为你自己的品牌名。

---

## 这是什么

Relay 是一个**开源的求职 agent 系统设计**,目标是把求职这件繁琐、焦虑、重复的事,压缩成几次轻量的点击。它不是又一个"批量轰炸投递"的工具——那条路市场已经证明走不通(转化率持续下滑、雇主反感、账号被封)。

Relay 的赌注是另一条路:

- **质量优先,而非数量优先。** 少投、投准、投好。
- **客户端执行,零封号风险。** 投递发生在用户自己的浏览器、自己的登录态、自己的 IP 下,平台无法区分"人工"还是"AI 辅助"。
- **数据飞轮是护城河,而非自动化本身。** 你的简历版本、投递历史、面试问答会随使用不断积累,越用越懂你——这是自动化脚本无法复制的资产。
- **AI 先做,用户后审。** 把高认知负担的"创造"任务,变成低负担的"审核"任务。

这个仓库目前是**完整的产品 + 架构 + 设计规格(design spec)**,可作为自建实现的蓝图,也欢迎贡献成可运行的参考实现。

---

## 为什么是现在

求职市场正在经历一场 "AI 投递潮 vs 雇主反制" 的军备竞赛:

- 通过 LinkedIn 提交的申请激增,平台一度记录到每分钟上万份申请;
- 招聘方上线了重复申请标记、更多现场面试来甄别真人;
- 数据显示**体量腐蚀质量**:投 11–20 份的面试转化率,是投 100+ 份的三倍多。

结论很清晰:**autofill 已是红海(Simplify/Jobright 免费且用户众多),真正服务不足的是"面试情报采集"和"可积累的个人职业上下文层"。** Relay 把切入点放在后者。

详见 [市场分析](docs/market-analysis.md)。

---

## 核心特性

| 能力 | 说明 | 状态 |
|------|------|------|
| 📄 简历管理 | 上传即解析为结构化 JSON Resume,版本控制 + diff | spec |
| ✨ AI 优化 | 针对行业/JD 优化简历,诚实重述而非编造 | spec |
| 🎯 JD 定制 | 一个 JD → 一份量身简历 + cover letter + 表单答案 | spec |
| 🤖 客户端投递 | 浏览器扩展在用户本地填表,用户亲自提交 | spec |
| 🎤 面试准备 | 基于 JD 生成问题、评估回答、采集真实面试题 | spec |
| 📈 市场趋势 | 每日聚合在招职位,个性化技能缺口分析 | spec |
| 🔁 数据飞轮 | 投递/面试/反馈持续沉淀为个人职业上下文 | spec |

---

## 文档导航

完整文档在 [`docs/`](docs/README.md)。建议阅读顺序:

1. **[产品愿景与原则](docs/vision.md)** — Relay 相信什么、不做什么
2. **[市场分析](docs/market-analysis.md)** — 竞争格局、机会、为什么不做批量投递
3. **[产品规格](docs/product-spec.md)** — 6 大功能的详细定义
4. **架构**
   - [系统总架构](docs/architecture/system-overview.md)
   - [Agent 架构](docs/architecture/agent-architecture.md)
   - [Agent Harness](docs/architecture/agent-harness.md)
   - [客户端投递方案](docs/architecture/client-side-delivery.md) ⭐ 核心
5. **设计**
   - [设计哲学](docs/design/design-philosophy.md) — 把"创造"变成"审核"
   - [设计系统](docs/design/design-system.md) — tokens、色彩、组件
   - [UX 流程](docs/design/ux-flows.md)
6. **[数据模型](docs/data-model.md)**
7. **[隐私与安全](docs/privacy-security.md)**
8. **[路线图](docs/roadmap.md)**

可交互的架构图与 UI 原型见 [`docs/assets/`](docs/assets/)(用浏览器打开 HTML 文件)。

---

## 架构一览

```
┌─────────── 用户的浏览器(本地) ───────────┐     ┌──── 你的云端后端 ────┐
│                                          │     │                      │
│  浏览器扩展 (Manifest V3)                 │     │  Web 账户系统         │
│  ├── content script  扫描+填充表单        │     │  ├── 简历/版本/投递    │
│  ├── service worker  协调 + profile      │◄───►│  ├── 面试/趋势/飞轮    │
│  └── popup           审核 UI             │     │  └── LLM API 端点      │
│                                          │     │      map-fields       │
│  ✓ 真实指纹 ✓ 真实登录 ✓ 真实 IP          │     │      answer-question  │
│  ✓ 用户亲自点 submit → 零封号             │     │      tailor-resume    │
└──────────────────────────────────────────┘     └──────────────────────┘
       智能在云端  ·  执行在本地  ·  提交靠用户
```

详见 [客户端投递方案](docs/architecture/client-side-delivery.md)。

---

## 设计原则速览

- **0 配置启动** — 上传简历即用,不填表单
- **3 次点击投递** — 从看到职位到完成提交
- **AI 先做,用户后审** — 永不让用户面对空白
- **一屏一焦点** — 每屏一个主操作,消除决策疲劳
- **颜色即语言** — 珊瑚橙 = AI 生成需过目,靛蓝 = 你的主操作,薄荷绿 = 安全/成功
- **零封号** — 本地执行,用户亲自提交

---

## 状态与贡献

Relay 目前处于 **设计规格阶段(design spec)**。仓库提供完整的产品/架构/设计蓝图,参考实现正在规划中。

欢迎以下形式参与:

- 💬 对设计与架构提出意见(开 issue)
- 🧩 认领某个模块的参考实现
- 📝 改进文档、补充 ATS 适配清单
- 🎨 贡献设计与原型

请先读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)。

---

## 重要声明

- Relay **不鼓励**任何违反平台服务条款的大规模自动投递。客户端方案的设计前提是**用户亲自提交、人性化操作**。
- 对 LinkedIn / Boss直聘 等平台的登录态自动化存在账号风险,Relay 默认**不实现**此类功能;若实现,必须明确告知风险并由用户显式 opt-in。
- 本仓库不提供法律建议。平台条款与 AI 招聘相关法规(如 GDPR、PIPL、CA AB 853)仍在演进,请自行评估合规性。

---

## License

[MIT](LICENSE) © Relay contributors
