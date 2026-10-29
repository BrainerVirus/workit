// Environment that points git at another repository, index, object store or
// ref namespace than the one at the working directory (#545). Grants resolve
// from the working directory; git follows these, so a grant-gated verb run
// with any of them set could act on a repository whose grants were never read.

export const GIT_REDIRECT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

/** The redirecting variables set (even empty) in any of `envs`, in GIT_REDIRECT_ENV order. */
export const gitRedirectsIn = (...envs: ReadonlyArray<NodeJS.ProcessEnv>): string[] =>
  GIT_REDIRECT_ENV.filter((name) => envs.some((env) => env[name] !== undefined));

/** Why a grant-gated `workit <verb>` does not run under them, with its unblock. */
export const gitRedirectRefusal = (
  names: readonly string[],
  verb: string,
  cwd: string,
): { error: string; unblock: string } => ({
  error: `git_env_redirect: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} set, so git would act on the repository ${names.length === 1 ? "it names" : "they name"} while grants are checked for ${cwd}; workit ${verb} does not run`,
  unblock: `unset ${names.join(" ")}, or cd into the repository and run workit ${verb} there`,
});
