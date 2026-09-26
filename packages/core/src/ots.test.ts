import { describe, expect, test } from "bun:test";
import { computeOtsCompleteness, OTS_PROFILE_TEXT_FIELDS, type OtsProfileView } from "./ots";

function profile(overrides: Partial<OtsProfileView> = {}): OtsProfileView {
  const base: Record<string, unknown> = {
    architectureNodeId: "node-1",
    category: null,
    endOfSupportDate: null,
    anomaliesReviewedAt: null,
    anomaliesReviewedBy: null,
    updatedAt: null,
  };
  for (const f of OTS_PROFILE_TEXT_FIELDS) base[f.key] = null;
  return { ...(base as OtsProfileView), ...overrides };
}

/** Every counted (non-Enhanced) field filled, reviewed recently - the "nothing to report"
 * baseline each test below breaks one thing in. */
function fullProfile(overrides: Partial<OtsProfileView> = {}): OtsProfileView {
  const filled: Record<string, unknown> = { category: "library", anomaliesReviewedAt: new Date("2026-09-01") };
  for (const f of OTS_PROFILE_TEXT_FIELDS) filled[f.key] = "documented";
  return profile({ ...(filled as Partial<OtsProfileView>), ...overrides });
}

const NOW = new Date("2026-09-24");

describe("computeOtsCompleteness", () => {
  test("an empty profile is valid and simply reports every counted field as a gap", () => {
    const result = computeOtsCompleteness({ profile: profile(), currentVersionId: null, anomalies: [], now: NOW });
    expect(result.filled).toBe(0);
    const counted = OTS_PROFILE_TEXT_FIELDS.filter(
      (f) => !("counted" in f && f.counted === false) && !("enhancedOnly" in f && f.enhancedOnly),
    ).length;
    expect(result.total).toBe(counted + 1); // + category
    expect(result.gaps.some((g) => g.field === "version")).toBe(true);
  });

  test("assurance-section gaps are flagged enhancedOnly and excluded from filled/total", () => {
    const result = computeOtsCompleteness({
      profile: fullProfile({ developmentAssurance: null, supportMechanism: null }),
      currentVersionId: "v1",
      anomalies: [],
      now: NOW,
    });
    expect(result.filled).toBe(result.total);
    const enhanced = result.gaps.filter((g) => g.enhancedOnly);
    expect(enhanced.map((g) => g.field).sort()).toEqual(["developmentAssurance", "supportMechanism"]);
    expect(result.gaps.filter((g) => !g.enhancedOnly)).toEqual([]);
  });

  test("fields marked counted: false never show up as gaps", () => {
    const result = computeOtsCompleteness({
      profile: fullProfile({ hostingEnvironment: null, masterFileNumber: null, updatesSourceUrl: null, retirementPlan: null }),
      currentVersionId: "v1",
      anomalies: [],
      now: NOW,
    });
    expect(result.gaps).toEqual([]);
  });

  test("anomaly review: never reviewed, and stale after the threshold", () => {
    const never = computeOtsCompleteness({
      profile: fullProfile({ anomaliesReviewedAt: null }),
      currentVersionId: "v1",
      anomalies: [],
      now: NOW,
    });
    expect(never.gaps.map((g) => g.message)).toEqual(["Known-issue list never marked as reviewed"]);

    const stale = computeOtsCompleteness({
      profile: fullProfile({ anomaliesReviewedAt: new Date("2026-01-01") }),
      currentVersionId: "v1",
      anomalies: [],
      now: NOW,
    });
    expect(stale.gaps).toHaveLength(1);
    expect(stale.gaps[0]!.message).toContain("more than 180 days ago");
  });

  test("unassessed anomalies are counted", () => {
    const result = computeOtsCompleteness({
      profile: fullProfile(),
      currentVersionId: "v1",
      anomalies: [{ outcome: null }, { outcome: "acceptable" }, { outcome: null }],
      now: NOW,
    });
    expect(result.gaps.map((g) => g.message)).toEqual(["2 known issues have no evaluation outcome"]);
  });

  test("vendor support already ended without a retirement plan is reported", () => {
    const withoutPlan = computeOtsCompleteness({
      profile: fullProfile({ endOfSupportDate: new Date("2026-01-01"), retirementPlan: null }),
      currentVersionId: "v1",
      anomalies: [],
      now: NOW,
    });
    expect(withoutPlan.gaps.map((g) => g.field)).toEqual(["retirementPlan"]);
  });
});
