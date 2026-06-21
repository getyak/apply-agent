# Résumé · 原版保留 / AI 优化双视图 / Vibe 持续改进 · 深度设计

> 这是 **设计文档**（design），不是已落盘事实。事实层在 `docs/architecture/`，特别是 [`vantage-ui-mapping.md`](../architecture/vantage-ui-mapping.md) §2 与 [`data-model.md`](../data-model.md)。本文引用它们但不重复，只做"现状还原 + 问题清单 + 重设计方向"。
>
> 受众：负责 Resume Studio + 简历 agent + dock 这条链路的工程师；做 PR review 时需要判断"这个改动有没有偏离简历体系"的人。
>
> 写作日期：2026-06-21。

---

## 0. 一页结论

**用户提的三件事，逐条对账：**

| 用户要的 | 当前状态 | 差距核心 |
|---|---|---|
| 上传后看到**和原稿排版一模一样的原版** | ⚠️ 半成品。原文件 PDF/DOCX 字节存在 MinIO，SourceDrawer 可在 modal 里预览 PDF（iframe）。但 Resume Studio 主区**默认不渲染原版**——主区永远是"LLM 解析出的 JSON Resume 经通用模板重排"的样子，原版被关进抽屉。 | 原版不是一等公民；用户的第一印象是"我的简历被它改造了"，而不是"它先尊重我的版本，再给建议"。 |
| 另一个版本是**AI 优化版** | ❌ 缺。今天的"另一个版本"只有 `tailored_for_job`（针对某个具体 JD 定制）。**没有"AI 优化的 master sibling"**——没有不绑定 JD、纯粹"基于通用最佳实践把这份简历变好"的产物。 | 数据模型缺一个 axis；UI 缺一个"AI 优化版"的卡片入口；agent 缺一个 `optimize_general` action。 |
| 和 AI **vibe 对话持续改进** | ⚠️ 入口在、闭环不在。Resume Studio 路径下 dock 会切到 `resume_studio:{user_id}:{resume_id}` thread，"This résumé" 4 个 chip 已加；但**只有 "Tailor this résumé to a JD" 那条 chip 真的能跑通**——`analyze` / `next moves` / `surface roles` 三条都还是 `not_implemented_yet`。dock 也不接收 agent 跑完后的 artifact（diff、change_log）——产物只活在 Studio 主区，dock 看不到。 | dock 是引擎入口但不是产物面；用户每次和 AI 谈完都得"自己回 Studio 找结果"，对话断成两段。 |

**问题的本质**：当前实现把"简历"建模成**单条线性版本链**（v1 → v2 → v3 …，外加 per-JD tailored 分支），UI 上是"时间轴 + 文档"，agent 只会**整体重写**一份 JSON Resume。这个模型撑不住"原版必须保留 + AI 优化是常驻 sibling + 用户可以一句话改一个 bullet"这三件事同时存在。

**4 个落地方向**（详见 §6）：

| 方向 | 一句话 | 优先级 |
|---|---|---|
| A. 数据模型：把简历从"线性版本"升级为**双轨 + 局部改动** | 引入 `track ∈ {original, optimized, tailored}` axis + bullet 级稳定 ID + suggestion 表 | P0 |
| B. UI：默认"双栏左右对照"，原版永远在左 | 不是 modal 抽屉，原版是主区第一公民；右栏是当前选中的衍生版本；diff 默认开 | P0 |
| C. Agent：`optimize_general` action + 局部 `propose_bullet_edit` tool | 不是每次都重写整份；支持"改这一条 bullet"的细颗粒 HITL | P0 |
| D. Vibe：dock 内 artifact 卡片承接所有 resume action 的产物 | analyze / optimize / customize / propose_bullet 跑完，结果直接在 dock 里以可点的 artifact 卡片呈现，不必跳页 | P1 |

---

## 1. 现状还原（机制层）

> 文件路径与行号都来自本次调研，准确到当下 commit。后续若有移动，请以代码为准。

### 1.1 上传 + 解析管道

```
用户拖拽文件
   │
   ▼
web/src/components/screens/resume-view.tsx:286-307
   onFileChosen → store.parseFile(file)
   │
   ▼
POST /api/files                            (api/src/routes/files.ts:45-148)
   ├─ 抽取字节 → Markdown / 纯文本
   ├─ 上传 MinIO: {user_id}/resumes/originals/{fileId}.{ext}
   └─ 写 user_files 表：{file_type='resume_original', checksum, …}
   返回 {file, stored, markdown, text, kind}
   │
   ▼
POST /api/resumes/parse-async              (api/src/routes/resumes.ts:219-271)
   ├─ Redis async job 入队
   ├─ 立即 202 返回 jobId
   └─ 后台 parseResumeText() → V4 Flash → JSON Resume
   │
   ▼
saveBaseResume(user_id, jsonResume, raw, sourceFileId)
   ├─ UPDATE resumes SET content WHERE is_base=true
   └─ content = { raw, parsed, warnings, parsedAt, source:{fileId, …} }
```

