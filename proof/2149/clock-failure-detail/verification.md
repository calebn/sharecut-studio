# Source-only verification

The local Node fixture executed the revised `gate.js` and unchanged `bridge-adapter.js`. Fourteen checks passed. New cases trigger each status and observer clock predicate, including the observer-only event timestamp check. They assert exact `failed` flags and sampled values, JSON-safe nonfinite and wrong-type tags, active context/phase, first-failure retention after a later clock change, `export` and `remove` survival, no extra row, and zero listeners after cleanup. Finite delayed event timestamps, equal callback times, and a changed wall-clock object still pass. Existing tests also cover the shared 600-row cap, original 120-second timer/deadline, listener options, no per-event DOM query, original touch cancellation, and the one-SHAM boundary. All events in these tests are synthetic; none establishes Safari behavior.

The fixture removes the exact `observer-insert.js` and `api-insert.js` text from `gate.js` and matches the frozen original gate SHA256 `9ef86e0a336278a55df6bde8a8b45c40babfe6970e2b44ce8b81e47b74da49d9`. The unchanged ACK validator tests use actual gate/adapter output. Run the local checks from this directory:

```sh
node --check gate.js
node --check bridge-adapter.js
node test_gate.cjs
python -m unittest discover -s . -p test_ack.py -v
ruff check validate_ack.py test_ack.py
ruff format --check validate_ack.py test_ack.py
```

No browser, native input, Mac bridge, CI dispatch, product candidate, or old invalid case was exercised. The previous Mac `chronology-clock-changed` reason is still aggregate evidence; without its raw values, the new detail cannot retrospectively identify that failure branch. Only an idle no-input recurrence could classify a new failure. PR #2174 remains a held failed draft.
