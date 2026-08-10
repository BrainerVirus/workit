// Ports of scripts/present/ascii-wireframe.sh + flow-diagram.sh — pure TS renderers.

function boxLine(text: string, width: number): string {
  const inner = width - 4;
  let t = text;
  if (t.length > inner) t = t.slice(0, inner - 1) + "…";
  return "│ " + t.padEnd(inner) + " │";
}

export function renderAsciiWireframe(spec: unknown): string {
  const parsed = typeof spec === "string" ? JSON.parse(spec) : spec;
  const title = String((parsed as any).title ?? "UI");
  const width = Number((parsed as any).width ?? 72);
  const rows = Array.isArray((parsed as any).rows) ? (parsed as any).rows : [];

  const top = "┌" + "─".repeat(Math.max(0, width - 2)) + "┐";
  const bot = "└" + "─".repeat(Math.max(0, width - 2)) + "┘";
  const lines = [top, boxLine(title, width)];
  lines.push("├" + "─".repeat(Math.max(0, width - 2)) + "┤");

  for (const row of rows) {
    const kind = row?.type ?? "text";
    if (kind === "separator") {
      lines.push("├" + "─".repeat(Math.max(0, width - 2)) + "┤");
      continue;
    }
    if (kind === "header") {
      lines.push(boxLine(String(row?.label ?? ""), width));
      continue;
    }
    if (kind === "button") {
      const label = "[ " + String(row?.label ?? "Button") + " ]";
      lines.push(
        boxLine(
          label.padStart(Math.max(0, (width - 4 + label.length) / 2)).padEnd(width - 4),
          width,
        ),
      );
      continue;
    }
    if (kind === "field") {
      const label = String(row?.label ?? "Field");
      const value = String(row?.value ?? "_______________");
      lines.push(boxLine(`${label}: ${value}`, width));
      continue;
    }
    if (kind === "columns") {
      const cols = Array.isArray(row?.columns) ? row.columns : [];
      const colW = Math.floor((width - 4 - cols.length + 1) / Math.max(cols.length, 1));
      const parts = cols.map((c: any) =>
        String(c?.label ?? "")
          .slice(0, Math.max(0, colW - 1))
          .padEnd(Math.max(0, colW)),
      );
      lines.push(boxLine(parts.join(" | ").trim(), width));
      continue;
    }
    lines.push(boxLine(String(row?.label ?? String(row)), width));
  }

  lines.push(bot);
  return lines.join("\n");
}

export function renderFlowDiagram(spec: unknown): string {
  const parsed = typeof spec === "string" ? JSON.parse(spec) : spec;
  const direction = String((parsed as any).direction ?? "TD");
  const nodes = Array.isArray((parsed as any).nodes) ? (parsed as any).nodes : [];
  const edges = Array.isArray((parsed as any).edges) ? (parsed as any).edges : [];
  const title = (parsed as any).title;

  const lines = ["flowchart " + direction];
  if (title) lines.push("  %% " + String(title));

  for (const n of nodes) {
    const nid = String(n?.id ?? "");
    const shape = String(n?.shape ?? "box");
    const label = String(n?.label ?? nid).replaceAll('"', "'");
    if (shape === "diamond") lines.push(`  ${nid}{"${label}"}`);
    else if (shape === "start") lines.push(`  ${nid}(["${label}"])`);
    else lines.push(`  ${nid}["${label}"]`);
  }

  for (const e of edges) {
    const src = String(e?.from ?? "");
    const dst = String(e?.to ?? "");
    const lbl = e?.label;
    if (lbl) lines.push(`  ${src} -->|${lbl}| ${dst}`);
    else lines.push(`  ${src} --> ${dst}`);
  }

  return lines.join("\n");
}

export function asciiWireframe(spec: unknown): Record<string, any> {
  try {
    return { data: { ascii: renderAsciiWireframe(spec), format: "ascii-wireframe" } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "ascii-wireframe render failed" };
  }
}

export function flowDiagram(spec: unknown): Record<string, any> {
  try {
    return { data: { mermaid: renderFlowDiagram(spec), format: "mermaid" } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "flow-diagram render failed" };
  }
}
