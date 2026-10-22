import { Box, Text } from "ink";
import { ConfirmInput, TextInput } from "@inkjs/ui";
import { useCallback, useEffect, useState, type JSX } from "react";
import { mergePreset, readConfig } from "@brainervirus/workit-core/src/core/config.ts";
import {
  resolveWorkspaceFromEntries,
  resolveWorkspacePolicy,
} from "@brainervirus/workit-core/src/core/workspaces.ts";
import {
  detectBranchPolicy,
  repoBranchPreset,
} from "@brainervirus/workit-core/src/core/branch-policy.ts";
import { projectTarget, type ProjectTarget } from "@brainervirus/workit-core/src/core/hygiene.ts";
import { buildSetupPreview, parseList, type SetupMutation } from "../logic";
import { resolveBasePath } from "../wizard-state";
import { SelectList } from "./select-list";
import type { ScreenProps } from "./screen-props";
import { effectivePolicy, SCREEN_PLACEHOLDERS } from "./options";

// Every keypress re-renders the project step: spawn `git rev-parse` once per
// base path, not once per frame.
let lastProjectTarget: { base: string; target: ProjectTarget } | null = null;
const projectTargetFor = (base: string): ProjectTarget => {
  if (lastProjectTarget?.base !== base) lastProjectTarget = { base, target: projectTarget(base) };
  return lastProjectTarget.target;
};

// CA-06: proposal screen shown between workspaces and project when the
// resolution root is a git repo. On mount it runs the shared detector and
// dispatches the proposal into the draft; the develop-branch edit is a real
// top-level text screen ("branchPolicyDevelop") so 'b' types into the input
// instead of navigating back (I2); the integration edit stays a component-local
// select (selects already have correct b/Esc semantics on this screen).
// Accepting stores the proposal into values.branchPolicy so runInit applies it
// through the same shared helper the host init action uses (byte-identical
// write).
type BranchPolicyEditMode = "menu" | "integration";

const BRANCH_POLICY_ACTIONS: { label: string; value: string }[] = [
  { label: "Accept defaults", value: "accept" },
  { label: "Edit integration", value: "integration" },
  { label: "Edit develop", value: "develop" },
  { label: "Skip", value: "skip" },
];

const INTEGRATION_OPTIONS: { label: string; value: "pr" | "merge" }[] = [
  { label: "Pull request (pr)", value: "pr" },
  { label: "Merge commit", value: "merge" },
];

export function BranchPolicyScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  const detected = draft.values.branchPolicyDetected;
  // I1: render the composed (edited) policy when present, the proposal otherwise
  // so edits show live on return from the integration/develop editors.
  const policy = draft.values.branchPolicy ?? detected;
  const [mode, setMode] = useState<BranchPolicyEditMode>("menu");
  const basePath = resolveBasePath(draft.values);

  useEffect(() => {
    if (detected) return;
    dispatch({
      type: "set",
      field: "branchPolicyDetected",
      value: detectBranchPolicy(basePath),
    });
  }, [detected, dispatch, basePath]);

  if (mode === "integration") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Branch policy · Integration</Text>
        <SelectList
          options={INTEGRATION_OPTIONS}
          value={policy?.integration ?? "merge"}
          onSelect={(value) => {
            dispatch({ type: "set", field: "branchPolicyIntegration", value });
            setMode("menu");
          }}
        />
        <Text dimColor>Enter to select · b Back · Esc Cancel</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 5 — Branch policy</Text>
      {policy ? (
        <Box flexDirection="column" gap={0}>
          <Text>
            Detected preset: <Text color="green">{policy.preset}</Text>
          </Text>
          <Text>
            Develop branch: <Text color="green">{policy.developBranch ?? "—"}</Text>
          </Text>
          <Text>
            Integration: <Text color="green">{policy.integration}</Text>
          </Text>
          <Text>
            Prefixes:{" "}
            <Text color="green">{Object.values(policy.prefixes ?? {}).join(", ") || "—"}</Text>
          </Text>
          <Text>
            Protected: <Text color="green">{policy.protected?.join(", ") || "—"}</Text>
          </Text>
        </Box>
      ) : (
        <Text dimColor>Detecting branch policy…</Text>
      )}
      <SelectList
        options={BRANCH_POLICY_ACTIONS}
        value="accept"
        onSelect={(value) => {
          // I1: Accept keeps whatever the user already edited; without edits it
          // stores the detected proposal.
          if (value === "accept" && policy) {
            if (detected) dispatch({ type: "set", field: "branchPolicy", value: detected });
            dispatch({ type: "next" });
          } else if (value === "integration") setMode("integration");
          else if (value === "develop") dispatch({ type: "branchPolicyEditDevelop" });
          else dispatch({ type: "next" });
        }}
      />
      <Text dimColor>Enter to continue · b Back · Esc Cancel</Text>
    </Box>
  );
}

