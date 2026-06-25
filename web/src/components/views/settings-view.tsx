"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { X, Check, AlertCircle, Download, Trash2 } from "lucide-react";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
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
  const t = useTranslations("settings");
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
              aria-label={t("jobPrefs.removeTag", { value: v })}
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
  const t = useTranslations("settings");
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

  // S3 (round-5): unsaved-changes guard. The form is unguarded until
  // round-5 — a user could edit five fields, navigate away, and silently
  // lose every change. We store the loaded baseline as a JSON snapshot in
  // a ref (no re-renders) and a live snapshot in a separate ref kept in
  // sync from a small effect (so we never touch ref.current during render).
  // beforeunload then compares the two at fire time and asks the browser
  // to show its native confirm dialog when they differ.
  const baselineRef = useRef<string | null>(null);
  const snapshotRef = useRef<string>("");
  useEffect(() => {
    snapshotRef.current = JSON.stringify({
      targetRoles,
      skills,
      locations,
      minSalary,
      remote,
      crowdsourceOptIn,
    });
  }, [targetRoles, skills, locations, minSalary, remote, crowdsourceOptIn]);

  useEffect(() => {
    users
      .getMe()
      .then(({ user }) => {
        setMe(user);
        const p: UserPreferences = user.preferences ?? {};
        const loadedTargetRoles = p.targetRoles ?? [];
        const loadedSkills = p.skills ?? [];
        const loadedLocations = p.locations ?? [];
        const loadedMinSalary = p.minSalary != null ? String(p.minSalary) : "";
        const loadedRemote = remoteFromBool(p.remote);
        const loadedCrowdsource = p.crowdsourceOptIn === true;
        setTargetRoles(loadedTargetRoles);
        setSkills(loadedSkills);
        setLocations(loadedLocations);
        setMinSalary(loadedMinSalary);
        setRemote(loadedRemote);
        setCrowdsourceOptIn(loadedCrowdsource);
        // Snapshot the just-loaded values as the "clean" baseline. Any
        // subsequent edit flips isDirty true; saving (below) resets it.
        baselineRef.current = JSON.stringify({
          targetRoles: loadedTargetRoles,
          skills: loadedSkills,
          locations: loadedLocations,
          minSalary: loadedMinSalary,
          remote: loadedRemote,
          crowdsourceOptIn: loadedCrowdsource,
        });
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : t("errors.load"));
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: BeforeUnloadEvent) => {
      const base = baselineRef.current;
      if (base === null || base === snapshotRef.current) return;
      // Modern browsers ignore the custom string but honour
      // preventDefault + returnValue to show their own confirm dialog.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const onSave = async () => {
    setSaveOk(false);
    setSaveError(null);
    setSalaryError(null);

    let parsedSalary: number | undefined;
    if (minSalary.trim() !== "") {
      const n = Number(minSalary);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        setSalaryError(t("errors.salaryInteger"));
        return;
      }
      // S1 (round-6): mirror the server-side cap from
      // api/src/schemas.ts UserPreferencesSchema (10_000_000). Before
      // round-6 the client only rejected negatives, so values >10M were
      // silently rejected by the server with a generic "Could not save"
      // toast and no field-level cue. Catch it here so the same inline
      // salaryError surfaces and onSave can short-circuit cheaply.
      if (n > 10_000_000) {
        setSalaryError(t("errors.salaryMax"));
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
      // S3 (round-5): re-baseline so isDirty flips back to false and the
      // beforeunload listener stops nagging. Recompute from current form
      // state (which already matches what we just persisted) so a follow-up
      // edit re-marks dirty correctly.
      baselineRef.current = JSON.stringify({
        targetRoles,
        skills,
        locations,
        minSalary,
        remote,
        crowdsourceOptIn,
      });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : t("errors.save"));
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
      setDeleteError(err instanceof ApiError ? err.message : t("errors.delete"));
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
        err instanceof ApiError ? err.message : t("errors.export"),
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
        {t("account")}
      </div>
      <h1 className="mb-[26px] font-display text-[32px] font-bold -tracking-[0.3px] text-ink">
        {t("title")}
      </h1>

      {loadError && (
        <div className="mb-6 flex items-center gap-2 rounded-[10px] border border-border bg-cream px-4 py-3 font-body text-[13px] text-ink">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber" strokeWidth={2} />
          {loadError}
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* Language (interface locale) */}
        <Section title={t("language.title")} desc={t("language.desc")}>
          <LanguageSwitcher variant="segmented" />
        </Section>

        {/* Profile (read-only) */}
        <Section title={t("profile.title")} desc={t("profile.desc")}>
          <dl className="grid grid-cols-[140px_1fr] gap-y-3 font-body text-[14px]">
            <dt className="text-ink-light">{t("profile.email")}</dt>
            <dd className="text-ink">{me?.email ?? "—"}</dd>
            <dt className="text-ink-light">{t("profile.displayName")}</dt>
            <dd className="text-ink">{me?.display_name || "—"}</dd>
            <dt className="text-ink-light">{t("profile.memberSince")}</dt>
            <dd className="text-ink">{created}</dd>
          </dl>
        </Section>

        {/* Job preferences (editable) */}
        <Section
          title={t("jobPrefs.title")}
          desc={t("jobPrefs.desc")}
        >
          <div className="flex flex-col gap-5">
            <TagInput
              label={t("jobPrefs.targetRoles")}
              values={targetRoles}
              onChange={setTargetRoles}
              placeholder={t("jobPrefs.targetRolesPlaceholder")}
            />
            <TagInput
              label={t("jobPrefs.skills")}
              values={skills}
              onChange={setSkills}
              placeholder={t("jobPrefs.skillsPlaceholder")}
            />
            <TagInput
              label={t("jobPrefs.locations")}
              values={locations}
              onChange={setLocations}
              placeholder={t("jobPrefs.locationsPlaceholder")}
            />

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="font-body text-[13px] font-semibold text-ink">
                  {t("jobPrefs.minSalary")}
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
                <span className="font-body text-[13px] font-semibold text-ink">{t("jobPrefs.workArrangement")}</span>
                <select
                  value={remote}
                  onChange={(e) => setRemote(e.target.value as RemoteChoice)}
                  className="mt-2 w-full cursor-pointer rounded-[10px] border border-border bg-white px-3 py-[11px] font-body text-[14px] text-ink outline-none transition-colors focus:border-border-dark"
                >
                  <option value="any">{t("jobPrefs.remoteAny")}</option>
                  <option value="remote">{t("jobPrefs.remoteRemote")}</option>
                  <option value="hybrid">{t("jobPrefs.remoteHybrid")}</option>
                  <option value="onsite">{t("jobPrefs.remoteOnsite")}</option>
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
                {saving ? t("jobPrefs.saving") : t("jobPrefs.save")}
              </button>
              {saveOk && (
                <span className="flex items-center gap-[6px] font-body text-[13px] font-medium text-green">
                  <Check className="h-4 w-4" strokeWidth={2.4} />
                  {t("jobPrefs.saved")}
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
          title={t("privacy.title")}
          desc={t("privacy.desc")}
        >
          <div className="flex items-start gap-3 rounded-[10px] border border-border bg-paper px-4 py-3">
            <label
              htmlFor="crowdsource-opt-in"
              className="flex-1 cursor-pointer"
            >
              <div className="font-body text-[14px] font-semibold text-ink">
                {t("privacy.donateTitle")}
              </div>
              <p className="mt-1 font-body text-[13px] leading-[1.55] text-ink-light">
                {t("privacy.donateBody")}
              </p>
              <a
                href="/legal/privacy"
                className="mt-1 inline-block font-body text-[12px] text-brown underline hover:no-underline"
              >
                {t("privacy.readMore")}
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
                {crowdsourceOptIn ? t("privacy.toggleOn") : t("privacy.toggleOff")}
              </span>
            </button>
          </div>
        </Section>

        {/* Data (export + delete) */}
        <Section title={t("data.title")} desc={t("data.desc")}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onExport}
                disabled={exporting}
                className="flex w-fit items-center gap-[7px] rounded-[9px] border border-border bg-white px-[16px] py-[10px] font-body text-[14px] font-medium text-ink transition-colors hover:border-border-dark disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-[15px] w-[15px]" strokeWidth={1.8} />
                {exporting ? t("data.exporting") : t("data.export")}
              </button>
              <p className="font-body text-[12px] text-ink-light">
                {t("data.exportDesc")}
              </p>
              {exportError && (
                <span className="flex items-center gap-[6px] font-body text-[12px] text-red-600">
                  <AlertCircle className="h-[14px] w-[14px]" strokeWidth={2} />
                  {exportError}
                </span>
              )}
            </div>

            <div className="mt-2 rounded-[10px] border border-red-200 bg-red-50/60 p-4">
              <div className="font-body text-[14px] font-semibold text-ink">{t("data.deleteTitle")}</div>
              <p className="mt-1 font-body text-[13px] text-ink-light">
                {t("data.deleteDesc")}
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
                {t("data.deleteButton")}
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
              {t("deleteModal.title")}
            </h3>
            <p className="mt-2 font-body text-[13px] text-ink-light">
              {t.rich("deleteModal.body", {
                token: (chunks) => (
                  <span className="font-mono font-semibold text-ink">{chunks}</span>
                ),
              })}
            </p>
            <input
              autoFocus
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="DELETE"
              aria-label={t("deleteModal.inputLabel")}
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
                {t("deleteModal.cancel")}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={deleteConfirm !== "DELETE" || deleting}
                className="rounded-[9px] border-none bg-red-600 px-[16px] py-[9px] font-body text-[14px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? t("deleteModal.deleting") : t("deleteModal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
