import { afterAll, expect, test } from "bun:test";
import { verifyReleased } from "@/packages/workit-core/src/forge/verify";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// `workit verify-delivery released --tag` and `release package` verify a
// release package's tag (`pkg-a@0.1.0`, #860): `@` is a plain tag character,
// while a reflog form like `x@{1}` stays refused.

const repos: RemoteRepo[] = [];
afterAll(() => {
  for (const repo of repos) repo.cleanup();
});

const actor = { host: "test", session: "s-verify", agentId: null };

test("Given pkg-a@0.1.0 on the remote, When verifyReleased checks the tag, Then it is accepted and observed delivered; x@{1} is still refused as not a plain tag name", () => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("tag", "-a", "pkg-a@0.1.0", "-m", "pkg-a 0.1.0");
  repo.git("push", "-q", "origin", "pkg-a@0.1.0");
  const verified = verifyReleased(repo.cwd, { tag: "pkg-a@0.1.0", actor });
  expect(verified.ok).toBe(true);
  if (verified.ok) expect(verified.data.delivered).toBe(true);
  const missing = verifyReleased(repo.cwd, { tag: "pkg-a@0.2.0", actor });
  expect(missing.ok && missing.data.delivered).toBe(false);
  expect(verifyReleased(repo.cwd, { tag: "x@{1}", actor })).toMatchObject({
    ok: false,
    code: "invalid_input",
    error: "--tag must be a plain tag name",
  });
});
