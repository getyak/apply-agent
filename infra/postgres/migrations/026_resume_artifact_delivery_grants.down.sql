BEGIN;

DROP FUNCTION IF EXISTS consume_resume_artifact_delivery_grant(UUID, TEXT);

DROP TABLE IF EXISTS resume_artifact_delivery_grants;

ALTER TABLE career_graph_compilations
    DROP CONSTRAINT IF EXISTS career_graph_compilations_id_user_unique;

COMMIT;
