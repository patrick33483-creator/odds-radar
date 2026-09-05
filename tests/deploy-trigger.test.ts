import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production deploy trigger", () => {
  it("ignores workflow, report and markdown-only pushes", () => {
    const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(workflow).toContain("paths-ignore:");
    expect(workflow).toContain('".github/workflows/**"');
    expect(workflow).toContain('"reports/**"');
    expect(workflow).toContain('"**/*.md"');
    expect(workflow).toContain("workflow_dispatch:");
  });
});
