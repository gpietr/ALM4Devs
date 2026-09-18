import { describe, expect, test } from "bun:test";
import { pickPrimaryMetric } from "./client";

describe("pickPrimaryMetric", () => {
  test("no metrics at all returns null", () => {
    expect(pickPrimaryMetric(undefined)).toBeNull();
    expect(pickPrimaryMetric({})).toBeNull();
  });

  test("prefers CVSS v3.1 over v3.0 and v2 when present", () => {
    const metric = pickPrimaryMetric({
      cvssMetricV31: [{ cvssData: { version: "3.1", baseScore: 9.8, baseSeverity: "CRITICAL" } }],
      cvssMetricV30: [{ cvssData: { version: "3.0", baseScore: 7.5, baseSeverity: "HIGH" } }],
      cvssMetricV2: [{ cvssData: { version: "2.0", baseScore: 5.0 }, baseSeverity: "MEDIUM" }],
    });
    expect(metric).toEqual({ score: 9.8, version: "3.1", severity: "CRITICAL" });
  });

  test("falls back to v3.0 when v3.1 is absent", () => {
    const metric = pickPrimaryMetric({
      cvssMetricV30: [{ cvssData: { version: "3.0", baseScore: 7.5, baseSeverity: "HIGH" } }],
    });
    expect(metric).toEqual({ score: 7.5, version: "3.0", severity: "HIGH" });
  });

  test("falls back to v2, reading severity from the metric entry (not cvssData)", () => {
    const metric = pickPrimaryMetric({
      cvssMetricV2: [{ cvssData: { version: "2.0", baseScore: 5.0 }, baseSeverity: "MEDIUM" }],
    });
    expect(metric).toEqual({ score: 5.0, version: "2.0", severity: "MEDIUM" });
  });

  test("prefers the entry marked Primary when a version has more than one", () => {
    const metric = pickPrimaryMetric({
      cvssMetricV31: [
        { type: "Secondary", cvssData: { version: "3.1", baseScore: 6.5, baseSeverity: "MEDIUM" } },
        { type: "Primary", cvssData: { version: "3.1", baseScore: 9.8, baseSeverity: "CRITICAL" } },
      ],
    });
    expect(metric).toEqual({ score: 9.8, version: "3.1", severity: "CRITICAL" });
  });

  test("falls back to the first entry when none is marked Primary", () => {
    const metric = pickPrimaryMetric({
      cvssMetricV31: [{ type: "Secondary", cvssData: { version: "3.1", baseScore: 6.5, baseSeverity: "MEDIUM" } }],
    });
    expect(metric).toEqual({ score: 6.5, version: "3.1", severity: "MEDIUM" });
  });

  test("empty version array falls through to the next version", () => {
    const metric = pickPrimaryMetric({
      cvssMetricV31: [],
      cvssMetricV30: [{ cvssData: { version: "3.0", baseScore: 4.3, baseSeverity: "MEDIUM" } }],
    });
    expect(metric).toEqual({ score: 4.3, version: "3.0", severity: "MEDIUM" });
  });
});
