"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  Check,
  FileJson,
  GitBranch,
  History,
  Link2,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  careerGraphs as careerGraphsApi,
  type CareerGraphChangeSet,
  type CareerGraphEntity,
  type CareerGraphEntityChange,
  type CareerGraphOverview,
} from "@/lib/api";
import { Badge, Button, Card, EmptyState, Field, HintBox, Input } from "@/components/ui";

type Decision = "approve" | "reject";

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key}: ${valueText(nested)}`)
      .join(" · ");
  }
  return "—";
}

function entityTitle(entity: CareerGraphEntity | null): string {
  if (!entity) return "—";
  const data = entity.data ?? {};
  const candidate =
    data.text ??
    data.position ??
    data.name ??
    data.organization ??
    data.institution ??
    data.language;
  return typeof candidate === "string" && candidate.trim() ? candidate : entity.id;
}

function EntitySnapshot({
  entity,
  label,
}: {
  entity: CareerGraphEntity | null;
  label: string;
}) {
  if (!entity) return null;
  const data = Object.entries(entity.data ?? {});
  return (
    <div className="min-w-0 rounded-[10px] border border-border bg-white px-3.5 py-3">
      <div className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.8px] text-ink-muted">
        {label}
      </div>
      {entity.from && entity.to ? (
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-light">
          <span className="truncate">{entity.from}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
          <span className="truncate">{entity.to}</span>
        </div>
      ) : (
        <dl className="space-y-1.5">
          {data.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
              <dt className="font-mono text-[10px] uppercase tracking-[0.35px] text-ink-muted">
                {key.replaceAll("_", " ")}
              </dt>
              <dd className="min-w-0 break-words font-body text-[12.5px] leading-[1.45] text-ink">
                {valueText(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {entity.provenance?.source_ref && (
        <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-2 font-mono text-[9.5px] text-ink-muted">
          <Link2 className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{entity.provenance.source_ref}</span>
        </div>
      )}
    </div>
  );
}

function EntityChangeCard({ item }: { item: CareerGraphEntityChange }) {
  const t = useTranslations("careerGraph");
  const active = item.after ?? item.before;
  const tone =
    item.change === "added"
      ? "bg-green-bg text-green"
      : item.change === "removed"
        ? "bg-coral-bg text-coral"
        : "bg-gold-bg text-amber";

  return (
    <article
      data-testid={`career-change-${item.entity}-${item.id}`}
      className="rounded-[12px] border border-border bg-cream/35 p-3.5"
    >
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-[13px] font-bold text-ink">
            {entityTitle(active)}
          </div>
          <div className="mt-0.5 truncate font-mono text-[9.5px] text-ink-muted">
            {active?.type ?? item.entity} · {item.id}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.45px] ${tone}`}
        >
          {t(`change.${item.change}`)}
        </span>
      </div>
      <div
        className={
          item.change === "updated"
            ? "grid gap-2.5 xl:grid-cols-2"
            : "grid gap-2.5"
        }
      >
        {item.before && (
          <EntitySnapshot entity={item.before} label={t("review.before")} />
        )}
        {item.after && (
          <EntitySnapshot entity={item.after} label={t("review.after")} />
        )}
      </div>
    </article>
  );
}

