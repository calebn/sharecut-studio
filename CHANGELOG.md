# Changelog

## Unreleased

### Upgrade notes

* **Source duration is the audio length (#2143).** `probe()` now reports the length of the first audio stream for files with audio (the container duration is kept only if a packet scan fails, flagged as estimated), not the container duration, which includes longer video tracks and bitrate estimates. Imports and add-track store it as the media, source and timeline extent, so a 10 s audio track in a 60 s video no longer stretches the timeline to 60 s. Projects created before this keep their stored source, clip and timeline durations; a pipeline run from `ingest_tracks` refreshes only the track media duration, and nothing flags the mismatch.

* **One clock for late-start audio (#2175).** For a file whose first audio stream starts after its container (video first, or `-itsoffset`), source time 0 is now that stream's first sample everywhere. `probe().duration_sec` is the audio's own length, where #2143 added the leading gap, and the new `audio_start_sec` carries the lead. The renderer and every windowed decode (waveform tiles, bleed echo, alignment, join checks, segment extract) add the lead at the seek, so a keep window at 0.5 to 1.5 s plays the audio at 0.5 to 1.5 s, where it used to play silence or the wrong span. The lead of a late AAC file is its first decoded sample, not its first packet. Files that start at or within 0.02 s of their container start keep their duration and render unchanged. Projects that stored a late-start source's container-clock extent keep it until the source is re-imported, and a saved clip beyond a late-start source's audio length now renders short or empty. MPEG-TS, M2TS and MPEG-PS files whose audio starts late are refused at ingest and fail every read of an already-saved source with `invalid_audio` ("audio starts late in an MPEG transport stream; re-encode it"), because ffmpeg rebases their audio-only reads.

* **Files with several audio streams (#2110).** Analysis now reads the first audio stream, the one the render plays, where it used to read FFmpeg's default pick (the default-flagged stream, else the one with most channels). Level records, room-tone pools, waveform pyramids, forced-alignment sidecars and the gate evidence for such files are keyed afresh and rebuilt on demand. Their gate fills, and speaker profiles enrolled from the raw source (a profile enrolled from a processed stem is not affected), are ignored, and their prosody profiles read as stale, until the step that writes them runs again (the pipeline's gate-fill step, speaker enrollment, `analyze_prosody`). Single-stream files are unchanged. On multi-stream files the silence-flag fingerprints change too, so the next transcribe run re-flags them under the own-track scope until reconcile runs. State already written from the default stream is not rewritten: the consolidated ingest WAVs, accepted alignments and placements, word times in the transcripts, pending proposals, and a `gain_db` that balance staged before (it shows as stale). On a project with a multi-stream source, re-run ingest, then run the pipeline from transcribe_tracks with "Re-time words" and realign (it re-runs align, reconcile, prosody, the proposal steps, gate fill and balance in order), and re-enroll speaker profiles taken from the raw source. A project created before this fix says so: `podcast info` and the `pipeline run` report (CLI and MCP) name each media file that has several audio streams where FFmpeg's old pick, judged from the default flag and channel count, was not the first or cannot be told (a stream that starts more than a few seconds into the file can be judged wrongly, and a file added since this fix is listed too but was read correctly), with the steps to re-run; `podcast episode mark-streams-current --project <path>` clears the notice once they are done. Projects consolidated before this fix are not detected, because the project does not record the original recordings: if any original had several audio streams, re-run `podcast ingest consolidate` and then the steps above.

### Features

* Studio's export dialog offers M4A (AAC-LC, 128 kbps) beside MP3, FLAC and the WAV master (#2260). `m4a` in a bounce's `formats`, or a bare `{ext: m4a}` entry in `export.formats` or `export-audio --formats`, now writes that preset (before, a bare `m4a` took FFmpeg's defaults). A build whose FFmpeg lacks the aac encoder or ipod muxer refuses it by name before encoding and leaves earlier exports untouched.

### Fixes

* The stdio MCP server and the CLI no longer write behind a live Studio bound to `127.0.0.2` or a LAN address; both now stop with a message naming the Studio and the two ways out (restart with `--host 127.0.0.1`, or `PODCAST_NO_STUDIO_HANDOFF=1`), and the CLI refuses reads for such a Studio too (#2515).

* A live Studio that answers the handoff check with an unreadable reply, or that fails before the call is sent (for example the MCP initialize fails), now stops the call or command with a message and nothing runs, instead of the call running here and writing directly (#2326).

* A Whisper GPU run that fails with a host out-of-memory error is no longer retried on the CPU (#2248). Only CUDA, cuBLAS, cuDNN and GPU errors, including ones named by an error's cause, trigger a retry after a failed run; a GPU model that fails to load is still retried on the CPU.

* Uploading an MPEG-TS, M2TS or MPEG-PS file whose audio starts late now says "audio starts late in an MPEG transport stream; re-encode it" to the host instead of "not a playable audio file" (#2310). Guests still see the generic copy. An upload whose probe times out now reports "not a playable audio file" instead of the raw timeout text.

* Audio health `peak_count` now reads the exact `Peak count` field instead of `Abs Peak count` (#2154). Counts can change on untagged files. Other health measurements and the clipping policy are unchanged.

* Basic and full loudness measurements return no measurement when zero audio frames decode, including with progress callbacks. Empty audio no longer measures as -70 LUFS; decoded silence still does (#2154).
* Full mastering loudness measurements now return no measurement after a failed FFmpeg run or when the file has no audio, including with progress callbacks. Forged Summary tag keys on video-only files no longer read as -16 LUFS (#2154). Successful audio measurements and their automatic stream selection are unchanged.

* Audio health stats (`measure_astats`) and `check_loudness` now read the first audio stream, the one the render plays, on media with several audio streams (#2131). Single-stream files measure the same as before.
* `check_loudness`, `measure_astats` and the speech-gated loudness blocks no longer read a file's metadata tags as measurements (#2143); mastering's loudness measurement ignores tag text on our own renders. A tagged file with no audio stream used to pass `check_loudness`; `check_loudness` and `measure_astats` now give `null` for it or for a failed FFmpeg run, and tags that are not valid UTF-8 no longer crash them. Untagged files measure the same as before.
* `load_profile` no longer falls back to a stale speaker profile (stem hash mismatch).

* A CLI command or stdio MCP tool call no longer writes the project directly when the Studio serving it is slow to answer (#2318). The Studio ping now waits 5 s and is tried twice; a Studio that accepts the connection but stays silent stops the command with "Studio (pid N) is serving this project but did not answer in time" and writes nothing.

* A stdio MCP tool call no longer runs in its own process when the live Studio serving the project is bound to a non-loopback address (such as `--host 0.0.0.0`) and so serves no `/mcp`. It stops with a message that names the Studio and offers `--host 127.0.0.1` or `PODCAST_NO_STUDIO_HANDOFF=1`, and writes nothing. The CLI is unchanged.
* A `podcast review` command that names `--project` is now handed to the Studio serving the project instead of writing the project directly (#2325).

## [0.1.1](https://github.com/calebn/sharecut-studio/compare/v0.1.0...v0.1.1) (2026-10-18)


### Features

* **desktop:** in-app updates through the Tauri updater ([#1701](https://github.com/calebn/sharecut-studio/issues/1701)) ([c4109a5](https://github.com/calebn/sharecut-studio/commit/c4109a5484c883d22f904345bb931d548670c022))
* **distribution:** updater profile fields, signed update feed and CI artifacts ([#1701](https://github.com/calebn/sharecut-studio/issues/1701)) ([60038c4](https://github.com/calebn/sharecut-studio/commit/60038c4ae5b97972536eccfa6d175e4e69a8cb1b))
* **envelopes:** create flat envelope with first point ([a0450e6](https://github.com/calebn/sharecut-studio/commit/a0450e651bf424df9692e0f35d5dba6316ecd058))
* **envelopes:** drag shown flat line to set level ([3407839](https://github.com/calebn/sharecut-studio/commit/3407839bfadce45218a3d1fdbc4e0cca0fa69024))
* guard released project and history formats ([6e8b082](https://github.com/calebn/sharecut-studio/commit/6e8b08276b8ee0eed723e350d4221a610b369603))
* **gui:** collapse the bottom drawer to the tool rail by dragging its handle ([#1706](https://github.com/calebn/sharecut-studio/issues/1706)) ([75a46bc](https://github.com/calebn/sharecut-studio/commit/75a46bcc270e993795950c322c88a1f85430d9c9))
* **gui:** load the phone timeline with time 0 beside the headers and the playhead on it ([#1707](https://github.com/calebn/sharecut-studio/issues/1707)) ([1aad0f4](https://github.com/calebn/sharecut-studio/commit/1aad0f479de1f12d1d3aae8372578cb1a8370a8d))
* **gui:** prototype three precision drags for a phone bake-off ([378a984](https://github.com/calebn/sharecut-studio/commit/378a98445d1103230fb844d3e5fa42d7d5fd7824))
* **gui:** ship Auto precision jog pad on touch ([#1184](https://github.com/calebn/sharecut-studio/issues/1184)) ([c515b74](https://github.com/calebn/sharecut-studio/commit/c515b7443a6f49e86bdfb37c29d8dbbc7ba3c381))
* **gui:** switch precision drag on automatically at arm time ([8d8285c](https://github.com/calebn/sharecut-studio/commit/8d8285cba35c7ca8eb3c68660d265fda543e9d5b))
* **history:** Undo says it waits for a save and a press queues behind it ([#1680](https://github.com/calebn/sharecut-studio/issues/1680), [#1679](https://github.com/calebn/sharecut-studio/issues/1679), [#1681](https://github.com/calebn/sharecut-studio/issues/1681)) ([aec7d1c](https://github.com/calebn/sharecut-studio/commit/aec7d1c9c0a8bb4ff7193a5ba3d8d6c5cdf56407))
* **relay:** log guest WebSocket close site and codes ([#1350](https://github.com/calebn/sharecut-studio/issues/1350)) ([8e3b2e8](https://github.com/calebn/sharecut-studio/commit/8e3b2e88951e658d4bec89e63459445368e28910))
* **release:** bump the version once per tester build with release-please, capped below 1.0 ([bd84a25](https://github.com/calebn/sharecut-studio/commit/bd84a25392e52534f7cead222d1e0cb5f7fae86b))
* **release:** sign only the Windows and Linux updater bundles with the updater key ([#1711](https://github.com/calebn/sharecut-studio/issues/1711)) ([9025890](https://github.com/calebn/sharecut-studio/commit/90258903bd398af8273abd0e03987f4da45d56ff))
* **speaker:** add move lane span after speaker split ([e16c00c](https://github.com/calebn/sharecut-studio/commit/e16c00cb07b2a46f469d399984da92248d69db82))
* **web:** add GapMark and flatline icon for trim mode ([#1138](https://github.com/calebn/sharecut-studio/issues/1138)) ([ee7eaa3](https://github.com/calebn/sharecut-studio/commit/ee7eaa3c5931d54f5b3681052f5b1bb227c3200a))
* **web:** add inspector numeric edit controls ([#1056](https://github.com/calebn/sharecut-studio/issues/1056)) ([2245094](https://github.com/calebn/sharecut-studio/commit/22450947ea0d06fe510bf4aeaa970a9f218ab0b3))


### Fixes

* **#1401:** avoid SessionAir band-floor drift on approve; sync decisions index ([21b53f9](https://github.com/calebn/sharecut-studio/commit/21b53f9b126be896f623560914cc8acf8c60b64f))
* allocate attention within compact inspector flow ([821c9dc](https://github.com/calebn/sharecut-studio/commit/821c9dc177c78f54c7bff604357f382cb9cce5a4))
* **audibility:** cached and uncached window reads return the same samples ([#1560](https://github.com/calebn/sharecut-studio/issues/1560)) ([bc8b19b](https://github.com/calebn/sharecut-studio/commit/bc8b19b846fab33f0ebce9e817661fb2f737d017))
* **audibility:** judge words in speech band over HVAC room ([#1377](https://github.com/calebn/sharecut-studio/issues/1377)) ([4a6075b](https://github.com/calebn/sharecut-studio/commit/4a6075b9442ca627f03a7caf140e4d6e19210814))
* **audibility:** speech-band rescue only for inaudible verdict ([#1377](https://github.com/calebn/sharecut-studio/issues/1377)) ([7e45769](https://github.com/calebn/sharecut-studio/commit/7e457692b4fbeca559c11e241a8ac7d9e77fb0ff))
* bind pause joins to unique placements ([8b620c6](https://github.com/calebn/sharecut-studio/commit/8b620c64e79aed9dfbc60c178d4d8e9ea7c45c9d))
* **bleed-gate:** read late-opening peer copy a syllable further ([#1131](https://github.com/calebn/sharecut-studio/issues/1131)) ([0208902](https://github.com/calebn/sharecut-studio/commit/0208902c9899d33722499a5aaac1c09dd7452bfa))
* **bleed:** drop fallback reverse when the other direction holds ([61f8c70](https://github.com/calebn/sharecut-studio/commit/61f8c70c8a2f0a71db57981c3e7f6b3ffa8155f3))
* **bleed:** pin null frames to the observation population ([2c61ef9](https://github.com/calebn/sharecut-studio/commit/2c61ef9cc19f29b22224ab2139e9644d3ed043ee))
* **bleed:** score echo frames without as-recorded dominance ([df5b814](https://github.com/calebn/sharecut-studio/commit/df5b814a1555cd1bf5a033e54675c2386e6681b0))
* **ci:** classify the release-please files and the changelog in the CI plan ([505fb6b](https://github.com/calebn/sharecut-studio/commit/505fb6be88ff63446238aae7b7409dced60bf9c2))
* **ci:** skip browser suites for wait allowlist only ([56b17b4](https://github.com/calebn/sharecut-studio/commit/56b17b4f680c00f03639bd3b4450e0c1ddc0e29f))
* **compat:** reject untracked producer runtime source ([7421348](https://github.com/calebn/sharecut-studio/commit/74213485273d0a7a43296e4678fdbe786417f692))
* complete source witness when coalescing primary cuts ([620d8df](https://github.com/calebn/sharecut-studio/commit/620d8df2e94298c38d66eeb19358d3bb7c619d4d))
* correct CI report summaries ([7cccf37](https://github.com/calebn/sharecut-studio/commit/7cccf374c6b534c79ec41a6c928abb523c8446a0))
* **cut-safety:** manual cut intent follows the acting role, not the route ([#1698](https://github.com/calebn/sharecut-studio/issues/1698)) ([ae83c95](https://github.com/calebn/sharecut-studio/commit/ae83c953426b136d8cd11cfd226a1dec3fdeb0e4))
* **cut-safety:** only a pad's own tiles are skipped as pad, not a user replay of its range ([#1403](https://github.com/calebn/sharecut-studio/issues/1403)) ([c979716](https://github.com/calebn/sharecut-studio/commit/c9797164f211ac0e7be10d16ea196dc0971595b7))
* **cut-speech:** batch peer reads use pre-chain evidence ([#1526](https://github.com/calebn/sharecut-studio/issues/1526)). ([dd22f7b](https://github.com/calebn/sharecut-studio/commit/dd22f7b8e0ea3aad7115a56e1141b6995e96de26))
* **cuts:** a pad laid by a batch edit does not make another batch removal incomplete ([#1403](https://github.com/calebn/sharecut-studio/issues/1403)) ([0dbab73](https://github.com/calebn/sharecut-studio/commit/0dbab73a42488985d50ce7e98d8886c0ef11fa2e))
* **cuts:** a pad tile copied from a pause's quiet is not a second play of it, so a batch's pad does not veto the pause ([#1403](https://github.com/calebn/sharecut-studio/issues/1403)) ([3905e56](https://github.com/calebn/sharecut-studio/commit/3905e56e15fe7ac04f2de6561c0d1eabe1717d4e))
* **cuts:** bind a surviving leaf to a BEFORE leaf that contains its source, so a batch's earlier mute fills are not one ambiguous occurrence ([#1403](https://github.com/calebn/sharecut-studio/issues/1403)) ([29e3b30](https://github.com/calebn/sharecut-studio/commit/29e3b3041efd3ec6f203750885bb576be3b3a779))
* **desktop:** accept dpkg-deb paths with or without a leading ./ in the Debian CLI check ([#1721](https://github.com/calebn/sharecut-studio/issues/1721)) ([7732a72](https://github.com/calebn/sharecut-studio/commit/7732a72751ed1775c24493d5cfb3d5d1062c1242))
* **desktop:** clear the engine port on stop, defer quit during install, claim the install once, fix a flaky sidecar test ([#1701](https://github.com/calebn/sharecut-studio/issues/1701)) ([d527ad9](https://github.com/calebn/sharecut-studio/commit/d527ad9bf3ab15e1a808e7293fcd483de6b985f9))
* **desktop:** end the install failure detail with a period before the status line ([#1701](https://github.com/calebn/sharecut-studio/issues/1701)) ([b9fb91b](https://github.com/calebn/sharecut-studio/commit/b9fb91b4a12eaa04053fab538ab787f18ccccee4))
* **desktop:** make the Linux AppImage smoke name its failing command ([#1721](https://github.com/calebn/sharecut-studio/issues/1721)) ([aad2e7d](https://github.com/calebn/sharecut-studio/commit/aad2e7d71b402049c4d0d82a604c96e6dfe8fdf9))
* **desktop:** never modal during a recording, respawn the engine after a failed install, check bundle ownership ([#1701](https://github.com/calebn/sharecut-studio/issues/1701)) ([36e35a5](https://github.com/calebn/sharecut-studio/commit/36e35a50ccf48de24471eea49d40b8bb6997eaa9))
* **desktop:** print the Debian usr/bin entries when a CLI path check fails ([#1721](https://github.com/calebn/sharecut-studio/issues/1721)) ([17b034f](https://github.com/calebn/sharecut-studio/commit/17b034f57ed6e0906d99aaa33c984cfd64cc96c0))
* **docs-sync:** preserve trailing-slash boundary ([f9d338b](https://github.com/calebn/sharecut-studio/commit/f9d338b775685c18372c60880ed859d337514b1d))
* **e2e:** satisfy template lint in precision-drag spec ([9d06029](https://github.com/calebn/sharecut-studio/commit/9d060294002ecd4ad46715da41a1bc4c0f6b1a6c))
* **edits:** hold unsafe source-witness overlaps ([967a468](https://github.com/calebn/sharecut-studio/commit/967a468840b4d08660ceb655c86b7332f0f6b9f7))
* **edits:** honor native cut operation mode ([844a35a](https://github.com/calebn/sharecut-studio/commit/844a35a9271519cb79724c1a7c2308cb1ffb10c6))
* **edits:** preserve source identity in approval batches ([4ae9e14](https://github.com/calebn/sharecut-studio/commit/4ae9e14484d81e24e98932ca29814416b3a76109))
* **edits:** reset intent after snapped proposal resize ([d741dab](https://github.com/calebn/sharecut-studio/commit/d741dabc8f0f5a24ca40e04eae0ee03c4d934527))
* **edits:** retain placement identity when resizing source cuts ([813a0f0](https://github.com/calebn/sharecut-studio/commit/813a0f07eb0807e406d45d8c9de6cc6deb07706d))
* **edits:** skip speech annotation for mute decisions ([9ab50a7](https://github.com/calebn/sharecut-studio/commit/9ab50a7c69825c8bd0b253665e072bdf3ce0364f))
* **edits:** type source cut optimizer kwargs ([33a7e5e](https://github.com/calebn/sharecut-studio/commit/33a7e5e6dd6141e151588ea807c9a8749af5368d))
* **fillers:** compare round-tripped pause spans within float error ([#1560](https://github.com/calebn/sharecut-studio/issues/1560)) ([d0a2235](https://github.com/calebn/sharecut-studio/commit/d0a2235a564f5c7a190a1056a5229ec3d7522ef4))
* **guard:** detect quiet backchannels under dense bleed ([#1357](https://github.com/calebn/sharecut-studio/issues/1357)) ([2a5c064](https://github.com/calebn/sharecut-studio/commit/2a5c064311a35cccc694d1702d74de0c53e9d647))
* **gui:** cache edit-boundary word maps and clip origins ([#1610](https://github.com/calebn/sharecut-studio/issues/1610)) ([33bb40e](https://github.com/calebn/sharecut-studio/commit/33bb40e48969e68da5c81df950415f9c631e77fa))
* **gui:** center the drawer reopen handle so it never covers the tool rail ([#1706](https://github.com/calebn/sharecut-studio/issues/1706)) ([722e774](https://github.com/calebn/sharecut-studio/commit/722e774a1e045d662e23450deeccdcf2f15e3416))
* **gui:** chooser chip grab never uses Auto precision ([#1184](https://github.com/calebn/sharecut-studio/issues/1184)) ([e67359a](https://github.com/calebn/sharecut-studio/commit/e67359a4da181a835e071b920d33de2cf992683b))
* **gui:** contain phone page zoom overflow ([3ac3515](https://github.com/calebn/sharecut-studio/commit/3ac3515d9ae72900d92a1e0dbc3a00f611131450))
* **gui:** declare attention placement default ([2b78939](https://github.com/calebn/sharecut-studio/commit/2b78939ab164c6563b16c917202137d2fbfb6a71))
* **gui:** dedupe attention announcements across polls ([#1540](https://github.com/calebn/sharecut-studio/issues/1540)). ([999009e](https://github.com/calebn/sharecut-studio/commit/999009ebe9a98215c7a00876ccf4b91271a46cc5))
* **gui:** exclude pending handles from Auto precision ([#1184](https://github.com/calebn/sharecut-studio/issues/1184)) ([05ec33d](https://github.com/calebn/sharecut-studio/commit/05ec33d71ea5c8682c863c6f653ba5daa7747246))
* **gui:** fit the envelope sheet's header on one row at 914x331 now the status line stays, unshift the unpinned marker rows, and tap the guest name in the idle spec ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([84063f0](https://github.com/calebn/sharecut-studio/commit/84063f01ae5448e574cfe59eb22ce08be188fc4d))
* **gui:** harden envelope visibility lifecycle ([e62e266](https://github.com/calebn/sharecut-studio/commit/e62e2667d0748cfab35eb9c32355647c7de8e869))
* **gui:** keep a scrub from being pulled back when the playhead sits on the view edge ([#1707](https://github.com/calebn/sharecut-studio/issues/1707)) ([2178e12](https://github.com/calebn/sharecut-studio/commit/2178e12645a3e641e338b95a4858bc2a3548faf9))
* **gui:** keep action feedback in shell status region ([#1540](https://github.com/calebn/sharecut-studio/issues/1540)). ([d013475](https://github.com/calebn/sharecut-studio/commit/d013475156a6d97173061bb338d879ff9250d26f))
* **gui:** keep agent range controls in tablet sheet ([d3ed9fc](https://github.com/calebn/sharecut-studio/commit/d3ed9fc45ce868a9b5b898a38d0faccccc6bfff6))
* **gui:** keep attention panel inside safe areas ([891dfaa](https://github.com/calebn/sharecut-studio/commit/891dfaa3882981b0deb74729870d4411df00565f))
* **gui:** keep attention recovery above supported inspectors ([950abd4](https://github.com/calebn/sharecut-studio/commit/950abd4b3f4d305d37d286a5fecd7ad18b3b1842))
* **gui:** keep chooser chip drag off Auto precision ([#1184](https://github.com/calebn/sharecut-studio/issues/1184)) ([c58652e](https://github.com/calebn/sharecut-studio/commit/c58652e6084cd0b52156d87e312e6103088655cb))
* **gui:** keep envelope on grammar drag, trim chips on jog ([#1184](https://github.com/calebn/sharecut-studio/issues/1184)) ([0dedb04](https://github.com/calebn/sharecut-studio/commit/0dedb0458b483ef3e4aaecdcc33c0da6b91e3444))
* **gui:** keep expanded attention recovery reachable ([c5c8d2a](https://github.com/calebn/sharecut-studio/commit/c5c8d2a1e56b29638b791a2ae2a88de325a72aa5))
* **gui:** keep fallback menu controls reachable and focused ([8053b01](https://github.com/calebn/sharecut-studio/commit/8053b01451f211814f59048aac0b90cd4ac33897))
* **gui:** keep focus through collapse and reopen, and keep a collapse across a phone-width trip ([#1706](https://github.com/calebn/sharecut-studio/issues/1706)) ([e3b9e6c](https://github.com/calebn/sharecut-studio/commit/e3b9e6c39ab29350a751efaedecbd05c611cc3d3))
* **gui:** keep iPad landscape on tablet shell for tool rail ([a58920a](https://github.com/calebn/sharecut-studio/commit/a58920a8d345d3c9cbf580b822c735aa5ed669f5)), closes [#1632](https://github.com/calebn/sharecut-studio/issues/1632)
* **gui:** keep iPad Pro 11 landscape on the tablet rail and list Select a range with the collapsed tools ([#1674](https://github.com/calebn/sharecut-studio/issues/1674)) ([f41ac3c](https://github.com/calebn/sharecut-studio/commit/f41ac3c36bc103576df7afe9eaec26c12865fde8))
* **gui:** keep pending sheet controls reachable ([2e7cd84](https://github.com/calebn/sharecut-studio/commit/2e7cd84e532180141f3605d5a2840235b8c31994))
* **gui:** keep the edited lane and the point form on screen in a landscape envelope sheet ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([744312f](https://github.com/calebn/sharecut-studio/commit/744312f3c8507bea3d677c2ee063517b9cd2f83c))
* **gui:** keep the edited lane, the form and Done on screen in a short landscape envelope sheet, and the regular form on a tall iPad ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([621d86b](https://github.com/calebn/sharecut-studio/commit/621d86b5304e01595ec454b9ffcc39c23269b7aa))
* **gui:** keep the envelope point draft in the store so rotation does not drop it ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([0a10f4a](https://github.com/calebn/sharecut-studio/commit/0a10f4a2b7f8a372a0fd8abd5320f825a04e798c))
* **gui:** keep the status line under the envelope sheet, and let the marker rows scroll at 914x331 so a touch user reaches the lanes ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([8f438dc](https://github.com/calebn/sharecut-studio/commit/8f438dc3a095e83cc0ac21028b35639a81f359ff))
* **gui:** leave a scrub alone when the playhead sits right of center, and tidy follow docs ([#1707](https://github.com/calebn/sharecut-studio/issues/1707)) ([cc57a24](https://github.com/calebn/sharecut-studio/commit/cc57a2437cbfa5e1c3a01acd329bdb1049bb3eca))
* **gui:** let the bottom panel splitter shrink a short window's default panel ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([66e21e4](https://github.com/calebn/sharecut-studio/commit/66e21e46649de8d93bcce902c64c76d66dd215f2))
* **gui:** limit Auto precision to phone shell ([#1184](https://github.com/calebn/sharecut-studio/issues/1184)) ([4448356](https://github.com/calebn/sharecut-studio/commit/444835626d476e2020807555d643910297706502))
* **gui:** observe the edited lane through the shared resize hook ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([34cc075](https://github.com/calebn/sharecut-studio/commit/34cc07522df800002f9d1b8b526f0a0e37e64aa1))
* **gui:** preserve newest outcome and correct guest retry guidance ([119afa5](https://github.com/calebn/sharecut-studio/commit/119afa56e554c40e36d4f9407339aca0c96a173c))
* **gui:** refit the edited lane a frame after the resize observer reports, and drop the redundant window listener ([#1694](https://github.com/calebn/sharecut-studio/issues/1694)) ([c1d7292](https://github.com/calebn/sharecut-studio/commit/c1d729240cd66302c88fa3a84419645aa3e4a8d5))
* **gui:** satisfy exhaustive-deps on attention announcer ([#1540](https://github.com/calebn/sharecut-studio/issues/1540)). ([597f495](https://github.com/calebn/sharecut-studio/commit/597f495f505e8c78430f05b9479d50b180f217b7))
* **gui:** show cancel on range-armed phone sheet without empty inspector ([606b1fc](https://github.com/calebn/sharecut-studio/commit/606b1fca81052380c134ab3631e9dc9950cc28d5))
* **gui:** wrap compact transport at phone Safari zoom ([309f05d](https://github.com/calebn/sharecut-studio/commit/309f05ddaa661c5246a7ca4181f3443be47ed080))
* **gui:** wrap compact transport on the phone only ([cee3864](https://github.com/calebn/sharecut-studio/commit/cee386498f59808c0cbbd6d283840a7625bbda47))
* **history:** every Undo after Approve all changes the timeline, and Undo waits for a running edit ([#1675](https://github.com/calebn/sharecut-studio/issues/1675)) ([c95ccd0](https://github.com/calebn/sharecut-studio/commit/c95ccd0e609ef8d9b523d56bcb7d6631e66de747))
* **history:** one Undo takes back an Approve all pass that asked Cut anyway ([#1677](https://github.com/calebn/sharecut-studio/issues/1677)) ([647a8f3](https://github.com/calebn/sharecut-studio/commit/647a8f3a5684df122cb64960d762483529c5e5d4))
* **history:** show the refusal toast when a queued toast Undo is refused ([#1690](https://github.com/calebn/sharecut-studio/issues/1690)) ([1ca27d2](https://github.com/calebn/sharecut-studio/commit/1ca27d298c098b22eae69d54d4b8d61c9f0e567e))
* **history:** undo past tip render_preview after approve all ([61dd0ec](https://github.com/calebn/sharecut-studio/commit/61dd0ec6e7e5a3b6118ec2d58a61a524d5bd5a20)), closes [#1629](https://github.com/calebn/sharecut-studio/issues/1629)
* **history:** validate the Approve all pass by identity, and make Redo mirror Undo ([#1677](https://github.com/calebn/sharecut-studio/issues/1677)) ([5df7db6](https://github.com/calebn/sharecut-studio/commit/5df7db6e3dff4a9ba12ef877b4538211fee2c92c))
* **ingest:** read on when the WAV reader clamps a wide VAD block ([#1546](https://github.com/calebn/sharecut-studio/issues/1546)) ([a8221c1](https://github.com/calebn/sharecut-studio/commit/a8221c10b0067b4499932ca630e966249377cad4))
* keep tablet agent range controls in selection sheets ([85c331e](https://github.com/calebn/sharecut-studio/commit/85c331eb3b32b0bd26af0fe7b8eb35c02c68efbc))
* let compact Pending review share the body scroller ([8cd930e](https://github.com/calebn/sharecut-studio/commit/8cd930ebde8cc33bf2e698d2bc9d71f8e1c626bf))
* **levels:** low-pass the timeline window level reads before they downsample ([#1547](https://github.com/calebn/sharecut-studio/issues/1547)) ([9c323b2](https://github.com/calebn/sharecut-studio/commit/9c323b20a55a68e88a023df37210e6ea9a13e35d))
* omit null source from mute archives ([e63189e](https://github.com/calebn/sharecut-studio/commit/e63189ef7d81cd4693cc2e9d137fb4c084123c88))
* **playback:** type missing transport media refusals ([7a18664](https://github.com/calebn/sharecut-studio/commit/7a186641883a8ce6dfa9ba6abc3b528dbab9ccf9))
* **poteto:** collect issue-gate state over REST ([07dd7ea](https://github.com/calebn/sharecut-studio/commit/07dd7ea03abf93b5b60fd816988c418d5f63cfab))
* **poteto:** treat GraphQL 403 by error substring ([ac96d31](https://github.com/calebn/sharecut-studio/commit/ac96d31c575f6b049760de06b8301d34d15ad1d7))
* **poteto:** use GraphQL review threads when available ([df46b1e](https://github.com/calebn/sharecut-studio/commit/df46b1e25a8019e6f70b450d7991c9dc7c33663c))
* preserve borrowed pad identity across cut batches ([3f4ed62](https://github.com/calebn/sharecut-studio/commit/3f4ed6277c921243a905952fec40035b1c73f888))
* preserve envelope preview ownership across repeats ([dadea03](https://github.com/calebn/sharecut-studio/commit/dadea03e8ad5e184303c7ffbdfb2e9462912d535))
* preserve selected join and native pad edges ([004a724](https://github.com/calebn/sharecut-studio/commit/004a72484f5a0971fad7ae84fbecc246fde799f9))
* **progress:** keep nested child fail from closing the parent job ([5a3c5b3](https://github.com/calebn/sharecut-studio/commit/5a3c5b3a67a04751d56a6a79f7b731c3683e09a0))
* **progress:** keep nested fail from closing guest and agent parents ([a5b6280](https://github.com/calebn/sharecut-studio/commit/a5b62803d7e9086087eb85367850ebc6dc80c552))
* reconcile refused and unknown queue outcomes ([190b0c0](https://github.com/calebn/sharecut-studio/commit/190b0c08d51a8b701e26727c28a119b464fe0427))
* **reconcile:** a path the reverse path dwarfs is not a bleed source ([#1495](https://github.com/calebn/sharecut-studio/issues/1495)) ([3d17c16](https://github.com/calebn/sharecut-studio/commit/3d17c168035797f5060ce753e07fa415cf30db1d))
* **reconcile:** annotate short-word RMS as optional for mypy ([#1594](https://github.com/calebn/sharecut-studio/issues/1594)). ([91c47c5](https://github.com/calebn/sharecut-studio/commit/91c47c51b32259599116c78e64f3234dcf872492))
* **reconcile:** compare levels on a voice scale, one fixed offset per track ([#1495](https://github.com/calebn/sharecut-studio/issues/1495)) ([ff9b6a9](https://github.com/calebn/sharecut-studio/commit/ff9b6a9c14ab8cecfc23400c70901f4e68f133cc))
* **reconcile:** compare raw levels, with no balance gain ([#1495](https://github.com/calebn/sharecut-studio/issues/1495)) ([bdeaa42](https://github.com/calebn/sharecut-studio/commit/bdeaa42c9a450aaf9723211c2371b13230be9984))
* **reconcile:** log when a track keeps its effects chain as evidence ([#1495](https://github.com/calebn/sharecut-studio/issues/1495)) ([e122699](https://github.com/calebn/sharecut-studio/commit/e122699cd818f8af2c1f46b8d43489df13726645))
* **reconcile:** measure a lane's lag steps once, also when it has none ([#1685](https://github.com/calebn/sharecut-studio/issues/1685)) ([8eca927](https://github.com/calebn/sharecut-studio/commit/8eca92735d32d3db65a7df3e7e4ae086bca6610a))
* **reconcile:** read bleed sources at per-segment copy lag ([#1333](https://github.com/calebn/sharecut-studio/issues/1333)) ([003a236](https://github.com/calebn/sharecut-studio/commit/003a23615ab3d6069599969abbafdacd903d0748))
* **reconcile:** read evidence before the effects chain ([#1495](https://github.com/calebn/sharecut-studio/issues/1495)) ([3ba4bf1](https://github.com/calebn/sharecut-studio/commit/3ba4bf1d67b0dc404c80d8ea1ccf366a84f8bb79))
* **reconcile:** read short words by loudest frame ([#1594](https://github.com/calebn/sharecut-studio/issues/1594)). ([fe175bb](https://github.com/calebn/sharecut-studio/commit/fe175bba07e1f8bc847f81dd81a90cb5e8309387))
* **reconcile:** set the one-way ratio above any split of the talking, document the voice scale ([#1495](https://github.com/calebn/sharecut-studio/issues/1495)) ([9f4102e](https://github.com/calebn/sharecut-studio/commit/9f4102e533cc50c6ff5788adfce352a8977dab22))
* **release:** bump the project version in uv.lock with the release PR ([aba238f](https://github.com/calebn/sharecut-studio/commit/aba238fda9f08511b1ace9b372bee45148c581fa))
* **release:** keep stapler output off the updater bundle path and let sign=true skip Windows signing ([bb2183e](https://github.com/calebn/sharecut-studio/commit/bb2183e8e8154641b0ac636c267ac29244c1d774))
* **release:** match the Cargo.lock package through release-please's toml wrapper, bound the first release, and refuse Release-As footers ([5a79059](https://github.com/calebn/sharecut-studio/commit/5a79059ba7fcb054f2d699f12138af42bc93a6b6))
* resolve primary recording aliases consistently ([dff96c8](https://github.com/calebn/sharecut-studio/commit/dff96c8d5ffadbf0f8c5948ec7928c3a86b4753e))
* restore dismissed save recovery target ([e56a918](https://github.com/calebn/sharecut-studio/commit/e56a918f0d8320fe368534cbbeebff009b27f64d))
* **speaker:** rebuild leftover split mutes with centred fades ([f768bbb](https://github.com/calebn/sharecut-studio/commit/f768bbb86639c27d6509ae770cb2917c2c05be47))
* **studio:** guard Move to speaker and document the control ([2fb9b22](https://github.com/calebn/sharecut-studio/commit/2fb9b22f7d7469bfc05b63360cfe3add33d2ed3d))
* **tighten:** a peer's room noise under its voice floor is not speech ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)) ([df061ca](https://github.com/calebn/sharecut-studio/commit/df061caefed42f29317825a2e547117711ff00ac))
* **tighten:** compare peer and owner levels as recorded, with no balance gain ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)) ([561b8ea](https://github.com/calebn/sharecut-studio/commit/561b8ea37de5a3600d382338240d0b099a010478))
* **tighten:** fail the word-probe child when weights are missing ([2417440](https://github.com/calebn/sharecut-studio/commit/2417440b99192e42ff96ee9c9c912b29b09642ab))
* **tighten:** keep proposals stable on 16-bit scaled stems ([#1401](https://github.com/calebn/sharecut-studio/issues/1401)) ([fa010f9](https://github.com/calebn/sharecut-studio/commit/fa010f96a7ecc2bdb69a54b439587351f401b596))
* **tighten:** keep quiet contrast mics on path reference ([#1529](https://github.com/calebn/sharecut-studio/issues/1529)). ([b0eeadb](https://github.com/calebn/sharecut-studio/commit/b0eeadb84120d8e84f54f53f59f69c256518685a))
* **tighten:** keep the voice scale to tracks with a voice and a readable file ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)) ([28bbff2](https://github.com/calebn/sharecut-studio/commit/28bbff2469846784594ea0ce32c1d1bc68174fef))
* **tighten:** limit contrast mic residue headroom to 12 dB ([#1529](https://github.com/calebn/sharecut-studio/issues/1529)). ([010a94a](https://github.com/calebn/sharecut-studio/commit/010a94a2f687fbb530fac6ac497947a2561cc25e))
* **tighten:** load level profiles only after voice refs resolve ([#1529](https://github.com/calebn/sharecut-studio/issues/1529)). ([bdc10dd](https://github.com/calebn/sharecut-studio/commit/bdc10ddaf382ee5be7bc7e56c0e7d0a4f450ca5a))
* **tighten:** peer guard voice scale for clip-only parked lanes ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)). ([b614124](https://github.com/calebn/sharecut-studio/commit/b614124044d6a7e79270ef45013470ff02a453e0))
* **tighten:** read the audibility floor only for a peer that has a recording ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)) ([647e931](https://github.com/calebn/sharecut-studio/commit/647e9319c9fbfa1391d04a432163f4a9301528b5))
* **tighten:** read the voice scale only when every compared track has a voice of its own ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)) ([c328121](https://github.com/calebn/sharecut-studio/commit/c32812158470bc44b3d69a9087d6206f6e226553))
* **tighten:** read which mic is louder against each mic's own voice ([#1549](https://github.com/calebn/sharecut-studio/issues/1549)) ([ae2d732](https://github.com/calebn/sharecut-studio/commit/ae2d732305ad50572537f0686b82d52dc9d3bfd3))
* **tighten:** report word-probe progress and contain decode failures ([68995fe](https://github.com/calebn/sharecut-studio/commit/68995fec37ee89478289af0a455a1e5696fa1a1f))
* **timeline:** a clip end still matches a point lookup on an index with repeated segments ([#1620](https://github.com/calebn/sharecut-studio/issues/1620)) ([073822c](https://github.com/calebn/sharecut-studio/commit/073822c518a0ee5f3893eb8a31b4d82894be055b))
* **transcript:** expose source-scoped take word indices ([9ff6ec7](https://github.com/calebn/sharecut-studio/commit/9ff6ec7411d4160aaf4a1d22fcc7cb916e428a40))
* **transcript:** preserve source identity across consumers ([94eec97](https://github.com/calebn/sharecut-studio/commit/94eec97c5fdec3551b09e65e2c3dc5110077bcb4))
* **transcript:** reveal panels before toggling find and replace ([e9472f1](https://github.com/calebn/sharecut-studio/commit/e9472f17dab68caf4f0456be4acbabbe922b0233))
* **transcript:** route multi-take cuts through source-aware ripple ([429eaae](https://github.com/calebn/sharecut-studio/commit/429eaaefd068b28dd298c7b7495ba481cfda64dd))
* **transcript:** type source-aware cut mapping ([8c8b0a7](https://github.com/calebn/sharecut-studio/commit/8c8b0a76dcadbc7e88b135bbd47099fde2ce3566))
* **web:** improve Approve all toast, counts, and shell reload while busy ([#1555](https://github.com/calebn/sharecut-studio/issues/1555)). ([77b6990](https://github.com/calebn/sharecut-studio/commit/77b69908f1accc6946f48922dcb348d4b07ccc7e))
* **web:** include flatline in Icon storybook gallery ([#1138](https://github.com/calebn/sharecut-studio/issues/1138)) ([03f14da](https://github.com/calebn/sharecut-studio/commit/03f14da75cf0a5283e62693c065764ef23b61ec0))
* **web:** keep remounted sheets under later overlays ([2965d46](https://github.com/calebn/sharecut-studio/commit/2965d46d4ce73980186ac8037eb73995297816b8)), closes [#1328](https://github.com/calebn/sharecut-studio/issues/1328)
* **web:** keep sheet Close after deferred envelope entry ([e8b4a90](https://github.com/calebn/sharecut-studio/commit/e8b4a903165bd61bfdbbdd7aa9c3013cc0b61a9f))
* **web:** keep waiver focus across inspector remount ([a4c5e71](https://github.com/calebn/sharecut-studio/commit/a4c5e71f4cf6fffd474c6b554acfab1cc1d3f8e3))
* **web:** let idle fade Escape dismiss the sheet ([d0f577d](https://github.com/calebn/sharecut-studio/commit/d0f577d48e802ea39ff9e60d555c4a01208f0e2c))
* **web:** make transcript word keys collision-free ([2f80eab](https://github.com/calebn/sharecut-studio/commit/2f80eab10b4fd72b9c0726af02363ef9c77e7adf))
* **web:** preserve nullable transcript source identity ([b704d40](https://github.com/calebn/sharecut-studio/commit/b704d4014699342f426109cd07c2b021d4a6af7d))
* **web:** show shell load-failure banner on cold bootstrap timeout ([#1555](https://github.com/calebn/sharecut-studio/issues/1555)). ([21ba7fd](https://github.com/calebn/sharecut-studio/commit/21ba7fdc02c6b440d901cfdeae438111d4333939))
* **web:** wrap find/replace and add-term rows on coarse pointer ([#1433](https://github.com/calebn/sharecut-studio/issues/1433)) ([f9c3e1f](https://github.com/calebn/sharecut-studio/commit/f9c3e1f0f58fc6e6cb2404e3e1e5b08a3289b486))
* **web:** wrap inspector nudge controls on narrow layouts ([dd0954f](https://github.com/calebn/sharecut-studio/commit/dd0954f773a90d8ed0aa1908b652f0563e56f782))


### Performance

* **bleed-gate:** map a plan's spans to the source clock in one indexed pass ([#1620](https://github.com/calebn/sharecut-studio/issues/1620)) ([1c52b66](https://github.com/calebn/sharecut-studio/commit/1c52b6603b18463ec542f51d035299f6dd503c4b))
* **bleed-gate:** read timbre only where level is undecided; skip level compare for identical channels ([#1668](https://github.com/calebn/sharecut-studio/issues/1668)) ([7481a32](https://github.com/calebn/sharecut-studio/commit/7481a32259fdfa8fb1001b975e418aabef262965))
* **fillers:** pass timeline RMS caches through the speech-guard scan ([85c3f08](https://github.com/calebn/sharecut-studio/commit/85c3f089b527d7b49030f0761d9b98e92adf5f31))
* **ingest:** decode the VAD window in blocks, not once per 0.25 s chunk ([#1546](https://github.com/calebn/sharecut-studio/issues/1546)) ([7451443](https://github.com/calebn/sharecut-studio/commit/74514438fad9d85671a3988c54636bb00f8c81b8))
* **media-identity:** reuse recording stats inside a batch scope ([5124bf5](https://github.com/calebn/sharecut-studio/commit/5124bf5e8b2bcb9fe37bf3d906b041980043900d)), closes [#1671](https://github.com/calebn/sharecut-studio/issues/1671)
* share the batch scope with run_parallel workers and the sound-action scan ([#1608](https://github.com/calebn/sharecut-studio/issues/1608)) ([c70ea3c](https://github.com/calebn/sharecut-studio/commit/c70ea3c8248aeedfdf6c10382a657ab0c1ab1939))
