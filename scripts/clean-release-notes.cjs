// Release-notes writer hook: strips git trailers (Co-Authored-By, Signed-off-by,
// …) and truncates breaking-change notes to their first paragraph.
const TRAILER = /^[A-Za-z][A-Za-z-]*-by:\s|^Co-Authored-By:/i;

function cleanNote(text) {
  const firstParagraph = String(text).split(/\n\s*\n/)[0] ?? "";
  return firstParagraph
    .split("\n")
    .filter((line) => !TRAILER.test(line.trim()))
    .join("\n")
    .trim();
}

module.exports = function finalizeContext(context) {
  for (const group of context.noteGroups ?? []) {
    group.notes = (group.notes ?? [])
      .map((note) => ({ ...note, text: cleanNote(note.text) }))
      .filter((note) => note.text.length > 0);
  }
  context.noteGroups = (context.noteGroups ?? []).filter((group) => group.notes.length > 0);
  return context;
};

module.exports.cleanNote = cleanNote;
