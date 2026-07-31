import { describe, expect, it } from "bun:test";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import {
  CareerGraphReviewPanel,
} from "../career-graph-view";
import type { CareerGraphChangeSet } from "@/lib/api";
import en from "../../../../messages/en.json";

const CHANGE_ID = "00000000-0000-4000-8000-000000000f01";
const APPROVE = `APPROVE CAREER CHANGE ${CHANGE_ID}`;

const change: CareerGraphChangeSet = {
  id: CHANGE_ID,
  graph_id: "00000000-0000-4000-8000-000000000f02",
  base_revision_id: null,
  summary: "Import résumé v3: Backend profile",
  status: "pending",
  proposed_by: "import",
  decided_via: null,
  created_at: "2026-08-01T00:00:00Z",
  decided_at: null,
  confirmation: {
    approve: APPROVE,
    reject: `REJECT CAREER CHANGE ${CHANGE_ID}`,
  },
  review_summary: {
    counts: {
      added_nodes: 1,
      updated_nodes: 1,
      removed_nodes: 0,
      added_edges: 1,
      updated_edges: 0,
      removed_edges: 0,
    },
    total_changes: 3,
    destructive: false,
    nodes: [
      {
        entity: "node",
        id: "achievement:postgres",
        change: "added",
        before: null,
        after: {
          id: "achievement:postgres",
          type: "achievement",
          data: {
            text: "Migrated billing workloads to PostgreSQL without downtime.",
          },
          provenance: {
            source_type: "resume_import",
            source_ref:
              "resume:00000000-0000-4000-8000-000000000f03:v3",
          },
        },
      },
      {
        entity: "node",
        id: "role:acme",
        change: "updated",
        before: {
          id: "role:acme",
          type: "role",
          data: { position: "Backend Engineer" },
        },
        after: {
          id: "role:acme",
          type: "role",
          data: { position: "Senior Backend Engineer" },
          provenance: {
            source_type: "resume_import",
            source_ref:
              "resume:00000000-0000-4000-8000-000000000f03:v3",
          },
        },
      },
    ],
    edges: [
      {
        entity: "edge",
        id: "edge:role-achievement",
        change: "added",
        before: null,
        after: {
          id: "edge:role-achievement",
          type: "includes",
          from: "role:acme",
          to: "achievement:postgres",
        },
      },
    ],
  },
};

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en as never}
      timeZone="UTC"
      now={new Date("2026-08-01T00:00:00Z")}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

function panel(confirmation: string) {
  return (
    <CareerGraphReviewPanel
      change={change}
      decision="approve"
      confirmation={confirmation}
      busy={false}
      onDecision={() => {}}
      onConfirmation={() => {}}
      onSubmit={() => {}}
    />
  );
}

describe("CareerGraphReviewPanel", () => {
  it("renders exact node/edge facts with provenance and before/after", () => {
    const html = render(panel(""));

    expect(html).toContain('data-testid="career-graph-review-panel"');
    expect(html).toContain("Migrated billing workloads to PostgreSQL without downtime.");
    expect(html).toContain("Backend Engineer");
    expect(html).toContain("Senior Backend Engineer");
    expect(html).toContain(
      "resume:00000000-0000-4000-8000-000000000f03:v3",
    );
    expect(html).toContain("role:acme");
    expect(html).toContain("achievement:postgres");
  });

  it("keeps approval disabled until the exact per-change phrase is typed", () => {
    const wrong = render(panel("yes"));
    expect(wrong).toMatch(
      /<button[^>]*data-testid="career-decision-submit"[^>]*disabled/,
    );
    expect(wrong).toContain(APPROVE);

    const exact = render(panel(APPROVE));
    expect(exact).toMatch(
      /<button[^>]*data-testid="career-decision-submit"/,
    );
    expect(exact).not.toMatch(
      /<button[^>]*data-testid="career-decision-submit"[^>]*disabled/,
    );
  });

  it("exposes both approval and rejection choices as pressed-state controls", () => {
    const html = render(panel(""));

    expect(html).toContain('data-testid="career-decision-approve"');
    expect(html).toContain('data-testid="career-decision-reject"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });
});
