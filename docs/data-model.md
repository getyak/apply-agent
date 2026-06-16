# 数据模型 · Data Model

核心 schema 设计。以 [JSON Resume](https://jsonresume.org/) 为简历脊骨。

## 核心表

### User
```sql
User {
  id            UUID PRIMARY KEY,
  email         TEXT UNIQUE,
  created_at    TIMESTAMP,
  preferences   JSONB,   -- {target_roles[], skills[], min_salary, locations[], remote}
  resume_base_id UUID    -- → Resume
}
```

### Resume(版本控制)
```sql
Resume {
  id          UUID PRIMARY KEY,
  user_id     UUID,
  version     INT,        -- 乐观锁
  content     JSONB,      -- JSON Resume schema v1.0
  is_base     BOOLEAN,    -- base vs tailored
  tailored_for_job UUID,  -- 若是定制版,指向 Job
  created_at  TIMESTAMP,
  UNIQUE(user_id, version)
}
```

### Job
```sql
Job {
  id          UUID PRIMARY KEY,
  source      TEXT,       -- greenhouse | lever | ashby | manual
  external_id TEXT,
  company     TEXT,
  role_title  TEXT,
  jd_text     TEXT,
  url         TEXT,
  posted_date TIMESTAMP,
  parsed      JSONB       -- {skills[], level, salary_min/max, locations[], remote}
}
```

### ApplicationDraft
```sql
ApplicationDraft {
  id            UUID PRIMARY KEY,
  user_id       UUID,
  job_id        UUID,
  status        TEXT,     -- draft | review | submitted | interview | rejected | offer
  resume_version UUID,
  cover_letter  TEXT,
  form_answers  JSONB,
  submitted_at  TIMESTAMP,
  submitted_via TEXT,     -- client_extension | api | manual | email
  outcome       TEXT,
  interview_date DATE
}
```

### InterviewSession + InterviewQuestion ⭐(数据飞轮核心)
```sql
InterviewSession {
  id           UUID PRIMARY KEY,
  user_id      UUID,
  job_id       UUID,
  version      INT,
  created_at   TIMESTAMP,
  completed_at TIMESTAMP
}

InterviewQuestion {
  id              UUID PRIMARY KEY,
  session_id      UUID,
  session_version INT,
  question_order  INT,
  question_text   TEXT,
  category        TEXT,    -- technical | behavioral | situational
  user_answer     TEXT,
  ai_feedback     TEXT,
  ai_rating       INT,     -- 1-5
  created_at      TIMESTAMP
}
```

## 分析表(DuckDB)

### TrendSnapshot(每日)
```sql
TrendSnapshot {
  date          DATE,
  total_jobs    INT,
  new_jobs_today INT,
  top_skills    JSONB,    -- [{skill, count, trend_pct_7d}]
  top_roles     JSONB,
  salary_stats  JSONB,
  remote_ratio  FLOAT,
  insights      JSONB
}
```

### SkillTrend(时序)
```sql
SkillTrend {
  skill        TEXT,
  date         DATE,
  count        INT,
  avg_salary   NUMERIC,
  trend_pct_7d FLOAT,
  trend_pct_30d FLOAT
}
```

## 一致性策略

### 乐观锁(简历更新)
```sql
UPDATE Resume SET content = ?, version = version + 1
WHERE user_id = ? AND version = ?
-- affected_rows == 0 → 冲突,客户端重取重试
```

### Saga(投递提交)
投递涉及多步(创建 draft → 调 ATS API → 发确认邮件 → 更新统计),任一步失败则补偿(标记 pending_manual / 排队重试)。

## 演化路径

- **MVP**:上述核心表,简单去规范化
- **Phase 2**:加 ApplicationEvent(状态变更事件)、UserMatchHistory
- **Phase 3**:加 embeddings 表(pgvector)、规范化的 CanonicalSkill / CanonicalCompany、聚合的 AggregatedInterviewQuestions

## 隐私分层

- 最敏感:简历、面试历史 → 可选纯本地(`chrome.storage.local`)或加密云存
- JD text 不必长期保存,只存提取的 metadata
- 见 [隐私与安全](privacy-security.md)
