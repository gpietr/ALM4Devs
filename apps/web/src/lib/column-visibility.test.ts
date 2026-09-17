import { describe, expect, test } from "bun:test";
import {
  defaultVisibleIds,
  parseColumnParam,
  serializeColumnParam,
  toggleColumnId,
  type ListColumn,
} from "./column-visibility";

const columns: ListColumn[] = [
  { id: "id", label: "ID" },
  { id: "title", label: "Requirement" },
  { id: "status", label: "Status" },
  { id: "cf-1", label: "Owner", defaultVisible: false },
  { id: "cf-2", label: "Safety Classification" },
];

describe("parseColumnParam", () => {
  test("absent param uses each column's defaultVisible", () => {
    expect(parseColumnParam(null, columns)).toEqual(["id", "title", "status", "cf-2"]);
  });

  test("none hides every column", () => {
    expect(parseColumnParam("none", columns)).toEqual([]);
  });

  test("an explicit list is the full visible set, dropping unknown ids", () => {
    expect(parseColumnParam("title,cf-1,nope", columns)).toEqual(["title", "cf-1"]);
  });
});

describe("serializeColumnParam", () => {
  test("the default set is omitted from the URL", () => {
    expect(serializeColumnParam(defaultVisibleIds(columns), columns)).toBeUndefined();
  });

  test("an empty set serializes as none rather than an empty string", () => {
    expect(serializeColumnParam([], columns)).toBe("none");
  });

  test("a non-default subset is the comma-separated ids", () => {
    expect(serializeColumnParam(["id", "cf-1"], columns)).toBe("id,cf-1");
  });
});

describe("toggleColumnId", () => {
  test("adds a missing id and removes a present one without reordering the rest", () => {
    expect(toggleColumnId(["id", "title"], "status")).toEqual(["id", "title", "status"]);
    expect(toggleColumnId(["id", "title", "status"], "title")).toEqual(["id", "status"]);
  });
});
