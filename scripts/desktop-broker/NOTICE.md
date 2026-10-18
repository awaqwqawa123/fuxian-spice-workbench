# Upstream and changes

The Windows stdio launcher and the request ID multiplexing design are adapted from
[DusuWorks/codex-webui](https://github.com/DusuWorks/codex-webui), fixed commit
`269d797196edfd1db134d12c4dda2d9f716cc1db`, files `desktop-bridge/launcher.cs`
and `server/desktop-broker.js`. The complete upstream MIT license is in
`LICENSE.dusu` and must travel with distributed copies.

This integration adds authenticated local discovery, bounded transport, per-thread
control ownership, delayed handoff until a turn finishes, single-owner approval
routing, reconnectable approval state, installation rollback, and isolated tests.
It does not include HAPI code or change the official Codex database or writer locks.
