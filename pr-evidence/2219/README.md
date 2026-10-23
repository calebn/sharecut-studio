# PR 2219 evidence

This branch holds evidence for [PR 2219](https://github.com/calebn/sharecut-studio/pull/2219). It is not a change proposed for `main` and must not be merged. The implementation head is `9ced2088f242c4daf3c050fbf8ec51aa375ece5f`. Its parent baseline is `92b3c36598619330fa428b9978bda7de58062f87`.

The captures use the repository's disposable aligned-dialogue fixture. The phone uses Chromium at 390 by 844, touch, and light mode. The desktop uses Chromium at 1280 by 720 with a fine pointer. These are not physical Safari captures.

`phone-before.png` shows the confirmed stale inspector after a refused approval, a saved waiver, and successful retry. `phone-after.png` shows the closed inspector and the existing completion toast. `desktop-after.png` shows the preserved desktop result. `browser-receipts.txt` retains the meaningful output from each run, including restoration of the same edit by Undo. The first parallel phone after-run hit a trace-output collision after its functional assertions. The published phone receipt is the subsequent clean run with isolated output.

`regression-before.txt` records the four expected selection failures before the helper fix. `regression-after.txt` records the owner's committed-head focused test run. Existing cheap tests were extended. No new recurring browser matrix was added.

## Repeat the browser proof

Use a provisioned source checkout at the chosen baseline or implementation head. Follow `docs/setup.md` for the supported FFmpeg pair and install Playwright Chromium. Copy `pending-review-repro.spec.ts` from this evidence branch to `gui/web/e2e/issue2159-repro.spec.ts` in that checkout. The copied file is a disposable proof, not a proposed permanent test.

From `gui/web`, run:

```sh
npm run build
ISSUE2159_PHASE=after ISSUE2159_EVIDENCE_OUT=/tmp/pr2219-phone npm run test:e2e -- issue2159-repro.spec.ts --output=/tmp/pr2219-phone-results
ISSUE2159_DESKTOP=1 ISSUE2159_PHASE=after ISSUE2159_EVIDENCE_OUT=/tmp/pr2219-desktop npm run test:e2e -- issue2159-repro.spec.ts --output=/tmp/pr2219-desktop-results
```

Run the two commands sequentially, or keep their output directories distinct. Each invocation creates its own disposable project. The baseline phone assertion fails with the missing inspector still present. The implementation passes and restores the same pending edit through Undo. The desktop baseline and implementation both pass. Delete the copied spec after the proof.

This execution environment remapped root ownership inside its sandbox, which caused the unchanged registry trust guard to reject the sandbox root. The recorded runs used the approved local execution mode with actual root ownership and a verified task-local FFmpeg 9.0.2 pair. No trust, permission, version, access, or production policy was changed.

## Qualify the merge predicate

`gate-failure-proof.py` uses a harmless in-memory stand-in, not a real merge. Its JSON receipt shows zero invocations for a helper exit 1 and for an HTTP 503 with null head. The passing control invokes the stand-in once. The real immediate issue gate, required exact-head CI, independent final verdict, ready transition, and parent merge instruction remain separate requirements.

The proof script's original output path names this run's local state directory. Change only that output path to repeat it elsewhere. It performs no GitHub writes.
