// Résumé edit session — the brain behind inline editing in Resume Studio.
//
// Surface contract (edit/save design §1, §3, §4, §5):
//
// - Single source of truth for the *unsaved* document. The page renders
//   `state.draft`, NOT the original `doc` prop after the user starts typing.
// - `commit(path, value)` mutates one bullet / field at a time. Triggers a
//   1.2 s debounced autosave through PUT /:id?mode=draft, which keeps the
//   row's `version` unchanged so the timeline doesn't grow per keystroke.
// - `saveSnapshot()` is the explicit "Save snapshot" / Cmd+S action; it
//   PUTs without `?mode=draft` so the row bumps `version` and a new entry
//   appears in the Version Rail.
// - localStorage backs up every dirty diff under
//   `relay:resume:draft:{resumeId}:{baseVersion}` with a 24 h TTL. On mount
//   we restore that draft if it matches the resume we're editing (page
//   refreshes never lose unsaved work).
// - 409 conflicts go through `state.conflict` — the page renders the §5
//   banner with three choices (view theirs / branch / discard). Until the
//   user resolves the conflict, `commit()` keeps writing locally but skips
//   the network so we don't burn requests on a guaranteed 409.
//
// Why a hook and not a Zustand slice: scoped to one mounted résumé editor.
// There's never two editors live at once (Studio is a singleton page), and
// keeping the state local makes the autosave timer cleanup trivial — when
// the page unmounts, the effect cleanup fires `flush()` synchronously and
// the timer dies with it.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resumes as resumesApi, ApiError } from "@/lib/api";

/** A JsonResume-shaped document. Loose on purpose — the studio edits a
 *  small handful of fields, but the document carries arbitrary envelope
 *  metadata (`_markdown`, `_raw`, `_warnings`, …) we MUST preserve on every
 *  PUT. The hook is field-agnostic — it just diffs and PUTs. */
export type ResumeDoc = Record<string, unknown>;

/** A dot-path into the document. Strings instead of immer/jotai atoms because
 *  the editor's mental model maps 1:1 to JsonResume's nested arrays, and the
 *  path doubles as a stable React key. */
export type FieldPath = string;

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "draft"; pendingAt: number } // user typed; autosave timer ticking
  | { kind: "saving"; mode: "draft" | "snapshot" } // PUT in flight
  | { kind: "saved"; mode: "draft" | "snapshot"; at: number; version: number }
  | { kind: "offline" } // fetch rejected with status=0; we'll retry
  | { kind: "error"; message: string };

export type ConflictState = {
  kind: "version_moved";
  /** The version we tried to write against (stale). */
  attemptedVersion: number;
};

