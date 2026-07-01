"use client";

// SlashPalette — the "/" command popover anchored above the composer.
//
// Opens when the user types `/` at the start of a line (or after whitespace).
// Lists four sources fetched from /api/slash/catalog. ↑↓ navigates, Enter
// inserts the slug into the composer (replacing the trigger `/...` token),
// Esc closes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { slash, type SlashCatalog, type SlashEntry } from "@/lib/api";

// Built-in commands operate on the local session rather than inserting a
// reference into the composer. Surfaced first in the palette so power users
// hit them on day one (mirrors VS Code / Slack / Cursor norms).
export type SlashCommandId =
  | "new"
  | "clear"
  | "search"
  | "help"
  | "focus";

interface BuiltInCommand {
  id: SlashCommandId;
  slug: string;             // "/new" — also what we match the query against
  titleKey: string;         // dock.slash.commands.{id}.title
  descriptionKey: string;   // dock.slash.commands.{id}.description
  needsArgs?: boolean;      // /search asks for a query before firing
}

const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  { id: "new", slug: "/new", titleKey: "commands.new.title", descriptionKey: "commands.new.description" },
  { id: "clear", slug: "/clear", titleKey: "commands.clear.title", descriptionKey: "commands.clear.description" },
  { id: "search", slug: "/search", titleKey: "commands.search.title", descriptionKey: "commands.search.description", needsArgs: true },
  { id: "help", slug: "/help", titleKey: "commands.help.title", descriptionKey: "commands.help.description" },
  { id: "focus", slug: "/focus", titleKey: "commands.focus.title", descriptionKey: "commands.focus.description" },
];

interface Props {
  open: boolean;
  query: string;
  onClose: () => void;
  /** Insert a literal string back into the composer (skills/prompts/memory/agents). */
  onPick: (insertion: string) => void;
  /** Run one of the BUILT_IN_COMMANDS local actions. `args` carries the
   *  trailing text typed after the slug (e.g. "/search react server actions"). */
  onCommand: (id: SlashCommandId, args: string) => void;
  /** Visual variant — `compact` for the dock, `wide` for /app/chat. */
  variant?: "compact" | "wide";
}

const EMPTY_CATALOG: SlashCatalog = {
  skills: [],
  prompts: [],
  memory: [],
  agents: [],
  generatedAt: "",
};

