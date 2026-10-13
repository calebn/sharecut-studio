# Roadmap

Future work only. Shipped work lives in the code and in `docs/`; remove a row when it ships.

Implemented host surfaces are registered in [`contracts/capabilities.manifest.json`](contracts/capabilities.manifest.json) and browsable at [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities). Document commands, share HTTP, and guest MCP have separate generated catalogs (see [docs/entry-points.md](docs/entry-points.md)).

---

## Beta

The beta scope, the nine journeys with their bars and proof, the bug bar, the exit criteria, the release candidate date, and the rules for picking and filing work are in [docs/beta-plan.md](docs/beta-plan.md). Labels on GitHub (`beta:blocker`, `beta:quality`, `post-beta`, `journey:J1` to `journey:J9`) are the live list. Do not track beta work here.

---

## Required for v1 release

Must land before non-beta packaged customers. The beta can ship without these.

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
| **Chapter MP3 export** | Chapters export as a JSON sidecar today. v1 adds an MP3 preset with native ID3 CHAP frames. |
| **Relay-owned share registry** | Claim API + named Docker volume on DO relay when multi-host minting is real. [docs/share-tokens.md](docs/share-tokens.md), [docs/persistence.md](docs/persistence.md). |
| **Hard `progress-check` gate** | Flip `PODCAST_PROGRESS_COMPLIANCE` default to `error` after approving `contracts/progress-exemptions.json`. |
| **MCP tool profiles** | Named registration profiles (`edit`, `transcript`, `review`, `pipeline`, `full`) for LLM tool-count caps. Unblocks in-app BYOK ([docs/cross-platform-byok.md](docs/cross-platform-byok.md)). |
| **Show notes suggest skill / tool** | Agent proposes show-note bullets from transcript; surface explicit "link in the notes" callouts. |
| **Multilingual transcription** | [#18](https://github.com/calebn/sharecut-studio/issues/18). |
| **Legacy MCP cancellation** | [#151](https://github.com/calebn/sharecut-studio/issues/151). |

---

## Video milestone

A separate product from the audio beta. It is required for credibility with video-first creators, and no beta journey needs it.

**Table stakes:** horizontal and vertical MP4 export everywhere video is supported. One shared aspect-preset, reframe, and caption render path serves long-form masters, approved `SocialClipCandidate` exports, and any clip cut from the episode timeline. Presets at minimum are **16:9**, **9:16**, and **1:1**.

| Item | Notes |
|------|--------|
| **Video track ingest** | Register camera / program video alongside dialogue in the episode project. Prerequisite for per-guest video recording and every row below. |
| **Per-guest video recording** | Per-guest local camera capture, separate video files per guest into `raw/` as episode video tracks, surviving a bad network like audio. Spec: [docs/recording-session.md](docs/recording-session.md). |
| **Vendor recorder layouts + video import** | Parse Zoom/Riverside/Zencastr/SquadCast export folders, including video, instead of the generic per-speaker audio importer. |
| **Aspect-preset MP4 export** | Export edited video at 16:9, 9:16, and 1:1 (and source aspect when no reframe is needed) from timeline ranges or `SocialClipCandidate`. Audio-only RSS export stays separate. |
| **Video edit parity** | Transcript cuts, tighten, and timeline edits drive linked video on the same `SessionTimeline` clock as audio. Required before advertising tighten on video-linked episodes, unless mute-in-place is the only tighten mode. |
| **Program / speaker preview** | In-DAW playback of the video-linked timeline (proxy acceptable), to validate multicam and export. |
| **Burned-in captions** | Word-timed subtitles from transcript excerpt or caption fields, on every video preset. |
| **Active speaker / multicam reframe** | Crop or cut to whoever is talking. Required when reframing between orientations and for multicam layouts. |
| **Brand template and clip discovery polish** | Fonts, colors, and logo safe zones on clip exports; better hooks and platform length presets. Details: [docs/social-clips.md](docs/social-clips.md). |

---

## After the beta

Issues for post-beta work live on GitHub under the `post-beta` label. Add new ideas there, not here. The beta plan lists what is [not in the beta](docs/beta-plan.md#not-in-beta). Those topics and their remaining detail live in the docs that govern them, such as [docs/filler-cut-quality.md](docs/filler-cut-quality.md) for word, pause, and repetition auto-tighten (`tighten.enabled` stays false until its bar is met).

**Native iOS/Android + in-app bring-your-own-agent** is deferred and long-horizon. Detail and interim architecture rules: [docs/cross-platform-byok.md](docs/cross-platform-byok.md). Native record clients follow the desktop and browser recording session.
