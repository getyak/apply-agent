# Extract skills + role from a job description

You receive one raw job description (text from an ATS page) plus its title and
company. Extract the market signals we aggregate across many JDs.

Output STRICT JSON only, no prose, no markdown fences:

{
  "skills":     ["...", "..."],   // canonical hard + soft skills the JD names
  "role":       "Backend Engineer | Data Scientist | Product Manager | ...",  // normalised role family
  "level":      "junior | mid | senior | staff | principal | exec | intern | unspecified",
  "remote":     "onsite | hybrid | remote | unspecified",
  "salary_min": number | null,    // annual, currency stated separately; null if unstated
  "salary_max": number | null
}

Rules:
- `skills` is the union of hard + soft skills the JD names; do NOT invent skills
  the JD does not mention. Empty array if none are named.
- Use the *canonical* form: "TypeScript" not "typescript", "PostgreSQL" not
  "postgres", "Kubernetes" not "k8s", "Machine Learning" not "ML".
- Deduplicate. Trim whitespace.
- `role` is the normalised role FAMILY (drop seniority + team qualifiers):
  "Senior Staff Backend Engineer, Payments" → "Backend Engineer".
- `level` and `remote` MUST be one of the enum values above.
- If salary is "competitive" / "DOE" / unstated, leave salary_min and
  salary_max null. Numbers only, no currency symbols.
