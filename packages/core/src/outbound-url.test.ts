import { afterEach, describe, expect, test } from "bun:test";
import { DomainError } from "./errors";
import { assertSafeOutboundUrl, normalizeOutboundUrl } from "./outbound-url";

afterEach(() => {
  delete process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS;
});

const check = (v: string) => assertSafeOutboundUrl(v, "The base URL");

describe("assertSafeOutboundUrl", () => {
  test.each([
    "https://spira.example.com/api/RestService.svc",
    "http://spira.example.com:8080/x",
    "https://203.0.113.10/api",
  ])("allows public target %p", (url) => {
    expect(() => check(url)).not.toThrow();
  });

  test.each(["file:///etc/passwd", "gopher://x/", "ftp://x/", "mock://step-suggestions", "javascript:alert(1)"])(
    "rejects non-http scheme %p",
    (url) => {
      expect(() => check(url)).toThrow(DomainError);
    },
  );

  test.each([
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://127.0.0.1:3000/",
    "http://localhost:5432/",
    "http://LOCALHOST/",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://0.0.0.0/",
    "http://postgres.internal/",
    "http://db.local/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://100.64.0.1/", // carrier-grade NAT
    "http://postgres:5432/", // a container/service name has no public DNS answer
    "http://spira/",
  ])("rejects internal target %p", (url) => {
    expect(() => check(url)).toThrow(DomainError);
  });

  // 172.15/172.32 sit just outside the RFC1918 block - a range check that's off by one
  // octet would wrongly reject these perfectly public addresses.
  test.each(["http://172.15.0.1/", "http://172.32.0.1/", "http://11.0.0.1/", "http://192.169.0.1/"])(
    "allows near-miss public address %p",
    (url) => {
      expect(() => check(url)).not.toThrow();
    },
  );

  test("self-hosted deployments can opt in to private hosts", () => {
    expect(() => check("http://192.168.1.10/")).toThrow(DomainError);
    process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS = "true";
    expect(() => check("http://192.168.1.10/")).not.toThrow();
  });

  test("the opt-in never relaxes the scheme rule", () => {
    process.env.ALLOW_PRIVATE_INTEGRATION_HOSTS = "true";
    expect(() => check("file:///etc/passwd")).toThrow(DomainError);
  });

  test("returns a normalized URL", () => {
    expect(check("https://spira.example.com")).toBe("https://spira.example.com/");
  });
});

describe("normalizeOutboundUrl", () => {
  test("normalizes what it can", () => {
    expect(normalizeOutboundUrl("https://spira.example.com")).toBe("https://spira.example.com/");
  });

  // Rows saved before validation existed may hold values that no longer parse; comparing
  // them must not throw, or editing such a connection becomes impossible.
  test("passes unparseable values through untouched", () => {
    expect(normalizeOutboundUrl("not a url")).toBe("not a url");
  });
});
