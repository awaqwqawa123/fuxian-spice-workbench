# Project working practice

For future implementation work on this project, use separate Git worktrees for independent changes and run those changes in parallel when they can be divided safely. Keep the main checkout for integration and verification. Merge the tested worktree commits into main only after checking their combined behavior.

Preserve local project data and chat bindings in the ignored `.desktop-control` and `.desktop-circuit` directories. Do not copy those directories into feature worktrees or commit them.

## Model library symbols

Import original ASY and OrCAD OLB graphics alongside electrical models. Use the original device geometry when available rather than replacing every subcircuit with a generic box. Preserve the original source and checksum, and derive electrical port order from explicit SpiceOrder or PSpiceTemplate plus the device pin map. Physical package pin numbers alone do not define SPICE port order. Keep model lookup, previews, canvas placement, saved model restoration and export consistent so the verified symbol and its anchors survive each handoff. Retain unsupported originals with a clear reason; do not invent geometry or pin assignments and describe them as an imported symbol.

Present one public device with selectable source versions rather than one device card per library file; keep genuine part grades and suffixes distinct. Put compatibility diagnostics behind an expandable control. When an original symbol is absent, use a registered standard functional symbol only with positive device identification and reviewed terminal meanings, and label it as standard. Preserve electrical port indices while mapping their display positions; never silently change existing wired devices to new anchors. Preview only the relevant source's symbol assets, not every unrelated downloaded symbol library.

## Durable fixes

When the user reports a failure, fix the shared cause across all affected entry points and saved-data retries, rather than patching only the current project or document. Reproduce the reported input when available and add a regression that exercises the real handoff between layers. Do not report a successful fix based only on mocks or an unrelated happy path.

For datasheet imports, keep PDF/TXT extraction, saved attachment restoration, server validation and assistant evidence handling consistent. Preserve readable pages and explicitly mark unreadable glyphs; never silently delete characters from numeric evidence or guess their values. Keep prior results recoverable but visibly distinguish them from the current failed or running request.
