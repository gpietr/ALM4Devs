import { describe, expect, test } from "bun:test";
import { buildScanQuery } from "./vulnerabilities";

describe("buildScanQuery", () => {
  test("prefers an exact CPE when present, ignoring supplier/title/version", () => {
    expect(
      buildScanQuery({ cpe: "cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*", supplier: "Apache", title: "Log4j", version: "2.14.1" }),
    ).toEqual({ matchType: "cpe", query: "cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*" });
  });

  test("falls back to a supplier+title+version keyword when there's no cpe", () => {
    expect(buildScanQuery({ cpe: null, supplier: "Apache", title: "Log4j", version: "2.14.1" })).toEqual({
      matchType: "keyword",
      query: "Apache Log4j 2.14.1",
    });
  });

  test("omits missing parts from the keyword rather than leaving gaps", () => {
    expect(buildScanQuery({ cpe: null, supplier: null, title: "Log4j", version: "2.14.1" })).toEqual({
      matchType: "keyword",
      query: "Log4j 2.14.1",
    });
  });

  test("returns null when nothing usable exists to search with", () => {
    expect(buildScanQuery({ cpe: null, supplier: null, title: "", version: null })).toBeNull();
    expect(buildScanQuery({ cpe: "   ", supplier: null, title: "   ", version: null })).toBeNull();
  });

  test("blank cpe falls through to the keyword fallback instead of searching for whitespace", () => {
    expect(buildScanQuery({ cpe: "  ", supplier: "Apache", title: "Log4j", version: "2.14.1" })).toEqual({
      matchType: "keyword",
      query: "Apache Log4j 2.14.1",
    });
  });
});
