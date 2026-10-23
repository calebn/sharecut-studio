# Pre-input viewport chronology: proof only

This package adds passive viewport event receipts to the existing diagnostic. It is ready for local Mac adapter review, not native execution. The future bound is ONE fresh SHAM target double tap with only the existing setup, after that review and a matching pre-input ACK. No ARMED, restored SHAM, matrix, automatic retry, or product change is authorized. Failed draft PR2174 stays held at `60d4c3099750f95113f55b97637b6e4eb9145b97`.

Parent-reported receipt comparison found the earlier positive recorded viewport scale1.6 at29ms after dblclick. The three qualified v2 SHAM trials first sampled408–649ms after dblclick; they had no resize-event receipts for the earlier interval. Their delayed samples/stability and native qualification remain valid. They cannot exclude an earlier transient, and this does not establish that one occurred. Raw Mac receipts were not inspected in cloud. The older invalid case and its lock remain invalid and untouched.

## Verify and test this package

All source and regression fixtures used by these tests are in this directory. `sha256.json` is a flat map of filename to SHA256. Check every listed file before using it. The frozen original gate is a regression fixture, not the revised script to serve.

```sh
node --check gate.js
node --check bridge-adapter.js
node test_gate.cjs
python -m unittest discover -s . -p test_ack.py -v
ruff check validate_ack.py test_ack.py
ruff format --check validate_ack.py test_ack.py
```

The mocks execute the actual revised gate/adapter. They model an excursion to1.6 at29ms and reversal to1 before408ms. These are synthetic timestamps, not reconstruction of missing Mac events. No browser/native or real asynchronous scheduling fixture needs repeating.

`gate.js` is exactly `original-gate.fixture.js` plus `observer-insert.js` before the metadata declaration and `api-insert.js` before the original timer. Removing those literal insertions reconstructs SHA256 `9ef86e0a336278a55df6bde8a8b45c40babfe6970e2b44ce8b81e47b74da49d9`. Original touch/pointer/mouse/gesture/focus callbacks, options, native input, cancellation and CSS remain unchanged. There is no new event cancellation call. The original diagnostic still contains its old ARMED capability; existing transport guards and this single-SHAM protocol keep it inaccessible here.

## Minimal private bridge adaptation: mandatory local review

The actual task-specific Mac bridge/coordinator source is private and unavailable to this package's cloud review. Do not assume the immutable b309 bridge already calls these new APIs. It only calls ordinary `mark`, and cannot implement this contract unchanged. The existing Mac owner must review its exact current apply path and admission wiring; stop before input if they differ or cannot be established. No foreground WebDriver/evaluate tab or new executor is needed or permitted.

Load `bridge-adapter.js` synchronously after `gate.js` and before the existing bridge, in the SAME external parser-blocking bundle. For example, concatenate these two local files as the stager's `--gate` input; pass the locally reviewed existing bridge as `--bridge`. Both execute with the same original script/currentScript marker during document loading. The existing immutable stager is available at [4b896 transport-stage.py](https://github.com/calebn/sharecut-studio/blob/4b896dfb489da0b7c841358cbd51f976c66ccd00/proof/2149/2149-transport-stage.py), SHA256 `a6f3ddaee5aa1e41079d2608d981b51dd126128b8690d22bdc74538357644b62`. Verify it before reuse. It refuses source/output overlap and asset collisions and hashes the combined served bytes.

At the known b309 bridge `apply` location AFTER existing command nonce/epoch/previous-hash/op/label/live-gate guards, use this single reference fragment. It binds the adapter BEFORE removal and retains the existing snapshot/row/idle-target fields. Locally compare with the actual private bridge; preserve its already-reviewed equivalent fields and all surrounding checks rather than blindly replacing unknown source.

```js
const chronologyAdapter = window.__sharecut2149ChronologyAdapter;
chronologyAdapter.applyMark(gate, command);
const snapshot = command.op === "remove" ? gate.remove() : gate.export();
const rows = snapshot.rows.slice(rowOffset);
rowOffset = snapshot.rows.length;
const navs = document.querySelectorAll('nav.mobile-nav[aria-label="Primary"]');
const timelines = navs.length === 1 ? navs[0].querySelectorAll('[data-presence-anchor="mobile-nav:timeline"]') : [];
const payload = {
  v: 1, run, instance, epoch: command.epoch, prev: previous, op: command.op,
  label: command.label, at: performance.now(), timeOrigin: performance.timeOrigin,
  remaining_ms: 120000 - (performance.now() - installed),
  document_identity: { origin: location.origin, pathname: location.pathname,
    sha256: await digest(new TextEncoder().encode(location.href)) },
  base_identity: { origin: new URL(document.baseURI).origin, pathname: new URL(document.baseURI).pathname,
    sha256: await digest(new TextEncoder().encode(document.baseURI)) },
  condition: snapshot.condition, stopReason: snapshot.stopReason, touchCount: snapshot.touchCount,
  timeline_pressed: timelines.length === 1 ? timelines[0].getAttribute("aria-pressed") : null,
  app_zoom: "unobserved", activePointerIds: snapshot.activePointerIds, rows, total_rows: rowOffset,
  metadata: epoch === -1 ? snapshot.metadata : undefined,
  cleanup: command.op === "remove" && !window.__sharecut2149Gate,
  ...chronologyAdapter.payload(snapshot),
};
```