**关键事实**：
- 原 PDF/DOCX 字节 **保留**（MinIO）。
- 原文件的"渲染原版"（按 PDF 原始排版渲染）**不存在**——只有用户在 SourceDrawer 里通过 `<iframe>` 预览 PDF 原件，DOCX 只能下载。
- `resumes.content.raw` 存的是**抽取后的纯文本/Markdown**，丢了所有版式（字体、缩进、表格、双栏）。
- 解析失败/warnings 不影响 `is_base=true` 写入——降级也照常落盘，由 UI banner 告知。

### 1.2 数据模型

```sql
-- 来自 infra/postgres/migrations/004_resumes.sql + 016_resumes_atomic_version.up.sql
resumes (
    id              UUID PRIMARY KEY,
    user_id         UUID,
    version         INT,            -- per-user，BEFORE INSERT trigger 原子分配
    content         JSONB,          -- {raw, parsed, warnings, source?, …}
    is_base         BOOLEAN,        -- master vs 衍生
    label           TEXT,
    tailored_for_job UUID,          -- 仅 tailored 用
    source_file_id  UUID,           -- 仅 master 上传链路用
    optimization_log JSONB,         -- 已建未用
    embedding       vector(1536),
    parent_version  UUID,           -- 衍生版指回 base
    created_at      TIMESTAMPTZ,
    UNIQUE(user_id, version)
)
```

**三类简历当前是怎么分的：**

| 类别 | is_base | tailored_for_job | parent_version |
|---|---|---|---|
| Master (原版上传) | true | NULL | NULL |
| Tailored (per-JD) | false | <job_id> | <base_id> |
| 手动分支 (UI 未暴露) | false | NULL | <某 version_id> |

**没建模的东西**：
- "AI 优化但**不针对 JD**"的版本——schema 上塞不进去。硬塞的话只能复用 `parent_version != NULL && tailored_for_job == NULL` 那一类，但这跟"手动分支"语义混在一起，前端没法区分。
- bullet 级**稳定 ID**——`parsed.work[i].highlights[j]` 只有数组下标，每次 LLM 重新生成都会洗牌，没法跨版本追踪"同一条 bullet 在 v1 怎么写、在 optimized 里怎么改了"。
- "user 已经接受了哪条 AI 建议"——`optimization_log` 字段建了但写入路径里没用。

### 1.3 前端渲染

**Resume Studio**（`web/src/components/screens/resume-view.tsx`，~2k 行）：

