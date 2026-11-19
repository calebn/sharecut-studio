# 2576e implement r11

Tests and docs only. No app code.

- `system.spec.ts`: new short-frame test. A host (followerrstale) and a guest (guesterr) in an Audio error, phone shell, folded: the Audio error pill, Retry and the guest's Comment are visible and named; the host has no Comment; off the phone shell the guest's Comment is gone.
- Mutation: added `.sys-pill--danger`, `.sys-player-retry` and `.sys-player-comment` to the short-frame `display: none` rule in a scratch Storybook build. The new test failed at the pill (`Expected: visible, Received: hidden`). The rule was reverted; `system.css` is unchanged in the commit.
- The names test is split: Following + Updating mix + cuts + status (followmixstale), and the rate (ratemixstale). No Following + rate pair.
- Docs (`CHANGELOG.md`, `docs/gui-mobile.md`): a guest's Comment is `display: none` at level 8 and in a short frame off the phone shell; the Stop following tap area passes the bar's right edge by 3 px (150%) and 6 px (200%), clipped by `.stage-frame` (`overflow: hidden`).
- Measured on a scratch build, fine and coarse, bar 600 to 900 px at 150% text and 800 to 900 px at 200%: tap area (`--touch-min` square centred on the X) minus the bar's right edge = 3 px and 6 px; 0 or inside at 100%; top and bottom stay inside at every size. Narrower widths hide the pill.
- Gates: vitest src/system 2610 passed; tsc -b, biome check, stylelint, oxlint (warnings only, as before), check_terminology, check_level_literals, docs_sync clean; Storybook `System/Player` specs 24 passed.
