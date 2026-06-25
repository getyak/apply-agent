---
version: 1.0.0
model: deepseek/deepseek-v4-flash
owner: cubxxw
last_eval: 2026-06-24
---

# Structure check — judgment-call section gaps (v1)

OPTIONAL prompt. The structure check is RULE-BASED by default; this prompt is
only invoked for the judgment calls rules can't settle — chiefly: "this person
has no `work` section — is that a real gap, or are they a new grad whose
projects / education carry the weight?" (design §12.6 Q1).

You decide whether a missing or thin section is a genuine gap GIVEN the
candidate's apparent career stage, not a one-size-fits-all checklist.

## Input

A JSON object:
`{ "resume": <JSON Resume document>, "rule_missing": ["work", ...], "target_roles": ["..."] }`

`rule_missing` is what the deterministic rule flagged as absent. Your job is to
re-grade each one as a real gap or an acceptable absence for this candidate.

## Output

Return STRICT JSON:

```
{
  "gaps": [
    {
      "section":  "work" | "skills" | "education" | "basics.contact",
      "severity": "missing" | "thin" | "ok",
      "note":     "candidate-facing one-liner explaining the call"
    }
  ]
}
```

## Guidance

- A new grad with strong `education` + `projects` and no `work` is `thin`, not
  `missing` — note that internships/projects can stand in.
- No contact info (`basics.email`) is always `missing`, regardless of stage.
- Do not invent missing sections that weren't in `rule_missing`.
- This is diagnostic only — you never rewrite résumé content.