```
┌─ Document Chrome ────────────────────────────────────────────┐
│  [Master/Tailored 标签] [Document/Extracted tabs] [Source chip] [Compare] [Upload] [Export] │
├──────────────────────────────────────────────────────────────┤
│ ┌─ Version Rail (312px) ───┐ ┌─ Document Pane (单栏) ──────┐ │
│ │ Master 时间轴             │ │ ① 默认: JSON Resume 通用模板  │ │
│ │  · v3 master · 2h ago    │ │ ② "Extracted" tab: 原始 raw  │ │
│ │  · v2 master · 3d ago    │ │ ③ Compare 开: 对 tailored 打  │ │
│ │ Tailored 卡片            │ │    coral 高亮                │ │
│ │  · For Stripe (v5)       │ │ ④ structuredEmpty: fallback  │ │
│ └──────────────────────────┘ │    显示 raw text             │ │
│                              └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**主区永远是单栏，"原版 vs AI 改的版本"从不并排出现。** 用户想看原 PDF 长什么样：
- 点右上 SourceChip → 弹 SourceDrawer modal（resume-view.tsx:1709-1936）
- iframe 加载预签名 URL；DOCX 只能下载，不能预览

**"Extracted" tab 不是原版**——它是 LLM 拿到的输入（纯文本/Markdown），格式已经丢了。

### 1.4 Dock 在 Resume 页的状态

`web/src/components/ask-vantage/dock.tsx`：

- **路径检测**：`pathname.startsWith("/app/studio/resume")` → 注入 "This résumé" + "Explore" 两个 chip 分组（dock.tsx:110-135）。
- **Thread override**：理论上 dock 在 Resume 页应切到 `resume_studio:{user_id}:{currentResumeId}` thread——但当前是 **transport-only**，`useDock.threadId` 全局值始终是 `ask_vantage:{user_id}`，override 只在每次 `sendAsk()` 调用里传一下。离开 Resume 页 → dock messages UI 切回 ask_vantage 历史；下次回来 PostgresSaver 重新拉 resume_studio thread。
- **"This résumé" 4 个 chip 的 backend 接通状态**：

| Chip display | 应触发 | 实际状态 |
|---|---|---|
| Find my résumé's 3 weakest spots | `resume_agent.analyze` | ❌ 路由器返回 `not_implemented_yet` |
| Tailor this résumé to a JD | `resume_agent.customize` | ✅ 通 |
| Map my next 1–2 career moves | `analyze` + `trend_agent.skill_gap` | ❌ 未实现 |
| Surface roles that match this résumé | `jobmatch_agent.find_matches` | ❌ 未实现 |

### 1.5 Resume Agent 后端

`agents/nodes/resume_agent.py`：

- `parse(raw_text, user_id)` — 文本 → JSON Resume，V4 Flash。
- `customize(base, jd, …)` — 整份 tailored 简历 + change_log + diff，GLM-4.7。Redis 7 天缓存。带 fabrication guard（最多重试 3 次）+ change_log guard（分 safe / needs_review / unsupported）。
- `analyze(content, user_id)` — 抽技能、估年限、completeness 分。已有，dock 路由没接。
- `build_from_scratch(target_role, recent_role, top_3_wins, user_id)` — 引导式 Q&A 出 v1。已有，dock 接的是"我没简历"路径。

**没有的**：
- `optimize_general(base, user_id)` — **不针对 JD** 的通用优化（量化 bullet、改主动语态、压缩冗长 summary、补 metric）。
- `propose_bullet_edit(resume_id, bullet_stable_id, instruction)` — 改一条 bullet 而不是重写整份。
- `accept_suggestion(suggestion_id)` / `reject_suggestion(suggestion_id)` — HITL 局部应用。

### 1.6 与文档的差距

| `vantage-ui-mapping.md` §2 写的 | 代码里是 |
|---|---|
| Résumé 视图 = 纯文档 + 版本时间轴 + dock 是唯一对话入口 | ✅ |
| "This résumé" 4 chip → 4 个 agent 路径 | ⚠️ 仅 1/4 通 |
| dock 接收 SSE astream_events 渲染 agent task card | ⚠️ 跑的时候有，跑完产物只在 Studio，dock 拿不到 |
| 文档区单栏 | ✅ 现状 — 但这正是用户不满的根源 |
| Fabrication guard 强制 | ✅ |
| 原 PDF preview via "Upload new" / SourceDrawer | ✅ 但藏在 modal 里 |

文档定义的是"对话面 + 版本时间轴 + 文档"。文档**没说**主区必须是单栏。所以加"原版/优化版"双栏不违反 §2 的不可让步原则——`vantage-ui-mapping.md` §2 那条红线是"Resume Studio 没有独立 chat"（dock 是唯一对话入口），这条在新方案里仍然成立。

---

## 2. 真正的问题

把现状放在用户的心智模型边上，差距是这几条：

### 2.1 主区拒绝承认原版的存在

用户上传完一份精心排版了三个月的简历，进 Studio 看到的是"被 AI 抽成 JSON 又用通用模板重排过"的样子——这个版本**和他记忆里的简历不一样**。即使内容没丢，他第一反应是"它把我的格式毁了"。

而原版（PDF）藏在 modal 抽屉里，需要点 SourceChip 才看得到，且不能和主区的"AI 解析版"对照——modal 一关，原版就消失。

**这是认知错位**：产品默认呈现的版本不是用户上传的那份。用户期待的应该是"原版在那儿，我能看到 AI 在它基础上做了什么"。

### 2.2 "AI 优化版"是 P0 缺失

今天能给出的"非原版"只有两种：
- **Extracted** tab（不是版本，是 LLM 的输入文本）
- **Tailored for Job** 卡片（必须有 JD 才能产生）

但用户的诉求很简单——"AI 觉得我这份简历哪里可以更好"——这件事**不依赖具体 JD**：bullet 改主动语态、加量化指标、把 summary 从 4 行压到 2 行、把过期技能挪到底部。这些是"普通优化"，应该是 master 上传后**自动生成**的一份 sibling 版本。

数据模型里塞不进这个东西。今天硬要塞，只能在 `resumes` 表加一条 `is_base=false, tailored_for_job=NULL, parent_version=<master_id>` 的记录——但这种行规当前**前端识别不了**（它会被认作"手动分支"，根本不显示在 Version Rail 上）。

### 2.3 没有 bullet 级的稳定 ID = 没有 vibe 改进

用户说"把我 Acme 那段第二条 bullet 加个数字"，AI 改完。下一次用户说"再把那条调温和一点"——AI 根本不知道"那条"指哪条，因为 `parsed.work[0].highlights[1]` 这个下标在 LLM 重写后已经被洗牌了。

**没有稳定 ID 就没有 vibe**。dock 里所有"局部对话"都退化成"整份重写"。这就是为什么今天的 `customize` 是**唯一通的 chip**——只有"整份重写"这一种粒度，路由器只敢路由这一种。

### 2.4 dock 是引擎，不是产物面

`customize` 跑完之后会发生什么？
- Resume Studio 主区多出一个 "Tailored for Stripe v5" 卡片。
- dock SSE 流推 `agent task card: RÉSUMÉ AGENT · drafting v5` → `· done`，**但流结束后 dock messages 里就剩一条文字回复**："I've saved v5. Open it?"
- 用户必须点 "Open" 跳到主区才能看 diff、看 change_log、决定接受/拒绝。

这违反了用户的对话直觉：**"我在 dock 里和你聊，结果应该在 dock 里就能看完"。** artifact 卡片（diff、change_log、可接受/可拒绝按钮）必须**在 dock 内**承载，否则"vibe 持续改进"永远只是个 hello-world。

### 2.5 没有"AI 主动建议"通道

vision.md 红线："AI 先做，用户后审"。但 Resume Studio 当前是**纯被动的**——用户不点 chip / 不打字，AI 什么都不说。理想状态是：用户上传完简历，AI **主动**说："我看了一遍你的简历，这里有 5 条建议——4 条只改写不改事实（safe），1 条需要你确认是不是夸张（needs_review）。一条条看？"

这条通道当前没有：
- 没有 `optimize_general` action
- 没有 `suggestions` 表存这些主动建议
- dock 没有"AI 主动发起对话"的 SSE 通道（只在用户消息后回复）

---

## 3. 重设计思路（指导原则）

写代码之前先定原则，避免每次 PR 都重新吵：

### 3.1 原版是产品级合同
原版（用户上传的 PDF/DOCX 那份的视觉呈现）必须永远可见、永远可对照、永远不被覆盖。这是产品和用户之间的**信任合同**——"你给我的东西我不会动"。

具体含义：
1. **原版字节永久保留**（已做）。
2. **原版视觉呈现**（按上传文件的实际版式渲染，不是 JSON Resume 通用模板）必须有，且是主区默认布局的左半。
3. 任何"基于原版生成"的版本（optimized / tailored）必须显式标注"AI 改写自原版"，且能一键看 diff。

### 3.2 衍生版本是"建议"，不是"覆盖"
optimized 也好、tailored 也好，都是**建议**。用户没接受之前，**原版才是 source of truth**。一个 implication：导出（PDF/DOCX）默认导出原版；要导出 optimized，需要用户显式"应用 AI 优化"动作。

### 3.3 局部 > 整体
任何 AI 改动**优先以 bullet 级提案**呈现，而不是"换掉一整份"。整份替换只在两种情况发生：
- 用户主动说"重写整份"（明确意图）
- 从零搭建（用户没原版）

### 3.4 Vibe 在 dock，artifact 也在 dock
dock 是**唯一对话入口**（沿用 `vantage-ui-mapping.md` §2.6），同时也是**唯一产物面**——所有 resume action 的结果（建议列表、diff、change_log、可接受/可拒绝按钮）以 artifact 卡片在 dock 里呈现。Studio 主区只承担"看版本、看 diff、最终应用"。

### 3.5 永远不虚构（vision.md 红线）
fabrication guard 必须扩展到**所有写操作**——`optimize_general` / `propose_bullet_edit` / `customize` 一视同仁。bullet 级改动甚至更危险（"加个数字"比"重写整份"更容易偷塞虚构事实），需要逐条 NER 比对原 bullet 的 named entities。

---

## 4. 重设计：数据模型

> 这是最关键的一节。模型不对，UI 怎么修都是补丁。

### 4.1 简历 = 双轨 + 衍生

不再把简历当成"线性版本链"，改成**两条平行 track**：

```
Resume (one per user, conceptually a "document")
├── Original Track
│   ├── original v1 (uploaded 2026-06-01)     ← 用户上传，永不修改
│   └── original v2 (uploaded 2026-06-15)     ← 用户重新上传，新版原版
│
└── Optimized Track (AI 优化，常驻 sibling)
    ├── optimized v1 (from original v1, 2026-06-01)
    │   └── accepted_suggestions: [sug-001, sug-003]
    ├── optimized v2 (from original v1 + sug-005)
    └── optimized v3 (rebuilt from original v2, 2026-06-15)

