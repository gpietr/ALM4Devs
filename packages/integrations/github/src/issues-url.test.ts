import { describe, expect, test } from "bun:test";
import { parseGithubIssuesUrl, tokenizeGithubQuery } from "./issues-url";

describe("parseGithubIssuesUrl", () => {
  test("carries a filtered issues URL's query over, scope pinned", () => {
    expect(parseGithubIssuesUrl("https://github.com/expressjs/express/issues?q=is%3Aissue+is%3Aopen+label%3Abug")).toEqual({
      owner: "expressjs",
      repo: "express",
      query: "repo:expressjs/express is:issue is:open label:bug",
    });
  });

  test("a bare issues page or repo URL means open issues", () => {
    expect(parseGithubIssuesUrl("https://github.com/o/r/issues")?.query).toBe("repo:o/r is:issue is:open");
    expect(parseGithubIssuesUrl("https://github.com/o/r/issues/")?.query).toBe("repo:o/r is:issue is:open");
    expect(parseGithubIssuesUrl("github.com/o/r")?.query).toBe("repo:o/r is:issue is:open");
    expect(parseGithubIssuesUrl("https://www.github.com/o/r.git")?.repo).toBe("r");
  });

  test("an explicit q without a state keeps closed issues too", () => {
    expect(parseGithubIssuesUrl("https://github.com/o/r/issues?q=label:bug")?.query).toBe("repo:o/r is:issue label:bug");
  });

  test("strips qualifiers that would widen the scope or switch to PRs", () => {
    const parsed = parseGithubIssuesUrl("https://github.com/o/r/issues?q=repo:evil/x org:evil is:pr is:open type:pr label:bug");
    expect(parsed?.query).toBe("repo:o/r is:issue is:open label:bug");
  });

  test("keeps quoted labels in one piece", () => {
    const parsed = parseGithubIssuesUrl('https://github.com/o/r/issues?q=is:open label:"good first issue"');
    expect(parsed?.query).toBe('repo:o/r is:issue is:open label:"good first issue"');
  });

  test("converts legacy labels/state params", () => {
    expect(parseGithubIssuesUrl("https://github.com/o/r/issues?labels=bug,needs triage&state=closed")?.query).toBe(
      'repo:o/r is:issue is:closed label:bug label:"needs triage"',
    );
    expect(parseGithubIssuesUrl("https://github.com/o/r/issues?state=all")?.query).toBe("repo:o/r is:issue");
  });

  test("rejects non-GitHub, PR, single-issue and malformed URLs", () => {
    expect(parseGithubIssuesUrl("")).toBeNull();
    expect(parseGithubIssuesUrl("https://gitlab.com/o/r/issues")).toBeNull();
    expect(parseGithubIssuesUrl("https://github.com/o/r/pulls")).toBeNull();
    expect(parseGithubIssuesUrl("https://github.com/o/r/issues/12")).toBeNull();
    expect(parseGithubIssuesUrl("https://github.com/o")).toBeNull();
    expect(parseGithubIssuesUrl("https://notgithub.com/o/r")).toBeNull();
    expect(parseGithubIssuesUrl("not a url at all")).toBeNull();
  });
});

describe("tokenizeGithubQuery", () => {
  test("splits on whitespace outside quotes", () => {
    expect(tokenizeGithubQuery('  is:open  label:"a b" -label:c ')).toEqual(["is:open", 'label:"a b"', "-label:c"]);
  });
});
