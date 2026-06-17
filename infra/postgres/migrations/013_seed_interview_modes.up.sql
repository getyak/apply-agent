-- 013 up: seed built-in Mock interview modes
--
-- Caller: infra/docker-compose.yml auto-loads on PG first start; make db-reset
-- replays the full migrations dir in lexicographic order. CI migration-check
-- (cicd-aiops-harness.md § 1.4) re-applies after rollback for idempotency.
--
-- Field shape (synthetic, no PII):
--   { slug: "scene_recreation", intel_strategy: "crowdsourced",
--     pressure_level: "one_follow_up", feedback_style: "three_perspective_translation",
--     loop_behavior: "save_to_card", is_built_in: true, user_id: NULL }
-- No date columns; created_at default = now() applies.
--
-- These four modes implement the four levers from
-- docs/architecture/vantage-ui-mapping.md § 3.1:
--   intel × pressure × feedback × loop
--
-- Idempotency strategy: ON CONFLICT can't infer the partial unique index
-- (idx_modes_builtin_slug WHERE user_id IS NULL) on all PG versions, so we
-- gate each INSERT with WHERE NOT EXISTS and follow with an UPDATE that's
-- always safe to re-run. IDs survive re-seeds; FKs from interview_sessions
-- stay valid.

BEGIN;

-- 1. Scene recreation — 还原现场, 带情报进场, 1 次追问, 读心翻译
INSERT INTO interview_modes (
    user_id, slug, display_name, description,
    intel_strategy, pressure_level, feedback_style, loop_behavior, is_built_in
)
SELECT NULL, 'scene_recreation', 'Scene recreation',
       'Walk in armed. We pull the company×round''s historical questions, mark the trap question, then drill it. Each answer gets one follow-up and a three-perspective read of what the interviewer actually heard.',
       'crowdsourced', 'one_follow_up', 'three_perspective_translation', 'save_to_card', true
WHERE NOT EXISTS (
    SELECT 1 FROM interview_modes WHERE user_id IS NULL AND slug = 'scene_recreation'
);

-- 2. Pressure drill — 压力面, JD 真实考点 + 连环追问 + 卡壳复盘
INSERT INTO interview_modes (
    user_id, slug, display_name, description,
    intel_strategy, pressure_level, feedback_style, loop_behavior, is_built_in
)
SELECT NULL, 'pressure_drill', 'Pressure drill',
       'Hard mode. Questions derived from the JD''s real subtext, chained follow-ups until you stall. After you stall we replay where it broke and how to recover. The post-mortem you wish you''d had after the real interview.',
       'jd_based', 'chained_to_stuck', 'three_perspective_translation', 'save_to_card', true
WHERE NOT EXISTS (
    SELECT 1 FROM interview_modes WHERE user_id IS NULL AND slug = 'pressure_drill'
);

-- 3. Warm-up — 暖身, 无情报, 只鼓励, 不追问
INSERT INTO interview_modes (
    user_id, slug, display_name, description,
    intel_strategy, pressure_level, feedback_style, loop_behavior, is_built_in
)
SELECT NULL, 'warm_up', 'Warm-up',
       'Confidence build. No intel, no follow-ups, no pressure. We coach gently after each answer — every reframe ends with what you did well first. For the morning of an interview, or when your head''s noisy.',
       'none', 'encourage_only', 'three_perspective_translation', 'standalone', true
WHERE NOT EXISTS (
    SELECT 1 FROM interview_modes WHERE user_id IS NULL AND slug = 'warm_up'
);

-- 4. Rapid fire — 快问快答, 短问短答, 1 行反馈, 练反应
INSERT INTO interview_modes (
    user_id, slug, display_name, description,
    intel_strategy, pressure_level, feedback_style, loop_behavior, is_built_in
)
SELECT NULL, 'rapid_fire', 'Rapid fire',
       'Reflex training. Short questions, short answers, one-line feedback per round. Builds the muscle for phone screens where you have 90 seconds to land each answer.',
       'none', 'encourage_only', 'one_line_per_answer', 'save_to_card', true
WHERE NOT EXISTS (
    SELECT 1 FROM interview_modes WHERE user_id IS NULL AND slug = 'rapid_fire'
);

-- Refresh display_name + description on every re-apply (cheap, harmless,
-- lets us iterate on copy without a new migration).
UPDATE interview_modes SET
    display_name = vals.display_name,
    description  = vals.description
FROM (VALUES
    ('scene_recreation',
     'Scene recreation',
     'Walk in armed. We pull the company×round''s historical questions, mark the trap question, then drill it. Each answer gets one follow-up and a three-perspective read of what the interviewer actually heard.'),
    ('pressure_drill',
     'Pressure drill',
     'Hard mode. Questions derived from the JD''s real subtext, chained follow-ups until you stall. After you stall we replay where it broke and how to recover. The post-mortem you wish you''d had after the real interview.'),
    ('warm_up',
     'Warm-up',
     'Confidence build. No intel, no follow-ups, no pressure. We coach gently after each answer — every reframe ends with what you did well first. For the morning of an interview, or when your head''s noisy.'),
    ('rapid_fire',
     'Rapid fire',
     'Reflex training. Short questions, short answers, one-line feedback per round. Builds the muscle for phone screens where you have 90 seconds to land each answer.')
) AS vals(slug, display_name, description)
WHERE interview_modes.user_id IS NULL
  AND interview_modes.slug = vals.slug;

COMMIT;
