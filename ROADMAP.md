# Roadmap

Future work only — not committed. Remove or move items to issues/PRs when shipped.

**What is implemented today:** host product surfaces are registered in [`contracts/capabilities.manifest.json`](contracts/capabilities.manifest.json) and browsable at [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities). Document commands, share HTTP, and guest MCP have separate generated catalogs (see [docs/entry-points.md](docs/entry-points.md)). Feature behavior lives in `docs/` (e.g. [daw-editing.md](docs/daw-editing.md), [host-online-relay.md](docs/host-online-relay.md)).

**Native iOS/Android + in-app bring-your-own-agent** is deferred long-horizon. Detail and interim architecture rules: [docs/cross-platform-byok.md](docs/cross-platform-byok.md).

---

## Required for beta / customer testing

Solo beta can stay on app version **0.1.0**. These gates must land before wider customer testing with recording and collaboration workflows.

### Recording session

Full-session capture (Riverside/Zencastr-style) — browser + desktop Tauri; iOS/Android native record clients are [Follow-up](#deferred-native-mobile-byok).

**Phasing:** ship **audio** first for beta testers who record video elsewhere; **per-guest video** is phase 2 in the same epic and required for credible “video podcast” positioning (most growth/discovery is video-heavy even when most listening stays audio). Phase 2 is blocked on **video track ingest** (schema + `raw/` registration) so record does not invent a second video model — pull that row forward from [v1 video](#video-podcast-minimum) when implementing.

**Beta recording assumes a host machine.** Testers must be told the host stays online; crash/resume is a gate so a laptop sleep does not silently lose the session. Design: [docs/recording-session.md](docs/recording-session.md).

| Item | Notes |
|------|--------|
| **Recording links** | **Shipped** (`feat/recording-links`): host mints share **kind** `record` (`/rec/{token}`), distinct from review `/r/{token}`. Caps `join` / `monitor` / `comment`. Guest vs producer are two tokens in one room. |
| **Lobby / consent / host transport** | **Shipped** (`feat/recording-lobby-consent`): lobby (name, headphones, mic meter), per-person consent, host Start/Pause/Resume/Stop, REC/PAUSED clock, roster with **Not recorded**, full-room/declined pages, CLI/MCP twins. Host admit / waiting room is [Follow-up](#follow-up). |
| **Full-session audio** | Local dry WAV keepers **shipped** (`feat/recording-keeper-capture`, OPFS). Chunk upload + resume **shipped** (`feat/recording-upload-resume`). Clip-per-segment landing into `raw/` **shipped** (`feat/recording-landing`). Live comments **shipped** (`feat/recording-producer-live-comments`). Lobby already shipped. |
| **Host disconnect / resume** | **Shipped** (`feat/record-host-live-reconnect`): last host Leave stamps `host_offline_since_wall_ms`; Join after ≥ 10 s while REC forces PAUSED (`pause_reason: host_reconnect`); remint refused mid-take; mesh re-offers on peer reconnect. Upload resume on the same `/rec/` token already shipped. Offline copy already shipped with mix-minus. |
| **Full-session video (phase 2)** | Per-guest **local** camera capture (1080p baseline; 4K optional later); camera + mic device selection; separate video files per guest into `raw/` + episode video tracks; survives bad network like audio. Requires video track ingest first. Not optional for video-first ICP — only phased after audio MVP. |
| **Live monitoring / presence** | Roster + REC/PAUSED/clock **shipped** with lobby. Mix-minus mesh **shipped** (`feat/recording-monitor-mixminus`, MM1–MM9). |
| **Clock sync / session timeline** | Happy path **shipped** (`feat/recording-landing`): one clip per segment at `join_offset_ms`, skip `ingest suggest`. Land duration check **shipped** (`feat/record-land-drift`): sample-count vs recording-clock on overlapping file-acked segments; `|drift_ms| > 50 ms` or missing `session_start` sets `align_fallback` as a post-transcribe `align_tracks` hint — land does not run conversation align. GCC-PHAT is shared-source TDOA, not a dry-keeper clock meter ([docs/multitrack-ingest.md](docs/multitrack-ingest.md)). Bars: [recording-session.md § Test contract](docs/recording-session.md#test-contract). |
| **Room-tone at record time** | **Shipped** (`feat/record-room-tone-bed`): optional 3 s quiet bed in the lobby (keeper constraints, skippable); lands as `track.room_tone` / `raw/room-tone/{participant}.wav`; `filler_pad_mode: room_tone` prefers the bed over stolen air. Default pad mode stays silence. Pair with **Find room-tone candidates** (Follow-up) as offline fallback. |
| **Mic + camera permission for record surfaces** | **Mic grant shipped** (`feat/record-mic-grant`): explicit Allow microphone in the web lobby; Tauri Info.plist + loopback-origin WebView handler. Camera chrome ships with [full-session video](#recording-session). Full WebView deny-by-default packaging policy is [v1](#packaging-trust). Native cpal/coreaudio capture is [Follow-up](#follow-up). |
| **External recorder import (interim ICP)** | **Shipped** (`feat/ingest-import-external`): generic audio folder → `ingest.yaml` via `podcast ingest import` / `ingest_import_folder_tool`. Does not copy audio or mint `record` URLs. Vendor-specific Zoom/Riverside/Zencastr/SquadCast layouts and video stay [v1](#video-podcast-minimum). |

### Packaging / installs (tester residuals)

Beta testers include **Intel Macs** and **Windows** — do not treat `mac-x64` or a signed NSIS installer as optional. Loopback squat ownership (exclusive bind, boot-token health, WebView allowlist) is required before sharing installers beyond solo dogfood; remaining public-customer trust work (client auth, deny-by-default WebView permissions, updater) stays [v1](#packaging--trust). Spec: [docs/desktop-packaging.md](docs/desktop-packaging.md).

| Item | Notes |
|------|--------|
| **Intel Mac (mac-x64) installer** | The reusable desktop build supports Intel installer artifacts. Signing and distribution are operated privately. |
| **Installer distribution** | Public builds provide reusable installer artifacts; publishing, hosting, manifests, and release operations live in the private operations repository. |
| **Loopback squat / installer hardening** | **Shipped in code** — exclusive bind, boot-token health, WebView allowlist (`gui/bind.py`, `gui/desktop` sidecar). Packaged client auth, deny-by-default WebView permissions, and updater remain v1. |
| **Standalone app packaging (finish)** | Tauri shell + first-run bootstrap shipped; **CDN client wired** for FFmpeg/RNNoise when `PODCAST_BOOTSTRAP_CDN_BASE` is set ([`util/asset_sources.py`](src/podcast_mcp/util/asset_sources.py)). Releases mirror blobs and pin SHAs. |
| **Apple notarization + Developer ID** | **Hooks shipped** (`release-desktop-build.yml` `workflow_call`, Environment `desktop-signing` when `sign=true`). Remaining owner-only: attach Developer ID + App Store Connect secrets and dispatch with **sign**. Associated Domains entitlement + Mac App Store still deferred. Pair with Windows Authenticode. |
| **Windows Authenticode** | **Hooks shipped** (`signtool` on sidecar `.exe` before `tauri build`, NSIS `*_x64-setup.exe` after). Remaining owner-only: attach PFX to Environment `desktop-signing`. Gate for Windows beta: unsigned setups hit SmartScreen / unknown publisher. EV preferred so reputation accrues faster; OV is OK if testers can click through during warmup. |
| **Public source boundary** | Keep provider source, secrets, and deployment operations outside the public DAW repository. See [docs/extension-seams.md](docs/extension-seams.md). |

### Progress UX

| Item | Notes |
|------|--------|
| **MCP host progress notifications** | Cursor and other MCP clients receive `notifications/progress` (headline, optional units, fail/cancel). Polish + host UI verification still open. |
| **Sharecut Studio fan-in of MCP/CLI jobs** | **Shipped (in-process):** host `/mcp` wrap-level long work lazily creates `kind=agent` jobs on the Studio job/SSE plane (StatusBar / phone chip). Instant tools do not flash a chip; agent jobs do not take the pipeline lock. **Remaining:** cross-process `podcast` CLI adopt (separate process; needs a `sync.db` jobs table). |
| **Sharecut Studio stale progress heartbeat** | **Shipped:** job snapshots carry `last_progress_at` (domain events + 5s mixin heartbeat; SSE 1s keepalive does not bump). StatusBar / Pipeline tab / phone chip show “last update Ns ago” after 15s with pulse + elapsed companion — no fake moving bar. |
| **Sharecut Studio non-pipeline long work** | **Shipped:** bounce and mastered export run on the Studio job/SSE plane (`kind=bounce` / `kind=export`; `{job_id}` + terminal `result.paths`). StatusBar uses **Activity** copy for non-pipeline kinds; Pipeline tab stays pipeline-only. MCP wrap-level work is `kind=agent`. **Remaining:** activity-history drawer. |
| **Guest / remote MCP progress display** | **Shipped:** guest tool wraps compose MCP `notifications/progress` over Streamable HTTP SSE when `progressToken` is set (JSON otherwise), plus a token-keyed `plane: "progress"` WS sink. ReviewApp shows the Activity chip (`/progress/ws`, no `view` required) with a live region that omits elapsed ticks; Studio share mode reuses `daw/ws` (phone guests see the chip). Host jobs and other tokens never fan in; payloads have no host paths. **Remaining:** Cursor UI fixtures for MCP notifications. |

### Filler / tighten (beta gate)

**Status:** pipeline auto-tighten is **off** (`tighten.enabled: false`). Manual `propose-edits` / `apply-edits` exists but join quality and selection failed real episodes (see [docs/filler-cut-quality.md](docs/filler-cut-quality.md)). **Not beta-ready** until the re-enable bar below is met **and** review UX ships.

**Scope vs video:** beta tighten marketing is **audio-first**. Ripple cuts on video-linked timelines wait for [v1 video edit parity](#video-podcast-minimum) **or** mute-in-place (keep timeline length). Do not advertise Descript-style video-locked filler removal until one of those lands.

**What competitors ship that we lack or under-deliver:**

| Gap | Typical product behavior | Sharecut today |
|-----|--------------------------|----------------|
| **Sounds good out of the box** | One-click remove fillers/pauses; listeners accept result | Deep join stack exists but splices often click/hollow; default off |
| **Review before apply** | Per-hit list, preview audio, skip/apply one, “avoid harsh cuts” ([Descript](https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words)) | MCP/CLI decisions; listen-first for NL pending, not a dedicated tighten review loop in GUI |
| **Gap shortening UX** | “Gaps over N ms → target M ms”, shorten all with per-gap audition ([Descript word gaps](https://help.descript.com/hc/en-us/articles/10164807277453-Shorten-word-gaps)) | `shorten_gaps_tool` / YAML knobs; no guided GUI wizard |
| **Mute vs cut** | Silence filler in place to preserve timing / video sync ([Cleanvoice `muted`](https://docs.cleanvoice.ai/docs/v2/rest/configuration)) | `tighten.edit_mode: mute` writes `Clip.mute_regions` (pauses skipped); default remains ripple + optional pad |
| **Non-lexical edits** | Stutters, hesitations, mouth sounds, breath as separate toggles (Cleanvoice API) | Breath co-removal partial; no stutter/false-start class; hesitations = ASR tokens only |
| **Discourse-safe “like”** | Contextual or conservative on discourse markers | Adjacent-token phrase matching demotes like / you know / sort of / kind of; fluent uses counted as `discourse:{token}` skips; pause/confidence remain escape hatches |
| **Audio-aware gaps** | Silence from waveform/VAD, not transcript holes only (common Descript user request) | Transcript gap + energy heuristics; Silero on breath only |

**Re-enable bar** (must pass before `tighten.enabled: true` or beta marketing):

1. Join continuity — blind A/B prefer edit vs leave-in ≥90% on gated cuts; zero leftover-consonant fails ([docs/filler-cut-quality.md](docs/filler-cut-quality.md) § Default pipeline status).
2. Selection — discourse `like` excluded or rare on like-heavy fixture.
3. Density — episode does not feel edited every breath.

| Item | Notes |
|------|--------|
| **Join continuity refinement** | Finish tuning Layer 1–5 stack + `join_continuity_gate` on real multitrack fixtures (Shot of Truth, `aligned_dialogue`); automated `join_qa_sweep` in CI as regression gate. |
| **Discourse-aware filler selection** | **Shipped** (`feat/tighten-discourse-safe-like`): demote `discourse_markers` (still in the lexicon) unless **adjacent** to a true disfluency / immediate repeat, pause-bounded, or low ASR confidence. Multi-word markers match split ASR tokens. Pause/confidence remain escape hatches (can still cut some fluent `like`). Skip counts `discourse:{token}` include isolated cluster-size rejects. Re-enable still waits on join quality, a like-heavy fixture, and density. |
| **Hesitation + stutter detection** | Beyond ASR token list: repeated fragments, non-word hesitations, optional audio classifier (VAD / small model) — parity with Cleanvoice `hesitations` / `stutters`. |
| **Mute-in-place tighten mode** | **Shipped** (`feat/tighten-mute-in-place`): `tighten.edit_mode: mute` proposes `MUTE` filler hits (pauses skipped), apply writes `Clip.mute_regions`, render silences with ≤5 ms fades. Default remains `ripple`. |
| **Tighten review UI (GUI)** | **Shipped** (`feat/tighten-review-panel`): host Tighten tab lists pending `filler:`/`pause:` hits with search/filters, listen-first preview, skip/apply one, apply-all with avoid harsh cuts (one `ApproveEdits` batch). |
| **Gap-shortening wizard** | GUI for `shorten_gaps` / pause policy: thresholds (gap over X → retain Y), per-gap audition, shorten-all with skip list — Descript-style without burning agent turns. |
| **Silero VAD on pause-floor logic** | Apply same VAD used for breath to pause-floor in `edits/fillers.py` (today `heuristic` default). |
| **Golden-ear QA harness** | **Shipped** (`feat/tighten-golden-ear-harness`): `make golden-ear ARGS='build …'` / `score` writes blinded leave-in vs edit WAVs under `listen/` + scores prefer-edit / leftover-consonant against bar (1). Owner still runs it on Shot of Truth before re-enable. |
| **Agent tighten skill polish** | Docs for propose → review (`list_edit_decisions_tool` + `play_pending_preview_tool` or Sharecut Studio Tighten tab) → approve per hit / apply only after sign-off. Pipeline auto-tighten stays off until golden-ear bar (1). |

### Document sync / DAW correctness

From [PR #73](https://github.com/calebn/sharecut-studio/pull/73) — projection work too large for that change.

| Item | Notes |
|------|--------|
| **Extract `ViewProjection` type under services** | Enum + `parse_view_projection` live in `services/document_sync/projection_types.py` ([PR #125](https://github.com/calebn/sharecut-studio/pull/125)). `dump_project_projection` stays in `gui/assembler.py` by design (ProjectView seam). Remaining services→gui imports (peaks/audio/mapper/jobs) are a follow-up. [PR #73 comment](https://github.com/calebn/sharecut-studio/pull/73#discussion_r3943220105). |

### Collaboration maintenance

| Item | Notes |
|------|--------|
| **Share agent = share user (HTTP first)** | Maintenance. HTTP/MCP/WS parity CI (`check_share_http_mcp_parity`) covers `/api/review/` and `/api/rec/` including WebSockets. Remaining: bugs (GUI missing HTTP twin) vs non-goals (`http-only:` peaks/proxy/review WS). Record MCP twins remain a product decision (not a missing-twin bug). See [docs/host-online-relay.md](docs/host-online-relay.md) § Remote MCP. |

### Beta tester ops

Not product features — still gates **wider** customer testing (solo dogfood can skip).

| Item | Notes |
|------|--------|
| **Privacy + crash telemetry decision** | **Shipped** — no telemetry or automatic crash reports; audio stays local unless a share is minted, and share media may transit while active. Opt-in GitHub App filing after the repo is public is [Follow-up](#follow-up). |
| **Support path** | **Shipped** — [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml), [issue chooser](.github/ISSUE_TEMPLATE/config.yml), diagnostics bundle via Home → Help / `podcast doctor --bundle`. Expected host-online hours for recording still TBD. |

---

## Required for v1 release

Must land before non-beta packaged customers. Solo beta can ship without these.

### Packaging / trust

| Item | Notes |
|------|--------|
| **Packaged GUI client auth** | Cookie or header on mutating host APIs + `Sec-Fetch-Site` checks. Boot token stays **health-only** (do not require on `/mcp` or all POSTs). Pin sidecar CSP `connect-src` to discovered engine port. |
| **WebView permission deny-by-default** | Camera, microphone, geolocation, notifications, etc. deny unless explicitly granted. |
| **Tauri updater** | Signed `latest.json` for auto-update. Keep provider-specific defaults outside the FOSS share-mint path ([docs/extension-seams.md](docs/extension-seams.md)). |

Later (not blocking v1): loopback TLS, custom `asset:` protocol rewrite, parent listen-fd instead of listen file.

### Product polish

| Item | Notes |
|------|--------|
| **Relay-owned share registry** | Claim API + named Docker volume on DO relay when multi-host minting is real. [docs/share-tokens.md](docs/share-tokens.md), [docs/persistence.md](docs/persistence.md). |
| **Hard `progress-check` gate** | Flip `PODCAST_PROGRESS_COMPLIANCE` default to `error` after approving `contracts/progress-exemptions.json`. |
| **MCP tool profiles** | Named registration profiles (`edit`, `transcript`, `review`, `pipeline`, `full`) for LLM tool-count caps. Unblocks in-app BYOK ([docs/cross-platform-byok.md](docs/cross-platform-byok.md)). |
| **ID3 CHAP embedding** | Chapters export as JSON sidecar today; native MP3 chapter frames TBD. |
| **Show notes suggest skill / tool** | Agent proposes show-note bullets from transcript; surface explicit “link in the notes” callouts. |

### Video podcast (minimum)

Required for v1 credibility with video-first creators — not just audio post.

**Table stakes:** **Horizontal and vertical MP4 export** everywhere video is supported — not audio-only sidecars. One shared aspect-preset + reframe + caption render path for long-form masters, **approved `SocialClipCandidate` exports**, and any clip cut from the episode timeline. Presets at minimum: **16:9** (YouTube/web), **9:16** (TikTok/Reels/Shorts), **1:1** (cross-post); same pipeline for every deliverable, not separate “social-only” vs “episode-only” forks.

| Item | Notes |
|------|--------|
| **Video track ingest** | Register camera / program video alongside dialogue in the episode project (local files or session upload). **Prerequisite for recording phase 2** — implement with that epic, not as a second model later. |
| **Vendor recorder layouts + video import** | Parse Zoom/Riverside/Zencastr/SquadCast export folders (including video) instead of the generic per-speaker audio importer. |
| **Aspect-preset MP4 export** | Export edited video at **16:9, 9:16, and 1:1** (and source aspect when no reframe needed) from timeline ranges or `SocialClipCandidate`. Long-form episode master + social clips use the same graph; audio-only RSS export remains separate. |
| **Video edit parity** | Transcript cuts, tighten, and timeline edits drive linked video (same `SessionTimeline` clock as audio); no “audio edited, video stale” drift. Required before advertising tighten on video-linked episodes (unless mute-in-place is the only tighten mode). |
| **Program / speaker preview** | In-DAW playback of video-linked timeline (proxy acceptable); required to validate multicam and export before ship. |

---

## Follow-up

### DAW / collab polish

| Item | Notes |
|------|--------|
| **Host admit / waiting room** | Optional host approval before a `/rec/` guest enters the lobby (Riverside waiting room). Today anyone with the link joins. Spec stays in [recording-session.md](docs/recording-session.md). |
| **Producer push-to-talk (`talk`)** | Silent producer MVP shipped (recvonly, no `getUserMedia`, MM9). Heard-by-room when the producer holds talk (Descript PTT). New `talk` cap; not a beta gate. Spec: [recording-session.md](docs/recording-session.md) § Roles. |
| **Producer `control`** | Start/stop/pause from a producer token. Host already owns transport. New `control` cap. Spec: [recording-session.md](docs/recording-session.md) § Roles. |
| **Room text chat** | Live comments are timeline notes, not a chat channel. Riverside Audience-style room chat stays follow-up. Spec: [recording-session.md](docs/recording-session.md). |
| **Tauri native mic (cpal)** | Host-as-talent uses the browser Worklet in the webview. Native cpal/coreaudio capture is deferred. Distinct from beta [mic + camera grant UX](#recording-session). Spec: [recording-session.md](docs/recording-session.md) § Platform support. |
| **Restricted record shares** | Record rooms are link-access only (`require_sign_in` rejected). Any account-based record policy belongs to an independently installed provider. Distinct from review Restricted shares. |
| **Record mesh STUN/TURN + SFU media authz** | Default ICE is Google public STUN. Configurable/self-hosted STUN or TURN, and server-side producer no-send (SFU), stay follow-up. |
| **Revoke cuts in-flight share media** | Revoke today 404s new guest requests; in-flight tunnel bytes, keeper uploads, and WebRTC media may continue until connections drop. Fail-closed revoke (drop proxy/WS/upload mid-stream) stays follow-up. |
| **Remote multi-user DAW host — polish** | Tight Web Audio clock sync; leader-initiated spotlight / bring-everyone-to-me; hide-cursor. Follow mode / presence UI exists (loose sync; tab-as-person until accounts). [docs/host-online-relay.md](docs/host-online-relay.md). |
| **Proxy envelope automation playback** | Guest Web Audio scheduler does not apply automation envelopes (known approximation). |
| **Proxy Opus upgrade** | Prefer Opus when Safari decode strategy exists; today MP3 for universal `decodeAudioData`. |
| **Host-mode proxy transport** | Optional host Sharecut Studio use of guest proxy scheduler. |
| **Agent audio-context extras** | Kitchen-sink payload, extra MOS, share-guest compose/context parity, stacked mix PNGs — only if a workflow needs them. |
| **Transcript select → suggest-cut / listen-first** | From Select-mode word range: propose pending cut with audition, bulk suggest-delete, or agent “cut this tangent”. |
| **Paste to target track / remap lanes** | Opt-in remapping when pasting; Mod+V stays same-track. |
| **Multi-clip clipboard stacks** | Clipboard history / paste-to-click-on-lane. |
| **Alternate takes / comping** | Per-track take lanes when a guest re-records a section. |
| **Music-bed ducking + minimal buses** | Dialogue→music auto-duck + thin bus model. |
| **Freeze / commit processed stems** | Hash-invalidated FX freeze for faster play/share. |
| **Named work regions** | Named timeline regions for agent/edit scopes + optional share deep-links. |
| **Theme-token blade/comment cursors** | Per-theme cursor assets (CSS `url()` cannot read variables). |
| **Pending inspector leftovers ([PR #174](https://github.com/calebn/sharecut-studio/pull/174))** | Pin/scroll shipped; still open: (1) mutation error is React state — StudioShell ↔ tablet/phone remount drops it (tests re-click Approve after resize); persist on the document/session plane. (2) Original overlap report was Firefox @ 1280; `frontend-e2e` is Chromium only. (3) `useProjectMutation.run` can start overlapping Approve calls before `busy` disables the button (pre-existing TOCTOU). |
| **Background waveform peaks** | Full job/SSE fan-in, cancel, streamed decode for hour-long ingest. |
| **Large-project performance ([#29](https://github.com/calebn/sharecut-studio/issues/29))** | Opt-in benchmark shipped ([docs/testing.md](docs/testing.md) § Large-project browser profile). Still open: timeline clip and transcript virtualization (the two-hour fixture renders ~81k DOM nodes), a many-entry history profile, and long-duration memory tracking. |
| **Edit preference learning** | Persist reject/approve/undo as preference events for join ranker priors. |
| **Room-tone pad from matched air** | Score quiet non-speech spans for `filler_pad_mode: room_tone`. |
| **Find room-tone candidates tool** | MCP/CLI scan for suitable room-tone segments. |
| **Recording MOS / audio_audit** | FOSS MOS-prediction to flag bad recordings (distinct from joinqc NISQA). |
| **True de-click / de-reverb** | iZotope-class; not in FFmpeg today. |
| **MCP SDK Streamable HTTP + OAuth for remote MCP** | Only if replacing custom JSON-RPC guest bridge. ACL stays share caps — not MCP OAuth. |
| **Destructive-tool policy hardening** | Beyond current guest allowlists. [docs/host-online-relay.md](docs/host-online-relay.md). |
| **Opt-in diagnostics filing** | Help / `podcast doctor --bundle` may offer an explicit action to open a GitHub issue with the sanitized bundle. No crash-time upload. |

### Multitrack ingest

| Item | Notes |
|------|--------|
| **Fail loud on missing anchor phrase** | `ingest suggest` / anchor path errors when phrase not found. |
| **Ingest manifest from project** | Generate or round-trip `ingest.yaml` from `meta.ingest_alignment`. |

### Video — social repurposing

Audio-only `export_social_clips_tool` (WAV + JSON) is **not** market-complete. **Horizontal + vertical MP4** at standard presets is table stakes — see [v1 § Aspect-preset MP4 export](#video-podcast-minimum). This section adds caption, reframe, and brand polish on top of that shared pipeline (all orientations). Depends on [v1 video podcast minimum](#video-podcast-minimum) for source video. Details: [docs/social-clips.md](docs/social-clips.md).

| Item | Notes |
|------|--------|
| **Burned-in captions** | Word-timed subtitles from transcript excerpt / caption fields; animated or highlighted words where platforms expect them. Applies to **every** video export preset (16:9, 9:16, 1:1). |
| **Active speaker / multicam reframe** | Crop or cut to whoever is talking (diarization + optional face boxes → render graph; FFmpeg executes, logic is ours). Required when reframing between orientations (e.g. horizontal source → 9:16 clip) and for multicam layouts at any aspect. |
| **Brand template** | Fonts, colors, logo safe zones on clip exports. |
| **Clip discovery polish** | Better hooks / platform length presets on top of existing `propose_social_clips_tool` heuristics. |

### Onboarding & tutorial

| Item | Notes |
|------|--------|
| **Tutorial podcast (learn-by-doing)** | Committed **multitrack** episode fixture: dialogue on the timeline teaches Sharecut as you listen — open the project, audition a line, cut by transcript, tighten a filler, bounce a stem, mint a review share, try an MCP/agent workflow. Chapter markers or timeline comments can cue “pause and do this now.” Ship when ready (not a beta/v1 gate): first-run “Open tutorial,” Home sample project, desktop bootstrap bundle, and/or public review link. Complements static [ux pack](ux/README.md) and screenshot fixture [`sharecut_ux_demo`](tests/fixtures/sharecut_ux_demo/); detail TBD in [docs/fixture-catalog.md](docs/fixture-catalog.md) when authored. |

### DevEx / agent

| Item | Notes |
|------|--------|
| **`podcast fixture sandbox`** | Copy fixture into `$TMPDIR`, fix `workspace_dir`, optional `--seed-transcript`, print `PODCAST_PROJECT=…`. |
| **Fixture write guard** | `ProjectStore.commit` refuses `tests/fixtures/` unless `PODCAST_ALLOW_FIXTURE_WRITE=1`. |
| **`PODCAST_PROJECT` env default** | CLI resolves `--project` from env when omitted. |
| **Pipeline step plugins** | Custom steps on Extensions SPI (not hardcoded `_STEP_MAP`). [docs/extensions.md](docs/extensions.md). |
| **Limited host agents** | Restricted host-agent profiles beyond MCP tool profiles. Guest stays share-cap scoped. |

### Engineering health

| Item | Notes |
|------|--------|
| **Adapter/facade decomposition** | Split `services/edit.py`, `mcp/tools/timeline.py`, `services/play.py`, `gui/web/src/api.ts`; drop `mcp/server.py` test re-exports. |
| **Coverage-boost cleanup** | Fold `tests/test_coverage_boost*.py` into feature-focused modules. |
| **Doc staleness sweep** | Opportunistic fixes as docs are touched. |
| **E2e on nightly** | Schedule `make e2e-slow` / `make e2e-real` for HF ASR and AMI/benchmark. |
| **Larger optional fixture** | Local-only long-form audio; [docs/e2e-real-data-plan.md](docs/e2e-real-data-plan.md). |

### Deferred (native mobile + BYOK)

| Item | Notes |
|------|--------|
| **Native mobile + BYOK in-app agent** | Same React Sharecut Studio + episode v2; phones use in-process libav + platform playback/ASR; user supplies model key. Follow [docs/cross-platform-byok.md](docs/cross-platform-byok.md) § Interim. |
| **iOS/Android native record clients** | After desktop + browser recording session ships. |
