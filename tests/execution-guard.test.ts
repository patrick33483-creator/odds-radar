import { describe, expect, it } from "vitest";
import {
  confirmedOpportunityKeys,
  EXECUTION_QUOTE_MAX_AGE_MS,
  isHkjcExecutionQuoteFresh,
} from "../server/lib/execution-guard";

const NOW = 1_800_000_000_000;

describe("HKJC execution quote freshness", () => {
  it("accepts only a locally fresh quote with a fresh HKJC source timestamp", () => {
    expect(isHkjcExecutionQuoteFresh({
      fetchedAt: NOW - 2_000,
      sourceUpdatedAt: NOW - 4_000,
    }, NOW)).toBe(true);
  });

  it("rejects an old HKJC price even when it was downloaded just now", () => {
    expect(isHkjcExecutionQuoteFresh({
      fetchedAt: NOW,
      sourceUpdatedAt: NOW - EXECUTION_QUOTE_MAX_AGE_MS - 1,
    }, NOW)).toBe(false);
  });

  it("fails closed when HKJC does not provide a source update time", () => {
    expect(isHkjcExecutionQuoteFresh({ fetchedAt: NOW }, NOW)).toBe(false);
  });

  it("rejects stale downloads and implausible future timestamps", () => {
    expect(isHkjcExecutionQuoteFresh({
      fetchedAt: NOW - EXECUTION_QUOTE_MAX_AGE_MS - 1,
      sourceUpdatedAt: NOW,
    }, NOW)).toBe(false);
    expect(isHkjcExecutionQuoteFresh({
      fetchedAt: NOW,
      sourceUpdatedAt: NOW + 5_001,
    }, NOW)).toBe(false);
  });
});

describe("two-pass execution confirmation", () => {
  it("keeps only opportunities present in both independent passes", () => {
    expect([...confirmedOpportunityKeys(
      ["ev|same", "ev|disappeared", "arb|changed"],
      ["ev|same", "ev|new", "arb|other"],
    )]).toEqual(["ev|same"]);
  });
});
