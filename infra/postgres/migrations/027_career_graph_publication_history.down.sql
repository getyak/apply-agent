BEGIN;

DROP TRIGGER IF EXISTS trg_career_graph_publication_writer ON resumes;
DROP FUNCTION IF EXISTS require_career_graph_publication_writer();

DROP TRIGGER IF EXISTS trg_career_graph_publication_events_immutable
    ON career_graph_publication_events;
DROP FUNCTION IF EXISTS prevent_career_graph_publication_event_mutation();
DROP TABLE IF EXISTS career_graph_publication_events;

ALTER TABLE career_graph_compilations
    DROP CONSTRAINT IF EXISTS career_graph_compilations_owned_resume_fk,
    DROP CONSTRAINT IF EXISTS career_graph_compilations_id_graph_user_unique;

ALTER TABLE resumes
    DROP CONSTRAINT IF EXISTS resumes_id_user_unique;

ALTER TABLE career_graphs
    DROP CONSTRAINT IF EXISTS career_graphs_id_user_unique;

COMMIT;
