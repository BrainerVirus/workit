// Existing users (#819): an account whose workspaces.json was never sealed
// gets the D4 defaults as its sealed value, so `workit upgrade` and
// `workit setup` at the user's terminal show its authority fields once and
// offer to seal them. Only when there is no seal at all, never on a mismatch
// (that one names `workit workspace seal` wherever it applies), and never
// headless or in an agent's shell. Doctor's grant_seal row warns until sealed.
import path from "node:path";
import { sealStatus } from "@workit-dev/core/src/autonomy";
import { type Io } from "../output";
import {
  atTerminal,
  offerSeal,
  terminalDeps,
  type GrantDeps,
  type SealOffer,
} from "../verbs/grant";

export async function offerFirstSeal(io: Io, deps: GrantDeps = terminalDeps): Promise<SealOffer> {
  if (io.json || !atTerminal(io, deps)) return "skipped";
  const status = sealStatus();
  if (status.state !== "none" || status.error || status.entries.length === 0) return "skipped";
  const offered = await offerSeal(
    io,
    deps,
    `Workit now reads grants only as far as the user sealed them: ${path.join(status.dir, "workspaces.json")} has no seal, so anything above the D4 defaults does not apply. Sealing accepts:`,
  );
  const say = io.json ? io.stderr : io.stdout;
  if (offered === "sealed") say("Sealed: workspaces.json's grants apply as written.\n");
  if (offered === "declined")
    say("Not sealed. Later, in your own terminal: workit workspace seal\n");
  return offered;
}