interface UseResumeEditArgs {
  /** Which row we're editing. `null` is the "no résumé yet" state — the hook
   *  becomes inert (no autosave, no localStorage write). */
  resumeId: string | null;
  /** The version the server returned when we GET'd this row. Optimistic-lock
   *  guard. Changes (after a snapshot save or a conflict reconcile) reset the
   *  edit session. */
  baseVersion: number;
  /** Initial document. We snapshot it once into local `draft`; subsequent
   *  parent-prop changes don't blow away the user's in-flight edits unless
   *  baseVersion changes (which means "we just loaded a new version"). */
  initialDoc: ResumeDoc | null;
  /** Called whenever a save lands (draft OR snapshot) with the server's
   *  authoritative content. Lets the parent refresh the version rail / mark
   *  the source-of-truth doc. */
  onSaved?: (next: ResumeDoc, version: number, mode: "draft" | "snapshot") => void;
  /** Autosave debounce in ms. Design §1 picks 1200. Override only for tests. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 1200;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h — matches §3 spec

function draftStorageKey(resumeId: string, baseVersion: number): string {
  return `relay:resume:draft:${resumeId}:${baseVersion}`;
}

/** Walk a dot-path and return the value (or undefined). Tolerates missing
 *  intermediate keys — callers may read paths that don't exist yet. */
function getAtPath(doc: ResumeDoc, path: FieldPath): unknown {
  const parts = path.split(".");
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number.parseInt(p, 10);
      cur = Number.isFinite(i) ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Immutably set a value at a dot-path. Arrays stay arrays; missing
 *  intermediate keys/indexes are created (objects by default, arrays when
 *  the next segment is a number). Pure — never mutates `doc`. */
function setAtPath(doc: ResumeDoc, path: FieldPath, value: unknown): ResumeDoc {
  const parts = path.split(".");
  function recur(node: unknown, idx: number): unknown {
    if (idx === parts.length) return value;
    const key = parts[idx]!;
    const isIndex = /^\d+$/.test(key);
    if (Array.isArray(node)) {
      const i = Number.parseInt(key, 10);
      const copy = node.slice();
      copy[i] = recur(copy[i], idx + 1);
      return copy;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      return { ...obj, [key]: recur(obj[key], idx + 1) };
    }
    // No node yet — synthesize the right container based on the next key
    // shape so callers can commit("work.0.highlights.3", "...") against a
    // brand-new bullet.
    if (isIndex) {
      const arr: unknown[] = [];
      arr[Number.parseInt(key, 10)] = recur(undefined, idx + 1);
      return arr;
    }
    return { [key]: recur(undefined, idx + 1) };
  }
  return recur(doc, 0) as ResumeDoc;
}

/** Strip envelope-only fields (those starting with `_`) before sending to
 *  the server — they're computed on read by unwrapResumeRow. */
function stripEnvelope(doc: ResumeDoc): ResumeDoc {
  const out: ResumeDoc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

export function useResumeEdit({
  resumeId,
  baseVersion,
  initialDoc,
  onSaved,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: UseResumeEditArgs) {
  // Live edit buffer. Re-initialised whenever the resumeId × baseVersion
  // identity flips. Within a session we ignore initialDoc churn so a parent
  // re-render doesn't blow away the user's in-flight typing.
  const [draft, setDraft] = useState<ResumeDoc | null>(initialDoc);
  const [dirty, setDirty] = useState<Set<FieldPath>>(() => new Set());
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  // Effective base version. After a snapshot save, the server returns N+1 —
  // we adopt it so subsequent draft writes don't 409.
  const [effectiveVersion, setEffectiveVersion] = useState<number>(baseVersion);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values kept in refs so the autosave timer reads the freshest
  // value (closure capture would lock it to the version at scheduling time).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const versionRef = useRef(effectiveVersion);
  versionRef.current = effectiveVersion;
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const resumeIdRef = useRef(resumeId);
  resumeIdRef.current = resumeId;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // Forward reference to doSave so the rehydrate-effect (which runs before
  // doSave is declared in the file order) can fire a deferred draft save.
  const doSaveRef = useRef<((mode: "draft" | "snapshot") => Promise<void>) | null>(null);

  // Reset the edit session when the row identity changes. Adopt the parent's
  // doc as our new buffer — clearing dirty/status/conflict because none of
  // that pertains to the new row. Also rehydrate a saved draft for this
  // identity so a page refresh doesn't lose work.
  useEffect(() => {
    setDraft(initialDoc);
    setDirty(new Set());
    setStatus({ kind: "idle" });
    setConflict(null);
    setEffectiveVersion(baseVersion);
    if (!resumeId || typeof window === "undefined" || !initialDoc) return;
    try {
      const raw = window.localStorage.getItem(draftStorageKey(resumeId, baseVersion));
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        draft: ResumeDoc;
        dirty: FieldPath[];
        savedAt: number;
      };
      if (Date.now() - parsed.savedAt > DRAFT_TTL_MS) {
        window.localStorage.removeItem(draftStorageKey(resumeId, baseVersion));
        return;
      }
      setDraft(parsed.draft);
      setDirty(new Set(parsed.dirty));
      setStatus({ kind: "draft", pendingAt: parsed.savedAt });
      // Rehydrate without a follow-up autosave would leave the row server-side
      // out of sync with what the user sees ("we restored your edits, but they
      // never landed"). Schedule the same debounced flush we'd run after a
      // keystroke — note we can't call scheduleAutosave() here because doSave
      // is declared below in the same hook body, so we re-implement the timer
      // inline. The dirtyRef check inside the timer guards against a stale
      // fire if the user adopts theirs / discards before the timer pops.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (dirtyRef.current.size === 0) return;
        void doSaveRef.current?.("draft");
      }, debounceMs);
    } catch {
      // Corrupt localStorage entry — drop and move on. The user's *current*
      // edits are still safe; we just lost the prior tab's draft.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, baseVersion]);

  // Persist every change to localStorage as a cheap insurance policy. This
  // is what makes "refresh the page → my edits are still here" work.
  useEffect(() => {
    if (!resumeId || typeof window === "undefined" || dirty.size === 0 || !draft) return;
    try {
      window.localStorage.setItem(
        draftStorageKey(resumeId, baseVersion),
        JSON.stringify({
          draft,
          dirty: Array.from(dirty),
          savedAt: Date.now(),
        }),
      );
    } catch {
      // Quota errors etc. — non-fatal; the network save will still happen.
    }
  }, [draft, dirty, resumeId, baseVersion]);

  // The actual network call. Shared by autosave and snapshot — they differ
  // only in `mode` and the post-success behavior.
  const doSave = useCallback(async (mode: "draft" | "snapshot") => {
    const rid = resumeIdRef.current;
    if (!rid) return;
    const next = draftRef.current;
    if (!next) return;
    if (conflictRef.current) return; // §5: pause network until reconcile
    setStatus({ kind: "saving", mode });
    try {
      const res = await resumesApi.update(
        rid,
        {
          content: stripEnvelope(next) as Record<string, unknown>,
          expectedVersion: versionRef.current,
        },
        { mode },
      );
      const savedVersion = res.resume.version;
      const savedAt = Date.now();
      // Adopt the server's authoritative version (snapshot bumped it; draft
      // returns the same number). Without this, subsequent saves race the
      // wrong version and 409 themselves.
      setEffectiveVersion(savedVersion);
      // Clear dirty — the row IS now what the user sees.
      setDirty(new Set());
      setStatus({ kind: "saved", mode: res.mode, at: savedAt, version: savedVersion });
      if (typeof window !== "undefined") {
        // Drop the localStorage stash; it's redundant now (the server has
        // it) and keeping it around would re-hydrate stale edits on mount.
        window.localStorage.removeItem(draftStorageKey(rid, versionRef.current));
      }
      onSavedRef.current?.(
        (res.resume.content ?? {}) as ResumeDoc,
        savedVersion,
        res.mode,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Stop the autosave loop; the §5 banner takes over. The draft
        // buffer stays intact so the user can choose "keep mine".
        setConflict({ kind: "version_moved", attemptedVersion: versionRef.current });
        setStatus({
          kind: "error",
          message: "This résumé moved while you were editing.",
        });
        return;
      }
      if (err instanceof ApiError && err.status === 0) {
        setStatus({ kind: "offline" });
        return;
      }
      const msg = err instanceof Error ? err.message : "Save failed.";
      setStatus({ kind: "error", message: msg });
    }
  }, []);
  // Publish the live doSave to the forward ref so the rehydrate effect above
  // can flush a freshly-restored draft.
  doSaveRef.current = doSave;

  // Schedule (or reschedule) a debounced autosave. Called by commit().
  const scheduleAutosave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      // Guard against scheduling races: if a conflict-resolve path cleared
      // dirty, skip — empty saves are pointless.
      if (dirtyRef.current.size === 0) return;
      void doSave("draft");
    }, debounceMs);
    setStatus({ kind: "draft", pendingAt: Date.now() });
  }, [doSave, debounceMs]);

