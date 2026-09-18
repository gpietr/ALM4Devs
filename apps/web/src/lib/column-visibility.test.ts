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

const requiredColumns: ListColumn[] = [
  { id: "id", label: "ID", required: true },
  { id: "title", label: "Requirement" },
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
    expect(toggleColumnId(["id", "title"], "status", columns)).toEqual(["id", "title", "status"]);
    expect(toggleColumnId(["id", "title", "status"], "title", columns)).toEqual(["id", "status"]);
  });

  test("refuses to remove a required column", () => {
    expect(toggleColumnId(["id", "title"], "id", requiredColumns)).toEqual(["id", "title"]);
  });
});

describe("required columns", () => {
  test("defaultVisibleIds always includes a required column even if defaultVisible is false", () => {
    expect(defaultVisibleIds(requiredColumns)).toEqual(["id", "title"]);
  });

  test("none still returns the required columns rather than an empty set", () => {
    expect(parseColumnParam("none", requiredColumns)).toEqual(["id"]);
  });

  test("an explicit list missing the required column has it added back", () => {
    expect(parseColumnParam("title", requiredColumns)).toEqual(["title", "id"]);
  });

  test("serializing down to just the required columns round-trips through none", () => {
    expect(serializeColumnParam(["id"], requiredColumns)).toBe("none");
    expect(parseColumnParam(serializeColumnParam(["id"], requiredColumns) ?? null, requiredColumns)).toEqual(["id"]);
  });
});