function describeMutation(m: SetupMutation): string {
  switch (m.type) {
    case "create-file":
      return `+ create ${m.path}`;
    case "merge-json":
      return `+ write ${m.path}`;
    case "update-workspaces":
      return `+ update ${m.path} (${m.entries.length} workspace${m.entries.length === 1 ? "" : "s"})`;
    case "append-gitignore":
      return `+ append ${m.path} (${m.entries.length} entr${m.entries.length === 1 ? "y" : "ies"})`;
    case "register-platform":
      return `+ register ${m.platform}: ${m.path}`;
    case "install-adapter":
      return `+ copy adapter ${m.platform}: ${m.path}`;
    case "install-host":
      return `+ install ${m.platform}: ${m.commands.map((command) => command.command).join(", ")}`;
    case "set-token-path":
      return `+ change ${m.key} in ${m.path} → ${m.value}`;
  }
}

// Each row is keyed by its own text; a repeated row gets an occurrence suffix.
function mutationRows(mutations: SetupMutation[]): { key: string; text: string }[] {
  const seen = new Map<string, number>();
  return mutations.map((m) => {
    const text = describeMutation(m);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { key: count === 0 ? text : `${text}#${count}`, text };
  });
}

// D-06: shown only when WORKFLOW_WORKSPACE_ROOT is unset — the prompt IS the
// resolution root for every workspace preview and hygiene target. Extracted
// component with stable callbacks: @inkjs/ui re-fires its onChange effect
// whenever the handler identity changes, and fresh inline arrows per render
// multiply dispatch rounds per keystroke (long error strings commit a frame
// per change) — enough to trip React's update-depth guard on backspace runs.
export function BasePathScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  const onChange = useCallback(
    (value: string) => dispatch({ type: "set", field: "basePath", value }),
    [dispatch],
  );
  // Commit the submitted value before validating: @inkjs/ui fires onChange
  // from an effect, so a keystroke can land after Enter — the same ordering
  // hazard branchPolicyDevelop guards against.
  const onSubmit = useCallback(
    (value: string) => {
      dispatch({ type: "set", field: "basePath", value });
      dispatch({ type: "next" });
    },
    [dispatch],
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 5 — Workspace root</Text>
      <Text dimColor>Absolute path where your projects live (e.g. /work):</Text>
      <TextInput defaultValue={draft.values.basePath} onChange={onChange} onSubmit={onSubmit} />
      {draft.errors.basePath && <Text color="red">{draft.errors.basePath}</Text>}
      <Text dimColor>Enter to continue · Esc Back</Text>
    </Box>
  );
}

export function BranchPolicyDevelopScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 5 — Branch policy · Develop branch</Text>
      <Text dimColor>Integration/develop branch name (leave empty to unset):</Text>
      <TextInput
        placeholder={SCREEN_PLACEHOLDERS.branchPolicyDevelop}
        defaultValue={
          draft.values.branchPolicy?.developBranch ??
          draft.values.branchPolicyDetected?.developBranch ??
          ""
        }
        onSubmit={(value) => {
          dispatch({ type: "set", field: "branchPolicyDevelop", value });
          dispatch({ type: "next" });
        }}
      />
      <Text dimColor>Enter to save · Esc Back</Text>
    </Box>
  );
}

export function ProjectScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  // CA-07: print the exact directory Apply will touch — the git toplevel
  // of the resolved base path, never an implicit process.cwd(). Outside a
  // repository nothing is offered: the refusal names the way out.
  const target = projectTargetFor(resolveBasePath(draft.values));
  if (!target.ok) {
    // y carries the refusal into the summary and the Apply output (a
    // Skipped row naming `cd <repo>`); n leaves project files out silently.
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 6 — Project setup</Text>
        <Text color="yellow">Skipped: {target.refused}</Text>
        <ConfirmInput
          defaultChoice="confirm"
          submitOnEnter={false}
          onConfirm={() => {
            dispatch({ type: "set", field: "applyProject", value: true });
            dispatch({ type: "next" });
          }}
          onCancel={() => {
            dispatch({ type: "set", field: "applyProject", value: false });
            dispatch({ type: "next" });
          }}
        />
        <Text dimColor>
          y to keep this note in the summary · n to skip it · either adds no project files · b Back
          · Esc Cancel
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 6 — Project setup</Text>
      <Text dimColor>
        Apply gitignore + hygiene in {target.root}? (Existing files are never overwritten.)
      </Text>
      <ConfirmInput
        defaultChoice="cancel"
        submitOnEnter={false}
        onConfirm={() => {
          dispatch({ type: "set", field: "applyProject", value: true });
          dispatch({ type: "next" });
        }}
        onCancel={() => {
          dispatch({ type: "set", field: "applyProject", value: false });
          dispatch({ type: "next" });
        }}
      />
      <Text dimColor>y to add project files · n to skip · b Back · Esc Cancel</Text>
    </Box>
  );
}

