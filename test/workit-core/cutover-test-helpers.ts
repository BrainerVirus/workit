import {
  applyCutover,
  type CutoverHost,
  type CutoverReceipt,
  previewCutover,
  type CutoverPaths,
} from "@/packages/workit-core/src/core/cutover";
import {
  type CutoverFixture,
  makeCutoverFixture,
  removeLegacySkills,
  installV1Skills,
} from "@/test/shared/helpers/cutover-fixture";

export const makeFx = () => makeCutoverFixture();

export const approve = (hosts: CutoverHost[] = ["opencode", "cursor"]) => ({
  approve: true as const,
  hosts,
  resolutions: { legacyWorkflowMode: "fresh-v1-task", "branchPolicy.allowed": "feature/*" },
});

export const resolvePathsForTest = (fx: CutoverFixture): CutoverPaths => ({
  home: fx.home,
  configDir: fx.configDir,
  stateDir: fx.stateDir,
  dev: fx.dev,
  workspace: fx.workspace,
  opencodeConfig: fx.opencodeConfig,
  cursorSettings: fx.cursorSettings,
  cursorMcp: fx.cursorMcp,
  cursorPluginDir: fx.pluginDir,
});

export const applyFxCutover = (fx: CutoverFixture): CutoverReceipt => {
  removeLegacySkills(fx.pluginDir);
  installV1Skills(fx.pluginDir);
  const plan = previewCutover(
    {
      ...resolvePathsForTest(fx),
      sessions: [{ host: "opencode", handle: "ses_old", state: "stopped" }],
    },
    ["opencode", "cursor"],
  );
  const result = applyCutover(plan, approve(), resolvePathsForTest(fx));
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
};
