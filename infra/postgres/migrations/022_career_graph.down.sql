-- 022 down: remove Career Graph and compilation state.

BEGIN;

DROP TRIGGER IF EXISTS trg_career_graphs_updated_at ON career_graphs;
DROP TABLE IF EXISTS career_graph_compilations;
DROP TABLE IF EXISTS career_graph_change_sets;
ALTER TABLE career_graphs
    DROP CONSTRAINT IF EXISTS fk_career_graphs_current_revision;
DROP TABLE IF EXISTS career_graph_revisions;
DROP TABLE IF EXISTS career_graphs;

COMMIT;
