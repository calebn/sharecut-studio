# Run one fresh observation-v2 diagnostic for #2174

This handoff changes only the observation sampling rule for ONE fresh case in the existing authorized Mac task. Preserve the native protocol, provenance, result qualification and cleanup requirements below. No product or CSP changes, new framework, physical-contact telemetry or fix/acceptance claim. The published Python files are reference code. They do not dispatch native actions or enable comparison conditions. The immutable b309 transport preflight remains comparison-disabled. Use only the existing separately reviewed task-local comparison revision, with its own pinned hashes.

## Preserve the prior case

Parent reports the first SHAM had valid Timeline tap/double-tap operation ACKs and matching successful final XCTest qualification. Its browser observation was invalid: nine samples over2001ms but four samples over750ms in the specified final second. Recorded scale1 is NOT a qualified no-zoom result. No second SHAM, ARMED or restored SHAM occurred. Preserve comparison-findings.json/native-qualified-browser-invalid.json and the invalid-lifecycle lock unchanged. Do not resume, replay, relabel or evaluate that case under the new rule. Original document/nine assets/CSP restored; candidate clean; owned services/16e stopped; other simulator preserved, per parent report. Raw Mac receipts have not been inspected in cloud.

## Exact fresh-run observation rule

Use one passive sampler in the existing same-tab external diagnostic. Store actual browser monotonic timestamps and page visualViewport scales. Its timer schedule is absolute, not recursive fixed delays that accumulate drift:

1. Take the first after-native-return observation; its actual browser timestamp is t0. Schedule the remaining eight observations at t0+250*i milliseconds, i=1..8. Record when callbacks actually execute. A callback before its deadline waits for the remaining time; it does not fabricate an on-time timestamp. Do not add replacement samples to repair an invalid trace.
2. Hard stop is t0+2500ms. A delayed callback at or after that boundary invalidates the observation and cannot keep sampling. The last actual sample T must be at least t0+2000ms and strictly before t0+2500ms. Require all nine samples, finite strictly increasing timestamps, finite positive scales, and every adjacent actual-time gap at most400ms. Missing samples, shorter span, excess gap, nonfinite data or cap/deadline failure is INVALID, not no-zoom. Retain any existing gesture-period/resize observations too; observed zoom there also counts.
3. Let B=T-1000ms. Find the LAST sample with actual timestamp <=B, then include it and EVERY later sample through T. This left bracket may be just outside the nominal final second. Require at least five samples and at least1000ms actual span in this bracketed tail. All those scales must differ by at most1e-6 (max minus min). This replaces the fragile requirement for five samples strictly inside a moving final-second interval; it observes sampled stability across at least one full second.
4. Initial pre-gesture scale must still be1 within1e-6. Any recorded scale >1+1e-6 anywhere in the case's gesture/observation evidence counts as observed page zoom, including one that later reverses. An incomplete/unstable observation remains INVALID even if it contains a zoom: stop without advancing. For a fully valid observation, report zoom or no observed zoom within this bounded window. Do not assert continuous or universal browser quiescence.

Example boundary fixture (synthetic, not raw Mac data): 0,250,500,750,1000,1250,1500,1750,2001ms. B=1001; include1000,1250,1500,1750,2001. They provide five samples spanning1001ms, rather than discarding1000 solely because it precedes B by1ms. This new-rule fixture does not reclassify the preserved invalid run.

Keep the gate condition fixed before the native action and throughout this observation. Sampling has no authority to dispatch native work, change conditions or reset the original gate120s lifetime/600-row cap. Budget the slightly larger hard observation deadline before admitting each operation. A longer scheduling delay stops the case; no extension-until-stable or automatic retry.

## Executor preflight and pinning

All reference files are in the same directory as this handoff. Verify the five file hashes in [sha256.json](sha256.json). Read the [sanitized verification summary](verification.md). No private raw receipts or local-path check reports are published. The Python collector is a fixture, not a replacement for the browser sampler. Browser samples must use actual browser monotonic measurement times, not HTTP completion times or fabricated ideal deadlines.

Run the deterministic reference tests without a simulator gesture:

```sh
python3 test_observation.py
```

Expect seventeen passing tests. Do not rerun `async_fixture.py` merely to repeat the preserved numerical timer proof. Its prior actual asyncio run is summarized in [verification.md](verification.md).

Use the reviewed observation-v2 validator and test fixtures in this directory. Verify their manifest hashes. Integrate only the precise deadline/bracketing validation change into the task-local existing sampler/host, inspect that exact diff locally, and retain source/build/tool hashes in a NEW manifest. The sampler must record actual timestamps, not ideal schedule targets. Keep the already reviewed native harness/result wiring unchanged unless a material mismatch is found.

