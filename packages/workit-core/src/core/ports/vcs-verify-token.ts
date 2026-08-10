// CLI port of scripts/vcs/verify-token.sh — soft-fail JSON, exit 0.
import { vcsVerifyToken } from "../vcs-config";

console.log(JSON.stringify(await vcsVerifyToken()));