  // The single mutation entrypoint. Skipping a redundant write (same value)
  // is intentional: tab-focus blur events can fire commit() with the same
  // text and we don't want each one to schedule a save.
  const commit = useCallback(
    (path: FieldPath, value: unknown) => {
      let changed = false;
      setDraft((prev) => {
        if (!prev) return prev;
        const cur = getAtPath(prev, path);
        if (Object.is(cur, value)) return prev;
        changed = true;
        return setAtPath(prev, path, value);
      });
      if (!changed) return;
      setDirty((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  // Force the autosave to fire NOW (skip the debounce). Used by Cmd+S
  // hand-off and page unmount / route change.
  const flush = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (dirtyRef.current.size === 0) return;
    await doSave("draft");
  }, [doSave]);

  // Explicit "create a new version" action (Cmd+S, Save snapshot button).
  const saveSnapshot = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    await doSave("snapshot");
  }, [doSave]);

  // Discard the unsaved draft and revert to the parent's doc. Used by the
  // toolbar "Discard draft" button and the conflict reconcile.
  const discardDraft = useCallback(() => {
    setDraft(initialDoc);
    setDirty(new Set());
    setStatus({ kind: "idle" });
    setConflict(null);
    if (resumeId && typeof window !== "undefined") {
      window.localStorage.removeItem(draftStorageKey(resumeId, baseVersion));
    }
  }, [initialDoc, resumeId, baseVersion]);

