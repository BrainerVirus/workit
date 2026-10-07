# Instruction-files mode (AGENTS.md, CLAUDE.md)

Instruction files are paid for in every session that reads them. Restructure
them in three escalating passes. Each pass is its own commit in one PR, in
this order, so the user can keep pass 1 and drop pass 3. Run
`workit knowledge lint` before pass 1 and after every commit: no commit adds
a finding, and the lint exits 0 after the last pass, or the report lists the
findings that remain and why.

After each commit, run `workit check test`. A sentence a test pins stays,
unless the user approves changing that test. Commit each pass with
`workit git commit -m "<type>: <pass>" -- <paths>`, then open the PR
(read the `workit-ship` skill's SKILL.md and follow it).

Before pass 1, report the current byte counts and the plan for each pass, then
wait for approval. A pass with nothing to do is skipped and said so, not
padded.

## Pass 1: remove no-ops

Delete lines that would change no behavior if removed: "be thorough", "write
clean code", "follow best practices", restated defaults of the host, notes
about one past session, `path:line` references, and rules whose mistake a type,
lint or check now prevents. Nothing moves in this pass; it only deletes.

## Pass 2: progressive disclosure

Keep the root file to what every session needs: commands, workflow, and
"Read before <task>: <file>" pointers. Move topic detail (testing, release,
hosts, architecture) into topic files under an existing docs folder, one file
per topic, each opened by when to read it. Move text verbatim first; rewording
belongs in pass 1 or a later change. Every pointer from AGENTS.md or
CLAUDE.md must resolve (the lint's `broken-link` rule). The lint does not read
topic files: check their own links and content by hand.

## Pass 3: standards and checks

- A judgment rule a reviewer must weigh goes to `CODING_STANDARDS.md`; the
  root file keeps one pointer to it.
- A mechanical rule (a forbidden import, a naming pattern, a file that must
  exist) becomes a check instead of prose: a lint rule, a test, or a
  configured `workit check <name>`. Show the check failing on a planted
  violation, then delete the sentence.
- No rule lives in two files (`duplicate-rule`).

## Never

- Create a file without its first real entry in the same commit. The lint
  flags a scaffolded `CODING_STANDARDS.md` or `GLOSSARY.md` (`scaffold-file`);
  for a topic file, that check is yours.
- Squash the passes into one commit, or mix a behavior change into them.
- Grow the root file past the lint's byte budget (`agents-budget`).
