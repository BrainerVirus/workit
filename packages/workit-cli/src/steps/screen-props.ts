import type { Dispatch } from "react";
import type { HostDetection, HostId } from "../admin/detect-hosts";
import type { WizardAction, WizardDraft } from "../wizard-state";

export type ScreenProps = {
  draft: WizardDraft;
  dispatch: Dispatch<WizardAction>;
  // Optional so sub-screens that never read it (branch policy, base path)
  // keep their call sites unchanged; Screen defaults it when absent.
  detection?: Record<HostId, HostDetection>;
  onSearchQueryChange?: (query: string) => void;
};
