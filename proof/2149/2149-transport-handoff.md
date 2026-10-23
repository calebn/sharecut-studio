# #2149 single-XCTest transport preflight — no gestures

Runnable scope: a throwaway no-gesture assets-file/query-log roundtrip while the existing XCTest session owns idle Safari. The helper DOES NOT run native processes. All condition/gesture/compare paths are hard-disabled in both host and bridge, with no bypass flag. This package is not a product fix, causal discriminator execution, or acceptance. Draft2174 remains failed60d4c3099750f95113f55b97637b6e4eb9145b97; old immutable proofs stay unchanged.

Parent reports4b22 external gate loaded while document was loading under unchanged CSP, but ZERO native trials occurred because foreground JS control was unavailable. Mac raw receipts are not cloud-inspected. User Yes confirms atomic task-local asset writes and full query-log capture. Actual log format/no truncation, timing, and existing Mac-specific THIS-operation completion/release boundary remain unverified here. Existing Mac source/invocation/per-operation receipts may establish that boundary; no new framework is inherently required. Generic process exit0 and a historical release-file hash are insufficient. No physical-device claim.

## Stage exact existing candidate inputs

Privately archive exact candidate60d4 build/static root and source commit; original response HTML/all viewport metas; actual full document URL/base URI/origin; status/redirect/MIME/CSP and other headers; every loaded original JS/CSS raw response/hash; wrapper/probe roles. Full URLs with tokens, queries or fragments stay private. Do not assume a local wrapper replaced the app. If the manifest cannot establish the served document/build and wrapper/probe roles, stop after the manifest stage and report the uncertainty; do not arm the intervention.

```
python 2149-transport-stage.py stage \
  --source-dist <ORIGINAL_EXACT_BUILD> --output-dist <NEW_SIBLING_STATIC_COPY> \
  --gate 2149-next-nav-gate.js --bridge 2149-transport-bridge.js \
  --document-url <ACTUAL_DOCUMENT_URL> --base-uri <ACTUAL_BASE_URI>
```

Values are actual Mac-owned inputs, not proposed harness commands. Output must be new/outside source. Staging refuses symlinks, recursion and source-path collisions. It inserts one empty classic parser-blocking external first script, no inline executable bytes/async/defer/module. Bundle = byte-identical old gate + bridge; full content hash in filename. Exactly3 assets are added: hashed JS, nonce command JSON, empty nonce receipt.txt. Only command JSON subsequently changes. Source and existing assets remain byte-identical. No new route/server policy/CSP change. Existing `/assets` serves all3.

The manifest binds EVERY packaged .py/.js/.cjs/.md byte hash, original and staged inventories, all added paths, generated128-bit run nonce, bundle hash and insertion. Host refuses package bytes changed after staging. Successful preflight report copies all tool hashes, bundle hash, run/instance and final ACK hash; it explicitly says native release validation was not run. No stale proof carry to revised tools.

The `verify` subcommand checks archived original/staged HTTP HTML differs only by exact insertion, unchanged actual CSP headers, status200/no redirect/same origin, resolved script URL/MIME/rawbodyhash and loaded original assets. Disk inventory/manifest is not live HTTP proof. Also archive initial command and empty receipt HTTP responses before host mutation: exact actual URLs/final URLs,200/no redirect, application/json and text/plain MIME, raw hashes matching staged inventory, identical unchanged CSP headers. Any source collision, altered original asset, policy/status/MIME/URL/redirect/body mismatch stops. Source-policy reading is not actual Mac-header proof.

## Mandatory actual Mac no-gesture roundtrip

Only existing authorized XCTest/Safari; no foreground evaluate/WebDriver/second tab/new session. Existing Mac owner supplies actual static selection, atomic-write and raw access-log invocations from its receipts. This package invents none. Keep Safari idle: do not start a native operation during the roundtrip. Host sends only mark/export/remove. DOM-idle contact counts do NOT establish physical release; this run starts from an independently known no-gesture idle lifecycle.

```
python 2149-transport-host.py preflight \
  --manifest <NEW_STATIC_COPY>-manifest.json \
  --access-log <PRIVATE_RAW_ACCESS_LOG> --output <NEW_PRIVATE_OUTPUT>
```

Run helper asynchronously with respect to the existing server so it can keep serving. Output and log must be outside static. A0700 private sibling contains shared per-run lock/tombstone and command-write tempfile; only final atomic os.replace touches command JSON. Cross-filesystem replace fails, no nonatomic fallback. No private argv/native receipts/logs in static. This helper invokes no subprocess. No guessed XCTest argv or automatic contact cleanup.

Browser autonomously emits ready then polls command JSON every150ms AFTER previous request/receipt completes, unique query/no-store, same-origin/no redirect/status200/JSON MIME. It accepts strict monotonic epoch+predecessor receipt SHA, fixed run and random document/gate-instance ID. Host reads ready solely from raw GET logs, locally rejects ARMED without writing it, then sends mark, export, remove. Bridge independently refuses either condition command, even a manually modified command file. No SHAM/ARMED native trials happen.

