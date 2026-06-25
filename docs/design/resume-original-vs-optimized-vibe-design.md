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

---

## 11. 修订（2026-06-24）：默认展示形态 + 渲染技术

> 本节是对 §3.1 / §5.1 / §5.3 的**定向修订**。§1–§10 的数据模型、fabrication 红线、suggestions 表、dock artifact 设计**全部保留不变**——本节只改"主区默认看哪个版本"和"用什么渲染"这两个 UX 决策。决策人：项目 owner，2026-06-24。

### 11.1 决策对账

§3.1 原立场是"**原版是主区默认布局的左半**"（原版优先）。本次修订改为：**主区默认渲染 AI 优化版，以 Markdown→HTML 呈现**；原版降为平级 tab（不藏 modal）。

**为什么改**（与 vision.md 对齐度更高）：

| | §3.1 原立场（原版优先） | 修订（优化版优先） |
|---|---|---|
| 第一印象 | "它先尊重我的版本" | "它已经帮我改好了" |
| §2.1 的担忧"用户觉得格式被毁" | 用原版规避 | 用**干净的 Markdown 渲染**化解——优化版不再是"丑陋 JSON 模板重排"，而是一份体面文档 |
| vision.md「AI 先做，用户后审」 | 偏"后审" | 偏"先做" ← **更贴北极星"为我而做的求职简报"** |

**关键澄清——这次修订没有动任何红线**：

- §3.2「衍生版本是建议不是覆盖」**不变**：优化版仍然是建议堆叠的结果，原版仍是导出默认（§7.3）。
- §7.2「原版永不被覆盖」**不变**：`prevent_original_mutation` trigger（migration 017 已落盘）继续生效。
- "默认看哪个"是**纯第一印象 UX**，与数据层 source-of-truth 是两件事。优化版默认可见，不代表它取代原版的合同地位。

### 11.2 主区布局修订（取代 §5.1 / §5.3 的 tab 定义）

§5.1 的"原版 ↔ 衍生版双栏"**保留为 Compare 模式**，但不再是默认。默认是**单栏看优化版**，一键切原版/对照：

```
┌──────────────────────────────────────────────────────────────────┐
│ Chrome: [优化版 ●] [原版] [对照]   [Source: resume.pdf] [Upload] [Export ▼] │
├──────────────┬───────────────────────────────────────────────────┤
│ Version Rail │ Document Pane（默认单栏）                          │
│ (280px)      │                                                   │
│ (§5.2 三段   │ 默认 = 优化版 Markdown → HTML                      │
│  rail 不变)  │   ① react-markdown + remark-gfm                   │
│              │   ② 一套 .resume-prose 主题 CSS                    │
│              │   ③ AI 改写的 bullet 行内 coral 高亮 + hover 看理由 │
│              │   ④ needs_review 建议行尾挂 [Accept][Reject] chip  │
└──────────────┴───────────────────────────────────────────────────┘
```

**三个 tab 的修订定义**（取代 §5.3）：

| Tab | 内容 | 是否默认 |
|---|---|---|
| **优化版** | 单栏，优化版 Markdown 渲染（默认落点） | ✅ 默认 |
| **原版** | 单栏，原版按上传版式渲染（PDF iframe / DOCX 转 PDF / MD 渲染，渲染方式见 §5.1 表） | |
| **对照** | §5.1 的双栏 diff（原版左 ↔ 优化版右，coral 高亮） | |

`Extracted`（LLM 输入 raw text）降为 Compare 模式下的 advanced 折叠项，不再是顶层 tab。

**优化版还在跑时的空态**：上传刚完成、`optimize_general` 异步未回 → 默认 tab 显示 skeleton + "Vantage 正在优化你的简历…"，并提供"先看原版"的副 CTA（避免空等）。

### 11.3 渲染技术：Markdown 为存储 + 渲染为 HTML

**决策**：优化版 / tailored 的**人类可读形态以 Markdown 字符串存储**，前端 react-markdown + remark-gfm + 一套 `.resume-prose` 主题渲染成 HTML。**不**为不同简历维护多套 HTML 模板。

**与现有 JSON Resume 的关系**——采纳 §10 之外的第三形态「Markdown 主轨 + JSON 旁路」：

```
解析时（parse-async）一次产出两份，由 bullet stable_id 关联：
┌─ 主轨：Markdown ──────────────┐   ┌─ 旁路：JSON Resume ─────────┐
│ 给人看（Document Pane 渲染）   │   │ 给机器用（匹配/技能/分析）   │
│ 给 LLM 改（optimize/vibe 输入） │←→│ jobmatch / analyze / 技能图  │
│ 行级 diff 干净                 │   │ basics/work/skills/...      │
└────────────────────────────────┘   └──────────────────────────────┘
        关联键：resumes.bullet_index 的 stable_id
        （§4.3 已定义；每个 stable_id 既指 JSON path 也锚 Markdown 行）
```

