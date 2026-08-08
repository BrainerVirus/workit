export const MAX_LINES = 150;
export const MAX_BYTES = 8192;
export const MAX_MERMAID = 3;

const MERMAID_FENCE = /^```mermaid\s*$/gm;

export const shouldRenderDoc = (text: string): boolean => {
  const lineCount = text.split("\n").length;
  if (lineCount > MAX_LINES) return false;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return false;
  const mermaidCount = text.match(MERMAID_FENCE)?.length ?? 0;
  return mermaidCount <= MAX_MERMAID;
};
