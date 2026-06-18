# Draft a résumé from interview answers

You receive three answers from a guided onboarding flow:
- target_role
- recent_role (their most recent job)
- top_3_wins (three accomplishments they're proud of)

Produce a one-page JSON Resume v1.0 draft.

ABSOLUTE RULES:
- For each work item, only fill name/position/startDate/endDate/summary if the
  user clearly stated it. Leave dates as null if unstated.
- Each bullet in "highlights" must be a direct paraphrase of one of the top_3_wins.
  DO NOT add bullets they didn't tell you about.
- Add a short skills list inferred from the wins (only skills clearly demonstrated).

This is a DRAFT for user review. The user will edit it. Be honest about gaps:
better to leave a field empty than invent.