  // After the §5 banner offers a choice, the page calls one of these:
  //
  //   adoptTheirs(theirDoc, theirVersion)
  //     → throw away local draft, replace with the server's newer copy.
  //
  //   branchFromTheirs(theirDoc, theirVersion)
  //     → take their doc as the new base, then re-apply our dirty paths on
  //       top. If a dirty path differs between theirs and ours, ours wins
  //       (the user chose "keep mine"). Future iteration: per-path prompts.
  const adoptTheirs = useCallback(
    (theirDoc: ResumeDoc, theirVersion: number) => {
      setDraft(theirDoc);
      setDirty(new Set());
      setEffectiveVersion(theirVersion);
      setConflict(null);
      setStatus({ kind: "idle" });
      if (resumeId && typeof window !== "undefined") {
        window.localStorage.removeItem(draftStorageKey(resumeId, baseVersion));
      }
    },
    [resumeId, baseVersion],
  );

  const branchFromTheirs = useCallback(
    (theirDoc: ResumeDoc, theirVersion: number) => {
      const myPaths = Array.from(dirtyRef.current);
      const myDraft = draftRef.current;
      if (!myDraft) {
        setDraft(theirDoc);
      } else {
        let merged = theirDoc;
        for (const p of myPaths) {
          merged = setAtPath(merged, p, getAtPath(myDraft, p));
        }
        setDraft(merged);
      }
      // Keep dirty so the very next autosave persists our overrides on top.
      setEffectiveVersion(theirVersion);
      setConflict(null);
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  // Unmount cleanup: flush in flight, drop timer. The flush is fire-and-forget
  // (we can't await in useEffect cleanup) — the network request completes
  // independently. If it 409s nobody's around to see it; localStorage still
  // holds the draft for next mount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (dirtyRef.current.size > 0) {
        void doSave("draft");
      }
    };
  }, [doSave]);

  return useMemo(
    () => ({
      /** The current edit buffer — render this, not the parent's doc. */
      draft,
      /** Field paths that diverge from the last server-side version. */
      dirty,
      /** UI state for the status chip. */
      status,
      /** Conflict banner state, or null when no conflict. */
      conflict,
      /** The version we're racing against. */
      version: effectiveVersion,
      commit,
      flush,
      saveSnapshot,
      discardDraft,
      adoptTheirs,
      branchFromTheirs,
    }),
    [
      draft,
      dirty,
      status,
      conflict,
      effectiveVersion,
      commit,
      flush,
      saveSnapshot,
      discardDraft,
      adoptTheirs,
      branchFromTheirs,
    ],
  );
}

// Re-export helpers for tests and the conflict reconcile path.
export const __test = { getAtPath, setAtPath, stripEnvelope, draftStorageKey };