export function SummaryScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  const policy = effectivePolicy(draft.values);
  // WZ-08: the summary renders the authoritative preview (read-only) — the
  // exact mutations Apply would perform. Malformed setup state (WZ-06)
  // blocks Apply: no confirm control is mounted until it is fixed.
  // CA-07: the preview's hygiene target is the same displayed base path
  // runInit will pass to Apply.
  const preview = buildSetupPreview(draft.values, { cwd: resolveBasePath(draft.values) });
  const policyPreview = (() => {
    try {
      const current = readConfig();
      const config = {
        ...current,
        branchPolicy: mergePreset(
          draft.values.branchPreset,
          {
            allowed: parseList(draft.values.branchAllowed),
            protectedNames: parseList(draft.values.branchProtected),
          },
          current,
        ),
        commitPolicy: draft.values.commitPolicy,
      };
      const checkout = resolveBasePath(draft.values);
      const workspace = resolveWorkspaceFromEntries(checkout, draft.values.workspaces);
      const resolved = resolveWorkspacePolicy(config, workspace, undefined, () =>
        repoBranchPreset(checkout),
      );
      if (resolved.status === "invalid") return { error: resolved.error };
      return {
        error: null,
        workspace: workspace?.name ?? null,
        branchSource: resolved.provenance.branchPolicy,
        commitSource: resolved.provenance.commitPolicy,
        target: resolved.branchPolicy.defaultTargetBranch,
        branchPreset: resolved.branchPolicy.preset,
        commitPreset: resolved.commitPolicy.preset,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })();
  const canApply = preview.ok && policyPreview.error === null;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        Review
      </Text>
      <Text>
        Platforms: <Text color="green">{draft.values.platforms.join(", ") || "—"}</Text>
      </Text>
      <Text>
        Locale: <Text color="green">{draft.values.locale}</Text>
      </Text>
      <Text>
        Branch policy: <Text color="green">{policy.preset}</Text> — allowed:{" "}
        {policy.allowed.join(", ")} · protected: {policy.protected.join(", ")}
      </Text>
      {policyPreview.error === null ? (
        <Box flexDirection="column" gap={0}>
          <Text>
            Sample checkout: <Text color="green">{resolveBasePath(draft.values)}</Text>
            {policyPreview.workspace
              ? ` · workspace ${policyPreview.workspace}`
              : " · no matching workspace"}
          </Text>
          <Text>
            Effective branch policy: <Text color="green">{policyPreview.branchPreset}</Text> ·
            target {policyPreview.target} · source {policyPreview.branchSource}
          </Text>
          <Text>
            Effective commit policy: <Text color="green">{policyPreview.commitPreset}</Text> ·
            source {policyPreview.commitSource}
          </Text>
        </Box>
      ) : (
        <Text color="red">Policy preview failed: {policyPreview.error}</Text>
      )}
      <Text>
        YouTrack base URL:{" "}
        <Text color="green">
          {draft.values.issueTracker === "youtrack"
            ? draft.values.baseUrl.trim()
              ? draft.values.baseUrl
              : "— (skip)"
            : "—"}
        </Text>
      </Text>
      <Text>
        VCS provider: <Text color="green">{draft.values.vcsProvider}</Text>
      </Text>
      <Text>
        Project hygiene:{" "}
        {preview.projectRefused ? (
          <Text color="yellow">skipped — {preview.projectRefused}</Text>
        ) : (
          <Text color="green">{draft.values.applyProject ? "yes" : "no"}</Text>
        )}
      </Text>
      {preview.overrides.length > 0 && (
        <Box flexDirection="column" gap={0}>
          <Text bold>Environment overrides (not applied by the wizard):</Text>
          {preview.overrides.map((o) => (
            <Text key={o.envKey} color="yellow">
              {o.envKey} → {o.affects}: {o.value}
            </Text>
          ))}
        </Box>
      )}
      {canApply ? (
        <Box flexDirection="column" gap={0}>
          <Text bold>Will apply:</Text>
          {mutationRows(preview.mutations).map((row) => (
            <Text key={row.key}>{row.text}</Text>
          ))}
          {preview.preserved.map((p) => (
            <Text key={p} color="green">
              preserve {p} (existing token)
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" gap={0}>
          <Text bold color="red">
            Apply blocked — malformed configuration:
          </Text>
          {preview.blocked.map((b) => (
            <Text key={b} color="red">
              {b}
            </Text>
          ))}
          <Text dimColor>Fix or remove the blocked file above, then return here. Esc Cancel.</Text>
        </Box>
      )}
      {canApply && (
        <ConfirmInput
          defaultChoice="confirm"
          submitOnEnter={false}
          onConfirm={() => dispatch({ type: "apply" })}
          onCancel={() => {}}
        />
      )}
      <Text dimColor>{canApply ? "y to apply · b Back · Esc Cancel" : "b Back · Esc Cancel"}</Text>
    </Box>
  );
}

export function ExitScreen(): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Exiting…</Text>
    </Box>
  );
}