Each UTF8 JSON receipt is base64url chunks <=900ASCII bytes, with byte length/count/full SHA256 and explicit end. Every raw logged GET including end must be200. Parser requires complete matching run/epoch chunks; reordered complete chunks allowed, identical duplicates allowed, conflicting duplicates/hash/length mismatch/non200 fail. Missing chunks/end/log format/timeouts stop without advancing. Rotated/truncated or >16MB log fails. Runtime preflight must prove actual Mac raw log format/query completeness; cloud Uvicorn-like fixtures are not that proof.

Payloads contain origin/path plus full-URL SHA256, never query/fragment/userinfo plaintext; exact full URL/base comparison is retained via private-manifest hash. Gate event metadata excludes app content. Gate source is unchanged. Unique Primary nav Timeline aria-pressed is READ on command receipts, app zoom explicitly unobserved, page visualViewport remains separate. Browser cannot infer native release from observed DOM contacts.

ACK requires same run/instance/document/base hashes, exact op/label, intended condition and no observed active contacts. Normal mark/export remain SHAM; remove must report stopped/removed and namespace deletion. Each next command depends on previous complete hash ACK. Host lock survives ANY invalid/uncertain failure, across output directories. Do not unlock/replay; preserve evidence and resolve outcome read-only. Successful remove ACK permits normal lock cleanup. Original staged inventory is unchanged except command JSON; verify inventory after case and restore original served build/HTML/assets with raw HTTP/CSP readback.

## Timing and stopping

Original gate600-row cap/120s timer remain unchanged; timer begins at original gate execution AFTER bundled fetch. Bridge remaining time derives from original installed-row performance clock, not later bridge execution. Every transport request checks that deadline before/after; no reset/extension. Full raw document/fetch/response/install/command/ACK timestamps and durations belong in private archive. Blocking fetch, polling/chunk requests and snapshots add observer effects; no claim of JS-free behavior.

Host ACK timeout6s and conservative remaining-time margin are fixed bounds. A cap, expiry, lost ready/ACK, unsupported log, stale command, different instance/tab/reload, uncertain admission, native operation starting unexpectedly or existing-session conflict invalidates case. Stop, report exact limit; no repeat-until-green or automatic replacement. Explicit future fresh known no-gesture lifecycle is distinct from retrying an uncertain run.

Root's one independent Chromium transport/CSP fixture uses page.goto only, no foreground evaluation/control/readback, raw GET log receipts and fake server. It verifies delivery only, not Safari, native contact releases, or #2149 behavior. Mac must still demonstrate actual no-gesture idle roundtrip and duration under the existing session. No comparison handoff is runnable from a local transport PASS.

## Conditional design only — disabled pending Mac evidence

Next missing integration fact: reviewed current-operation native completion/release boundary and in-place interleave using existing Mac XCTest source, exact invocation, and each operation's receipts. Parent can route the existing Mac QA owner to those existing facts; user setup rediscovery is unnecessary. Cloud has not inspected them. Do not substitute a generic exit0 or invent a new release schema. Until established, compare always errors and both host/bridge reject all condition changes. No bypass exists.

After that integration is reviewed in a FUTURE revision, original design remains: setup ordinary Timeline activation while SHAM; same stable connected Timeline anchor path and aria-pressed true before/after each intended tab trial; separately measured page scale exactly1 with at most1e-6 numeric serialization epsilon. At most3 fully released native SHAM trials, stop at first actual page-scale increase above1+epsilon with trusted Timeline dispatch/sentinel evidence. Without failure, INCONCLUSIVE and no B. Only then after independently completed reset may at most2 ARMED trials run, stopping at first zoom; restore SHAM and at most1 final trial. Condition ACK must match before next gesture; no timing/DOM-idle shortcut. All original positive-control, served-input provenance, native-release, no-uncertain-retry and bounded stopping rules stay required. Existing historical genuine pinches are not counterfactual pinch proof.

Persisting zoom under VERIFIED listed Primary-nav downstream dispatch exclusion would falsify necessity of those LISTED handlers for that event. Focus/focusin/blur/focusout are observed but ungated; scroll/native defaults/asynchronous/other routes remain outside gate. Absence of zoom does not establish cause/efficacy. This package performs none of that comparison.

## Cleanup report

Require complete export/remove ACK; restore original build/HTML/assets/CSP and prove inventories/raw HTTP responses; preserve private case logs/ACKs/toolhashes; stop only owned runner/server and preserve other simulator/session. If outcome is uncertain, read-only verification precedes any recovery; no automatic cleanup during native operations. Return exact source/build/HTTP/probe roles, transport nonce/tool hashes, no-gesture count0, timings/errors/limits, status of original restoration and actual private Mac receipt paths. No public raw Mac/app data. No production/CI/ready/merge/new-issue actions.