This helper runs only in the existing idle command path. The tests exercise begin-before-ordinary-mark, end-before-ordinary-mark, exact context, missing-context refusal, and cleanup. Locally verify the private source uses that order and forwards both initial ready and subsequent fresh snapshots into the EXACT hashed ACK bytes. Do not edit polling cadence, chunking, status200/end/length/hash verification, nonce/epoch/previous-hash chain, source privacy, condition guards or original lifecycle.

The normal ready `export` command returns top-level `chronology` from `adapter.payload(snapshot)`. Bind its `transport_run`, gate instance, `time_origin`, `original_start`, `installed_at`, `script_path` and `bundle_sha256` into the private case manifest after verifying actual served bytes. Retain existing bridge instance, document/base origin/path and exact-URL SHA256 identity checks. The transport nonce from `data-run` is distinct from the native case/run ID; map them explicitly rather than assuming equality.

## Exact command and admission contract

Before EVERY existing setup native action and before the single target, map the intended operation to its unique context in the private manifest. One native case only; setup contexts occur before the target; the gate admits at most one `sham1` context. Each operation ID is lowercase letters/digits/hyphens,1–42 characters (a36-character UUID fits both boundary labels). Native run is1–80 such characters. Request digest is the64-lowercase-hex SHA256 of the exact intended native operation request, not a guessed ACK or a self-referential command hash.

An ordinary chained `mark` command retains all existing fields and adds:

```json
{
  "chronology_boundary": "begin",
  "chronology_context": {
    "transport_run": "<actual32hextransportnonce>",
    "native_run": "<actual-native-case-id>",
    "operation_id": "<actual-unique-operation-id>",
    "trial_id": "sham1",
    "request_sha256": "<actual64hex-request-digest>",
    "gate_instance": "<actual-ready-gate-instance>",
    "label": "before-native-<actual-unique-operation-id>"
  }
}
```

Its existing outer `label` equals context.label, `op` is `mark`, and trial_id is `setup1`, `setup2`, etc. for separately reviewed setup operations. No ID-only substitute. `applyMark` synchronously calls `beginChronology(context)` BEFORE the unchanged ordinary `gate.mark(label)`. A complete matching ACK must arrive before the existing coordinator admits that particular native operation.

Call `validate_start_ack(raw_payload, receipt_sha256, expected)` only AFTER the existing complete raw transport verifier. `raw_payload` is its exact reconstructed UTF8 bytes, not JSON reserialization. If the existing complete parser discards the raw body, retain that already hash-verified body alongside its parsed ACK and digest; do not reserialize or relax its guards. The local private wiring review/test must demonstrate this exact-body retention. Missing fields, exceptions and any non-PASS are terminal invalidity, not permission to skip the predicate. `expected` must contain:

- `context`: the exact seven manifest fields above, with target `trial_id="sham1"`.
- `transport_run`, `bridge_instance`, `gate_instance`, current `epoch`, `prev_sha256`.
- `document_identity`, `base_identity`: existing exact origin/path/full-URL-hash identities.
- `time_origin`, `original_start`, `installed_at`: actual initial ready chronology values.
- `script_path`, `bundle_sha256`: actual complete served bundle path/hash independently checked from the HTTP body. The gate parses the hash in the existing content-addressed filename; that alone is not a byte-hash proof.
- `min_remaining_ms`: reviewed remaining allowance for this actual native operation plus the unchanged2.5s maximum observation window and existing transport overhead. It must exceed2500ms, fit the original120s lifetime, and never extend it. Do not guess a native duration or add a fresh timer.

The predicate requires exact full context, same instance/clock/document/chain, SHAM, no observed contacts, one start row, all four sources live, visible start AND fresher current ACK snapshots, finite baseline scale1±1e-6, original deadline and row budget. It rejects recorded pre-input excursions even if back to1 by the ACK. The ACK is a snapshot, not a guarantee that baseline cannot change afterward. Retain and inspect later appended pre-input rows too; any recorded pre-input nonbaseline invalidates the case with no retry. DOM contact counts are observation only; native completion still uses the already reviewed current-operation correlation/fail-fast/synchronous-return provisional barrier and final matching successful XCTest result after stop. Do not add physical-contact telemetry or per-gesture result bundles/restarts.

