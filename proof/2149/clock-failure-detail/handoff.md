# Clock failure detail for the held #2149 diagnostic

This proof package copies the immutable [pre-input chronology package](https://github.com/calebn/sharecut-studio/tree/64bb6b727f4e2c59b49e5e00498541fc5cab0b2b/proof/2149/preinput-chronology) and changes only the passive clock failure report. It does not identify which check failed in the parent-reported Mac run. That run stopped during setup with `chronology-clock-changed`, before any target double tap or ARMED condition. Its raw numeric receipt is unavailable in this cloud lane. The old invalid lock, original restoration, failed product candidate `60d4c3099750f95113f55b97637b6e4eb9145b97`, and PR #2174 hold remain.

## Report shape

`gate.export().chronology.clock_failure` is `null` on a valid or non-clock stopped trace. The first clock failure stores one immutable object before the unchanged `finish("chronology-clock-changed")` call. Existing `chronology.error` stays `clock-changed`. The field travels in the existing hashed `chronology` snapshot through the existing adapter payload, including `remove`; it consumes no row.

The object has `site` (`status` or `observer`), `source` and `type` (both `null` for status), `context`, `phase`, `failed`, and `samples`. The boolean `failed` map exactly names the predicates checked at that site:

| Site | Predicate keys, in the unchanged guard order |
| --- | --- |
| `status` | `now_nonfinite`, `captured_origin_nonfinite`, `origin_changed`, `now_before_last_at` |
| `observer` | `now_nonfinite`, `origin_changed`, `now_before_last_at`, `event_timestamp_nonfinite` |

`now_nonfinite` checks `!Number.isFinite(performance.now())`. `captured_origin_nonfinite` checks the original installation `performance.timeOrigin` on the status path only. `origin_changed` compares the once-sampled current `performance.timeOrigin` with that captured origin by strict inequality. `now_before_last_at` checks the callback/status `performance.now()` against the last accepted callback time with strict `<`. `event_timestamp_nonfinite` checks `!Number.isFinite(event.timeStamp)` on the observer path only. Several flags may be true at once. A nonfinite event timestamp keeps the old `clock-changed` reason but is now distinguishable in `failed`.

`samples` contains `now`, `current_origin`, `captured_origin`, `last_at`, and `event_timestamp`. Each is `{value, finite, type, tag}`. A finite number has its numeric `value`, `finite: true`, `type: "number"`, and `tag: null`. `NaN`, `Infinity`, and `-Infinity` have `value: null`, `finite: false`, `type: "number"`, and their spelling in `tag`. A wrong-type string or boolean retains its JSON-safe `value` and names its type in `tag`. Other wrong types have `value: null` and a type tag; an absent status event timestamp is `{value:null,finite:false,type:"undefined",tag:"undefined"}`. The stored `context` and `phase` are those active at the failure. The same object survives later exports and removal even if clock inputs change.

The failure detail does not alter accepted equal callback times, finite event timestamps from another scale or earlier than a callback, deadline-before-clock order in observer callbacks, the shared 600-row cap, the original 120-second timer, listener cleanup, or any original touch handler. `Date.now` is not used. The gate still reconstructs the SHA256 `9ef86e0a336278a55df6bde8a8b45c40babfe6970e2b44ce8b81e47b74da49d9` original after the two literal insertions are removed.

## Use boundary

The only possible next diagnostic is the existing **no-gesture idle** ready/export/ordinary-mark/remove transport path, after the Mac owner checks exact private source and served-byte provenance. Do not perform a native setup tap, any other native input, target double tap, ARMED run, retry, browser drive, or causal comparison with this package. If idle traffic triggers `clock-changed`, its `clock_failure` object can identify which local guard failed. If idle traffic does not trigger it, that result does not classify the previous setup failure; stop and retain the hold. No native run is part of this publication.

The previous [chronology handoff](https://github.com/calebn/sharecut-studio/blob/64bb6b727f4e2c59b49e5e00498541fc5cab0b2b/proof/2149/preinput-chronology/handoff.md) describes the existing external first-script route, bridge and ACK validation. The present boundary narrows its future input section. Do not treat that earlier input plan as authorization from this package. The unchanged `bridge-adapter.js` forwards the entire `chronology` object. Existing private hashed transport must carry the exact snapshot bytes; no per-event transport, polling, policy, asset, CSP, or setup change is needed.

Verify every file listed in `sha256.json` before reuse. `verification.md` records local source-only checks. Raw Mac requests, URLs, receipts, paths, and run IDs remain private. The observed Mac branch and the product root cause remain unknown.