**为什么 Markdown 是主轨**（回应 owner 原话"HTML 显示有优势但渲染麻烦，且不同简历不同定制"）：

1. **LLM 友好**：`optimize_general` / `propose_bullet_edit` 直接产出/修改 Markdown，不必让 LLM 操作嵌套 JSON 数组下标——这也顺带消解了 §2.3「LLM 重写洗牌下标」的根因。
2. **diff 干净**：Markdown 行级 diff 比 JSON 结构 diff 直观，§5.1 的 coral 高亮直接基于行 diff。
3. **可编辑**：未来"手动微调"= textarea ↔ 预览，零模板成本。
4. **一套主题吃所有简历**：`.resume-prose` 一套 CSS，不为每份简历定制——"不同简历不同定制"的需求改由**优化版内容本身的差异**承载，而非排版模板差异。HTML 自由排版（双栏、图标）简历其实不需要，导出 PDF 时再谈版式（§7.3）。

**存储落点**：`resumes.content` 扩展为同时持有 `markdown`（新，主轨）+ `parsed`（JSON，旁路）+ `raw`（原始抽取文本，不变）。Markdown 由 JSON 渲染生成，或由 LLM 直接产出——两者必须经 §4.3 的 stable_id 校验保持一致。

**安全**：Markdown→HTML 渲染必须过 sanitize（react-markdown 默认禁 raw HTML，保持默认；简历内容不需要内嵌 HTML/script）。这条对齐 RULES.md「sanitize all HTML output」。

### 11.4 对 §8 PR 顺序的影响

- **P0-3**（主区双栏）修订为：**主区默认单栏优化版 Markdown 渲染 + [优化版/原版/对照] tab**；§5.1 双栏降级为"对照"tab 内的形态。
- 新增 **P0-2.5**：`parse-async` 产出 Markdown 主轨 + JSON 旁路双形态 + `.resume-prose` 渲染组件。排在 P0-2（optimize_general）前，因为 optimize 的输入/输出都是 Markdown。

---

## 12. 新增（2026-06-24）：上传 = Resume Intake Agent

> §1.1 把上传当**纯管道**（提取 → LLM parse → 入库），唯一"验证"是被动 `warnings`。本节把上传升级为一个**主动验证 agent**——这是 §1–§11 完全没有的新层。决策人：项目 owner，2026-06-24（四项能力全要）。

### 12.1 定位：intake 是 parse 的超集，不是新 agent

不新增第 6 个 agent（守 agent-architecture.md「红线：能塞进现有 5 个之一就不新增」）。**intake 是 ResumeAgent 的一个新 action**，把现有的 `parse` 包进一条更长的验证链：

```
upload → bytesToMarkdown (TS, 不变)
              │
              ▼
   ResumeAgent.intake(markdown, user_id)   ← 新 action，替代裸 parse
   ┌─────────────────────────────────────────────────────┐
   │ ① parse           markdown → JSON Resume（复用现有）  │
   │ ② structure_check 必备 section 齐全？缺口清单          │
   │ ③ proofread       错别字/语法/时态/标点（标，不改）     │
   │ ④ normalize       日期/技能名/动词时态 规范化建议        │
   │ ⑤ quality_diag    弱 bullet 诊断（= analyze 的子集）   │
   └─────────────────────────────────────────────────────┘
              │
              ├─ JSON + Markdown 双形态落 track='original'
              │   （原版内容不动，校验产物单独存）
              └─ 校验产物 → resume_suggestions(proposed_by='intake')
                          + dock artifact 主动推送
```

**关键约束——intake 永不改原版**：四项验证全部产出**建议/标注**，写进 §4.2 的 `resume_suggestions` 表（`proposed_by='intake'`），绝不 mutate `track='original'` 的内容（§7.2 trigger 兜底）。这守住了 §3.1 信任合同——上传是"它先看了一遍并指出问题"，不是"它擅自改了我的简历"。

### 12.2 四项能力的实现边界（对应 owner 四选）

