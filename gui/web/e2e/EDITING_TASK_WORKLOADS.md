# Run editing task saved-state proof

Run from `gui/web` on the workload branch. Choose a new evidence directory. The runner rejects existing output directories.

```sh
node node_modules/vite-node/dist/cli.mjs scripts/profile-editing-tasks.ts \
  --app-base 6033d77a2884697ae659f2b2b917cacae4b2e737 \
  --trials 5 --out /tmp/editing-task-baseline
```

The default builds production assets with `VITE_SHARECUT_E2E` unset. To reuse a retained production build, supply `--production-dist`, `--build-receipt`, and `--source-receipt`. The build receipt identifies `productRevision`, successful `exit`, and every asset hash. The source receipt identifies the same revision and the complete application inventory. It includes `src/podcast_mcp/`, `gui/web/src/`, `gui/web/public/`, frontend package and lock files, Vite configuration, `pyproject.toml`, and `uv.lock`. The driver and its imported harness files have separate byte hashes. The runner verifies the current files against the declared application revision before serving that build.

For a browser correctness check, add `--validity-only --trials 1 --task seek --route ruler-keyboard`. Validity and diagnostic trials do not enter baseline statistics. For a separate Chrome trace, add `--diagnostic`. Selectors filter the invocation’s scope. `selectedProofComplete` applies only to the listed selected task routes. `fullSupportedCoverage` reports all current routes, and unselected routes retain not-run rows.

Protocol version 2 retains local API read requests, responses, and failures. A setup detail read cancellation is admitted only when the exact same project URL starts a replacement after the abort and receives one successful typed document snapshot response. Action failures, command failures, other read failures, and HTTP errors remain fatal. Earlier smoke protocols remain excluded. Inspect `protocol.json`, `protocol.sha256`, `source.json`, `backend-import.log`, `attempts.json`, and `summary.json`. Each attempt retains its ordered input and command journal, starting and resulting durable saved state, applicable canceled and undone state, history cursor, head identity and entry facts from saved project JSON, project JSON, screenshots, and the existing editor profiler's raw scheduling and CDP observations. UI evidence records initiation, input completion, save, and recovery geometry. Pointer drags and comment swipes also retain an intermediate geometry observation. Validity and diagnostic modes retain screenshots during input. Baseline mode retains geometry during input and screenshots outside the measured window. Comment cancellation uses independent clones for a short swipe, vertical motion, and trusted `touchCancel`. Failed attempts remain in the evidence. A failed supported proof exits unsuccessfully.

The registry contains eight atomic cases in seven families. The trim case uses the shipped Ripple handle. Its source-in target is 0.3 seconds on the first reference occurrence. The matching guest source-in also becomes 0.3 seconds, and the later reference occurrence starts at 9.7 seconds. The selected clip stays at timeline zero. This replaces the proposed Gap task because the shipped handle commits Ripple mode.

The durable oracle covers all saved clip geometry, track order and mix, envelope points, and comment state in the fixture. Targets are literal and independent of outgoing commands. A task that leaves the document unchanged fails. Cancellation and Undo require actual input evidence, permitted command cardinality, and restored saved state. Exact keyboard and form routes use tolerance `0.000001` in each field’s units where pointer precision allowances exist. Pointer errors retain fixed allowances declared before execution.

Action counts include task navigation. Setup, cancellation, and Undo counts remain separate. A drag is one deliberate operation regardless of its pointer moves. A held key burst is one operation. Mix keyboard adjustment records twelve separate steps and requires twelve corresponding Undo commands.

Baseline summaries retain valid and failed counts and median, minimum, and maximum duration only after five valid baseline trials. Duration includes driver input, geometry observation, saved-state polling, and two animation frames. It does not represent input-to-visible latency. Timing remains inconclusive until a separate limiter diagnosis and comparable noise evidence exist.

Exact timestamp entry, numeric trim, and future precise Mix controls remain pending. Browser pointer, keyboard, numeric form, and trusted CDP touch retain their actual labels. This proof does not establish physical-device acceptance or future touch grammar. Current browser proof covers the seek keyboard route only. The retained receipt is `/tmp/poteto-workloads1035-owner/writer-evidence/seek-validity-5`. It observed the literal stopped target, seven task activations, zero commands, and zero errors. Earlier invalid attempts remain retained beside that directory and are excluded. Other current routes and baseline remain unverified. Each attempt uses an owned share registry. Linux attempts retain live backend process evidence for the leased port, working directory, production assets path, and share registry path.

Run the focused oracle checks.

```sh
npx --no-install vitest run e2e/editingTaskReport.test.ts
```
