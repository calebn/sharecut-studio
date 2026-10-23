# Same-origin external diagnostic gate on the existing native QA route

This is the diagnostic-only CSP revision for root inspection. It is not a new production fix or an acceptance result. Do not run or publish until root coordinates the existing Mac QA task. No new Simulator session or direct cloud-to-QA communication is requested.

## Why this revision exists

Trusted parent report: the c1b113 run correctly stopped at the unchanged response `script-src 'self'` because the injected gate was inline. SHAM0 and ARMED0 ran. The QA host archived original candidate HTTP and9 actually loaded JS/CSS assets, confirmed the staged difference was only the old gate insertion, and observed native positive-control scale0.398 to1.182. Original document/assets were restored and verified; owned runner/services were cleaned, isolated16e shut down, and15Plus preserved. Raw receipts remain local to Mac and uninspected in cloud. Backend admission recovered enough for this run; it is not the current blocker.

This revision adds a classic external script from the existing same-origin `/assets` route in a task-local build copy. It does not relax CSP, alter application code/security configuration, or change the failed product commit. The gate body and listeners are byte-identical to the reviewed9ef86e0a… gate. No new native execution has occurred for this revision.

## Pin the input before changing it

Use failed product commit `60d4c3099750f95113f55b97637b6e4eb9145b97`, the existing isolated iPhone16e / iOS26.3.1 / Safari26.3 route, and the existing native XCTest gesture implementation. Do not rebase the product branch. Main is now `7f85f9a5502486c25d84577904f8c1c0c5cc09b2`, but its changed Listen/status/dock code is not part of this experiment.

The parent reports real failures on the candidate, including after the SVG-policy counterfactual. Stable connected targets weaken replacement, but do not prove Safari's internal input policy. The latest no-zoom trials did not discriminate. Raw Mac receipts have not been inspected in cloud. No physical-device claim follows.

The premise to test is whether downstream application navigation input handling is necessary for a failing page-zoom occurrence. First rule out a delivery mismatch. The earlier phrase “local HTML wrapper” is ambiguous; do not assume it replaced or framed the application.

1. Keep a manifest-only receipt on the original application route. Record final URL and origin, top-level or frame context, exact raw HTTP response body and headers, every viewport meta, base URI, original loaded JS/CSS URLs and SHA-256 hashes, checkout/build SHA, build command/environment and the actual static directory selected by the server. Hash the exact passive probe and any wrapper/helper bytes separately and describe their role. Preserve local raw inputs; redact session tokens from any public summary.
2. Evaluate `2149-next-manifest-snapshot.js` only through the existing read/evaluate route while native XCTest is idle. This captures DOM/resource metadata, not HTTP bytes. Independently save the original server response and loaded asset bytes on the QA host, using the existing authenticated route. A disk build hash or outerHTML alone cannot establish served-input identity. Record redirects, service-worker/cache involvement and differences if any; do not silently repair them and count a pass.

If the manifest cannot establish the served document/build and wrapper/probe roles, stop after the manifest stage and report the uncertainty; do not arm the intervention.

3. Verify the exact existing positive control with one fully released native double tap. Preserve the native request/complete timestamps and actual browser result. Use the established safe reset to scale1. Do not reinterpret a WebDriver or synthesized DOM event as native touch. Do not run WebDriver and XCTest concurrently; the prior conflicted attempt was excluded.

Useful existing-checkout commands, with QA-owned paths filled from its receipts:

```sh
git -C "$QA_CHECKOUT" rev-parse HEAD
git -C "$QA_CHECKOUT" status --porcelain
shasum -a 256 "$QA_DIST/index.html" "$QA_PROBE" "$QA_WRAPPER"
```

Expected checkout is exactly60d4 and clean. Reuse the existing verified build when its manifest establishes identity. If it does not, rebuild that same commit using its recorded command and record the new build; do not infer a build command or harness invocation from this cloud document.

## Stage the external first script without changing policy

`2149-external-stage-document.py stage` copies the exact original build into a NEW isolated directory. It adds one gate file to the existing `assets` directory, named `qa2149-nav-gate-<full SHA-256>.js`, and inserts one empty external script element before the first application script. The inserted element has only `data-qa-2149` and an absolute same-origin `src`. It has no inline executable bytes, async, defer, module type, nonce or policy override. Existing `currentScript` marker/first-script/loading guards stay intact. The browser fetches this classic parser-blocking script before following application scripts.

The absolute URL comes from the archived actual document origin. The original observed base URI must also be same-origin, and the resolved script URL must equal the manifest URL. A changed/cross-origin base, redirect or source asset collision is a stop. A content-hashed filename prevents the immutable static-assets cache from reusing different gate bytes. The stager refuses even an identical preexisting gate path, an existing output/sidecar manifest, overlapping output or symlinked source inputs. It never overwrites the original build. The complete original file inventory remains identical; the staged inventory must contain exactly that inventory with only index.html changed and one added gate file.

