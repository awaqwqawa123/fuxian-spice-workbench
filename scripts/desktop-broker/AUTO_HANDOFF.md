# Desktop send and automatic control handoff

The desktop broker treats a native `turn/start` on a web-owned, loaded thread as an explicit request to continue from the desktop. It keeps the same official app-server and forwards the original request payload and JSON-RPC response.

- An idle thread with no outstanding server requests transfers immediately and forwards once.
- A busy thread, pending approval, or unfinished tool keeps the original side in control. The desktop request remains pending in the broker until the turn is idle and all server requests have settled. The broker never interrupts the web turn or answers its approvals.
- Only one desktop turn may wait per thread; at most eight threads may wait. A second distinct request is rejected with an explanation while the earlier request stays intact.
- Retries with the same JSON-RPC ID and parameters do not dispatch again. In-flight requests share the original receipt; the latest 64 receipts retain completed results or errors for replay. Reusing an in-flight ID for different parameters cannot start a second turn.
- An explicit handoff button/API action cancels the older queued desktop request. An unload or desktop disconnection also cancels it. The desktop receives an error explaining that the queued message did not run and needs review before resending. A later completion cannot revive it.
- Disconnecting and reconnecting a web named-pipe client does not delete a desktop request or restart the official child process.

The queue and receipts live only in this broker process. They are not an automatic retry journal and are never replayed after a broker restart. A process crash can leave an unacknowledged request uncertain; inspect the thread before manually resending. Cancelling or receiving a turn-start error does not undo a turn that was already forwarded.

Regression coverage in `tests/desktop-broker.test.ts` exercises routing, approval ownership, outstanding tools, duplicate requests, queue limits, manual cancellation, unload/disconnect, and a real named-pipe connection to a deterministic fixture app-server. The native desktop UI and gateway suites retain the existing explicit handoff behavior.
