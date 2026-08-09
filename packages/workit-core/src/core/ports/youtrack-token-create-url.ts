// CLI port of scripts/youtrack/token-create-url.sh.
import { youTrackTokenCreateUrl } from "../youtrack";

console.log(JSON.stringify(youTrackTokenCreateUrl().data, null, 2));
