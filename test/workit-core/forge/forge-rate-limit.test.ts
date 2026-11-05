import { afterEach, expect, test } from "bun:test";
import {
  apiJson,
  apiWrite,
  rateLimitDeps,
  type CliRun,
  type ForgeRunner,
} from "@/packages/workit-core/src/forge/exec";

// #284 N4: a forge rate limit (HTTP 429, or a 403 that says so) waits once,
// bounded, and retries; a limit that persists is `unavailable` with a
// `rate_limited:` reason and an unblock, never a plain `failed`.

const original = { ...rateLimitDeps };
afterEach(() => Object.assign(rateLimitDeps, original));

const ok = (stdout: string): CliRun => ({
  status: 0,
  stdout,
  stderr: "",
  timedOut: false,
  missing: false,
});
const limited = (stderr: string, stdout = ""): CliRun => ({
  status: 1,
  stdout,
  stderr,
  timedOut: false,
  missing: false,
});

/** A runner that answers each call with the next reply, recording the calls. */
const scripted = (replies: CliRun[]): ForgeRunner & { calls: number } => {
  const runner = Object.assign(
    () => {
      runner.calls += 1;
      return replies[Math.min(runner.calls - 1, replies.length - 1)];
    },
    { calls: 0 },
  );
  return runner;
};

const sleeps = (): number[] => {
  const waited: number[] = [];
  Object.assign(rateLimitDeps, { sleep: (ms: number) => void waited.push(ms), now: () => 0 });
  return waited;
};

test("Given a 429 with Retry-After: 3, When the call is made, Then it waits 3 s once and returns the retried answer", () => {
  const waited = sleeps();
  const runner = scripted([
    limited("gh: Too Many Requests (HTTP 429)\nRetry-After: 3"),
    ok('{"login":"octo"}'),
  ]);
  const result = apiJson<{ login: string }>(runner, "gh", "github.com", ["api", "user"], "user");
  expect(result).toEqual({ ok: true, data: { login: "octo" } });
  expect(runner.calls).toBe(2);
  expect(waited).toEqual([3000]);
});

test("Given a 429 that persists, When the call is made, Then it retries once and returns rate_limited (unavailable) with an unblock", () => {
  const waited = sleeps();
  const runner = scripted([limited("gh: Too Many Requests (HTTP 429)\nRetry-After: 2")]);
  const result = apiJson(runner, "gh", "github.com", ["api", "user"], "user");
  expect(runner.calls).toBe(2);
  expect(waited).toEqual([2000]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("unavailable");
  expect(result.error).toStartWith("rate_limited: gh api user hit the github.com rate limit");
  expect(result.unblock).toContain("wait 2s for the rate limit to reset, then retry");
});

test("Given a GitHub secondary rate limit (HTTP 403) with no Retry-After, When the call is made, Then it waits the default once", () => {
  const waited = sleeps();
  const runner = scripted([
    limited(
      "gh: You have exceeded a secondary rate limit. (HTTP 403)",
      '{"message":"You have exceeded a secondary rate limit."}',
    ),
  ]);
  const result = apiJson(runner, "gh", "github.com", ["api", "repos/o/r"], "repository o/r");
  expect(waited).toEqual([rateLimitDeps.defaultWaitMs]);
  expect(result.ok || result.code).toBe("unavailable");
  expect(result.ok || result.error).toContain("secondary rate limit");
});

test("Given an X-RateLimit-Reset beyond the cap, When the call is made, Then it does not sleep and fails rate_limited at once", () => {
  const waited = sleeps();
  const runner = scripted([
    limited("gh: API rate limit exceeded for user ID 1. (HTTP 403)\nX-RateLimit-Reset: 600"),
  ]);
  const result = apiJson(runner, "gh", "github.com", ["api", "user"], "user");
  expect(runner.calls).toBe(1);
  expect(waited).toEqual([]);
  expect(result.ok || result.unblock).toContain("wait 600s");
});

test("Given a plain 403 (no rate limit wording), When the call is made, Then it is not retried", () => {
  const waited = sleeps();
  const runner = scripted([limited("gh: Resource not accessible by integration (HTTP 403)")]);
  const result = apiJson(runner, "gh", "github.com", ["api", "repos/o/r"], "repository o/r");
  expect(runner.calls).toBe(1);
  expect(waited).toEqual([]);
  expect(result.ok || result.code).toBe("failed");
});

test("Given a rate-limited write, When it persists, Then the unblock says to wait, not that the write may have gone through", () => {
  sleeps();
  const runner = scripted([limited("glab: 429 Too Many Requests (HTTP 429)")]);
  const result = apiWrite(
    runner,
    "glab",
    "gitlab.com",
    ["api", "-X", "PUT", "projects/1/merge_requests/2/merge"],
    "merge",
  );
  expect(runner.calls).toBe(2);
  expect(result.ok || result.error).toStartWith("rate_limited:");
  expect(result.ok || result.unblock).not.toContain("may have gone through");
});

test("Given a write that hits a 403 secondary rate limit, When it is made, Then it is not repeated (the forge may have applied it) and fails rate_limited", () => {
  const waited = sleeps();
  const runner = scripted([
    limited("gh: You have exceeded a secondary rate limit. (HTTP 403)"),
    ok("{}"),
  ]);
  const result = apiWrite(
    runner,
    "gh",
    "github.com",
    ["api", "-X", "POST", "repos/o/r/issues/1/comments"],
    "comment",
  );
  expect(runner.calls).toBe(1);
  expect(waited).toEqual([]);
  expect(result.ok || result.error).toStartWith("rate_limited:");
});
