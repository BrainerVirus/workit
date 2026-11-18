// A Markdown file imported `with { type: "text" }`: Bun inlines it as a string
// (agents.ts reads the canonical Claude Code agent files this way).
declare module "*.md" {
  const text: string;
  export default text;
}