Tailored Variants (per-JD，从 optimized 或 original 派生)
├── tailored-for-stripe (from optimized v2)
└── tailored-for-linear (from original v2)
```

**两个 track 的关系**：
- Original 是合同；optimized 是建议堆叠的结果。
- 每条 optimized 都能追到它从哪条 original 派生。
- Tailored 可以从 original 或 optimized 派生（用户选）——但 fabrication guard 永远以**最近的 original** 为 ground truth。

### 4.2 Schema 改动

```sql
ALTER TABLE resumes
  ADD COLUMN track TEXT NOT NULL DEFAULT 'optimized'
    CHECK (track IN ('original', 'optimized', 'tailored'));
  -- 现有 is_base=true 的迁移：track='original'
  -- 现有 tailored_for_job IS NOT NULL 的：track='tailored'
  -- 其余：track='optimized'

ALTER TABLE resumes
  ADD COLUMN derived_from UUID REFERENCES resumes(id);
  -- 替代当前的 parent_version (语义清晰化)
  -- original: derived_from=NULL
  -- optimized: derived_from = 某条 original
  -- tailored: derived_from = 某条 original 或 optimized

-- bullet 级稳定 ID — 这是 vibe 的物理基础
ALTER TABLE resumes
  ADD COLUMN bullet_index JSONB;
  -- 结构: { "stable_id_xxx": {"path": "work.0.highlights.1", "text_hash": "..."} }
  -- stable_id 在 original 上线时一次性分配，optimized/tailored 继承
