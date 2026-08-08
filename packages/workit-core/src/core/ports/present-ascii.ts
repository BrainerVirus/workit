// CLI port of scripts/present/ascii-wireframe.sh — JSON spec on stdin.
import { renderAsciiWireframe } from "../present";

const input = await Bun.stdin.text();
try {
  console.log(renderAsciiWireframe(input));
} catch (err) {
  console.error(err instanceof Error ? err.message : "ascii-wireframe render failed");
  process.exit(1);
}