Keep the condition SHAM through native input and the entire existing v2 observation. After that window, send the same chained mark with `chronology_boundary="end"`, identical context, and outer label `after-observation-<operation_id>`. The helper invokes `endChronology(context)` then ordinary mark. Retain its end row and fresh snapshot. No condition changes, second target or automatic retry. Actual local wiring must prove begin ACK gates native admission and end happens after the unchanged observation, not merely that IDs exist.

## Event and result interpretation

Listeners start at diagnostic installation, before setup and native admission. They are separate from navigation-path filtering: `visualViewport` resize/scroll, window resize, and window/document viewport scroll only. Element/Timeline scroll is excluded. Callback rows contain ordered sequence, performance.now, raw event.timeStamp, timeOrigin, source/type, condition, current context/phase, and numeric viewport scale/size/offsets/window scroll only. No per-event document visibility, activeElement, traversal, geometry, promises, frames or network is added. Ready/start/end snapshots check visibility outside callbacks; event rows do not assert per-event visibility. Existing touch-observer code is unchanged.

Correlate same-document callback performance times with existing trusted dblclick capture time and v2 samples, retaining raw event.timeStamp separately. Equal/coarsened timestamps keep array/sequence order. They are callback observations, not physical/compositor transition times. A reported scale above1+1e-6 is observed page zoom even if it reverses before the first delayed sample. Scroll/offset/size change alone is not zoom. No callbacks means no event reported, not proof of no transient: rendering/event coalescing can omit intermediate states. Added listener and idle-transport overhead may influence timing; disclose exact sources/hashes and placement.

Retain v2's9 absolute250ms sample slots from actual firstsample t0, end at least2000ms and strictly below2500ms, all adjacent gaps≤400ms; final1s bracket is last sample≤T−1000 plus every later sample, at least5 samples/span≥1000ms, scale max−min≤1e-6. All scales finite/positive; any early/transient scale>1+epsilon remains an observation. Invalid timing/settling trace stays terminal even if zoom was observed. No extension or replay of the old invalid case.

## Provenance, stopping and cleanup

Before any input, the existing Mac owner must locally review/freeze the exact adapter/coordinator source and mandatory predicate wiring, record every package/adapter/stager/native source digest, and verify the initial ready/begin ACK on the same live document. If the existing private wiring cannot be verified, report that precise gap and stop before input. This public package neither claims that private integration has passed nor starts it.

Retain raw original HTTP document, all nine loaded original JS/CSS response bodies/hashes, viewport metas, original document/build/static root, exact origin/base URL, final URL/no redirects, MIME/status, CSP headers and external bundle bytes. Only the established task-local same-origin assets route and unchanged CSP may serve the probe. Stage only the known HTML insertion plus declared diagnostic assets; refuse collisions and all original asset changes. No inline executable bytes, async/defer/module gate, CSP changes or product edits. If actual served document/build and wrapper/probe roles cannot be established, stop before input. Keep full URLs, private paths/native requests/receipts in private archives; public artifacts and GET payloads must not expose them.

One original600-row buffer and one original120s installation lifetime cover installation, setup, target and observation together. No new/reset budget. Reaching either bound, unsupported source, nonfinite/changed clock or document/instance, hidden ready/start/end, missing chunk/hash/ACK, uncertain native completion, wrong target/condition, or incomplete final result is terminal. Export what exists, preserve observations/invalidity, do not retry/replay/extend.

Export all remaining rows through existing complete offset/chunk/hash receipts; verify continuity from installation through the end. `remove` uses the existing path, removes old and all four new listeners, deletes gate AND adapter namespaces, and reports `chronology_cleanup={adapter_removed:true,live_listeners:0}`. Apply `validate_cleanup_ack` after the same existing complete verifier with expected identities, current epoch/previous hash and removal label; also retain existing `cleanup=true`, stopped/removed checks. Repeated removal is idempotent. Restore original document/nine assets/CSP, stop only owned services/isolated device and preserve other devices, prior cases and invalid locks. No acceptance or merge follows from this diagnostic.

The [CSSOM View working draft](https://www.w3.org/TR/cssom-view-1/#the-visualviewport-interface) defines VisualViewport events/values; [its event processing](https://www.w3.org/TR/cssom-view-1/#events) permits pending scroll-event coalescing. [High Resolution Time](https://www.w3.org/TR/hr-time-3/#dom-performance-now) describes the monotonic browser clock and precision limits. These contracts support event chronology, not lossless viewport/HID telemetry.