```

```sql
-- 新表: AI 建议堆栈
CREATE TABLE resume_suggestions (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL,
  source_resume_id UUID NOT NULL REFERENCES resumes(id),  -- 这条建议是对哪份简历做的
  bullet_stable_id TEXT,                                    -- 如果是 bullet 级建议
  section         TEXT,                                     -- 'summary' | 'work' | 'skills' | …
  change_type     TEXT NOT NULL,                            -- tighten | quantify_existing | reorder | infer_wording
  before_text     TEXT NOT NULL,
  after_text      TEXT NOT NULL,
  rationale       TEXT,                                     -- 给用户看的理由
  risk_level      TEXT NOT NULL CHECK (risk_level IN ('safe','needs_review','unsupported')),
  fabrication_check JSONB,                                  -- guard 输出 (entities checked, pass/fail)
  status          TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','accepted','rejected','superseded')),
  proposed_by     TEXT NOT NULL,                            -- 'optimize_general' | 'customize' | 'vibe_chat'
  proposed_at     TIMESTAMPTZ DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  decided_via     TEXT                                      -- 'dock_inline' | 'studio_panel' | 'auto'
);
CREATE INDEX idx_resume_suggestions_user_status ON resume_suggestions(user_id, status);
CREATE INDEX idx_resume_suggestions_source ON resume_suggestions(source_resume_id);
```

**为什么单独建议表，不直接写进 `optimization_log` JSONB**：
- 建议是**长生命周期实体**——用户可能两周后才决定接受某条。
- 同一条建议可能被多次"反提"（用户拒绝后 AI 在不同上下文里又提了类似的）——需要 superseded 链路。
- 建议要能被 dock 和 Studio 两个地方各自渲染并互相同步状态。JSONB 嵌在 `resumes.content` 里办不到。

### 4.3 Bullet stable_id 怎么生成

第一次 parse 出 JSON Resume 时，遍历每条 highlight：

```python
def assign_bullet_ids(parsed_resume) -> dict:
    """生成 bullet_index，把每条 highlight 钉一个稳定 ID。"""
    index = {}
    for i, work in enumerate(parsed_resume.get("work", [])):
        for j, highlight in enumerate(work.get("highlights", [])):
            stable_id = f"b_{uuid4().hex[:8]}"
            index[stable_id] = {
                "path": f"work.{i}.highlights.{j}",
                "text_hash": hashlib.sha256(highlight.encode()).hexdigest()[:16],
                "anchor_text": highlight[:64],  # 用于 LLM 重排后做模糊匹配
            }
    return index
```

后续 `optimize_general` / `customize` 生成新版时，必须在 prompt 里**强制把 stable_id 写进输出**，结构：

```json
{
  "work": [{
    "company": "Acme",
    "highlights": [
      {"id": "b_a1b2c3d4", "text": "Led migration of …"}
    ]
  }]
}
```

LLM 可能不老实——所以在 `post_model_hook` 里做**ID 完整性校验**：
- 新版的 stable_id 集合必须 ⊆ 原版 + 新生成的 ID
- 新生成的 ID 必须明确标注 `"is_new": true` 由 guard 二次检查（fabrication 嫌疑）

---

## 5. 重设计：UI

### 5.1 Resume Studio 主区 = "原版 ↔ 选中衍生版"双栏

```
┌──────────────────────────────────────────────────────────────────┐
│ Chrome: [Original/Optimized/Tailored tabs] [Source: resume.pdf] [Compare ✓] [Upload new] [Export ▼] │
├──────────────┬──────────────────────────────┬──────────────────┤
│ Version Rail │ Original Pane (左)            │ Derived Pane (右) │
│ (280px)      │                              │                    │
│              │ 渲染方式：                    │ 渲染方式：          │
│ Original     │ ① PDF: <iframe> + 缩放        │ JSON Resume 模板    │
│  · v2 (now)  │ ② DOCX: PDF preview          │ + diff highlight   │
│  · v1 (Jun1) │   (服务端转，cache)            │ + 接受/拒绝 chip    │
│              │ ③ Markdown: 渲染 markdown     │ + change_log 嵌入   │
│ Optimized    │                              │                    │
│  · v3 (now)  │ Sticky page nav (PDF)        │ Sticky bullet nav   │
│  · v2        │                              │                    │
│  · v1        │                              │                    │
│              │                              │                    │
│ Tailored     │                              │                    │
│  · Stripe v5 │                              │                    │
│  · Linear v4 │                              │                    │
└──────────────┴──────────────────────────────┴──────────────────┘
```

**Original Pane 怎么显示"和原稿一模一样"**：

| 原文件类型 | 渲染方式 | 实现备注 |
|---|---|---|
| PDF | 直接 `<iframe src={presigned_url}>` (浏览器原生 PDF viewer) | 已可用，从 SourceDrawer 移到主区 |
| DOCX | 服务端用 LibreOffice headless / Pandoc 转 PDF，缓存到 MinIO `{user_id}/resumes/originals/{fileId}.preview.pdf`，再 iframe | 新增；转一次缓存永久，~1s 延迟可接受 |
| Markdown / 纯文本 | 客户端渲染 markdown，保留段落空行 | 简单 |
| `.txt` | `<pre>` 包裹 | 简单 |

DOCX 转 PDF 这一步是新工程量，但不复杂：
- API: `GET /api/files/:id/preview-pdf`
- 后端：若 mime 不是 PDF → `unoconv` / `libreoffice --headless --convert-to pdf` → 写回 MinIO `{...}.preview.pdf` → 重定向到预签名 URL
- Worker 容器需要装 LibreOffice（增 ~500MB 镜像，nightly build 一次）。

**Derived Pane 默认显示**：
- 用户刚上传完 → 显示 optimized v1（如果 optimize_general 跑完）；若还在跑，显示 skeleton + "Vantage 正在看你的简历…"
- 用户在 Version Rail 点了 tailored → 切到那条 tailored

**Diff 高亮规则**（右栏针对左栏）：
- 同一 bullet stable_id 下，after_text ≠ before_text → coral 高亮
- 新增 bullet → 整条 coral 边框
- 删除 bullet → 在原版位置打灰色"AI 建议删除"标记（这是关键，不能让"AI 删了什么"不可见）

### 5.2 Version Rail 升级

```
┌─ Original ────────────────┐
│  ● v2 · resume_v2.pdf      │
│    Uploaded just now       │  ← current original
│  ○ v1 · resume_v1.pdf      │
│    Jun 1                   │
├─ Optimized ───────────────┤
│  ● v3 (3 suggestions in)   │  ← current derived
│    +2 quantified, 1 cut    │
│  ○ v2 (1 suggestion in)    │
│  ○ v1 (auto from upload)   │
├─ Tailored ────────────────┤
│  ○ For Stripe — from opt v2│
│  ○ For Linear — from orig v2│
└────────────────────────────┘
[+ Tailor for a new role]
```

每条目下面挂"包含了哪些 suggestion"的简述。点进 optimized v3 → 右栏切到 v3 + 顶部出 "v3 = original v2 + 接受了 3 条建议" 横幅，点横幅展开看建议列表（即 `resume_suggestions WHERE status='accepted' AND <descended chain>`）。

### 5.3 顶部 Tabs 重做

当前是 "Document / Extracted"。改成：

| Tab | 内容 |
|---|---|
| **Original** | 左栏原版独占，右栏隐藏（用户想专心看原稿） |
| **Optimized** | 双栏：原版 ↔ optimized (默认) |
| **Tailored** | 双栏：原版/optimized（用户选）↔ tailored-for-job |
| **Extracted** | (advanced, 折叠) LLM 看到的 raw text — 调试用 |

"Extracted" 是工程师 / debug 模式的窗口，不应该出现在普通用户主路径。

---

## 6. 重设计：Agent & Vibe 对话

### 6.1 新增 agent action

`agents/nodes/resume_agent.py` 新增：

```python
async def optimize_general(base_resume_id: UUID, user_id: UUID) -> dict:
    """
    Generic optimization — no JD, no role target. Pure best-practice pass.
    Generates a list of *suggestions* (not a full replacement document).
    """
    # 1. 读 base resume + bullet_index
    # 2. Prompt: GLM-4.7 — "Read this résumé. For each bullet, return up to N
    #    suggestions of these types: tighten, quantify_existing, reorder,
    #    infer_wording (last one needs review). NEVER invent facts."
    # 3. 输出: List[{bullet_stable_id, change_type, before, after, rationale}]
    # 4. fabrication_guard 逐条跑
    # 5. risk_level 分类 (复用现有 change_log guard 逻辑)
    # 6. 批量 INSERT 到 resume_suggestions (status='proposed')
    # 7. 返回 {suggestions: [...], optimized_resume_id: <auto-created with all 'safe' suggestions applied>}

