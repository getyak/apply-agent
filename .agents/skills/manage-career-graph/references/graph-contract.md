# Career Graph operation contract

## Snapshot

```json
{
  "schema_version": 1,
  "nodes": [],
  "edges": []
}
```

Every node requires:

- `id`: stable, descriptive ID such as `role:acme-2022` or
  `achievement:billing-postgres`.
- `type`: one of `person`, `role`, `achievement`, `project`, `education`,
  `skill`, `certification`, `language`.
- `data`: type-specific facts.
- `provenance.source_type`: one of `user_asserted`, `resume_import`,
  `document`, `application_feedback`.
- `provenance.source_ref`: a required, non-empty source locator such as a
  résumé version, attachment name, application ID, or current user message.

Recommended data fields:

- `person`: `name`, `email`, `phone`, `url`, `summary`, `location`.
- `role`: `organization`, `position`, `start_date`, `end_date`, `location`,
  `summary`, `url`.
- `achievement`: `text`.
- `project`: `name`, `description`, `start_date`, `end_date`, `url`,
  `highlights`, `keywords`.
- `education`: `institution`, `area`, `study_type`, `start_date`, `end_date`,
  `score`, `url`.
- `skill`: `name`, `level`, `keywords`.
- `certification`: `name`, `date`, `issuer`, `url`.
- `language`: `language`, `fluency`.

Every edge requires `id`, `from`, `to`, and `type`. Both endpoints must exist.
Allowed types:

- `held_role`: person → role
- `includes` or `delivered`: role → achievement
- `demonstrates` or `used_skill`: achievement/project → skill
- `built_project`: person/role → project
- `studied`: person → education
- `earned`: person → certification
- `speaks`: person → language

## Operations

Use only these operations:

```json
{"op": "upsert_node", "node": {"id": "...", "type": "...", "data": {}, "provenance": {}}}
{"op": "remove_node", "node_id": "..."}
{"op": "upsert_edge", "edge": {"id": "...", "from": "...", "to": "...", "type": "..."}}
{"op": "remove_edge", "edge_id": "..."}
```

Removing a node also removes all incident edges. Prefer `upsert_node` with the
same ID for corrections so revision history retains identity.

## Evidence rules

- Copy claims faithfully; do not convert qualitative language into metrics.
- Do not treat JD requirements as candidate facts.
- Do not translate proper nouns, employer names, product names, credentials,
  or technologies.
- If wording is ambiguous, preserve the original wording or ask the user.
- The résumé compiler may select and reorder facts but does not generate new
  claims.
