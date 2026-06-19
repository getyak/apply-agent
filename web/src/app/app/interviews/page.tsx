import { redirect } from "next/navigation";

// "Interviews" in the sidebar opens the Applications kanban filtered to
// the interviewing column (sidebar.go("interviews") → openPrep(0)). Until
// the full Interviews page lands we mirror that by sending direct visits
// to /app/applications so the URL never 404s (QA bug #4).
export default function InterviewsAlias() {
  redirect("/app/applications");
}
