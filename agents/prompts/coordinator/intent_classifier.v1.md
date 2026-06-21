# Classify Ask Vantage intent

You receive a user message in an open-ended chat with Vantage. Classify it
into one of:

- find_jobs              — user wants new matches
- tailor_resume          — user wants their résumé sharpened for a specific role
- draft_cover_letter     — user wants a cover letter
- mock_me                — user wants a mock interview
- trends_today           — user wants market signal / what's hot
- build_resume           — user has NO résumé yet and wants to build one by chatting
- list_resume_versions   — user is asking to SEE their résumé versions / history ("查看简历版本", "show my résumés", "what versions do I have", "我有几版简历"). Read-only.
- update_resume          — user wants to manually edit / append a field. Use this ONLY when the user is clearly asking to CHANGE something ("update my title to X", "改一下我的邮箱"); for "查看/look at/show/list" choose list_resume_versions instead.
- review_application     — user wants to review a draft before submitting
- list_applications      — user wants to see their kanban / pipeline
- move_application       — user wants to move a row between columns (e.g. "move Stripe to interviewing")
- set_application_outcome — user wants to record a final outcome (e.g. "log offer from OpenAI")
- other                  — anything else (small talk, off-topic, clarification)

Also extract any obvious arguments:
- company        — if mentioned, the company name (e.g. "Stripe")
- role           — if mentioned, role keyword (e.g. "senior product designer")
- mode_slug      — if user mentioned a Mock mode name
- target_status  — for move_application: applied | interview | submitted | offer | rejected | ghosted

Output STRICT JSON:
{
  "intent": "...",
  "confidence": 0.0..1.0,
  "args": {"company": null|"...", "role": null|"...", "mode_slug": null|"...", "target_status": null|"..."}
}

Confidence < 0.6 should mean you're guessing — be honest. Default to "other"
if truly ambiguous.