| 能力 | 做什么 | 模型 | 产出 risk_level | 是否自动应用 |
|---|---|---|---|---|
| **① 结构完整性** | 检查 basics/work/skills/education 必备项；缺口标注（"没有量化成果"、"缺联系方式"） | 规则 + V4 Flash | — (诊断类，不是改写建议) | 否，只提示 |
| **② 错别字/语法** | 拼写、语法、时态一致、标点。**标出可疑处，不自动改** | V4 Flash | `needs_review`（专有名词/技术栈缩写易误伤） | **否，必须用户确认** |
| **③ 格式规范化** | 日期统一（2021–2024）、技能名规范（JavaScript≠js）、bullet 动词时态、量化表达 | 规则优先 + LLM 兜底 | `safe`（纯格式）/ `needs_review`（涉及语义） | safe 可自动，needs_review 卡 HITL |
| **④ 内容质量诊断** | 弱 bullet 识别（无量化/被动语态/职责堆砌非成果）→ 改进方向。**这就是 §6.1 的 analyze / "3 weakest spots" chip** | GLM-4.7 | `needs_review`（都是改写建议） | 否 |

**②/④ 必须守 fabrication 红线**（§7.1）：proofread 改专有名词、quality_diag 加量化指标，都极易偷塞虚构——必须逐项过 `fabrication_guard`，任何 before 里没有的 named entity 一律 `unsupported`，不进 safe。

**②错别字的特别注意**：技术简历充斥"非词典词"（k8s、PostgreSQL、gRPC、CUBXXW）。proofread prompt 必须显式声明"技术栈缩写、产品名、人名不算拼写错误"，否则误报率会毁掉信任。这条进 `agents/prompts/resume/proofread.v1.md` 并配 Promptfoo eval（误伤率 < 5%）。

### 12.3 上传后的 dock 主动通道（具体化 §6.4）

intake 跑完 → dock 主动推一张 artifact 卡（沿用 §6.3 suggestion-list 协议，新增 intake 分组）：

```
│ [agent task] RÉSUMÉ AGENT · checking your résumé
│ [agent task] RÉSUMÉ AGENT · done
│ [artifact: intake-report]                          ← 新 artifact 子类型
│   ┌──────────────────────────────────────────────┐
│   │ 我看了一遍你的简历：                            │
│   │                                                │
│   │ ✅ 结构完整（4/4 section 齐全）                 │
│   │ ⚠️ 2 处可能的笔误（待你确认）                   │
│   │ 🔧 3 处格式已帮你规范（safe，已应用）           │
│   │ 💡 4 条 bullet 可以更有说服力                   │
│   │                                                │
│   │ [逐条看 (6)] [全部接受 safe (3)] [先这样]        │
│   └──────────────────────────────────────────────┘
```

- ③的 `safe` 项（日期格式统一等）**自动应用进 optimized v1**（vision.md「AI 先做」），卡片只做事后告知。
- ①②④ 全是 `needs_review` → 留 `status='proposed'`，等用户逐条决定（vision.md「用户后审」）。
- 点 [逐条看] → 进 §6.3 的逐条 accept/reject/discuss 流。

### 12.4 同步 vs 异步

intake 是**两段**：

1. **快段（同步，阻塞 parse-async job）**：① parse + ② structure_check。这两步是"能不能用"的判断，必须在 job done 前完成——否则用户进 workspace 看到的优化版是空的。
2. **慢段（异步，parse 完链式触发）**：③ proofread + ④ normalize + ⑤ quality_diag + `optimize_general`（§6.2）。这些是"锦上添花"，走 §6.2 的 optimize-async job，dock banner 通知。

这样 §6.2 的"上传链式触发 optimize_general"和本节的慢段验证**合并成一条 optimize-async**，省一次 LLM 往返。

### 12.5 对 §8 PR 顺序的影响

- 新增 **P0-2.7**：`ResumeAgent.intake` action（封装 parse + 四项验证）+ `proofread.v1.md` / `normalize.v1.md` prompt + Promptfoo 误伤率 eval。排在 P0-2.5（双形态）后、P1-5（dock artifact）前。
- `intake-report` artifact 子类型并入 **P1-5** dock artifact card 工程。

### 12.6 留给实施的问题

1. **structure_check 的"必备 section"对不同人群是否一刀切**：应届生没 work，是不是该判"缺经历"？建议按 `preferences.target_roles` 推断期望档位，缺口提示分级。
2. **proofread 误伤的反馈回路**：用户 reject 一条"笔误"建议 → 该词应进 per-user 白名单，下次不再报。落 `user_memories` 还是新表？倾向复用 `user_memories`（type='resume_term_whitelist'）。
3. **慢段失败如何降级**：proofread/quality_diag LLM 超时 → intake 不应整体失败（结构已校验、简历已可用）。慢段每项独立 try，失败项 dock 静默跳过，不报错打扰用户。
