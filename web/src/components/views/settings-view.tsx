"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Check, AlertCircle, Download, Trash2 } from "lucide-react";
import { users, clearToken, ApiError, type UserRecord, type UserPreferences } from "@/lib/api";

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

  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [salaryError, setSalaryError] = useState<string | null>(null);

  // Delete-account modal.
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

        {/* Data (export + delete) */}
        <Section title="Data" desc="Export or permanently delete everything Vantage holds about you.">
          <div className="flex flex-col gap-3">
            <div className="group relative w-fit">
              <button
                type="button"
                disabled
                className="flex cursor-not-allowed items-center gap-[7px] rounded-[9px] border border-border bg-white px-[16px] py-[10px] font-body text-[14px] font-medium text-ink-light opacity-70"
              >
                <Download className="h-[15px] w-[15px]" strokeWidth={1.8} />
                Export my data
              </button>
              <span className="pointer-events-none absolute left-0 top-full mt-1 whitespace-nowrap rounded-md bg-ink px-2 py-1 font-body text-[11px] text-paper opacity-0 transition-opacity group-hover:opacity-100">
                Coming soon
              </span>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6">
          <div className="w-full max-w-[420px] animate-fade-up rounded-[16px] border border-border bg-white p-6 shadow-xl">
            <h3 className="font-display text-[19px] font-bold text-ink">Delete your account?</h3>
            <p className="mt-2 font-body text-[13px] text-ink-light">
              This permanently deletes all your data. Type{" "}
              <span className="font-mono font-semibold text-ink">DELETE</span> to confirm.
            </p>
            <input
              autoFocus
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="DELETE"
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
