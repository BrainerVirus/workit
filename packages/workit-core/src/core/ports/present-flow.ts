// CLI port of scripts/present/flow-diagram.sh — JSON spec on stdin.
import { renderFlowDiagram } from "../present";

const input = await Bun.stdin.text();
try {
  console.log(renderFlowDiagram(input));
} catch (err) {
  console.error(err instanceof Error ? err.message : "flow-diagram render failed");
  process.exit(1);
}