export function CareerGraphReviewPanel({
  change,
  decision,
  confirmation,
  busy,
  onDecision,
  onConfirmation,
  onSubmit,
}: {
  change: CareerGraphChangeSet;
  decision: Decision;
  confirmation: string;
  busy: boolean;
  onDecision: (decision: Decision) => void;
  onConfirmation: (value: string) => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("careerGraph");
  const expected = change.confirmation[decision];
  const canSubmit =
    change.status === "pending" && !busy && confirmation === expected;
  const counts = change.review_summary.counts;
  const items = [
    ...change.review_summary.nodes,
    ...change.review_summary.edges,
  ];

  return (
    <section
      aria-labelledby="career-change-review-title"
      data-testid="career-graph-review-panel"
      className="min-w-0 rounded-[16px] border border-border bg-white shadow-sm"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone={change.proposed_by === "import" ? "info" : "ai"}>
                {t(`source.${change.proposed_by}`)}
              </Badge>
              {change.review_summary.destructive && (
                <Badge tone="gap">{t("review.destructive")}</Badge>
              )}
            </div>
            <h2
              id="career-change-review-title"
              className="font-display text-[18px] font-bold tracking-[-0.3px] text-ink"
            >
              {change.summary}
            </h2>
            <p className="mt-1 font-mono text-[10px] text-ink-muted">
              {change.id}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-[9px] bg-green-bg px-3 py-2">
              <div className="font-display text-[16px] font-bold text-green">
                {counts.added_nodes + counts.added_edges}
              </div>
              <div className="font-mono text-[8.5px] uppercase tracking-[0.5px] text-green">
                {t("change.added")}
              </div>
            </div>
            <div className="rounded-[9px] bg-gold-bg px-3 py-2">
              <div className="font-display text-[16px] font-bold text-amber">
                {counts.updated_nodes + counts.updated_edges}
              </div>
              <div className="font-mono text-[8.5px] uppercase tracking-[0.5px] text-amber">
                {t("change.updated")}
              </div>
            </div>
            <div className="rounded-[9px] bg-coral-bg px-3 py-2">
              <div className="font-display text-[16px] font-bold text-coral">
                {counts.removed_nodes + counts.removed_edges}
              </div>
              <div className="font-mono text-[8.5px] uppercase tracking-[0.5px] text-coral">
                {t("change.removed")}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-h-[46vh] space-y-3 overflow-y-auto px-5 py-4">
        {items.length > 0 ? (
          items.map((item) => <EntityChangeCard key={`${item.entity}:${item.id}`} item={item} />)
        ) : (
          <EmptyState title={t("review.noDiff")} description={t("review.noDiffBody")} />
        )}
      </div>

      {change.status === "pending" && (
        <div className="border-t border-border bg-cream/35 px-5 py-4">
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-[11px] bg-white p-1 shadow-sm">
            <button
              type="button"
              data-testid="career-decision-approve"
              aria-pressed={decision === "approve"}
              onClick={() => onDecision("approve")}
              className={`rounded-[8px] px-3 py-2 font-body text-[12.5px] font-semibold transition-colors ${
                decision === "approve"
                  ? "bg-green-bg text-green"
                  : "text-ink-light hover:bg-cream"
              }`}
            >
              <Check className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
              {t("review.approve")}
            </button>
            <button
              type="button"
              data-testid="career-decision-reject"
              aria-pressed={decision === "reject"}
              onClick={() => onDecision("reject")}
              className={`rounded-[8px] px-3 py-2 font-body text-[12.5px] font-semibold transition-colors ${
                decision === "reject"
                  ? "bg-coral-bg text-coral"
                  : "text-ink-light hover:bg-cream"
              }`}
            >
              <X className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
              {t("review.reject")}
            </button>
          </div>

          <Field label={t("review.confirmLabel")} hint={t("review.confirmHint")}>
            <Input
              value={confirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onConfirmation(event.target.value)}
              placeholder={expected}
              aria-label={t("review.confirmLabel")}
              className="font-mono text-[11px]"
            />
          </Field>
          <div className="mt-2 rounded-[8px] border border-dashed border-border-dark bg-white px-3 py-2 font-mono text-[10px] text-ink-light">
            {expected}
          </div>
          <Button
            data-testid="career-decision-submit"
            className="mt-3"
            fullWidth
            variant={decision === "approve" ? "primary" : "danger"}
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {busy
              ? t("review.saving")
              : decision === "approve"
                ? t("review.approveRevision")
                : t("review.rejectProposal")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function CareerGraphView() {
  const t = useTranslations("careerGraph");
  const [overview, setOverview] = useState<CareerGraphOverview | null>(null);
  const [selectedGraphId, setSelectedGraphId] = useState("");
  const [selectedResumeId, setSelectedResumeId] = useState("");
  const [selectedChangeId, setSelectedChangeId] = useState("");
  const [decision, setDecision] = useState<Decision>("approve");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applyOverview = useCallback((next: CareerGraphOverview) => {
    setOverview(next);
    setSelectedGraphId((current) =>
      next.graphs.some((graph) => graph.id === current)
        ? current
        : (next.graphs[0]?.id ?? ""),
    );
    setSelectedResumeId((current) =>
      next.source_resumes.some((resume) => resume.id === current)
        ? current
        : (next.source_resumes.find((resume) => resume.is_base)?.id ??
          next.source_resumes[0]?.id ??
          ""),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await careerGraphsApi.overview();
      applyOverview(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.load"));
    } finally {
      setLoading(false);
    }
  }, [applyOverview, t]);

  useEffect(() => {
    let cancelled = false;
    careerGraphsApi
      .overview()
      .then((next) => {
        if (!cancelled) applyOverview(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t("errors.load"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyOverview, t]);

  const selectedGraph = overview?.graphs.find(
    (graph) => graph.id === selectedGraphId,
  );
  const visibleChanges = useMemo(
    () =>
      (overview?.pending_changes ?? []).filter(
        (change) => !selectedGraphId || change.graph_id === selectedGraphId,
      ),
    [overview?.pending_changes, selectedGraphId],
  );
  const selectedChange =
    visibleChanges.find((change) => change.id === selectedChangeId) ??
    visibleChanges[0] ??
    null;

  const chooseChange = (changeId: string) => {
    setSelectedChangeId(changeId);
    setDecision("approve");
    setConfirmation("");
    setNotice("");
  };

  const stageImport = async () => {
    if (!selectedResumeId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const proposal = await careerGraphsApi.importResume({
        resumeId: selectedResumeId,
        graphId: selectedGraphId || undefined,
      });
      setSelectedGraphId(proposal.graph_id);
      setSelectedChangeId(proposal.id);
      setConfirmation("");
      await load();
      setNotice(t("notice.staged"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.import"));
    } finally {
      setBusy(false);
    }
  };

  const decide = async () => {
    if (!selectedChange) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await careerGraphsApi.decide(
        selectedChange.id,
        decision,
        confirmation,
      );
      setConfirmation("");
      setSelectedChangeId("");
      await load();
      setNotice(
        result.status === "approved"
          ? t("notice.approved", { revision: result.revision ?? "—" })
          : t("notice.rejected"),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.decision"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[1px] text-ink-muted">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
          {t("loading")}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-[1320px] px-5 py-7 lg:px-8">
      <header className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone="info">
            <Network className="h-3 w-3" aria-hidden />
            {t("eyebrow")}
          </Badge>
          <Badge tone="ai">{t("codexNative")}</Badge>
        </div>
        <h1 className="font-display text-[30px] font-bold tracking-[-1.15px] text-ink">
          {t("title")}
        </h1>
        <p className="mt-2 max-w-[760px] font-body text-[14px] leading-[1.65] text-ink-light">
          {t("subtitle")}
        </p>
      </header>

      <div
        aria-label={t("lineage.label")}
        className="mb-5 grid overflow-hidden rounded-[14px] border border-cream-border bg-[linear-gradient(135deg,#FBF1DC_0%,#F8ECD6_100%)] md:grid-cols-4"
      >
        {[
          ["source", FileJson],
          ["proposal", Sparkles],
          ["revision", History],
          ["compile", GitBranch],
        ].map(([key, Icon], index) => (
          <div
            key={String(key)}
            className="relative flex items-center gap-3 border-b border-cream-border px-4 py-3.5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-white text-brown shadow-sm">
              <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
            </div>
            <div>
              <div className="font-mono text-[8.5px] uppercase tracking-[0.6px] text-amber">
                0{index + 1}
              </div>
              <div className="font-body text-[12.5px] font-semibold text-ink">
                {t(`lineage.${key}`)}
              </div>
            </div>
            {index < 3 && (
              <ArrowRight className="absolute -right-2 z-10 hidden h-4 w-4 rounded-full bg-gold-bg text-amber md:block" aria-hidden />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-[11px] border border-coral-border bg-coral-bg px-4 py-3 font-body text-[13px] text-coral">
          {error}
        </div>
      )}
      {notice && (
        <HintBox tone="success" className="mb-4">
          {notice}
        </HintBox>
      )}

      <div className="mb-5 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.42fr)]">
        <Card className="min-w-0">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-[16px] font-bold text-ink">
                {t("asset.title")}
              </h2>
              <p className="mt-1 font-body text-[12.5px] text-ink-light">
                {t("asset.body")}
              </p>
            </div>
            <ShieldCheck className="h-5 w-5 shrink-0 text-green" aria-hidden />
          </div>
          {overview && overview.graphs.length > 0 ? (
            <>
              <label className="mb-3 block">
                <span className="mb-1.5 block font-body text-[12px] font-semibold text-ink">
                  {t("asset.select")}
                </span>
                <select
                  value={selectedGraphId}
                  onChange={(event) => {
                    setSelectedGraphId(event.target.value);
                    setSelectedChangeId("");
                    setConfirmation("");
                  }}
                  className="w-full rounded-[10px] border border-border-dark bg-white px-3.5 py-[10px] font-body text-[13px] text-ink outline-none focus:border-brown"
                >
                  {overview.graphs.map((graph) => (
                    <option key={graph.id} value={graph.id}>
                      {graph.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  [t("asset.revision"), selectedGraph?.revision ?? 0],
                  [t("asset.nodes"), selectedGraph?.node_count ?? 0],
                  [t("asset.edges"), selectedGraph?.edge_count ?? 0],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-[10px] bg-cream px-3 py-2.5">
                    <div className="font-display text-[18px] font-bold text-brown">{value}</div>
                    <div className="font-mono text-[9px] uppercase tracking-[0.45px] text-ink-muted">{label}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="rounded-[10px] bg-cream px-3.5 py-3 font-body text-[12.5px] text-ink-light">
              {t("asset.empty")}
            </p>
          )}
        </Card>

        <Card tone="ai">
          <div className="mb-3 flex items-center gap-2">
            <Plus className="h-4 w-4 text-amber" aria-hidden />
            <h2 className="font-display text-[15px] font-bold text-ink">
              {t("import.title")}
            </h2>
          </div>
          {overview && overview.source_resumes.length > 0 ? (
            <>
              <select
                aria-label={t("import.sourceLabel")}
                value={selectedResumeId}
                onChange={(event) => setSelectedResumeId(event.target.value)}
                className="mb-3 w-full rounded-[10px] border border-cream-border bg-white px-3.5 py-[10px] font-body text-[12.5px] text-ink outline-none focus:border-brown"
              >
                {overview.source_resumes.map((resume) => (
                  <option key={resume.id} value={resume.id}>
                    {resume.label || t("import.unnamed")} · v{resume.version} · {resume.track}
                  </option>
                ))}
              </select>
              <Button
                data-testid="career-import-submit"
                fullWidth
                size="sm"
                disabled={busy || !selectedResumeId}
                onClick={stageImport}
              >
                {busy ? t("import.staging") : t("import.stage")}
              </Button>
              <p className="mt-2 font-mono text-[9.5px] leading-[1.45] text-ink-muted">
                {t("import.guard")}
              </p>
            </>
          ) : (
            <div className="font-body text-[12.5px] leading-[1.55] text-ink-light">
              {t("import.empty")}{" "}
              <Link href="/app/studio/resume" className="font-semibold text-brown underline underline-offset-2">
                {t("import.openStudio")}
              </Link>
            </div>
          )}
        </Card>
      </div>

      <div className="grid items-start gap-4">
        <aside className="rounded-[14px] border border-border bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2 px-1">
            <div>
              <h2 className="font-display text-[14px] font-bold text-ink">
                {t("queue.title")}
              </h2>
              <p className="font-mono text-[9px] uppercase tracking-[0.5px] text-ink-muted">
                {t("queue.count", { count: visibleChanges.length })}
              </p>
            </div>
            <History className="h-4 w-4 text-amber" aria-hidden />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleChanges.map((change) => {
              const active = selectedChange?.id === change.id;
              return (
                <button
                  key={change.id}
                  type="button"
                  data-testid={`career-change-select-${change.id}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => chooseChange(change.id)}
                  className={`w-full rounded-[10px] border px-3 py-3 text-left transition-colors ${
                    active
                      ? "border-brown bg-cream"
                      : "border-border bg-white hover:border-border-dark hover:bg-cream/40"
                  }`}
                >
                  <div className="line-clamp-2 font-body text-[12.5px] font-semibold leading-[1.35] text-ink">
                    {change.summary}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.4px] text-ink-muted">
                      {t(`source.${change.proposed_by}`)}
                    </span>
                    <span className="rounded-full bg-gold-bg px-2 py-0.5 font-mono text-[9px] text-amber">
                      {change.review_summary.total_changes}
                    </span>
                  </div>
                </button>
              );
            })}
            {visibleChanges.length === 0 && (
              <div className="rounded-[10px] bg-cream px-3 py-4 text-center font-body text-[12px] leading-[1.5] text-ink-light">
                {t("queue.empty")}
              </div>
            )}
          </div>
        </aside>

        {selectedChange ? (
          <CareerGraphReviewPanel
            change={selectedChange}
            decision={decision}
            confirmation={confirmation}
            busy={busy}
            onDecision={(next) => {
              setDecision(next);
              setConfirmation("");
            }}
            onConfirmation={setConfirmation}
            onSubmit={decide}
          />
        ) : (
          <EmptyState
            className="min-h-[360px] justify-center"
            icon={<ShieldCheck className="h-7 w-7" />}
            title={t("review.emptyTitle")}
            description={t("review.emptyBody")}
          />
        )}
      </div>
    </div>
  );
}
