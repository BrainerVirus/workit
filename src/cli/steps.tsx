import { Box, Text, useInput } from "ink";
import { ConfirmInput, MultiSelect, Select, TextInput } from "@inkjs/ui";
import { useState, type Dispatch, type JSX, type SetStateAction } from "react";
import { configDir, readConfig, writeConfig, type BranchPreset, type ToolkitConfig } from "../core/config";
import type { WorkspaceConfig } from "../core/workspaces";
import {
  collectConfigValues,
  DEFAULT_BASE_URL,
  loadWorkspaces,
  parseList,
  runProjectSetup,
  scaffoldVcs,
  scaffoldYouTrack,
  shouldWriteWorkspaces,
  validateBaseUrl,
  validateLocale,
  validateTimezone,
  writeWorkspaces,
  type ProjectSetupResult,
  type VcsProvider,
  type VcsScaffold,
  type YouTrackScaffold,
} from "./logic";

export type WizardResults = {
  platforms: string[];
  config: ToolkitConfig;
  youtrack: YouTrackScaffold | null;
  vcs: VcsScaffold | null;
  project: ProjectSetupResult | null;
};

type StepProps = {
  results: WizardResults;
  setResults: Dispatch<SetStateAction<WizardResults>>;
  onDone: () => void;
  onExit: () => void;
};

type StepComponent = (props: StepProps) => JSX.Element;

const PLATFORMS = [
  { label: "OpenCode", value: "opencode" },
  { label: "Cursor", value: "cursor" },
];

const BRANCH_PRESETS: { label: string; value: BranchPreset }[] = [
  { label: "GitFlow", value: "gitflow" },
  { label: "GitHub Flow", value: "github-flow" },
  { label: "Trunk-based", value: "trunk-based" },
  { label: "Custom", value: "custom" },
];

const VCS_PROVIDERS = [
  { label: "GitLab", value: "gitlab" },
  { label: "GitHub", value: "github" },
];

function continueLabel(): string {
  return " y to continue · n to stay · Esc to exit";
}

export function Wizard({ onExit }: { onExit: () => void }): JSX.Element {
  const [step, setStep] = useState(0);
  const [results, setResults] = useState<WizardResults>(() => ({
    platforms: [],
    config: readConfig(),
    youtrack: null,
    vcs: null,
    project: null,
  }));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === "c")) onExit();
  });

  const advance = () => setStep((s) => Math.min(s + 1, 6));
  const props: StepProps = { results, setResults, onDone: advance, onExit };
  const Step = (step === 6 ? SummaryStep : [PlatformStep, ConfigStep, YouTrackStep, VcsStep, WorkspacesStep, ProjectStep, SummaryStep][step]) as StepComponent;

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        flowkit — workflow rails for agentic coding
      </Text>
      <Step {...props} />
    </Box>
  );
}

function PlatformStep({ results, setResults, onDone }: StepProps): JSX.Element {
  const [error, setError] = useState(false);
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 1 — Platforms</Text>
      <Text dimColor>Select the tools to configure (space to toggle):</Text>
      <MultiSelect
        options={PLATFORMS}
        defaultValue={results.platforms}
        onSubmit={(values) => {
          if (values.length === 0) {
            setError(true);
            return;
          }
          setResults((r) => ({ ...r, platforms: values }));
          onDone();
        }}
      />
      {error && <Text color="red">Select at least one platform to continue.</Text>}
      <Text dimColor>Enter to continue · Esc to exit</Text>
    </Box>
  );
}

