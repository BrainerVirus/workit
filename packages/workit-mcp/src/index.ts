import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertMcpHost, runStdioServer } from "./server";
import type { McpHost } from "./server";

export {
  assertMcpHost,
  createMcpServer,
  runStdioServer,
  type McpHost,
  type NativeContextProvider,
} from "./server";

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const hostIndex = args.indexOf("--host");
  const host = hostIndex >= 0 ? args[hostIndex + 1] : undefined;
  try {
    assertMcpHost(host);
    await runStdioServer(host as McpHost);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.replace(/\r?\n/g, " ").slice(0, 500)}\n`);
    process.exitCode = 2;
  }
};

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === path.resolve(fileURLToPath(import.meta.url))) await main();
