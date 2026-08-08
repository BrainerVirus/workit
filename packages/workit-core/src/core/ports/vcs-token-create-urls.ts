// CLI port of scripts/vcs/token-create-urls.sh.
import { vcsTokenCreateUrls } from "../vcs-config";

console.log(JSON.stringify(vcsTokenCreateUrls(), null, 2));
