// Release-notes writer hook (writerOpts.finalizeContext): strips git trailers
// (Co-Authored-By, Signed-off-by, …), truncates breaking-change notes to their
// first paragraph, and keeps the body under GitHub's 125000-character release
// limit. The first @workit-dev release (no previous workit-dev-v tag) would
// list every commit since the repository began (809 on 1.0.0, which GitHub
// rejected), so it gets a short body pointing at the changelog and the
// migration guide instead. Any other release whose estimated body passes
// NOTES_CAP keeps the entries that fit and ends with a link to the full
// comparison.
const TRAILER = /^[A-Za-z][A-Za-z-]*-by:\s|^Co-Authored-By:/i;

// GitHub rejects a release body over 125000 characters. The estimate below
// over-counts each line, and the cap leaves a further 25000-character margin.
const NOTES_CAP = 100_000;
const PREDECESSOR = "`@brainervirus/workit` 14.6.1";

function cleanNote(text) {
  const firstParagraph = String(text).split(/\n\s*\n/)[0] ?? "";
  return firstParagraph
    .split("\n")
    .filter((line) => !TRAILER.test(line.trim()))
    .join("\n")
    .trim();
}

function repoUrl(context) {
  const { host, owner, repository } = context;
  return host && owner && repository ? `${host}/${owner}/${repository}` : "";
}

function fileLink(context, file) {
  const base = repoUrl(context);
  const ref = context.currentTag || "main";
  return base ? `[${file}](${base}/blob/${ref}/${file})` : file;
}

function compareLink(context) {
  const base = repoUrl(context);
  const { previousTag, currentTag } = context;
  if (!base || !previousTag || !currentTag) return "";
  return `[${previousTag}...${currentTag}](${base}/compare/${previousTag}...${currentTag})`;
}

// A line the template renders as `* text`, with no commit link.
const textLine = (text) => ({ header: text, subject: text });

// Upper bound on one rendered commit line: bullet, scope, subject, the linked
// short hash and every linked reference.
function commitLength(commit, context) {
  const link = repoUrl(context).length + 40;
  const subject = String(commit.subject || commit.header || "");
  const scope = commit.scope ? String(commit.scope).length + 8 : 0;
  const hash = commit.hash ? String(commit.hash).length * 2 + link : 0;
  const refs = (commit.references ?? []).reduce(
    (sum, ref) =>
      sum +
      2 * (String(ref.owner ?? "").length + String(ref.repository ?? "").length) +
      2 * String(ref.issue ?? "").length +
      link,
    0,
  );
  return 16 + scope + subject.length + hash + refs;
}

const noteLength = (note) =>
  24 + String(note.text).length + String(note.commit?.scope ?? "").length;

function estimateLength(context) {
  let total = 200;
  for (const group of context.noteGroups) {
    total += String(group.title ?? "").length + 12;
    for (const note of group.notes) total += noteLength(note);
  }
  for (const group of context.commitGroups ?? []) {
    total += String(group.title ?? "").length + 12;
    for (const commit of group.commits ?? []) total += commitLength(commit, context);
  }
  return total;
}

function firstReleaseBody(context) {
  context.noteGroups = [];
  context.commitGroups = [
    {
      title: "First @workit-dev release",
      commits: [
        textLine(
          `The \`@workit-dev\` packages continue ${PREDECESSOR}. ` +
            `${fileLink(context, "CHANGELOG.md")} lists what changed and ` +
            `${fileLink(context, "docs/guides/migration.md")} explains how to move over.`,
        ),
      ],
    },
  ];
  return context;
}

// Keeps entries in order (breaking notes first, then each commit group) until
// the budget runs out, drops the rest, and appends one line pointing at the
// full comparison.
function capBody(context, cap) {
  let budget = cap - 1000;
  let dropped = 0;
  const keep = (items, size) =>
    items.filter((item) => {
      const length = size(item);
      if (length > budget) {
        dropped += 1;
        budget = -1;
        return false;
      }
      budget -= length;
      return true;
    });

  context.noteGroups = context.noteGroups
    .map((group) => ({ ...group, notes: keep(group.notes, noteLength) }))
    .filter((group) => group.notes.length > 0);
  context.commitGroups = (context.commitGroups ?? [])
    .map((group) => ({
      ...group,
      commits: keep(group.commits ?? [], (commit) => commitLength(commit, context)),
    }))
    .filter((group) => group.commits.length > 0);
  if (dropped === 0) return context;

  const compare = compareLink(context);
  const where = compare ? `the full comparison ${compare}` : fileLink(context, "CHANGELOG.md");
  context.commitGroups.push({
    title: "More changes",
    commits: [textLine(`${dropped} more entries are not listed here; see ${where}.`)],
  });
  return context;
}

function finalizeContext(context, cap = NOTES_CAP) {
  for (const group of context.noteGroups ?? []) {
    group.notes = (group.notes ?? [])
      .map((note) => ({ ...note, text: cleanNote(note.text) }))
      .filter((note) => note.text.length > 0);
  }
  context.noteGroups = (context.noteGroups ?? []).filter((group) => group.notes.length > 0);
  if (!context.previousTag) return firstReleaseBody(context);
  if (estimateLength(context) > cap) return capBody(context, cap);
  return context;
}

// The writer calls finalizeContext(context, options, …); only the context is
// ours, so the cap argument never receives the writer's options.
module.exports = (context) => finalizeContext(context);
module.exports.cleanNote = cleanNote;
module.exports.finalizeContext = finalizeContext;
module.exports.NOTES_CAP = NOTES_CAP;
