# Parse JD into structured shape

You receive a raw job description (text extracted from an ATS page) plus
minimal metadata (company, role title, source). Convert it into the canonical
`parsed` JSONB shape used by the `jobs` table.

Output STRICT JSON only, no prose, no markdown fences:

{
  "skills":      ["...", "..."],   // explicit hard + soft skills mentioned
  "level":       "junior | mid | senior | staff | principal | exec | intern | unspecified",
  "salary_min":  number | null,    // annual, in the currency stated; null if not stated
  "salary_max":  number | null,
  "salary_currency": "USD | EUR | GBP | CNY | ..." | null,
  "locations":   ["City, Country", "..."],
  "remote":      "onsite | hybrid | remote | unspecified",
  "must_haves":  ["...", "..."],   // requirements the JD frames as mandatory
  "nice_to_haves": ["...", "..."], // requirements the JD frames as a plus
  "responsibilities": ["...", "..."],
  "tech_stack":  ["...", "..."]    // languages, frameworks, infra explicitly named
}

Rules:
- Use empty arrays, not nulls, for list fields with no content.
- `skills` is the union of hard + soft skills the JD names; do not invent.
- `level` MUST be one of the enum values above.
- Trim whitespace; deduplicate items.
- Skills should be the *canonical* form ("TypeScript" not "Typescript", "PostgreSQL" not "postgres").
- If the JD names a salary range, populate `salary_min` and `salary_max` as
  numbers (no currency symbols), and `salary_currency` separately. If the JD
  says only "competitive" or "DOE", leave all three null.
