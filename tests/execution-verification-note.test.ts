import { describe, expect, it } from "vitest";
import { executionVerificationNote } from "../server/lib/engine";

describe("simulation execution audit note", () => {
  it("records the two-pass live HKJC confirmation contract", () => {
    const note = executionVerificationNote(Date.parse("2026-08-10T01:30:00+08:00"));
    expect(note).toContain("execution_recheck=two_pass");
    expect(note).toContain("hkjc_quote_max_age=30s");
    expect(note).toContain("economic_key=confirmed");
    expect(note).toContain("2026-08-09T17:30:00.000Z");
  });
});
