# Spec: Doc rendering — render/raw/umbral

**Branch:** `feature/doc-rendering`

## Context

The agent delivers specs and plans as raw markdown blocks in chat. In a TUI that renders markdown (OpenCode) or an IDE with a mermaid extension (Cursor), raw blocks force the user to read source and lose the rendered diagrams/tables. The user wants: by default, docs are delivered rendered (markdown formatting, mermaid fences, tables); a long/heavy doc gets only the clickable link + a short summary; an explicit `raw` request shows the block as today.

## Goals

- G1: Doc delivery rule: render the full markdown content of spec/plan in chat (headings, tables, mermaid fences preserved), NOT a backtick-wrapped raw block — unless the user explicitly asked for raw (e.g. "raw", "as raw", "para copiar").
- G2: Automatic threshold: `shouldRenderDoc(text)` decides when a doc is too long/heavy to render — dimensions: line count, byte size, mermaid-block count (heavy = many diagrams). Above threshold → clickable link + 3-5 bullet summary only.
- G3: Raw mode: explicit user request renders the full content in a fenced raw block exactly as today.
- G4: The clickable link `[spec.md](docs/<slug>/spec.md)` always accompanies the delivery (already enforced by DOC_DELIVERY_TEXT; keep).
- G5: Threshold constants are exported and testable; behavior documented in the reminder text so agents apply it consistently.

## Non-goals

- No client-side rendering changes (OpenCode/Cursor native rendering is out of toolkit control).
- No changes to the docs themselves (spec/plan content untouched).
- No interactive pager; the decision is purely by content size.

## Platform rendering research (verified against official sources)

| Platform | Markdown | Tables | Mermaid | Links |
| --- | --- | --- | --- | --- |
| OpenCode TUI 1.18.x | Yes (marked) | Yes (grid) | No — only syntax highlighting; `mermaid-*.js` is a TextMate grammar, not a renderer | No — inline markdown links are styled text (`markdown-link` theme color); the clickable `Link` component (`open()` on mouse-up) is only used for explicit UI links |
| Cursor CLI (cursor-agent) | Yes | Yes | Yes — `code-block` with `language === "mermaid"` renders via `beautiful-mermaid` `renderMermaidASCII` (ASCII diagram) in the interactive TUI | Yes (hyperlinks) |

Implication (D-05): the toolkit always emits the standard ` ```mermaid ` fence (the one Cursor renders; GitHub/editors render too). OpenCode TUI shows it as code text — a renderer limitation, not a toolkit defect. Raw delivery stays available on request.

## Architecture

```mermaid
flowchart TD
  %% Spec: doc rendering — render/raw/umbral
  deliver["Doc delivery (spec/plan)"]
  size["shouldRenderDoc (umbral)"]
  render["Render markdown completo"]
  link["Solo link + resumen"]
  out["Chat renderizado"]
  raw["Petición raw explícita"]
  rawout["Bloque raw como hoy"]
  deliver -->|agente entrega spec/plan| size
  size -->|<= umbral| render
  size -->|> umbral (líneas/KB/mermaid)| link
  render -->|markdown completo| out
  link -->|link clickeable + 3-5 bullets| out
  raw -->|'raw' explícito| rawout
```

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| `shouldRenderDoc(text)` | `(text: string) => boolean` — true when text fits the render threshold |
| Threshold | `MAX_LINES = 150`, `MAX_BYTES = 8192`, `MAX_MERMAID = 3` — render only if ALL bounds are within |
| `DOC_RENDER_TEXT` | Reminder constant instructing render-by-default + threshold + raw escape hatch |
| Raw request | User asks for "raw" explicitly (or "sin render", "copiar") — full fenced block, no summary-only truncation |

## Acceptance criteria

- CA-01: `shouldRenderDoc` returns true for a typical short spec (under all thresholds) and false when any bound is exceeded (long lines, heavy bytes, 4+ mermaid blocks).
- CA-02: `DOC_RENDER_TEXT` reminder instructs: render full markdown by default; when the doc exceeds the threshold, deliver only the clickable link + 3-5 bullet summary; on explicit raw request, show the full fenced block.
- CA-03: The reminder's rule is applied by the agent — enforced via the per-turn reminder injection (like DOC_DELIVERY_TEXT); tests cover the threshold helper and the reminder text content.
- CA-04: `bun run check` green; docs validate ok.

## Decisions

- D-01: Threshold = all-of (lines ≤ 150 AND bytes ≤ 8KB AND mermaid ≤ 3) — a doc fails render if ANY dimension is too heavy (user choice: automatic threshold).
- D-02: Raw is an explicit user request escape hatch (default stays rendered).
- D-03: The link always accompanies (existing DOC_DELIVERY_TEXT preserved).
- D-04: Reminder-based enforcement (same rail pattern as DOC_DELIVERY_TEXT), not a hard gate.
- D-05: Standard ` ```mermaid ` fences always — verified compatible with Cursor CLI's ASCII renderer and GitHub preview; OpenCode TUI limitation is documented, not worked around.

## Future work

- A `flowkit render <doc>` CLI that prints the rendered markdown standalone.
- Threshold tuning per platform (TUI vs IDE) via config.
