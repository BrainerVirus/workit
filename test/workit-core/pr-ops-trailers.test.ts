import { afterEach, expect, test } from "bun:test";
import type { MergeMethod } from "@/packages/workit-core/src/forge/types";
import {
  fillFromCommits,
  mergePullRequest,
  type MergeInput,
} from "@/packages/workit-core/src/forge/pr-ops";
import type { ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// Issue #292: `pr create --fill` drops Workit-Session trailers with the
// trailer parser commit amends use, and a merge or rebase with a message is
// refused, naming the squash it needs.

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

// Only baseRemote is read on the --fill path; nothing reaches a forge.
const RESOLVED = { baseRemote: "origin" } as ResolvedForge;

test("Given commits with mixed trailer blocks, When --fill builds the body, Then no Workit-Session line remains and prose and other trailers stay", () => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "feature/a");
  const commit = (file: string, message: string) => {
    repo.write(file, `${file}\n`);
    repo.git("add", file);
    repo.git("commit", "-q", "-m", message);
  };
  commit(
    "a.txt",
    "feat: a\n\nprose\nSigned-off-by: A <a@b.c>\nWorkit-Session: s1\n  folded onto the session",
  );
  commit("b.txt", "fix: b\n\nWorkit-Session: s2\nCo-Authored-By: B <b@c.d>");

  const filled = fillFromCommits(repo.cwd, RESOLVED, "main");
  if (!filled.ok) throw new Error(filled.error);
  expect(filled.data.title).toBe("feat: a");
  expect(filled.data.body).not.toMatch(/Workit-Session|folded onto/u);
  expect(filled.data.body).toBe(
    [
      "- feat: a",
      "",
      "  prose",
      "  Signed-off-by: A <a@b.c>",
      "",
      "- fix: b",
      "",
      "  Co-Authored-By: B <b@c.d>",
    ].join("\n"),
  );
});

test("Given a merge or rebase with --subject or --body, When merging, Then it is refused naming the squash it needs and nothing is asked of the forge", async () => {
  const forge = new Proxy(
    {},
    {
      get: () => {
        throw new Error("the forge was called");
      },
    },
  );
  const resolved = { forge, baseRemote: "origin" } as unknown as ResolvedForge;
  const input = (method: MergeMethod, message: Partial<MergeInput>): MergeInput =>
    ({
      pr: 1,
      method,
      deleteBranch: false,
      actor: {},
      ...message,
    }) as MergeInput;
  for (const method of ["merge", "rebase"] as const)
    for (const message of [{ subject: "feat: x" }, { body: "text" }]) {
      const result = await mergePullRequest(
        process.cwd(),
        resolved,
        input(method, message),
        async () => {},
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("invalid_input");
      expect(result.error).toContain("squash");
      expect(result.error).toContain(`a ${method} merge`);
    }
});
