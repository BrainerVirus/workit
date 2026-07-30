/** Split script stdout on ## Section headers (print_section output). */
export function parseSections(stdout) {
  const sections = {};
  const parts = stdout.split(/\n## /);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const title = part.slice(0, nl).trim();
    sections[title] = part.slice(nl + 1).trim();
  }
  return sections;
}

export function parseKeyValueLines(text, keys) {
  const out = {};
  for (const line of text.split('\n')) {
    for (const key of keys) {
      const prefix = `${key}: `;
      if (line.startsWith(prefix)) {
        out[key] = line.slice(prefix.length).trim();
      }
    }
  }
  return out;
}
