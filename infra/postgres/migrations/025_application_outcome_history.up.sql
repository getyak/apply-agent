-- 025 up: append-only application lifecycle history and honest outcome cohorts.
--
-- application_drafts is the current projection used by the kanban.  Career
-- Graph feedback needs the transitions that produced that projection:
-- submitted -> interview -> rejected must retain the interview evidence even
-- when the current status changes.  A database trigger captures every writer
-- (Hono, FastAPI, MCP, extension, or manual SQL) into one owner-scoped log.

BEGIN;

ALTER TABLE application_drafts
    DROP CONSTRAINT IF EXISTS application_drafts_status_check,
    ADD CONSTRAINT application_drafts_status_check CHECK (status IN (
        'draft',
        'review',
        'submitted',
        'interview',
        'rejected',
        'offer',
        'withdrawn',
        'ghosted',
        'accepted',
        'closed'
    ));

-- The history row repeats user_id so every read can be owner scoped without
-- joining the current projection.  Tie that owner to the parent application
-- at the database boundary rather than trusting each writer to keep them in
-- sync.
ALTER TABLE application_drafts
    ADD CONSTRAINT application_drafts_id_user_unique UNIQUE (id, user_id);

CREATE INDEX idx_application_drafts_owner_resume
    ON application_drafts(user_id, resume_version_id)
    WHERE resume_version_id IS NOT NULL;

CREATE TABLE application_outcome_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL,
    application_id      UUID NOT NULL,
    event_kind          TEXT NOT NULL CHECK (event_kind IN ('baseline', 'created', 'changed')),
    event_source        TEXT NOT NULL CHECK (
        char_length(event_source) BETWEEN 1 AND 64
    ),
    changed_fields      TEXT[] NOT NULL CHECK (cardinality(changed_fields) > 0),
    from_status         TEXT,
    to_status           TEXT NOT NULL,
    from_outcome        TEXT,
    to_outcome          TEXT,
    submitted_at        TIMESTAMPTZ,
    submitted_via       TEXT,
    interview_date      DATE,
    resume_version_id   UUID,
    job_id              UUID NOT NULL,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT application_outcome_events_owned_application_fk
        FOREIGN KEY (application_id, user_id)
        REFERENCES application_drafts(id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_application_outcome_events_owner_time
    ON application_outcome_events(user_id, occurred_at DESC);
CREATE INDEX idx_application_outcome_events_application_time
    ON application_outcome_events(application_id, occurred_at, id);
CREATE INDEX idx_application_outcome_events_stage
    ON application_outcome_events(user_id, to_status, occurred_at DESC);

-- Existing projections become an explicit baseline.  They are not presented
-- as historical transitions that Relay did not observe.
INSERT INTO application_outcome_events (
    user_id,
    application_id,
    event_kind,
    event_source,
    changed_fields,
    from_status,
    to_status,
    from_outcome,
    to_outcome,
    submitted_at,
    submitted_via,
    interview_date,
    resume_version_id,
    job_id,
    occurred_at
)
SELECT
    user_id,
    id,
    'baseline',
    'migration_backfill',
    ARRAY['baseline']::TEXT[],
    NULL,
    status,
    NULL,
    outcome,
    submitted_at,
    submitted_via,
    interview_date,
    resume_version_id,
    job_id,
    COALESCE(updated_at, created_at, now())
FROM application_drafts;

CREATE OR REPLACE FUNCTION capture_application_outcome_event()
RETURNS TRIGGER AS $$
DECLARE
    fields TEXT[];
    source_name TEXT;
BEGIN
    source_name := COALESCE(
        NULLIF(current_setting('relay.application_event_source', true), ''),
        'database'
    );

    IF TG_OP = 'INSERT' THEN
        INSERT INTO application_outcome_events (
            user_id,
            application_id,
            event_kind,
            event_source,
            changed_fields,
            from_status,
            to_status,
            from_outcome,
            to_outcome,
            submitted_at,
            submitted_via,
            interview_date,
            resume_version_id,
            job_id,
            occurred_at
        ) VALUES (
            NEW.user_id,
            NEW.id,
            'created',
            source_name,
            ARRAY['created']::TEXT[],
            NULL,
            NEW.status,
            NULL,
            NEW.outcome,
            NEW.submitted_at,
            NEW.submitted_via,
            NEW.interview_date,
            NEW.resume_version_id,
            NEW.job_id,
            COALESCE(NEW.updated_at, NEW.created_at, now())
        );
        RETURN NEW;
    END IF;

    fields := array_remove(ARRAY[
        CASE WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'status' END,
        CASE WHEN OLD.outcome IS DISTINCT FROM NEW.outcome THEN 'outcome' END,
        CASE WHEN OLD.submitted_at IS DISTINCT FROM NEW.submitted_at THEN 'submitted_at' END,
        CASE WHEN OLD.submitted_via IS DISTINCT FROM NEW.submitted_via THEN 'submitted_via' END,
        CASE WHEN OLD.interview_date IS DISTINCT FROM NEW.interview_date THEN 'interview_date' END,
        CASE
            WHEN OLD.resume_version_id IS DISTINCT FROM NEW.resume_version_id
            THEN 'resume_version_id'
        END,
        CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id THEN 'job_id' END
    ]::TEXT[], NULL);

    IF cardinality(fields) = 0 THEN
        RETURN NEW;
    END IF;

    INSERT INTO application_outcome_events (
        user_id,
        application_id,
        event_kind,
        event_source,
        changed_fields,
        from_status,
        to_status,
        from_outcome,
        to_outcome,
        submitted_at,
        submitted_via,
        interview_date,
        resume_version_id,
        job_id,
        occurred_at
    ) VALUES (
        NEW.user_id,
        NEW.id,
        'changed',
        source_name,
        fields,
        OLD.status,
        NEW.status,
        OLD.outcome,
        NEW.outcome,
        NEW.submitted_at,
        NEW.submitted_via,
        NEW.interview_date,
        NEW.resume_version_id,
        NEW.job_id,
        COALESCE(NEW.updated_at, now())
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_outcome_event_capture
    AFTER INSERT OR UPDATE OF
        status,
        outcome,
        submitted_at,
        submitted_via,
        interview_date,
        resume_version_id,
        job_id
    ON application_drafts
    FOR EACH ROW
    EXECUTE FUNCTION capture_application_outcome_event();

CREATE OR REPLACE FUNCTION prevent_application_outcome_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    -- Account/application privacy deletion must still cascade.  The owned
    -- application FK is the sole delete path, and its parent row is already
    -- invisible when PostgreSQL invokes this child delete.
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1
          FROM application_drafts
         WHERE id = OLD.application_id
           AND user_id = OLD.user_id
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        'application outcome history is append-only'
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_application_outcome_events_immutable
    BEFORE UPDATE OR DELETE ON application_outcome_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_application_outcome_event_mutation();

COMMENT ON TABLE application_outcome_events IS
    'Append-only, owner-scoped lifecycle observations used for Career Graph feedback.';
COMMENT ON COLUMN application_outcome_events.event_source IS
    'Trusted writer context; database when the writer did not provide a more specific source.';
COMMENT ON COLUMN application_outcome_events.changed_fields IS
    'Projection fields that changed in this observation; baseline/created are explicit sentinels.';

COMMIT;