```sh
python3 "$QA_PACKAGE/2149-external-stage-document.py" stage \
  --source-dist "$QA_DIST" \
  --output-dist "$QA_CASE/external-gated-dist" \
  --gate "$QA_PACKAGE/2149-next-nav-gate.js" \
  --document-url "$QA_ACTUAL_DOCUMENT_URL" \
  --base-uri "$QA_OBSERVED_BASE_URI"
```

Serve this copy ONLY through the existing isolated QA server and its existing `/assets` route, at the original origin and application URL. Do not add a special route or weaken headers. Before any SHAM, archive the actual original/staged HTML responses and gate response with raw headers and bytes on the QA host. Require200, no redirects, final URL equal to requested URL, same origin, expected text/html for documents and JavaScript MIME for gate, and exact returned gate hash. Capture Content-Security-Policy header values on all three responses and compare them without modification. Preserve original meta policies and other security headers. No extension, unsafe-inline allowance, security-policy bypass or MIME fix is authorized; any mismatch stops the run.

Record the gate's actual resolved currentScript URL, document baseURI and first-script/loading metadata. Record actual document request/response, external-script request/response and gate installation timestamps. The120s gate timer starts at execution/installation AFTER the external fetch. It does not cover the pre-fetch interval. Added parser-blocking fetch/startup delay affects both SHAM and ARMED and remains a timing limitation; do not silently extend, restart or reset the installed timer.

The `verify` subcommand checks local archives and supplied actual response metadata, not the browser's CSP decision. Populate this evidence schema from the existing QA capture route; do not fill it with expected values. Retain raw originals beside the JSON. Paths are QA-local, not cloud paths.

```json
{
  "original_document": {
    "url": "ACTUAL_DOCUMENT_URL", "final_url": "ACTUAL_DOCUMENT_URL", "status": 200,
    "redirect_chain": [], "base_uri": "ACTUAL_BASE_URI", "csp_headers": ["EXACT_RETURNED_CSP"],
    "content_type": "ACTUAL_CONTENT_TYPE", "body_path": "LOCAL_ORIGINAL_HTTP_BODY"
  },
  "staged_document": {
    "url": "ACTUAL_DOCUMENT_URL", "final_url": "ACTUAL_DOCUMENT_URL", "status": 200,
    "redirect_chain": [], "base_uri": "ACTUAL_BASE_URI", "csp_headers": ["EXACT_RETURNED_CSP"],
    "content_type": "ACTUAL_CONTENT_TYPE", "body_path": "LOCAL_STAGED_HTTP_BODY"
  },
  "gate": {
    "url": "ACTUAL_GATE_URL", "final_url": "ACTUAL_GATE_URL", "resolved_script_url": "ACTUAL_GATE_URL",
    "status": 200, "redirect_chain": [], "csp_headers": ["EXACT_RETURNED_CSP"],
    "content_type": "ACTUAL_JS_CONTENT_TYPE", "body_path": "LOCAL_GATE_HTTP_BODY"
  },
  "loaded_original_resource_paths": ["assets/ACTUAL_LOADED_APP.js", "assets/ACTUAL_LOADED_APP.css"],
  "loaded_original_assets": {
    "assets/ACTUAL_LOADED_APP.js": "LOCAL_ACTUAL_LOADED_JS_BODY",
    "assets/ACTUAL_LOADED_APP.css": "LOCAL_ACTUAL_LOADED_CSS_BODY"
  }
}
```

The loaded-resource list must come from the actual browser document/resource capture, and every listed original JS/CSS body must be archived and checked against the original build inventory. Missing resource identity is a manifest stop, not an assumed match. The verifier also requires actual staged HTTP HTML to reduce exactly to the original response by removing the single declared external-script insertion. It does not claim that a metadata-only PASS proves native execution, CSP enforcement or handler exclusion.

```sh
python3 "$QA_PACKAGE/2149-external-stage-document.py" verify \
  --manifest "$QA_CASE/external-gated-dist-manifest.json" \
  --evidence "$QA_CASE/external-http-evidence.json"
```

After archive verification, require actual browser evidence that CSP allowed the external gate to execute before the application, with marker, scriptsAtInstall count1, readyState loading and an app-visible gate. Any CSP console block or absent/late gate stops before SHAM. Root owns the one independent local Chromium delivery fixture: unchanged CSP inline-block negative control versus external-first execution. That is delivery-fixture evidence only, not Mobile Safari gesture proof or acceptance.

## Run one conditional A–B–A comparison

Both conditions use the SAME gate listeners and options. All are first-registered window capture listeners with `passive:true`. The second listener for each event is a downstream sentinel. In SHAM, navigation events pass to that sentinel and the app. In ARMED, only events whose composed path contains the unique `nav.mobile-nav[aria-label="Primary"]` stop propagation. There is no `preventDefault`, style/viewport change, DOM replacement or app-state write. This is a temporary behavior counterfactual, not a production candidate or a “JS-free” claim.

