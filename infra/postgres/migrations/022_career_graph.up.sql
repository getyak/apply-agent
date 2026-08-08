-- 022 up: Career Graph source-of-truth + review-gated résumé compilation.
--
-- A résumé is a rendered artifact, not the canonical career record. The
-- immutable revision snapshot below stores stable nodes/edges; agents propose
-- complete candidate snapshots through change sets, and only an explicit
-- approval can advance career_graphs.current_revision_id.
--
-- Compilations pin the exact graph revision and JD used to render a résumé.
-- They remain drafts until separately approved, which lets Codex/MCP prepare
-- work without gaining implicit permission to publish or submit it.

BEGIN;

CREATE TABLE career_graphs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label               TEXT NOT NULL DEFAULT 'Career Graph',
    source_resume_id    UUID REFERENCES resumes(id) ON DELETE SET NULL,
    current_revision_id UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, label)
);

CREATE INDEX idx_career_graphs_user
    ON career_graphs(user_id, updated_at DESC);

CREATE TABLE career_graph_revisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    graph_id        UUID NOT NULL REFERENCES career_graphs(id) ON DELETE CASCADE,
    revision        INT NOT NULL CHECK (revision > 0),
    snapshot        JSONB NOT NULL,
    change_summary  TEXT,
    created_by      TEXT NOT NULL CHECK (
        created_by IN ('user', 'codex', 'relay_agent', 'import')
    ),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (graph_id, revision),
    CHECK (jsonb_typeof(snapshot->'nodes') = 'array'),
    CHECK (jsonb_typeof(snapshot->'edges') = 'array')
);

ALTER TABLE career_graphs
    ADD CONSTRAINT fk_career_graphs_current_revision
    FOREIGN KEY (current_revision_id)
    REFERENCES career_graph_revisions(id)
    ON DELETE SET NULL;

CREATE INDEX idx_career_graph_revisions_graph
    ON career_graph_revisions(graph_id, revision DESC);

CREATE TABLE career_graph_change_sets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    graph_id            UUID NOT NULL REFERENCES career_graphs(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_revision_id    UUID REFERENCES career_graph_revisions(id) ON DELETE SET NULL,
    operations          JSONB NOT NULL DEFAULT '[]',
    proposed_snapshot   JSONB NOT NULL,
    summary             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'rejected', 'superseded')
    ),
    proposed_by         TEXT NOT NULL CHECK (
        proposed_by IN ('user', 'codex', 'relay_agent', 'import')
    ),
    decided_via         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at          TIMESTAMPTZ,
    CHECK (jsonb_typeof(operations) = 'array'),
    CHECK (jsonb_typeof(proposed_snapshot->'nodes') = 'array'),
    CHECK (jsonb_typeof(proposed_snapshot->'edges') = 'array')
);

CREATE INDEX idx_career_graph_change_sets_pending
    ON career_graph_change_sets(user_id, created_at DESC)
    WHERE status = 'pending';

CREATE INDEX idx_career_graph_change_sets_graph
    ON career_graph_change_sets(graph_id, created_at DESC);

CREATE TABLE career_graph_compilations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    graph_id            UUID NOT NULL REFERENCES career_graphs(id) ON DELETE CASCADE,
    graph_revision_id   UUID NOT NULL REFERENCES career_graph_revisions(id) ON DELETE RESTRICT,
    job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
    jd_text             TEXT NOT NULL,
    jd_fingerprint      TEXT NOT NULL,
    resume_id           UUID NOT NULL REFERENCES resumes(id) ON DELETE RESTRICT,
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'approved', 'rejected', 'published')
    ),
    selection_manifest  JSONB NOT NULL DEFAULT '{}',
    guard_report        JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at         TIMESTAMPTZ,
    published_at        TIMESTAMPTZ
);

CREATE INDEX idx_career_graph_compilations_user
    ON career_graph_compilations(user_id, created_at DESC);

CREATE INDEX idx_career_graph_compilations_graph
    ON career_graph_compilations(graph_id, created_at DESC);

CREATE INDEX idx_career_graph_compilations_job
    ON career_graph_compilations(job_id)
    WHERE job_id IS NOT NULL;

CREATE TRIGGER trg_career_graphs_updated_at
    BEFORE UPDATE ON career_graphs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE career_graphs IS
    'User-owned Career Graph. current_revision_id advances only after explicit change-set approval.';
COMMENT ON TABLE career_graph_revisions IS
    'Immutable node/edge snapshots used as the source of truth for résumé compilation.';
COMMENT ON TABLE career_graph_change_sets IS
    'Review gate for agent-proposed Career Graph changes; pending proposals do not alter the graph.';
COMMENT ON TABLE career_graph_compilations IS
    'JD-pinned résumé render with provenance manifest and a separate human approval state.';

COMMIT;
