# 客户端投递方案 · Client-Side Delivery ⭐

> 这是 Relay 的核心架构决策。可交互版本见 [`assets/client-side-browser-application-architecture.html`](../assets/client-side-browser-application-architecture.html)。

## 核心洞察:客户端执行 = 零封号

服务器端代投有个根本缺陷——它从**陌生 IP、陌生浏览器指纹、陌生 session** 操作用户账户,这正是最容易被封号的模式,还需要存储用户密码。

客户端方案完全相反。投递发生在**用户自己的浏览器、登录态、IP** 下,用户亲自点 submit。平台无法区分"人工"还是"AI 辅助",因为所有信号都是真实的。

| 维度 | 服务器 Sandbox | 客户端方案 |
|------|---------------|-----------|
| IP | 陌生服务器 IP | 用户真实 IP |
| 浏览器指纹 | 陌生 | 用户真实 |
| 登录态 | 需存用户密码 ⚠️ | 用户已登录 session |
| 提交者 | 机器人 | 用户亲自 |
| 封号风险 | **高** | **极低** |

> 这也是市面成功产品(Simplify、Jobright、SpeedyApply)的共同选择,它们的核心安全卖点正是"用户自己点 Apply,零 bot 封号风险"。

---

## 三种实现方案

### 方案 A:浏览器扩展(Manifest V3)— 推荐起点

最主流、最实际。Simplify/Jobright 同款。

```
用户的浏览器
├── content script (content.js)   注入职位页,读写 DOM 表单
│   ① detectFormFields()  扫描 input/select/textarea
│   ② mapFieldsToProfile() label → profile key 匹配
│   ③ fillFields()        人性化时序填充
├── service worker (background.js) 后台协调,管理 profile,消息路由
├── popup (popup.html)            审核 UI,展示填充预览
└── chrome.storage.local          用户 profile(密码绝不存)
```

- 实现成本:低(~2–3 周 MVP),Chrome Web Store 一键安装
- 局限:纯规则匹配,陌生表单/开放题易失灵

### 方案 B:扩展 + 云端 LLM 混合 — 差异化护城河 ⭐

在 A 基础上,把搞不定的字段交给云端 LLM。**这是 Relay vs 纯 autofill 工具的根本差异。**

```
① 扩展检测所有字段(本地,无 LLM)
② 简单字段 (~70%)   本地规则填充           $0
③ 复杂/陌生字段(~25%) → 云端 LLM map-fields  Haiku ~$0.001/job
④ 开放题 (~5%)      → 云端 LLM answer-q      Sonnet ~$0.002/job
⑤ 用户审核(AI 项高亮)→ 亲自 submit
```

**云端 API 端点**:
```
POST /api/map-fields    in: 未知字段 + profile → out: 字段→值映射
POST /api/answer-q      in: 开放题 + JD + 简历 → out: 个性化答案草稿
POST /api/tailor-resume in: base 简历 + JD     → out: 定制简历
```

**成本模型**:每次投递总 LLM 成本 ~$0.003,100 投递/月 = $0.30/用户,订阅 $15 毛利 ~98%。可选 BYO key 让成本归零。

### 方案 C:桌面 App + CDP — 最强但最重(Phase 3)

桌面 app(Tauri/Electron)通过 Chrome DevTools Protocol 连接用户**已登录的真实 Chrome**,用 browser-use / Stagehand 做多步自主导航。

- 能力最强:跨页自主导航 + 批量 + 定时;可用本地 Ollama 模型零成本
- 代价:需下载安装(信任门槛高)、跨平台维护重、批量投递仍有账号风险
- 建议:仅给 power user,明确 opt-in,速度人性化,submit 必须确认

---

## 推荐路径

```
Phase 1 (2-3周):  扩展 autofill (方案 A) — 验证价值,快速上架
Phase 2 (4-6周):  + 云端 LLM (方案 B) — 护城河,主战场
                  + 面试准备 + 趋势 + 数据飞轮
Phase 3 (可选):   桌面 app (方案 C) — power user,批量定时
```

## 隐私模型

- 敏感数据可全留本地(`chrome.storage.local`)
- 只有需要 LLM 时才上传必要内容(JD + 字段,不含密码)
- 符合 GDPR / PIPL 数据最小化原则
- "数据留在设备上"本身是卖点

## ATS 检测 → 策略选择

```
检测 ATS 类型(URL pattern + HTML 签名 + 字段数 + captcha 检测)
├── Greenhouse/Lever/Ashby → 优先用 Partner API
├── Workday/iCIMS          → Playwright/扩展 selector 填充
├── 未知 ATS               → LLM 视觉映射(方案 B/C)
└── 仅 email               → 生成 email 草稿,用户手动发

自动升级:规则填充失败 → 重试 LLM 映射 → 失败则给手动 checklist
```

## 战略提醒

方案 A(纯 autofill)已被 Simplify/Jobright 占据且免费。**不要只做 autofill。** Relay 的切入点必须是方案 B 那一层——LLM 智能映射 + 开放题生成 + 完整 journey。autofill 只是入口,真正留住用户的是后面的面试准备、趋势、数据飞轮。
