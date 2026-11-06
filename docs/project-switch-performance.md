# Project switching performance regression · 2026-11-06

Switching the active project previously called the full project-library save path,
which parsed, validated, cloned and serialized every project. Mounting or rendering
an editor also evaluated `readCandidateUndo(projectId)` as a `useRef` argument,
deserializing up to twelve project snapshots even when AI undo was unused.

## Changes

- Save only the selected project ID when the entries array is the exact one from
  the last successful full save. The small selection record is bound to that
  library revision. Invalid, stale or missing selection records cannot replace the
  saved library, and failed saves do not advance the revision.
- Keep strict full saves for edits, imports, new projects and copies. Older
  libraries still load. Existing damaged-library recovery behavior is preserved.
- Load AI candidate undo snapshots only when applying or undoing a proposal.
  Retain existing validation, bounds and reload undo behavior.
- Initialize the electrical snapshot cache once per editor; reuse project-list
  summaries between selections and shared date formatters when rendering rows.

## Validation

- 30 related automated checks passed: actual App switching and file operations,
  project store, sidebar behavior, editor mount, electrical snapshots and waveform
  setup/application undo. TypeScript and production build passed.
- The App regression switches three independent projects, including an RC drawing
  with persisted simulation profiles, edits one, switches back and reloads. The
  project tab, project IDs, edited content and project chat bindings are checked.
  Initial automatic simulation may persist a default waveform group once; subsequent switches
  must not rewrite the library.
- Storage benchmark on this Windows machine: 120 projects × 48 devices, five
  switches, 480,144-character library. The old validation/serialization path took
  101.3 ms in the integration run; selection writes took 0.1 ms. These are storage
  timings, not whole-page latency or a guarantee for other machines.
- Actual React mount regression: two mounts and twelve zoom actions previously
  read unused undo history 21 times (714,945 characters); now zero reads. Both
  valid project mounts still start their normal automatic simulation.
- Codex built-in browser verification against the production build: three test
  projects, six switches, title preservation, project tab selection and reload
  restoration passed. Real ngspice-45.2 completed the RC AC simulation with 401
  points. Desktop-chat APIs were isolated test stubs; no real chats were created.

No simulation precision, point count, electrical topology or routing changes are
part of this fix. Newly opened valid projects still run automatically; first
opening and a new full simulation can therefore take longer than selection-only
storage operations.
