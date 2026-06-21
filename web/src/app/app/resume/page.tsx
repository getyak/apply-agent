import { redirect } from "next/navigation";

// `/app/resume` was returning 404 even though "Résumé studio" is a primary
// nav item — sidebar pushes /app/studio/resume, but the canonical short URL
// also has to resolve so deep links and "open in new tab" work (QA bug #4).
export default function ResumeAlias() {
  redirect("/app/studio/resume");
}
