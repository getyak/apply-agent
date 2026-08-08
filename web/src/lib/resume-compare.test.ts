import { describe, expect, it } from "bun:test";
import { mergeCompareWork } from "./resume-compare";

describe("mergeCompareWork", () => {
  it("keeps omitted source bullets and places rewrites in source order", () => {
    const base = [
      {
        name: "Northwind Payments",
        position: "Backend Engineer",
        summary: "Built payment APIs processing 2 million transactions per month.",
        highlights: [
          "Reduced PostgreSQL query latency by 35% through indexing.",
          "Improved reliability to 99.95% for production services.",
        ],
      },
    ];
    const derived = [
      {
        name: "Northwind Payments",
        position: "Backend Engineer",
        highlights: [
          "Optimized PostgreSQL performance, reducing query latency by 35%.",
          "Maintained 99.95% service reliability in production.",
        ],
      },
    ];

    const merged = mergeCompareWork(derived, base)[0];
    expect(merged?.summary).toBe(
      "Built payment APIs processing 2 million transactions per month.",
    );
    expect(merged?.highlights).toEqual([
      "Optimized PostgreSQL performance, reducing query latency by 35%.",
      "Maintained 99.95% service reliability in production.",
    ]);
  });

  it("keeps a source role that disappeared from the derived document", () => {
    const base = [
      {
        name: "Acme",
        position: "Engineer",
        highlights: ["Built a Kafka ingestion pipeline."],
      },
    ];
    expect(mergeCompareWork([], base)).toEqual(base);
  });
});
