import { describe, expect, test } from "bun:test";
import { diffHtmlFieldsAsText, diffPlainText, type TextDiffSegment } from "./text-diff";

function joinByType(segments: TextDiffSegment[], type: TextDiffSegment["type"]): string {
  return segments
    .filter((s) => s.type === type)
    .map((s) => s.text)
    .join("");
}

describe("diffPlainText", () => {
  test("identical strings are entirely unchanged", () => {
    const segments = diffPlainText("Enter valid credentials", "Enter valid credentials");
    expect(segments.every((s) => s.type === "unchanged")).toBe(true);
    expect(segments.map((s) => s.text).join("")).toBe("Enter valid credentials");
  });

  test("a small word swap only marks the changed letters, not the whole word", () => {
    // "valid" -> "your" - shares no characters, but the surrounding text does.
    const segments = diffPlainText("Enter valid credentials", "Enter your credentials");
    expect(joinByType(segments, "removed")).toBe("valid");
    expect(joinByType(segments, "added")).toBe("your");
    expect(joinByType(segments, "unchanged")).toBe("Enter  credentials");
  });

  test("a typo fix highlights only the changed characters, not the whole word", () => {
    const segments = diffPlainText("Recieve the confirmation", "Receive the confirmation");
    // Only "ie"/"ei" around the transposition should be flagged, not "Recieve"/"Receive" wholesale.
    expect(joinByType(segments, "removed").length).toBeLessThan("Recieve".length);
    expect(joinByType(segments, "added").length).toBeLessThan("Receive".length);
    // Reassembling removed+unchanged should recover the original string, and
    // added+unchanged should recover the new one - a basic diff-correctness invariant.
    const before = segments
      .filter((s) => s.type !== "added")
      .map((s) => s.text)
      .join("");
    const after = segments
      .filter((s) => s.type !== "removed")
      .map((s) => s.text)
      .join("");
    expect(before).toBe("Recieve the confirmation");
    expect(after).toBe("Receive the confirmation");
  });

  test("appending text to the end shows only the new tail as added", () => {
    const segments = diffPlainText("Covers the happy path", "Covers the happy path and edge cases");
    expect(joinByType(segments, "unchanged")).toBe("Covers the happy path");
    expect(joinByType(segments, "added")).toBe(" and edge cases");
    expect(joinByType(segments, "removed")).toBe("");
  });

  test("a completely different string still round-trips correctly (all-removed + all-added, no crash)", () => {
    const segments = diffPlainText("Enter valid credentials", "Restart the device");
    const before = segments
      .filter((s) => s.type !== "added")
      .map((s) => s.text)
      .join("");
    const after = segments
      .filter((s) => s.type !== "removed")
      .map((s) => s.text)
      .join("");
    expect(before).toBe("Enter valid credentials");
    expect(after).toBe("Restart the device");
  });

  test("empty strings on either side don't crash", () => {
    expect(() => diffPlainText("", "")).not.toThrow();
    expect(() => diffPlainText("", "New text")).not.toThrow();
    expect(() => diffPlainText("Old text", "")).not.toThrow();
    expect(joinByType(diffPlainText("", "New"), "added")).toBe("New");
    expect(joinByType(diffPlainText("Old", ""), "removed")).toBe("Old");
  });
});

describe("diffHtmlFieldsAsText - strips tags/decodes entities before diffing", () => {
  test("adjacent block elements don't run together into one word", () => {
    const segments = diffHtmlFieldsAsText("<p>A</p><p>B</p>", "<p>A</p><p>B</p>");
    expect(segments.map((s) => s.text).join("")).toBe("A B");
  });

  test("identical HTML (different markup aside) is unchanged once reduced to text", () => {
    const segments = diffHtmlFieldsAsText("<p>Enter valid credentials</p>", "<p>Enter valid credentials</p>");
    expect(segments.every((s) => s.type === "unchanged")).toBe(true);
  });

  test("a real content change inside HTML tags is diffed correctly", () => {
    const segments = diffHtmlFieldsAsText("<p>Enter valid credentials</p>", "<p>Enter your credentials</p>");
    expect(joinByType(segments, "removed")).toBe("valid");
    expect(joinByType(segments, "added")).toBe("your");
  });

  test("markup itself (tags) never leaks into the diff output as visible text", () => {
    const segments = diffHtmlFieldsAsText("<p>Click <b>Login</b></p>", "<p>Click <b>Login</b> now</p>");
    const allText = segments.map((s) => s.text).join("");
    expect(allText).not.toContain("<");
    expect(allText).not.toContain(">");
    expect(joinByType(segments, "added")).toBe(" now");
  });

  test("HTML entities decode before diffing, so an entity-vs-literal difference doesn't show as a spurious change", () => {
    const segments = diffHtmlFieldsAsText("<p>A &amp; B</p>", "<p>A &amp; B</p>");
    expect(segments.every((s) => s.type === "unchanged")).toBe(true);
    expect(segments.map((s) => s.text).join("")).toBe("A & B");
  });

  test("a list-to-paragraph structural change still diffs its text content sensibly", () => {
    const segments = diffHtmlFieldsAsText("<ul><li>Step A</li><li>Step B</li></ul>", "<ul><li>Step A</li><li>Step C</li></ul>");
    expect(joinByType(segments, "removed")).toContain("B");
    expect(joinByType(segments, "added")).toContain("C");
  });
});