function ConfigStep({ results, setResults, onDone }: StepProps): JSX.Element {
  const current = results.config;
  const [locale, setLocale] = useState(current.locale);
  const [localeOk, setLocaleOk] = useState(validateLocale(current.locale) === null);
  const [localeError, setLocaleError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(current.timezone);
  const [tzOk, setTzOk] = useState(validateTimezone(current.timezone) === null);
  const [tzError, setTzError] = useState<string | null>(null);
  const [preset, setPreset] = useState<BranchPreset>(current.branchPolicy.preset);
  const [allowed, setAllowed] = useState(current.branchPolicy.allowed.join(", "));
  const [protectedNames, setProtectedNames] = useState(current.branchPolicy.protected.join(", "));

  const save = () => {
    const next = collectConfigValues(
      {
        locale: localeOk ? locale : undefined,
        timezone: tzOk ? timezone : undefined,
        preset,
        allowed: preset === "custom" ? parseList(allowed) : undefined,
        protectedNames: preset === "custom" ? parseList(protectedNames) : undefined,
      },
      current,
    );
    writeConfig(next);
    setResults((r) => ({ ...r, config: next }));
    onDone();
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 2 — Global config</Text>
      <Text dimColor>Locale (BCP-47, e.g. en or es-CL):</Text>
      <TextInput
        defaultValue={locale}
        onSubmit={(v) => {
          const err = validateLocale(v);
          if (err) {
            setLocaleError(err);
            setLocaleOk(false);
          } else {
            setLocaleError(null);
            setLocale(v);
            setLocaleOk(true);
          }
        }}
      />
      {localeError && <Text color="red">{localeError}</Text>}
      <Text dimColor>Timezone (IANA name, e.g. America/Santiago):</Text>
      <TextInput
        defaultValue={timezone}
        onSubmit={(v) => {
          const err = validateTimezone(v);
          if (err) {
            setTzError(err);
            setTzOk(false);
          } else {
            setTzError(null);
            setTimezone(v);
            setTzOk(true);
          }
        }}
      />
      {tzError && <Text color="red">{tzError}</Text>}
      <Text dimColor>Branch policy preset:</Text>
      <Select options={BRANCH_PRESETS} defaultValue={preset} onChange={(v) => setPreset(v as BranchPreset)} />
      {preset === "custom" && (
        <>
          <Text dimColor>Allowed branch patterns (comma-separated):</Text>
          <TextInput defaultValue={allowed} onChange={setAllowed} />
          <Text dimColor>Protected branch names (comma-separated):</Text>
          <TextInput defaultValue={protectedNames} onChange={setProtectedNames} />
        </>
      )}
      <ConfirmInput
        isDisabled={!localeOk || !tzOk}
        defaultChoice="confirm"
        submitOnEnter={false}
        onConfirm={save}
        onCancel={() => {}}
      />
      <Text dimColor>{continueLabel()}</Text>
    </Box>
  );
}

function YouTrackStep({ results, setResults, onDone }: StepProps): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [scaffold, setScaffold] = useState<YouTrackScaffold | null>(results.youtrack);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 3 — YouTrack</Text>
      <Text dimColor>Base URL (https):</Text>
      <TextInput
        defaultValue={baseUrl}
        isDisabled={scaffold !== null}
        onSubmit={(v) => {
          const err = validateBaseUrl(v);
          if (err) {
            setUrlError(err);
            return;
          }
          setUrlError(null);
          setBaseUrl(v);
          const s = scaffoldYouTrack(configDir(), v, {
            locale: results.config.locale,
            timezone: results.config.timezone,
          });
          setScaffold(s);
          setResults((r) => ({ ...r, youtrack: s }));
        }}
      />
      {urlError && <Text color="red">{urlError}</Text>}
      {scaffold ? (
        <>
          <Box flexDirection="column" gap={0}>
            <Text color="green">Scaffolded {scaffold.youtrackJson}</Text>
            <Text>Token placeholder: {scaffold.tokenPath}</Text>
            <Text>Create token: {scaffold.tokenCreateUrl}</Text>
          </Box>
          {/* ponytail: @inkjs/ui has no focus system — render the ConfirmInput only once the scaffold
              exists and disable the TextInput, so y reaches only the confirm (hint stays truthful) */}
          <ConfirmInput
            defaultChoice="confirm"
            submitOnEnter={false}
            onConfirm={onDone}
            onCancel={() => {}}
          />
          <Text dimColor>{continueLabel()}</Text>
        </>
      ) : (
        <Text dimColor>Enter to submit the URL — then y to continue</Text>
      )}
    </Box>
  );
}