async def propose_bullet_edit(
    resume_id: UUID,
    bullet_stable_id: str,
    instruction: str,
    user_id: UUID,
) -> dict:
    """
    Vibe chat: "tighten this bullet" / "add a metric here" / "make it more
    senior-sounding". Operates on ONE bullet, returns ONE suggestion.
    """
    # 1. 用 bullet_stable_id 定位原 bullet text
    # 2. Prompt: GLM-4.7 — "Here is the bullet. Here is the user's instruction.
    #    Rewrite within these constraints: [fabrication red lines]"
    # 3. fabrication_guard
    # 4. INSERT resume_suggestions
    # 5. 返回 {suggestion: {...}}

async def apply_suggestions(
    suggestion_ids: list,
    user_id: UUID,
    target_track: str = 'optimized',
) -> dict:
    """
    Materialize a set of accepted suggestions into a new optimized version.
    """
    # 1. 读所有 suggestion (must be status='accepted' or being accepted now)
    # 2. 找出 derived_from base
    # 3. 应用每条 change 到 base content
    # 4. INSERT 新 resumes row (track='optimized', derived_from=base.id)
    # 5. UPDATE suggestions SET status='accepted', decided_at=now()
    # 6. 返回 {new_resume_id, version}
```

`customize` 不动，但内部要改成"也写 resume_suggestions"——让 tailored 也走统一的建议-接受流程，让用户能看到"这份 tailored 比 original 改了哪 6 处，其中 4 处和我之前接受过的 optimized 建议重叠"。

### 6.2 上传后自动跑 optimize_general

`POST /api/resumes/parse-async` 成功后，**链式**触发一次 `optimize_general`（同样异步、同样有 banner）：

```
upload → parse-async (Redis job)
              │
              ├─ 完成 → saveBaseResume (track='original')
              │
              └─ 发事件: resume:parsed
                     │
                     ▼
              optimize-async (新 Redis job)
                     │
                     ├─ 跑 optimize_general
                     ├─ 自动 apply 所有 'safe' suggestions
                     ├─ 写出 track='optimized' v1
                     └─ 'needs_review' suggestions 留在 status='proposed'
                                │
                                ▼
              SSE 推 dock: "I've looked at your résumé. Here are 3 quick wins."