export function SlashPalette({
  open,
  query,
  onClose,
  onPick,
  onCommand,
  variant = "compact",
}: Props) {
  const t = useTranslations("dock.slash");
  const [catalog, setCatalog] = useState<SlashCatalog>(EMPTY_CATALOG);
  const [loadError, setLoadError] = useState<string | null>(null);
  // activeIndex must reset to 0 whenever (open, query) changes. Instead of
  // doing it via `useEffect(() => setActiveIndex(0), [query, open])` —
  // which React 19's `react-hooks/set-state-in-effect` rule rightly flags —
  // we render-derive it: hold (resetKey, index) in one state, and when the
  // incoming key differs we re-init synchronously during render (the
  // official "adjusting state when a prop changes" pattern from
  // https://react.dev/learn/you-might-not-need-an-effect).
  const resetKey = `${open ? "1" : "0"}:${query}`;
  const [navState, setNavState] = useState<{ key: string; index: number }>({
    key: resetKey,
    index: 0,
  });
  if (navState.key !== resetKey) {
    setNavState({ key: resetKey, index: 0 });
  }
  const activeIndex = navState.key === resetKey ? navState.index : 0;
  const setActiveIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      setNavState((prev) => {
        const idx = typeof next === "function" ? next(prev.index) : next;
        return { key: prev.key, index: idx };
      });
    },
    [],
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  // The query may carry trailing args (`/search react server actions`).
  // For built-in matching we strip after the first space so the row still
  // shows up; for execution we pass everything after the slug as args.
  const queryHead = query.split(/\s/, 1)[0] ?? "";
  const queryArgs = query.slice(queryHead.length).trimStart();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await slash.catalog();
        if (!cancelled) {
          setCatalog(c);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : t("loadFailed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const rows = useMemo(() => {
    const qHead = queryHead.toLowerCase();
    const qFull = query.trim().toLowerCase();
    type Row =
      | { kind: "header"; labelKey: string; key: string }
      | {
          kind: "entry";
          entry: SlashEntry;
          key: string;
          flatIndex: number;
        }
      | {
          kind: "command";
          cmd: BuiltInCommand;
          key: string;
          flatIndex: number;
        };
    const flat: Row[] = [];
    let entryIndex = 0;

    // Commands group first — matched by slug prefix (the user typed `/n` →
    // surfaces /new). We also do a coarse title match so /search shows up
    // when typing /find too.
    const matchedCommands = qHead
      ? BUILT_IN_COMMANDS.filter(
          (c) =>
            c.slug.toLowerCase().startsWith(qHead) ||
            c.id.toLowerCase().startsWith(qHead.replace(/^\//, "")),
        )
      : BUILT_IN_COMMANDS;
    if (matchedCommands.length > 0) {
      flat.push({ kind: "header", labelKey: "categoryCommands", key: "h:commands" });
      for (const cmd of matchedCommands) {
        flat.push({ kind: "command", cmd, key: `cmd:${cmd.id}`, flatIndex: entryIndex });
        entryIndex += 1;
      }
    }

    const groups: Array<{
      category: SlashEntry["category"];
      labelKey: string;
      items: SlashEntry[];
    }> = [
      { category: "skills", labelKey: "categorySkills", items: catalog.skills },
      { category: "prompts", labelKey: "categoryPrompts", items: catalog.prompts },
      { category: "memory", labelKey: "categoryMemory", items: catalog.memory },
      { category: "agents", labelKey: "categoryAgents", items: catalog.agents },
    ];
    for (const group of groups) {
      const matched = qFull
        ? group.items.filter(
            (item) =>
              item.title.toLowerCase().includes(qFull) ||
              item.slug.toLowerCase().includes(qFull) ||
              item.description.toLowerCase().includes(qFull),
          )
        : group.items;
      if (matched.length === 0) continue;
      flat.push({ kind: "header", labelKey: group.labelKey, key: `h:${group.category}` });
      for (const entry of matched) {
        flat.push({ kind: "entry", entry, key: entry.id, flatIndex: entryIndex });
        entryIndex += 1;
      }
    }
    return flat;
  }, [catalog, query, queryHead]);

  const pickables = useMemo(
    () =>
      rows.filter(
        (r): r is Extract<typeof rows[number], { kind: "entry" | "command" }> =>
          r.kind === "entry" || r.kind === "command",
      ),
    [rows],
  );

  // (activeIndex reset moved to render-derived navState above — see comment
  // near the `navState` declaration. No effect needed here.)

  const insertForEntry = useCallback((entry: SlashEntry): string => {
    if (entry.category === "memory") return `[[${entry.slug.replace(/^\//, "")}]] `;
    return `${entry.slug} `;
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(pickables.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        const target = pickables[activeIndex];
        if (!target) return;
        e.preventDefault();
        if (target.kind === "command") {
          onCommand(target.cmd.id, queryArgs);
        } else {
          onPick(insertForEntry(target.entry));
        }
        onClose();
      } else if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    open,
    pickables,
    activeIndex,
    insertForEntry,
    onPick,
    onCommand,
    onClose,
    queryArgs,
    setActiveIndex,
  ]);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLElement>(`[data-slash-active="true"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, rows]);

  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label={t("label")}
      ref={listRef}
      style={{
        position: "absolute",
        left: variant === "wide" ? 16 : 16,
        right: variant === "wide" ? 16 : 16,
        bottom: "calc(100% - 10px)",
        background: "#FFFFFF",
        border: "1px solid #EDE8DF",
        borderRadius: 14,
        boxShadow: "0 14px 36px rgba(40,25,5,.16)",
        padding: 6,
        zIndex: 50,
        maxHeight: 360,
        overflowY: "auto",
      }}
    >
      <div
        className="ds-mono-9"
        style={{
          padding: "6px 10px",
          color: "#A39F99",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>{t("hint")}</span>
        <span>{t("selectHint")}</span>
      </div>
      {loadError ? (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            color: "#A23A2E",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          {loadError}
        </div>
      ) : rows.length === 0 ? (
        <div
          className="ds-body-sm"
          style={{ padding: "10px 12px", color: "#6B6560" }}
        >
          {t("emptyResult")}
        </div>
      ) : (
        rows.map((row) => {
          if (row.kind === "header") {
            return (
              <div
                key={row.key}
                className="ds-mono-9"
                style={{
                  padding: "8px 12px 4px",
                  color: "#A39F99",
                }}
              >
                {t(row.labelKey)}
              </div>
            );
          }
          const isCommand = row.kind === "command";
          const slugText = isCommand ? row.cmd.slug : row.entry.slug;
          const title = isCommand ? t(row.cmd.titleKey) : row.entry.title;
          const description = isCommand
            ? t(row.cmd.descriptionKey)
            : row.entry.description;
          return (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={activeIndex === row.flatIndex}
              data-slash-active={activeIndex === row.flatIndex ? "true" : "false"}
              onMouseEnter={() => setActiveIndex(row.flatIndex)}
              onMouseDown={(e) => {
                e.preventDefault();
                if (isCommand) {
                  onCommand(row.cmd.id, queryArgs);
                } else {
                  onPick(insertForEntry(row.entry));
                }
                onClose();
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: 8,
                background: activeIndex === row.flatIndex ? "#FBF8F3" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                transition: "background .12s",
              }}
            >
              <span
                style={{
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  color: isCommand ? "#A66A00" : "#5D3000",
                  fontSize: 12.5,
                  minWidth: 92,
                  flexShrink: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {slugText}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontWeight: 600,
                    fontSize: 13.5,
                    color: "#2B2822",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </span>
                <span
                  style={{
                    display: "block",
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontSize: 12,
                    color: "#6B6560",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {description}
                </span>
              </span>
              {isCommand && (
                <span
                  className="ds-mono-9"
                  style={{
                    padding: "2px 6px",
                    border: "1px solid #F0E4D2",
                    borderRadius: 5,
                    color: "#A66A00",
                    background: "#FFFBF4",
                    flexShrink: 0,
                  }}
                >
                  {t("actionBadge")}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
