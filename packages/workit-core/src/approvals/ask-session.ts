// The host session an inline ask's ticket must come from (#864).
import { hostSessionFromEnv, realHostSession } from "../host-session";

/**
 * The host's own shell variable (Pi's PI_SESSION_ID, which its bash tool sets
 * on every call) when it belongs to the host WORKIT_HOST names, else the
 * declared WORKIT_SESSION_ID (Claude Code's SessionStart export). A Pi
 * worker's shell also carries WORKIT_SESSION_ID `<lead>:<worker>`, which is
 * not what its dialog recorded.
 */
export const inlineAskSession = (env: NodeJS.ProcessEnv): string | null => {
  const real = realHostSession(env);
  const declared = env.WORKIT_HOST?.trim().replace(/_(?:cli|desktop)$/u, "");
  return real.kind === "derived" && (!declared || real.host?.startsWith(declared))
    ? real.session
    : hostSessionFromEnv(env).session;
};
