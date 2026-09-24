import { describe, expect, test } from "bun:test";
import { clientIp, rateLimit, ruleFromEnv } from "./rate-limit";

/** Each test uses its own bucket name so the module-level Map can't leak between them. */
process.env.TRUSTED_PROXY_HOPS = "1";

function req(ip: string): Request {
  return new Request("http://localhost/api/register", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

describe("rateLimit", () => {
  test("allows up to max per window, then 429s with a retry-after", () => {
    const rule = { window: 60, max: 3 };
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(req("1.1.1.1"), "t-basic", rule)).toBeNull();
    }
    const blocked = rateLimit(req("1.1.1.1"), "t-basic", rule);
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("counts each client IP separately", () => {
    const rule = { window: 60, max: 1 };
    expect(rateLimit(req("2.2.2.2"), "t-perip", rule)).toBeNull();
    expect(rateLimit(req("2.2.2.2"), "t-perip", rule)?.status).toBe(429);
    // A different caller is unaffected by the first one's exhausted bucket.
    expect(rateLimit(req("3.3.3.3"), "t-perip", rule)).toBeNull();
  });

  test("counts each named limit separately", () => {
    const rule = { window: 60, max: 1 };
    expect(rateLimit(req("4.4.4.4"), "t-name-a", rule)).toBeNull();
    expect(rateLimit(req("4.4.4.4"), "t-name-a", rule)?.status).toBe(429);
    expect(rateLimit(req("4.4.4.4"), "t-name-b", rule)).toBeNull();
  });

  test("the window expires", async () => {
    const rule = { window: 1, max: 1 };
    expect(rateLimit(req("5.5.5.5"), "t-window", rule)).toBeNull();
    expect(rateLimit(req("5.5.5.5"), "t-window", rule)?.status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(rateLimit(req("5.5.5.5"), "t-window", rule)).toBeNull();
  });

  test("trusts only the entry our proxy appended, not client-supplied ones", () => {
    const rule = { window: 60, max: 1 };
    const spoofed = (fake: string) =>
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "x-forwarded-for": `${fake}, 6.6.6.6` },
      });
    expect(rateLimit(spoofed("9.9.9.1"), "t-xff", rule)).toBeNull();
    // A different spoofed prefix must not reset the bucket for the same real client.
    expect(rateLimit(spoofed("9.9.9.2"), "t-xff", rule)?.status).toBe(429);
  });

  test("with no trusted proxies configured, the header is ignored entirely", () => {
    expect(clientIp(req("1.2.3.4"), 0)).toBeNull();
    expect(clientIp(req("1.2.3.4"), 1)).toBe("1.2.3.4");
  });

  test("requests with no resolvable IP share one bucket rather than going unlimited", () => {
    const rule = { window: 60, max: 1 };
    const anonymous = () => new Request("http://localhost/api/register", { method: "POST" });
    expect(rateLimit(anonymous(), "t-noip", rule)).toBeNull();
    expect(rateLimit(anonymous(), "t-noip", rule)?.status).toBe(429);
  });
});

describe("ruleFromEnv", () => {
  const fallback = { window: 10, max: 3 };

  test("uses the strict fallback when unset", () => {
    delete process.env.TESTPREFIX_RATE_LIMIT_MAX;
    delete process.env.TESTPREFIX_RATE_LIMIT_WINDOW;
    expect(ruleFromEnv("TESTPREFIX", fallback)).toEqual(fallback);
  });

  test("reads an override", () => {
    process.env.TESTPREFIX_RATE_LIMIT_MAX = "500";
    process.env.TESTPREFIX_RATE_LIMIT_WINDOW = "30";
    expect(ruleFromEnv("TESTPREFIX", fallback)).toEqual({ window: 30, max: 500 });
    delete process.env.TESTPREFIX_RATE_LIMIT_MAX;
    delete process.env.TESTPREFIX_RATE_LIMIT_WINDOW;
  });

  // A typo'd or empty override must not silently disable the limit - that's the
  // fail-open behaviour this whole indirection exists to avoid.
  test.each(["", "nonsense", "0", "-5"])("falls back rather than failing open on %p", (value) => {
    process.env.TESTPREFIX_RATE_LIMIT_MAX = value;
    expect(ruleFromEnv("TESTPREFIX", fallback)).toEqual(fallback);
    delete process.env.TESTPREFIX_RATE_LIMIT_MAX;
  });
});
