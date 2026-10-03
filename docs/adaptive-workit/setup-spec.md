# Complete Workit setup

Status: implementation in progress, 2026-10-03.

## Behavior

- Hosting and issue tracking are independent. GitHub and GitLab may both use
  YouTrack. Hosting-native GitHub Issues retain their GitHub-only validation.
  Existing configuration format and credentials remain compatible.
- Basic setup stays short. Advanced configuration is optional and includes
  global/workspace commit policy, workspace branch rules, tracker/link settings,
  profiles/default profile, and named release tracks. Existing fields survive
  edits; choosing inheritance removes an override rather than copying a default.
- Reuse the shared most-specific workspace resolver. A narrow repo glob wins
  over a broad work glob regardless of file order. Global defaults fill only
  according to existing policy resolution; explicit profile/track selection stays
  explicit. Equal-specificity ambiguity is reported, never resolved by order.
  Preview shows the effective target and source so legacy nun branches can be
  inspected without changing broad product rules.
- Show OpenCode, Cursor, Codex and Pi. Detected supported hosts are preselected;
  absent hosts are visibly disabled. Select all available/clear all and manual
  selection are supported. OS-aware executable/app detection must not equate an
  old configuration directory with an installed executable.
- Apply installs Workit into selected hosts using supported native mechanisms,
  with exact commands/paths reviewed beforehand. Do not install the host apps,
  alter native permissions, replace unrelated registrations, or silently reload
  running sessions. Version/capability errors report actionable failures.
  Network installs are bounded and outcomes observed; uncertain effects are not
  blindly retried. No downloaded shell bootstrap is needed where native package
  and plugin installation already exists.
- Secrets stay in their existing storage; no token appears in summaries. Existing
  preview/revision guards and atomic writes remain authoritative. No live history
  migration or credential cleanup belongs to setup.
- `workit upgrade` inspects installed versions, previews supported package and
  configuration upgrades, applies only an explicit reviewed target and verifies
  it. Versioned migrations must be idempotent, preserve unrelated settings and
  secret files, and have fixture tests and backups. No historical task migration
  is implied. Local pins are reported and never silently converted to npm.
- Automatic upgrades occur only before host startup. Native host package update
  behavior is preferred; an opt-in `workit launch <host>` can upgrade then launch
  where the native host cannot do so. Do not update loaded plugin files mid-session
  or turn startup hooks into competing installers. Failure must remain visible,
  with the existing working version available when safe.

## Acceptance

1. Schema + runtime + PR-body tests cover GitHub/YouTrack and GitLab/YouTrack;
   GitHub Issues with GitLab still fail. Read-only machine config validation passes.
2. Wizard reducer/UI/apply tests cover basic skip, advanced edits, inheritance,
   preserving unknown fields, scoped rules independent of order, profiles/tracks,
   malformed values, stale revisions and an unchanged-input no-op.
3. Host detection/selection fixtures cover Linux/macOS/Windows, absent disabled
   hosts, all/none/manual selection and supported installation commands. Apply
   sandbox tests preserve unrelated host config and show partial failures.
4. Full supported-Node tests/static checks and isolated packed installation pass.
   Use temporary homes for live native installer qualification. Do not rebuild
   the user's active local plugin until a safe restart boundary.
5. Upgrade tests cover current/latest/pinned/local sources, repeated migration,
   unavailable registry, failed install, preserved config and pre-launch ordering.
   AGENTS.md requires keeping install/upgrade fixtures and docs current whenever
   adapter/config versions change.