1. While the gate is SHAM, use ordinary native app activation to select Timeline. Await releases and settled layout. Record aria-pressed, source of the independent app `zoomPxPerSec` measurement, page scale, button geometry and the exact native gesture command/timing. If the app-state reader is unavailable, mark app zoom unknown; do not substitute page scale or timeline scroll width for it.
2. Keep Timeline selected and page scale1 for every condition. Use the same native XCTest Timeline double-tap operation, same measured hit point and requested duration/gap. Record achieved native completion/release timestamps and all observed trusted event types, paths, contacts, cancellation observations and gate coverage. Only one JS touch pair may be exposed; that alone does not prove both releases.
3. SHAM A has at most3 attempts. Export receipts after each fully completed trial. A valid page-scale increase above1 is the trigger for B. If no SHAM failure occurs, STOP as inconclusive; do not arm or expand attempts to obtain a green result. A generic positive control cannot replace a paired app failure.
4. After a valid SHAM failure, safely reset the page and restore the same already-selected Timeline state while SHAM. Confirm all observed contacts ended, native completion is certain, and the app/layout has settled. Call `window.__sharecut2149Gate.setCondition("armed")` only between trials. Run at most2 ARMED attempts, stopping after the first valid ARMED zoom. Export before any condition change. Return to SHAM only after fully awaited releases.
5. Run at most1 restored SHAM A trial from the same state. A missing restored failure weakens the comparison. Never repeat an uncertain gesture, a timed-out release or an automation conflict. Stop immediately on those conditions, a nonzero observed active-contact state, unexpected targets, a cap/timeout, changed document/assets or lost native control. DOM contacts are observed signals only; independently await native XCTest completion and releases. A trace stopped at600 rows or120 seconds is incomplete and invalid for exclusion claims. The120s timer begins at gate execution/installation after its external fetch, including subsequent app startup and control handoff. If it expires at any point, STOP as invalid; do not silently reset, extend the timer or replay a trial.

Use the existing passive probe only if needed for the already-established geometry/viewport measurements. Its timing overhead must be present equally in SHAM and ARMED and its exact hash recorded. The gate adds no layout reads per input event. Trial marks sample viewport state; capture records are observations at that phase, not final-dispatch defaultPrevented. No capture microtask is described as a completed-dispatch boundary.

Export/read operations happen only after native XCTest has completed and released control:

```js
window.__sharecut2149Gate.mark("sham-a1-before");
window.__sharecut2149Gate.export();
window.__sharecut2149Gate.setCondition("armed");
window.__sharecut2149Gate.export();
window.__sharecut2149Gate.setCondition("sham");
window.__sharecut2149Gate.remove();
```

These calls illustrate separate trial boundaries; never run them as one sequence during an active gesture. Use the already verified Mac local wrapper/read-evaluate route only while the native XCTest operation has completed and relinquished control. The parent must name that exact existing invocation and archive it; this cloud lane cannot infer it from the report. If that route needs a simultaneous WebDriver session, STOP rather than recreating the excluded automation conflict. Save each returned object with the existing receipt writer. Before/after scale, app zoom, achieved contacts/releases, screenshots and native harness command logs belong to each condition, not only the aggregate summary.

## Interpret and clean up

- Persistent page zoom while every observed LISTED nav event is blocked before the sentinel, ordering is verified, and no target escaped the guard would falsify the necessity of those downstream event-dispatch handlers for that occurrence. This is not exclusion of all app JS, all inputs, or all app effects. The listed types are touch start/move/end/cancel, pointer down/move/up/cancel, mouse down/up/move, click/dblclick and gesture start/change/end. Focus/focusin/blur/focusout are observed without blocking. Scroll, native default behavior, focus effects, unobserved events and unrelated asynchronous app effects remain outside the gate. Record those limits and any remaining focus observations explicitly.
- Absence of ARMED zoom does not prove app causation or a fix. Suppressed state transitions, timing changes and intermittent reproduction can explain it. Report the nearby SHAM failures and any missing signals.
- `visualViewport.scale`/width/offset changes establish page magnification separately from app `zoomPxPerSec`. Both can change. Existing true browser/Timeline pinch reports remain valid for their old commits; they do not verify pinch under this counterfactual.

Always export/remove the gate and passive probe, restore the original static directory and verify the original response/assets again. Preserve all receipts and the staged copy for review. Clean only the owned runner/server/isolated16e resources through the existing QA procedure; preserve15Plus and other sessions. If cleanup is uncertain, report it and stop. No acceptance, ready/merge, production source change or CI action follows from this diagnostic.

## References and scope

Classic external scripts without async or defer use the parser-blocking processing path in the [HTML Standard](https://html.spec.whatwg.org/multipage/scripting.html#the-script-element). `script-src` constrains script sources, including inline execution; see [W3C Content Security Policy Level 3, script-src](https://www.w3.org/TR/CSP3/#directive-script-src). These references explain the proposed delivery mechanism. Actual QA-host headers, bytes and browser execution remain required.
