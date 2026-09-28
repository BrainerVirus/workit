import { validateBranchNameFor, type BranchNamePolicyCheck } from "./branch";

// ponytail: recognize direct literal Git forms only; expand coverage if users need shell AST support.
export const shellBranchTarget = (command: string): string | null => {
  if (
    !command.trim() ||
    /[\r\n;&|<>`'"$()\\*?{}~!#]/u.test(command) ||
    command.includes("[") ||
    command.includes("]")
  )
    return null;

  const args = command.trim().split(/\s+/u);
  if (args[0] !== "git") return null;
  const option = args[2];
  const target =
    args[1] === "switch" &&
    ["-c", "--create", "-C", "--force-create"].includes(option ?? "") &&
    (args.length === 4 || args.length === 5)
      ? args[3]
      : args[1] === "checkout" &&
          ["-b", "-B"].includes(option ?? "") &&
          (args.length === 4 || args.length === 5)
        ? args[3]
        : args[1] === "branch" && (args.length === 3 || args.length === 4)
          ? args[2]
          : null;
  return target && !target.startsWith("-") ? target : null;
};

export const shellBranchPolicyViolation = (
  root: string,
  command: string,
): BranchNamePolicyCheck | null => {
  const target = shellBranchTarget(command);
  return target === null ? null : validateBranchNameFor(root, target);
};