function VcsStep({ results, setResults, onDone }: StepProps): JSX.Element {
  const [provider, setProvider] = useState<VcsProvider>(results.vcs?.provider ?? "gitlab");
  const [scaffold, setScaffold] = useState<VcsScaffold | null>(results.vcs);

  const apply = (p: VcsProvider) => {
    const s = scaffoldVcs(configDir(), p);
    setScaffold(s);
    setResults((r) => ({ ...r, vcs: s }));
  };

  // ponytail: Select's onChange only fires when Enter picks a different option — this useInput
  // covers Enter on the default provider; scaffoldVcs is idempotent so double-apply is harmless
  useInput((_input, key) => {
    if (key.return) apply(provider);
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 4 — Version control</Text>
      <Text dimColor>Provider:</Text>
      <Select
        options={VCS_PROVIDERS}
        defaultValue={provider}
        onChange={(v) => {
          const p = v as VcsProvider;
          setProvider(p);
          apply(p);
        }}
      />
      {scaffold ? (
        <>
          <Box flexDirection="column" gap={0}>
            <Text color="green">Scaffolded {scaffold.vcsJson} (provider: {scaffold.provider})</Text>
            <Text>Token placeholder: {scaffold.activeTokenPath}</Text>
            <Text>Create token: {scaffold.tokenCreateUrl}</Text>
          </Box>
          <ConfirmInput
            defaultChoice="confirm"
            submitOnEnter={false}
            onConfirm={onDone}
            onCancel={() => {}}
          />
          <Text dimColor>{continueLabel()}</Text>
        </>
      ) : (
        <Text dimColor>Enter to confirm the provider — then y to continue</Text>
      )}
    </Box>
  );
}

type WsDraft = {
  name: string;
  glob: string;
  provider: VcsProvider;
  branch: string;
  linking: "youtrack" | "github" | "none";
};

type WsMode = "list" | "name" | "glob" | "provider" | "branch" | "linking" | "remove";

const WS_ACTIONS = [
  { label: "Add workspace", value: "add" },
  { label: "Remove workspace", value: "remove" },
  { label: "Done", value: "done" },
];

const WS_LINKING = [
  { label: "YouTrack", value: "youtrack" },
  { label: "GitHub issues", value: "github" },
  { label: "None", value: "none" },
];

// ponytail: Select has no onSubmit — onChange fires on Enter once the value differs from
// defaultValue, so action/provider/linking selects pass no defaultValue (undefined -> first
// Enter is a change). TextInput onSubmit fires on Enter even for empty input (validation).
// Each input gets a distinct key: mode swaps render the same element type at the same tree
// position, so without keys React reuses the instance and the previous input's text leaks in.
function WorkspacesStep({ onDone }: StepProps): JSX.Element {
  const [loaded] = useState<WorkspaceConfig[]>(() => loadWorkspaces());
  const [entries, setEntries] = useState<WorkspaceConfig[]>(loaded);
  const [mode, setMode] = useState<WsMode>("list");
  const [draft, setDraft] = useState<WsDraft>({ name: "", glob: "", provider: "gitlab", branch: "main", linking: "none" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const resetDraft = () => setDraft({ name: "", glob: "", provider: "gitlab", branch: "main", linking: "none" });

  const finish = () => {
    if (!shouldWriteWorkspaces(loaded, entries)) {
      onDone();
      return;
    }
    const result = writeWorkspaces(entries);
    if (result.ok) {
      onDone();
    } else {
      setWriteError(result.error ?? "failed to write workspaces.json");
      setMode("list");
    }
  };

  if (mode === "list") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Workspaces</Text>
        {entries.length === 0 && <Text dimColor>No workspaces configured yet.</Text>}
        {entries.map((e) => (
          <Text key={e.name}>
            • {e.name} — {e.vcs?.provider ?? "?"} — {e.glob}
          </Text>
        ))}
        <Text dimColor>Select an action:</Text>
        <Select
          key="actions"
          options={WS_ACTIONS}
          onChange={(v) => {
            if (v === "add") {
              setFieldError(null);
              setWriteError(null);
              setMode("name");
            } else if (v === "remove" && entries.length > 0) {
              setFieldError(null);
              setWriteError(null);
              setMode("remove");
            } else if (v === "done") {
              finish();
            }
          }}
        />
        {writeError && <Text color="red">{writeError}</Text>}
        <Text dimColor>Enter to pick · Esc to exit</Text>
      </Box>
    );
  }

  if (mode === "name") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Workspaces · new workspace</Text>
        <Text dimColor>Name (e.g. work):</Text>
        <TextInput
          key="name"
          onSubmit={(v) => {
            if (!v.trim()) {
              setFieldError("name is required");
              return;
            }
            setFieldError(null);
            setDraft({ ...draft, name: v.trim() });
            setMode("glob");
          }}
        />
        {fieldError && <Text color="red">{fieldError}</Text>}
      </Box>
    );
  }

  if (mode === "glob") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Workspaces · {draft.name}</Text>
        <Text dimColor>Path glob (e.g. /home/*/Documents/projects/work/**):</Text>
        <TextInput
          key="glob"
          onSubmit={(v) => {
            if (!v.trim()) {
              setFieldError("glob is required");
              return;
            }
            setFieldError(null);
            setDraft({ ...draft, glob: v.trim() });
            setMode("provider");
          }}
        />
        {fieldError && <Text color="red">{fieldError}</Text>}
      </Box>
    );
  }

  if (mode === "provider") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Workspaces · {draft.name}</Text>
        <Text dimColor>VCS provider:</Text>
        <Select
          key="provider"
          options={VCS_PROVIDERS}
          onChange={(v) => {
            setDraft({ ...draft, provider: v as VcsProvider });
            setMode("branch");
          }}
        />
      </Box>
    );
  }

  if (mode === "branch") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Workspaces · {draft.name}</Text>
        <Text dimColor>Default target branch (Enter to keep "{draft.branch}"):</Text>
        <TextInput
          key="branch"
          defaultValue={draft.branch}
          onSubmit={(v) => {
            setDraft({ ...draft, branch: v.trim() });
            setMode("linking");
          }}
        />
      </Box>
    );
  }

  if (mode === "linking") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Workspaces · {draft.name}</Text>
        <Text dimColor>Issue linking:</Text>
        <Select
          key="linking"
          options={WS_LINKING}
          onChange={(v) => {
            const linking = v as WsDraft["linking"];
            const vcs = { provider: draft.provider, ...(draft.branch ? { defaultTargetBranch: draft.branch } : {}) };
            setEntries([
              ...entries,
              {
                name: draft.name,
                glob: draft.glob,
                vcs,
                ...(linking === "youtrack" ? { youtrack: { link_issues: true } } : {}),
                ...(linking === "github" ? { issues: { provider: "github", link_on_pr: true } } : {}),
              },
            ]);
            resetDraft();
            setWriteError(null);
            setMode("list");
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 5 — Workspaces · remove</Text>
      <Text dimColor>Select a workspace to remove:</Text>
      <Select
        key="remove"
        options={entries.map((e) => ({ label: `${e.name} — ${e.vcs?.provider ?? "?"}`, value: e.name }))}
        onChange={(v) => {
          setEntries(entries.filter((e) => e.name !== v));
          setWriteError(null);
          setMode("list");
        }}
      />
    </Box>
  );
}

function ProjectStep({ setResults, onDone }: StepProps): JSX.Element {
  const apply = () => {
    const result = runProjectSetup(process.cwd());
    setResults((r) => ({ ...r, project: result }));
    onDone();
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 6 — Project setup</Text>
      <Text dimColor>Will apply gitignore + hygiene in {process.cwd()} (existing files are never overwritten):</Text>
      <ConfirmInput defaultChoice="confirm" submitOnEnter={false} onConfirm={apply} onCancel={() => {}} />
      <Text dimColor>{continueLabel()}</Text>
    </Box>
  );
}

function SummaryStep({ results, onExit }: StepProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        Setup complete
      </Text>
      <Text>
        Platforms: <Text color="green">{results.platforms.join(", ")}</Text>
      </Text>
      <Text>
        Global config: <Text color="green">{configDir()}/config.json</Text>
      </Text>
      {results.youtrack && (
        <Box flexDirection="column" gap={0}>
          <Text>
            YouTrack: <Text color="green">{results.youtrack.youtrackJson}</Text>
          </Text>
          <Text>  token placeholder: {results.youtrack.tokenPath}</Text>
          <Text>  create token: {results.youtrack.tokenCreateUrl}</Text>
        </Box>
      )}
      {results.vcs && (
        <Box flexDirection="column" gap={0}>
          <Text>
            VCS: <Text color="green">{results.vcs.vcsJson}</Text> (provider: {results.vcs.provider})
          </Text>
          <Text>  token placeholder: {results.vcs.activeTokenPath}</Text>
          <Text>  create token: {results.vcs.tokenCreateUrl}</Text>
        </Box>
      )}
      {results.project && results.project.created.length > 0 && (
        <Box flexDirection="column" gap={0}>
          <Text>Project files:</Text>
          {results.project.created.map((file) => (
            <Text key={file}>  + {file}</Text>
          ))}
        </Box>
      )}
      <Text dimColor>Paste the token(s) into the placeholder files, then run /wf-status to verify.</Text>
      <ConfirmInput defaultChoice="confirm" submitOnEnter={false} onConfirm={onExit} onCancel={() => {}} />
      <Text dimColor>{continueLabel()}</Text>
    </Box>
  );
}
