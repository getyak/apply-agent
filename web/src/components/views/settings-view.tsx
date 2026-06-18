"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Check, AlertCircle, Download, Trash2 } from "lucide-react";
import {
  users,
  resumes as resumesApi,
  applications as applicationsApi,
  clearToken,
  ApiError,
  type UserRecord,
  type UserPreferences,
} from "@/lib/api";

type RemoteChoice = "any" | "remote" | "hybrid" | "onsite";

// The API only stores a boolean `remote`. We map the richer UI select onto it:
// "remote" → true, "onsite"/"hybrid" → false, "any" → omit the field. On read we
// can only recover remote/onsite/any (hybrid collapses to onsite on round-trip).
function remoteFromBool(v: boolean | undefined): RemoteChoice {
  if (v === true) return "remote";
  if (v === false) return "onsite";
  return "any";
}
function remoteToBool(v: RemoteChoice): boolean | undefined {
  if (v === "remote") return true;
  if (v === "onsite" || v === "hybrid") return false;
  return undefined;
}

// Tag-style multi input: a list of strings with add (Enter / comma) + remove.
function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const t = draft.trim().replace(/,$/, "").trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft("");
  };

  return (
    <label className="block">
      <span className="font-body text-[13px] font-semibold text-ink">{label}</span>
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-white px-3 py-[10px] transition-colors focus-within:border-border-dark">
        {values.map((v) => (
          <span
            key={v}
            className="flex items-center gap-[6px] rounded-[7px] bg-cream px-[9px] py-[4px] font-body text-[13px] text-brown"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="cursor-pointer text-brown/60 hover:text-brown"
              aria-label={`Remove ${v}`}
            >
              <X className="h-[13px] w-[13px]" strokeWidth={2} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={values.length ? "" : placeholder}
          className="min-w-[120px] flex-1 border-none bg-transparent font-body text-[14px] text-ink outline-none placeholder:text-ink-muted"
        />
      </div>
    </label>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-border bg-white p-6 shadow-sm">
      <h2 className="font-display text-[18px] font-bold text-ink">{title}</h2>
      <p className="mt-1 font-body text-[13px] text-ink-light">{desc}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function SettingsView() {
  const router = useRouter();
  const [me, setMe] = useState<UserRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Job-preferences form state.
  const [targetRoles, setTargetRoles] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [minSalary, setMinSalary] = useState<string>("");
  const [remote, setRemote] = useState<RemoteChoice>("any");
  // Data-flywheel opt-in (vantage-ui-mapping.md §3.5). Starts false until
  // we hear from the server — the answer "off" is never silently flipped on.
  const [crowdsourceOptIn, setCrowdsourceOptIn] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [salaryError, setSalaryError] = useState<string | null>(null);

  // Delete-account modal.
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Export. vision.md commits to letting users export every byte we hold;
  // until the API ships a one-shot /api/users/export, we aggregate
  // client-side from existing endpoints. This is honest-degrade: it covers
  // user + résumés + applications, which is everything the API currently
  // returns scoped to the caller.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    users
      .getMe()
      .then(({ user }) => {
        setMe(user);
        const p: UserPreferences = user.preferences ?? {};
        setTargetRoles(p.targetRoles ?? []);
        setSkills(p.skills ?? []);
        setLocations(p.locations ?? []);
        setMinSalary(p.minSalary != null ? String(p.minSalary) : "");
        setRemote(remoteFromBool(p.remote));
        setCrowdsourceOptIn(p.crowdsourceOptIn === true);
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Could not load your profile.");
      });
  }, []);

  const onSave = async () => {
    setSaveOk(false);
    setSaveError(null);
    setSalaryError(null);

    let parsedSalary: number | undefined;
    if (minSalary.trim() !== "") {
      const n = Number(minSalary);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        setSalaryError("Enter a whole, non-negative number.");
        return;
      }
      parsedSalary = n;
    }

    // The schema treats every field as optional and rejects unknown keys. We
    // always send the three lists (empty array == "I cleared this"); salary and
    // remote are omitted when not set so we don't write a default the user
    // never chose.
    const preferences: UserPreferences = { targetRoles, skills, locations };
    if (parsedSalary !== undefined) preferences.minSalary = parsedSalary;
    const remoteBool = remoteToBool(remote);
    if (remoteBool !== undefined) preferences.remote = remoteBool;
    // Always send the opt-in explicitly. Sending `false` when the user
    // turns it off is the whole point — silently dropping the field would
    // leave a stale `true` in storage.
    preferences.crowdsourceOptIn = crowdsourceOptIn;

    setSaving(true);
    try {
      const { user } = await users.updateMe(preferences);
      setMe(user);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save your preferences.");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (deleteConfirm !== "DELETE") return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await users.deleteMe();
      clearToken();
      router.replace("/");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete your account.");
      setDeleting(false);
    }
  };

  const onExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      // Fan out reads in parallel — these endpoints are scoped to the caller
      // and don't depend on each other. Each response is unwrapped from its
      // envelope (`{user}`, `{data|resumes}`, etc.) so the export stays flat.
      const [meRes, resumesRes, appsRes] = await Promise.all([
        users.getMe(),
        resumesApi.list().catch(() => ({ data: [] as unknown[] })),
        applicationsApi.list().catch(() => ({ data: [] as unknown[] })),
      ]);

      const unwrap = (
        res: unknown,
        key: "resumes" | "applications",
      ): unknown[] => {
        const r = res as Record<string, unknown>;
        return (
          (r.data as unknown[] | undefined) ??
          (r[key] as unknown[] | undefined) ??
          []
        );
      };

      const payload = {
        schema: "vantage.export.v1",
        exported_at: new Date().toISOString(),
        user: meRes.user,
        resumes: unwrap(resumesRes, "resumes"),
        applications: unwrap(appsRes, "applications"),
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `vantage-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(
        err instanceof ApiError ? err.message : "Could not export your data.",
      );
    } finally {
      setExporting(false);
    }
  };

  // Esc cancels the delete modal — standard dialog affordance. We do NOT
  // bind Enter to confirm; the DELETE-typing requirement is the intentional
  // friction agent-harness.md §HITL calls for on destructive actions.
  useEffect(() => {
    if (!showDelete) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !deleting) setShowDelete(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showDelete, deleting]);

  const created = me?.created_at
    ? new Date(me.created_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "—";

  return (
    <div className="mx-auto max-w-[760px] animate-fade-up px-12 pb-[60px] pt-10">
      <div className="mb-[10px] font-mono text-[11px] uppercase tracking-[1px] text-ink-muted">
        Account
      </div>
      <h1 className="mb-[26px] font-display text-[32px] font-bold -tracking-[0.3px] text-ink">
        Settings
      </h1>

      {loadError && (
        <div className="mb-6 flex items-center gap-2 rounded-[10px] border border-border bg-cream px-4 py-3 font-body text-[13px] text-ink">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber" strokeWidth={2} />
          {loadError}
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* Profile (read-only) */}
        <Section title="Profile" desc="Your account details. Read-only for now.">
          <dl className="grid grid-cols-[140px_1fr] gap-y-3 font-body text-[14px]">
            <dt className="text-ink-light">Email</dt>
            <dd className="text-ink">{me?.email ?? "—"}</dd>
            <dt className="text-ink-light">Display name</dt>
            <dd className="text-ink">{me?.display_name || "—"}</dd>
            <dt className="text-ink-light">Member since</dt>
            <dd className="text-ink">{created}</dd>
          </dl>
        </Section>

        {/* Job preferences (editable) */}
        <Section
          title="Job preferences"
          desc="What Vantage matches against. The closer this is to reality, the better your daily briefing."
        >
          <div className="flex flex-col gap-5">
            <TagInput
              label="Target roles"
              values={targetRoles}
              onChange={setTargetRoles}
              placeholder="e.g. Senior Product Designer — press Enter"
            />
            <TagInput
              label="Skills"
              values={skills}
              onChange={setSkills}
              placeholder="e.g. Figma, Design systems — press Enter"
            />
            <TagInput
              label="Locations"
              values={locations}
              onChange={setLocations}
              placeholder="e.g. Remote, New York — press Enter"
            />

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="font-body text-[13px] font-semibold text-ink">
                  Minimum salary (USD)
                </span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={minSalary}
                  onChange={(e) => setMinSalary(e.target.value)}
                  placeholder="120000"
                  className="mt-2 w-full rounded-[10px] border border-border bg-white px-3 py-[10px] font-body text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-border-dark"
                />
                {salaryError && (
                  <span className="mt-1 block font-body text-[12px] text-red-600">{salaryError}</span>
                )}
              </label>

              <label className="block">
                <span className="font-body text-[13px] font-semibold text-ink">Work arrangement</span>
                <select
                  value={remote}
                  onChange={(e) => setRemote(e.target.value as RemoteChoice)}
                  className="mt-2 w-full cursor-pointer rounded-[10px] border border-border bg-white px-3 py-[11px] font-body text-[14px] text-ink outline-none transition-colors focus:border-border-dark"
                >
                  <option value="any">Any</option>
                  <option value="remote">Remote</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="onsite">On-site</option>
                </select>
              </label>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="flex items-center gap-[7px] rounded-[9px] border-none bg-brown px-[18px] py-[11px] font-body text-[14px] font-semibold text-paper transition-colors hover:bg-brown-light disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check className="h-[15px] w-[15px]" strokeWidth={2} />
                {saving ? "Saving…" : "Save preferences"}
              </button>
              {saveOk && (
                <span className="flex items-center gap-[6px] font-body text-[13px] font-medium text-green">
                  <Check className="h-4 w-4" strokeWidth={2.4} />
                  Saved
                </span>
              )}
              {saveError && (
                <span className="flex items-center gap-[6px] font-body text-[13px] text-red-600">
                  <AlertCircle className="h-4 w-4" strokeWidth={2} />
                  {saveError}
                </span>
              )}
            </div>
          </div>
        </Section>

        {/* Privacy — flywheel opt-in (vantage-ui-mapping.md §3.5) */}
        <Section
          title="Privacy"
          desc="Help future job-seekers without exposing yourself. Off by default."
        >
          <div className="flex items-start gap-3 rounded-[10px] border border-border bg-paper px-4 py-3">
            <label
              htmlFor="crowdsource-opt-in"
              className="flex-1 cursor-pointer"
            >
              <div className="font-body text-[14px] font-semibold text-ink">
                Donate anonymised interview questions to the shared pool
              </div>
              <p className="mt-1 font-body text-[13px] leading-[1.55] text-ink-light">
                When you log a real interview, Vantage strips company /
                personal identifiers and contributes the question text to a
                pool that helps other users prep for the same round. Your
                résumé, answers, and outcomes never leave your account. You
                can turn this off at any time and any previously donated
                questions stay in the pool — past contributions are
                anonymised, so we can&apos;t pull a specific one back.
              </p>
              <a
                href="/legal/privacy"
                className="mt-1 inline-block font-body text-[12px] text-brown underline hover:no-underline"
              >
                Read what we collect →
              </a>
            </label>
            <button
              id="crowdsource-opt-in"
              type="button"
              role="switch"
              aria-checked={crowdsourceOptIn}
              onClick={() => setCrowdsourceOptIn((v) => !v)}
              className={`mt-1 relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                crowdsourceOptIn ? "bg-brown" : "bg-border-dark"
              }`}
            >
              <span
                className={`absolute top-[2px] h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  crowdsourceOptIn ? "translate-x-[22px]" : "translate-x-[2px]"
                }`}
              />
              <span className="sr-only">
                {crowdsourceOptIn ? "On" : "Off"} — toggle question donation
              </span>
            </button>
          </div>
        </Section>

        {/* Data (export + delete) */}
        <Section title="Data" desc="Export or permanently delete everything Vantage holds about you.">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onExport}
                disabled={exporting}
                className="flex w-fit items-center gap-[7px] rounded-[9px] border border-border bg-white px-[16px] py-[10px] font-body text-[14px] font-medium text-ink transition-colors hover:border-border-dark disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-[15px] w-[15px]" strokeWidth={1.8} />
                {exporting ? "Preparing export…" : "Export my data"}
              </button>
              <p className="font-body text-[12px] text-ink-light">
                Downloads a JSON file with your profile, all résumé versions, and every
                application Vantage holds for you. No server-side queue — generated on
                the spot.
              </p>
              {exportError && (
                <span className="flex items-center gap-[6px] font-body text-[12px] text-red-600">
                  <AlertCircle className="h-[14px] w-[14px]" strokeWidth={2} />
                  {exportError}
                </span>
              )}
            </div>

            <div className="mt-2 rounded-[10px] border border-red-200 bg-red-50/60 p-4">
              <div className="font-body text-[14px] font-semibold text-ink">Delete account</div>
              <p className="mt-1 font-body text-[13px] text-ink-light">
                Permanently erases your résumés, applications, interviews, and profile. This cannot be
                undone.
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowDelete(true);
                  setDeleteConfirm("");
                  setDeleteError(null);
                }}
                className="mt-3 flex items-center gap-[7px] rounded-[9px] border border-red-300 bg-white px-[16px] py-[9px] font-body text-[14px] font-semibold text-red-600 transition-colors hover:bg-red-600 hover:text-white"
              >
                <Trash2 className="h-[15px] w-[15px]" strokeWidth={1.9} />
                Delete my account
              </button>
            </div>
          </div>
        </Section>
      </div>

      {/* Delete confirmation modal */}
      {showDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          onClick={() => {
            if (!deleting) setShowDelete(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[420px] animate-fade-up rounded-[16px] border border-border bg-white p-6 shadow-xl"
          >
            <h3
              id="delete-account-title"
              className="font-display text-[19px] font-bold text-ink"
            >
              Delete your account?
            </h3>
            <p className="mt-2 font-body text-[13px] text-ink-light">
              This permanently deletes all your data. Type{" "}
              <span className="font-mono font-semibold text-ink">DELETE</span> to confirm.
            </p>
            <input
              autoFocus
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="DELETE"
              aria-label="Type DELETE to confirm"
              className="mt-4 w-full rounded-[10px] border border-border bg-white px-3 py-[10px] font-mono text-[14px] text-ink outline-none focus:border-red-300"
            />
            {deleteError && (
              <span className="mt-2 flex items-center gap-[6px] font-body text-[12px] text-red-600">
                <AlertCircle className="h-[14px] w-[14px]" strokeWidth={2} />
                {deleteError}
              </span>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDelete(false)}
                disabled={deleting}
                className="rounded-[9px] border border-border bg-white px-[16px] py-[9px] font-body text-[14px] font-medium text-ink transition-colors hover:bg-cream disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={deleteConfirm !== "DELETE" || deleting}
                className="rounded-[9px] border-none bg-red-600 px-[16px] py-[9px] font-body text-[14px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
