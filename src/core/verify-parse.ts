/** Parse verify-project.sh stdout (# Summary + ## check sections). */
export function parseVerifyOutput(stdout: string): Record<string, any> {
  const commands = [];
  const parts = stdout.split(/\n## /);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const label = part.slice(0, nl).trim();
    const body = part.slice(nl + 1);
    const cmdMatch = body.match(/^command: (.+)$/m);
    const statusMatch = body.match(/^status: (pass|fail|skipped)(?: \((.+)\))?/m);
    if (cmdMatch && statusMatch) {
      commands.push({
        label,
        command: cmdMatch[1].trim(),
        status: statusMatch[1],
        reason: statusMatch[2]?.trim(),
      });
    }
  }

  const summaryMatch = stdout.match(/# Summary[\s\S]*?passed: (\d+)[\s\S]*?failed: (\d+)[\s\S]*?skipped: (\d+)/);
  const passed = summaryMatch ? Number(summaryMatch[1]) : 0;
  const failed = summaryMatch ? Number(summaryMatch[2]) : 0;
  const skipped = summaryMatch ? Number(summaryMatch[3]) : 0;

  return { passed, failed, skipped, commands };
}
