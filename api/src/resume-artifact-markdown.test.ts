import { describe, expect, test } from "bun:test";
import { markdownToSafeArtifactHtml } from "./resume-artifact-markdown";

describe("markdownToSafeArtifactHtml", () => {
  test("renders ordinary résumé structure", () => {
    const html = markdownToSafeArtifactHtml(
      "# Avery\n\n## Experience\n\n- Documented result",
    );
    expect(html).toContain("<h1>Avery</h1>");
    expect(html).toContain("<h2>Experience</h2>");
    expect(html).toContain("<li>Documented result</li>");
  });

  test("makes raw HTML, dangerous links, and remote images passive", () => {
    const html = markdownToSafeArtifactHtml(
      [
        "<script>globalThis.compromised = true</script>",
        "",
        "[safe](https://example.test/profile)",
        "[unsafe](javascript:alert(1))",
        "![portrait](https://tracker.example.test/pixel.png)",
      ].join("\n"),
    );

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://example.test/profile"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example.test");
    expect(html).toContain("portrait");
  });
});
