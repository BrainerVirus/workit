# YouTrack update style (Cristhofer / es-CL)

Use when writing or polishing the comment body before `workit_youtrack_draft`. **Preserve the author's voice** — like the ChatGPT revision thread: grammar, flow, and light structure, not a changelog.

## Audience

**@Alejandra.Flores is the primary reader — she is not a developer.** Write for a technical project manager:

- Lead with **what you worked on and why it mattered**, not implementation mechanics.
- If you mention something technical (OpenAPI, flags, component names, GUAS, MFE), add **one short plain-language clause** so the reader understands impact without knowing the stack.
- Prefer product/feature language: *data sources*, *integración con el backend*, *selector de color*, *vista del segundo factor*.

### Technical detail — clarify, don't drop

| Too dev (avoid alone) | Better for manager |
|-----------------------|-------------------|
| overlays fuera del shadow DOM en el host | el selector de color no se veía bien cuando el reporte está embebido en la web principal |
| `replaceUrl: true` en el interceptor | para que al volver atrás no se repitiera el mismo error en bucle |
| Migré a `daisy-overlay-tokens` | ajusté los estilos del overlay para que respeten el tema de la web |

Only include dev terms the user actually brought up — then **translate or contextualize** in the same breath.

## Shape

1. `# Actualización` (single H1)
2. Blank line
3. `@Alejandra.Flores` + greeting (`Hola, buenos días.` / `Hola, buenas tardes.`) — same line or next paragraph OK
4. **Body: paragraphs**, not bullet dumps

Optional second H1 when the user has a long tangent block:

- `## Off-topic` — only when the user's material is clearly a side topic (tooling, proceso, ideas). Keep the main work under `# Actualización`.

## Openers (only if the user's material implies it)

- `Hoy estuve trabajando en…` / `Hoy por la tarde he estado full con…`
- `Hoy estuve full con <proyecto>.`
- `Dado lo que conversamos,…`

Do **not** force an opener.

## Voice

- First person, Chilean Spanish: *harto*, *darle una vuelta*, *al día*, *trasteando*, *ojalá*.
- Honest: *al parecer*, *creo que*, *imagino que*, *no alcancé a*, *entiendo que*.
- Explain **why** and **what's next**, not file trees.
- Close with forward look when relevant: *Mañana…*, *me falta…*, *de momento va bien*.

## Tangents

Natural bridges: `Por otro lado,…`, `Como comentario adicional,…`, `Como punto aparte,…`, `Quiero comentar algo que puede ser interesante.`

Long tooling/process tangents → `## Off-topic` (exemplar 4).

## Allowed formatting

- Backticks for product/component names the user mentioned: `` `color-picker` ``, `` `button` ``
- Links and screenshots the user attached
- Short inline lists **only** when comparing options the manager needs to understand (exemplar 4: OpenAPI vs backend vs frontend) — as **prose or one flowing sentence**, not a task checklist

## Forbidden (unless user wrote them verbatim)

- Branch names, SHAs, `src/...` paths
- Nested `###` subsections for work items
- Bullet lists of completed tasks (PR style)
- Stacked changelog verbs: *Implementé*, *Migré*, *Alineé*
- Invented work or metrics
- Pasting `git log`, agent session, or `facts.*` into the comment
- Jargon without a plain-language gloss

## Polish level (ChatGPT-thread)

1. Grammar and spelling.
2. Smooth sentences; similar length to input.
3. Split wall-of-text into paragraphs; add bridges only when needed.
4. **Do not** add facts the user did not supply.
5. **Do** add a brief gloss when the user used opaque tech terms.

## Length

Match the user. Never pad.
