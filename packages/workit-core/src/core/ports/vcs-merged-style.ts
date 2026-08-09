// CLI port of scripts/vcs/merged-style.sh.
import { mergedPrStyle } from "../vcs-config";

const limit = Number(process.argv[2] ?? "6") || 6;
console.log(JSON.stringify(mergedPrStyle(limit), null, 2));
