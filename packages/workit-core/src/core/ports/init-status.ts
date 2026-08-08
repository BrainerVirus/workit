// CLI port of scripts/init/status.sh.
import { initStatusData } from "../init";

console.log(JSON.stringify(initStatusData(), null, 2));
