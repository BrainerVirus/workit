// CLI port of scripts/init/toolkit-status.sh.
import { toolkitStatusData } from "../init";

console.log(JSON.stringify(toolkitStatusData(), null, 2));