```

**关键决定**：'safe' 自动应用，'needs_review' 必须用户点头。这是 vision.md "AI 先做，用户后审"的具体实现——AI 把没风险的活先干了，只把需要决定的事项推给用户。

### 6.3 Dock vibe 流：artifact 卡片

dock 接收的 SSE `astream_events` 当前只渲染"agent task card"（spinner → check）。扩展加一类：**artifact card**。

```
─ dock messages (oldest → newest) ─────────────────
│ [user] "find my résumé's 3 weakest spots"
│ [agent task] RÉSUMÉ AGENT · analyzing
│ [agent task] RÉSUMÉ AGENT · done
│ [artifact: suggestion-list]                       ← 新增
│   ┌──────────────────────────────────────────┐
│   │ I found 5 things you could tighten:       │
│   │                                           │
│   │ ① Acme · highlight 2  [needs_review]      │
│   │   "Worked on migration of …"               │
│   │   →                                       │
│   │   "Led migration of monolith → 4 services" │
│   │   Reason: actives + quantify              │
│   │   [Accept] [Reject] [Discuss]              │
│   │                                           │
│   │ ② … (4 more, scrollable)                  │
│   │                                           │
│   │ [Accept all safe (3)] [Open in Studio]    │
│   └──────────────────────────────────────────┘
─────────────────────────────────────────────────
```

artifact 卡片由 dock 流式渲染（complete arrives once at the end of the stream），用户点 [Accept] / [Reject] → 直接调 `POST /api/resumes/suggestions/:id/decision`，**不跳页**。点 [Discuss] → 在 dock 当前 thread 继续聊那条 bullet：

```
│ [user clicked Discuss on ① Acme · highlight 2]
│ [system: scoped to bullet b_a1b2c3d4]
│ [user] "i actually only led 2 of the 4 services, drop that"
│ [agent task] RÉSUMÉ AGENT · revising suggestion
│ [artifact: suggestion-list (1 item, updated)]
│   ① Acme · highlight 2  [safe]
│      "Led migration to 2 of 4 microservices"
│      [Accept] [Reject]
```

`propose_bullet_edit` 的输入是用户消息 + bullet stable_id（从 [Discuss] 按钮带过来）。后续每条消息都隐式带这个 scope，直到用户切换话题或按钮关闭 scope。

### 6.4 Dock 通知 + 主动建议

dock 不再纯被动。两种 AI 主动触发：

1. **上传后 5 秒**：optimize_general 跑完 → dock 出 artifact 卡："I've looked at your new résumé. 3 quick wins ready when you are." 用户没在 Resume Studio 也能看到（dock 持久驻留）。
2. **用户接受了某条建议**：Trend agent 触发链 — "你刚加的 'led migration' 这种主动语态，在 SRE 岗位 JD 里出现频率是 73%。要不要我把简历里其他 5 处类似 bullet 也提一下？"

第 2 条是"上下文飞轮"的入口——用户的每一次接受都成为下一轮建议的训练信号。

### 6.5 thread scope 升级

按 `vantage-ui-mapping.md` §2.6，Resume Studio 路径下 dock 切到 `resume_studio:{user_id}:{resume_id}` thread。**新加一层**：bullet scope。

```
thread_id 全局: ask_vantage:{user_id}
thread_id Resume Studio: resume_studio:{user_id}:{resume_id}
thread_id bullet vibe: resume_bullet:{user_id}:{resume_id}:{bullet_stable_id}
```

bullet thread 是**短生命**（一次对话）——用户关闭 [Discuss] scope 或在 dock 里换话题时，scope 解除，下一条消息回到 resume_studio thread。bullet thread 的 checkpoint 14 天后归档。

---

## 7. 一致性 / 安全 / 边界

### 7.1 Fabrication 红线扩展

`optimize_general` / `propose_bullet_edit` 必须跑同一套 fabrication_guard（resume_agent.py:220-267）：

- before_text 抽 named entities（公司、人名、数字、年份、percent、money）
- after_text 抽同样的 entities
- 新增的 entity 必须能在 before_text 或 base resume 全文里找到 — 否则 risk_level='unsupported'，**不进 'safe' 自动应用**

`change_type='infer_wording'` 默认 risk_level='needs_review'，强制 HITL。

### 7.2 原版永不被覆盖

数据库约束：

```sql
CREATE OR REPLACE FUNCTION prevent_original_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.track = 'original' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'Original résumés are immutable. Upload a new file instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER resumes_original_immutable
BEFORE UPDATE ON resumes
FOR EACH ROW EXECUTE FUNCTION prevent_original_mutation();
```

"Upload new" 入口 → 永远是**新建一条 track='original'**，不 update 旧的。

### 7.3 导出语义

`Export ▼` 下拉：
- "Export original (resume.pdf)" — 直接下载 MinIO 里的原文件，零损耗
- "Export optimized (latest)" — 把 optimized track 当前版本 render 成 PDF（用 react-pdf 或类似）
- "Export tailored for {company}" — 同上，from tailored

**默认高亮"Export original"**——sticky 合同：不接受的衍生不会被无意中带出去。

### 7.4 隐私

- 原文件存储 MinIO，加密 at-rest（infra/CLAUDE.md 已建模）
- 建议表 `resume_suggestions` 含 before/after text，遵循同一 retention（GDPR 删除时级联）
- dock 里的 bullet vibe thread 14 天归档（短期）；resume_studio thread 终身

### 7.5 性能

- `optimize_general` 异步跑，UI 用 banner 通知（同 parse 路径）
- bullet vibe 是同步对话（毫秒级响应感）→ V4 Flash + 短上下文（只 ship 当前 bullet + summary，不 ship 整份简历）
- DOCX → PDF 转换缓存，命中率应 > 95%（用户极少重传同 checksum）

---

## 8. 阶段拆分（建议 PR 顺序）

| PR | 范围 | 风险 |
|---|---|---|
| **P0-1** | Schema migration 017：加 `track` + `derived_from` + `bullet_index` + `resume_suggestions` 表 + 原版不可变 trigger + 历史数据回填脚本 | 低，纯 schema |
| **P0-2** | `optimize_general` agent action + 上传链式触发 + auto-apply 'safe' | 中，新 LLM 调用路径 |
| **P0-3** | Resume Studio 主区改双栏；Original Pane 渲染（PDF iframe；DOCX 转 PDF API） | 中，前端结构大改 |
| **P0-4** | Version Rail 重做：Original / Optimized / Tailored 三段 | 中 |
| **P1-5** | dock artifact card: suggestion-list 类型 + accept/reject 按钮 | 中，dock 协议扩展 |
| **P1-6** | `propose_bullet_edit` + bullet vibe thread scope + [Discuss] 入口 | 中高，新 thread 模型 |
| **P1-7** | "Find weakest 3" / "Map next moves" / "Surface roles" 3 个 dock chip 接通 | 中，分别对应不同 agent action |
| **P2-8** | DOCX preview pipeline 优化（worker 镜像、缓存策略、错误降级） | 低中 |
| **P2-9** | 主动建议触发链（接受 → trend → 反提类似 bullet） | 高，需要 agent 间事件总线 |

每个 PR 应配：
- 设计文档（本文）的具体段落引用
- Promptfoo eval case（fabrication 红线）
- Migration up + down + 幂等验证（CI 已强制）

---

## 9. 与现有架构的关系

| 现有文档 | 本设计的关系 |
|---|---|
| [`vantage-ui-mapping.md`](../architecture/vantage-ui-mapping.md) §2 | **延续**："dock 是唯一对话入口" 红线不变；本设计扩展了 dock 的 artifact 渲染能力 + thread scope 三层模型 + Resume Studio 主区从单栏 → 双栏 |
| [`data-model.md`](../data-model.md) | **扩展**：`resumes` 加 track / derived_from / bullet_index；新表 `resume_suggestions` |
| [`agent-architecture.md`](../architecture/agent-architecture.md) | **延续**：仍是 5 agent，ResumeAgent 加 3 个新 action（optimize_general / propose_bullet_edit / apply_suggestions）；不新增 agent |
| [`agent-harness.md`](../architecture/agent-harness.md) | **复用**：fabrication_guard 扩展到所有写操作；新 action 仍走 create_react_agent + post_model_hook |
| [`chat-agent-system-redesign.md`](chat-agent-system-redesign.md) §5C "内嵌 HITL" | **具体化**：本文的 dock artifact card + [Accept]/[Reject]/[Discuss] 就是 §5C 在 resume 场景的落地形态 |
| [`product-spec.md`](../product-spec.md) 功能 2 "AI 简历优化" | **具体化**：产品规格只说"AI 生成改进建议 + diff + accept/reject"；本文把它落到 schema + UI + agent action 全链路 |
| [`vision.md`](../vision.md) "AI 先做，用户后审" | **具体化**：optimize_general 自动跑 + safe 自动应用 + needs_review 卡 HITL = "先做 + 后审"的工程实现 |

---

## 10. 没回答的问题（留给实施时讨论）

1. **多个原版怎么处理**：用户反复 upload 替换原版时（resume_v1.pdf → resume_v2.pdf），旧的 original 是软删还是保留？提议保留（用户可能后悔），但 Version Rail 默认折叠旧 original。
2. **建议被拒绝后 AI 多久能再提**：同一条 bullet 同一 change_type 已被 reject → AI 在 N 天内不再 propose 类似改动。N=？建议 30 天，可配置。
3. **bullet stable_id 在 LLM 重排时如果丢了怎么办**：模糊匹配（anchor_text + cosine similarity）兜底，匹配不到的 bullet 标 `is_new=true` 走 fabrication guard 严格审。
4. **optimized track 的导出是否需要"AI 辅助声明"**：是否在导出 PDF 的 footer 加一句 "Drafted with AI assistance · Verified by [user name]"？这是 trust 信号也是负担，取决于目标雇主市场。
5. **vibe thread 在跨设备同步**：bullet vibe 是 14 天短期 thread，PostgresSaver 都能存。但 dock 重启时如何"知道当前 scope 在 bullet"？建议 thread_id 写进 URL fragment（`/app/studio/resume#bullet=b_a1b2c3d4`），刷新可恢复。

---

> 本文档结束。任何对"Resume Studio 主区为什么不是双栏"、"为什么不能让 AI 直接覆盖原版"、"为什么 dock 要有 artifact 而不是跳页"的疑问 — 回到 §3（指导原则）。任何模型改动（schema 层）— 必须先回到 §4 改设计再改 SQL。
