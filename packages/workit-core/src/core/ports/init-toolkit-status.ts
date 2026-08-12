// CLI port of scripts/init/toolkit-status.sh.
import { toolkitStatusData } from "../init";

console.log(JSON.stringify(await toolkitStatusData(), null, 2));
