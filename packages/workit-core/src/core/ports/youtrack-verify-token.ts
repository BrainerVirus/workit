// CLI port of scripts/youtrack/verify-token.sh.
import { youTrackVerifyToken } from "../youtrack";

const out = await youTrackVerifyToken();
if ("error" in out) {
  const payload: Record<string, any> = { ok: false, error: out.error };
  if (out.http_status !== undefined) payload.http_status = out.http_status;
  if (out.path !== undefined) payload.path = out.path;
  console.log(JSON.stringify(payload, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(out.data, null, 2));