Before any new gesture, run the reference edge/jitter tests and the same fixtures through the actual task-local validator. Confirm the2001ms edge succeeds under v2; sparse/delayed/nonmonotonic/unstable/incomplete traces fail; transient zoom is retained. Confirm the timer scheduling uses absolute deadlines with the2500ms hard stop. These tests require no simulator gesture and must not consume/recover the previous locked case. If these checks pass, proceed within the existing Mac task without another cloud preparation roundtrip.

## Preserve the native protocol and final qualification

Use only the existing single XCTest session and the reviewed task-local runner. Do not open a competing WebDriver tab or start another native driver. Verify that the installed runner matches the reviewed source and build. Use the exact existing invocations established by the Mac task. This handoff supplies no new runner command.

Require a fresh run nonce, unique operation IDs, monotonic operation order, known operation names and the exact expected parameters. Reject missing IDs instead of replacing them with a default. Permit one operation in flight. Accept its ACK only when run, ID, operation, request parameters or hash, and status match the outstanding request. Confirm ACK delivery and coordinator acceptance. ID presence or process exit alone is insufficient. Missing, mismatched, duplicate-conflicting or uncertain correlation stops advancement. Never replay a gesture to recover a lost ACK.

Treat the operation ACK as provisional. It must follow the actual synchronous XCTest action return with fail-fast behavior and no recorded issue. A normally returning gesture can produce no visible effect. DOM touch-pair visibility is not physical-contact telemetry. Do not require a new per-contact telemetry system. Do not change conditions while an operation is in flight or while its browser observation is pending.

After the bounded case, stop the runner and require its matching successful XCTest result. Bind the result to this run, intended executed test, reviewed source, built and installed runner, simulator and invocation. A missing or mismatched result, skipped or zero intended executions, XCTest issue or final failure invalidates the whole case. Do not restart the runner or require a separate result bundle for each event.

Retain the current positive-control requirement. Preserve the exact failed candidate60d4 build, all served original HTML and viewport metadata, original nine loaded JavaScript and CSS asset bytes, actual status, redirects, MIME types and CSP headers, and reviewed diagnostic script hashes. Raw HTTP archives stay private. Source policy is not a substitute for actual response checks. Prove the same Safari document and gate instance before and after each operation. Require the intended condition ACK, stable connected Timeline target path, preselected Timeline state and appropriate capture/sentinel evidence. Keep browser viewport scale separate from application zoom.

## One fresh bounded execution

Create a fresh run nonce, unique operation IDs, new private output/result/static staging paths and fresh lifecycle lock. Never remove/reuse the old invalid lock. Verify the exact failed candidate60d4 build, actual served HTML/viewport/CSP/headers and nine original assets, reviewed external gate/bridge hashes and same-document identity. Install/use only the reviewed corrected runner. Preserve the validated run/operation/ACK/delivery checks, provisional operation completion and final matching successful XCTest qualification for the entire case.

Execute at most3 SHAM trials until the first VALID observed page zoom. Any invalid observation/protocol/action/result stops the case. Validity during the running case is provisional until its final XCTest result qualifies. If no valid SHAM zoom within3, stop INCONCLUSIVE and do not arm. Only after valid SHAM zoom and verified reset/ARMED ACK: at most2 ARMED trials, stopping the CASE at the first zoom; no further gesture trial then. Only if both ARMED trials validly show no zoom, allow verified reset/restored SHAM ACK and at most1 final SHAM trial. Target/gate/sentinel proof and full observation remain necessary. No extra matrix, retry-until-green, or further fresh run is included in this handoff.

Stop on failed provenance, wrong target/document, missing or uncertain operation/transport correlation, XCTest issue, reset failure, incomplete settling/sampling, gate120s expiry/600-row cap, or unexpected concurrent control. Safe export/remove/restore is cleanup, not an extra gesture. Stop the runner and qualify this case's own final result; a later failure invalidates the case. Result collection may finish after instrumentation removal without extending the gate or admitting more gestures.

Return per-trial actual timestamps, bracket indices/span/count/max gap/scales, native ACK correlation and final qualification, exact hashes and observed gate/sentinel evidence. Restore/prove original document/nine assets/CSP; stop only owned services/isolated16e; preserve15Plus. Report limits and raw private receipt paths. No product efficacy or merge claim follows from this diagnostic.
