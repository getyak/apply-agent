# 设计系统 · Design System

Relay 的设计 tokens、色彩、字体、组件规范。可直接用于前端实现。

## 色彩 · Color

### 语义色(核心)

| Token | Hex | 语义 |
|-------|-----|------|
| `--signal` | `#3a3fd6` | 主操作 / 链接(深靛蓝) |
| `--ai` | `#ff5c39` | AI 生成内容标记(珊瑚橙)⭐ |
| `--mint` | `#0b9d7e` | 安全 / 成功 / 高匹配 |
| `--amber` | `#e8a317` | 中等匹配 / 提示 |

### 中性色

| Token | Hex | 用途 |
|-------|-----|------|
| `--ink` | `#171826` | 主文字 / 深色元素 |
| `--ink-soft` | `#3a3c52` | 次级文字 |
| `--mist` | `#6b6e85` | 辅助文字 / 占位 |
| `--line` | `#e7e7ee` | 边框 |
| `--line-soft` | `#f0f0f5` | 分隔线 |
| `--paper` | `#f7f7fb` | 页面背景 |
| `--card` | `#ffffff` | 卡片背景 |

### 软色(背景填充)

| Token | Hex | 配对 |
|-------|-----|------|
| `--signal-soft` | `#ececfb` | 配 signal |
| `--ai-soft` | `#fff0ec` | 配 ai(AI 字段背景) |
| `--mint-soft` | `#e4f6f1` | 配 mint(成功提示背景) |

## 字体 · Typography

| 角色 | 字体 | 用途 |
|------|------|------|
| Display | **Space Grotesk** | 标题、按钮、数字、品牌 |
| Body | **Inter** | 正文、表单、说明 |

- Display 字重:500 / 600 / 700
- Body 字重:400 / 450 / 500 / 600
- Display 字间距:`letter-spacing: -.02em`

类型尺度(参考):
```
h1 hero    46px / 600
h1 page    26px / 600
h3 section 12px / 600 / uppercase / letter-spacing .07em
body       14–15px / 400
caption    12–13px / mist
```

## 圆角 · Radius

```
--radius:    18px   卡片、容器
--radius-sm: 12px   按钮、输入框、小卡片
999px              药丸标签、chip
```

## 阴影 · Shadow

```
--shadow:    0 1px 2px rgba(23,24,38,.04), 0 8px 24px rgba(23,24,38,.06)
--shadow-lg: 0 4px 12px rgba(23,24,38,.08), 0 24px 48px rgba(23,24,38,.10)
```

## 核心组件

### 职位卡片(Job Card)
```
[logo] 职位标题              [match%]  [一键投递]
       公司·地点·薪资·ATS
```
- 橙色按钮 = 已备好可投;深色按钮 = 需准备
- hover:轻微上浮 + 边框加深 + shadow

### AI 字段(AI Field)⭐ 签名组件
```
标签 [AI 生成·草稿 chip]
┌─────────────────────────────┐  ← 橙色边框 + ai-soft 背景
│ AI 生成的内容...    [编辑]    │
└─────────────────────────────┘
```
- 边框 `#ffcdbf`,背景 `--ai-soft`
- chip 背景 `--ai`,白字
- 右上角"编辑"链接,`--ai` 色

### 趋势 ribbon
- 深色渐变背景 `linear-gradient(100deg,#1b1c2e,#2a2c45)`
- 左侧脉冲点(珊瑚橙,pulse 动画)
- 上涨数字用 mint 高亮

### 提交栏(Submit Bar)
```
已填 N 个字段 · 其中 M 项由 AI 生成,建议先看一眼    [保存草稿] [审核无误,投递 →]
```

## 可访问性底线

- 响应式下探到移动端
- 可见的键盘焦点
- 尊重 `prefers-reduced-motion`
- 文字对比度达 WCAG AA

## 动效

克制使用。主要动效:
- 页面切换 fade(.4s)
- 趋势点 pulse(2s 循环)
- 解析 spinner
- hover 微交互(.15s)

> 原则:less is more。过度动画会让设计显得 AI 生成。
