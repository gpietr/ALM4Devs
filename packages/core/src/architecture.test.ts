import { describe, expect, test } from "bun:test";
import { generateMermaid } from "./architecture";

describe("generateMermaid", () => {
  test("empty tree is blank so the UI skips render", () => {
    expect(generateMermaid([], "SWARCH")).toBe("");
  });

  test("uses local n-ids and quoted labels, not hyphenated display ids as node ids", () => {
    const mermaid = generateMermaid(
      [
        { id: "a", parentId: null, sequenceNumber: 1, title: "Controller" },
        { id: "b", parentId: "a", sequenceNumber: 2, title: 'Loop "core"' },
      ],
      "SWARCH",
    );
    expect(mermaid).toBe(
      [
        "flowchart TB",
        '  n1["SWARCH-1 Controller"]',
        '  n2["SWARCH-2 Loop core"]',
        "  n1 --> n2",
      ].join("\n"),
    );
  });
});
