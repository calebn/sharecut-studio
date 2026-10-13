# Beta plan

This is the scope of the beta, the bar each journey must reach, and the rules
that decide which work agents start. The owner approved it on 2026-10-13.
Read it before you choose work. Labels on GitHub are the live source of truth
for what is open. Lists of issue numbers on this page are snapshots dated
2026-10-13.

A beta user is a podcast host editing a remote or in-person conversation, plus
the guests and producers the host invites. The beta is finished when that user
can complete each journey below to its bar, on the named shells, with the named
proof. Work that no journey needs is post-beta.

## Where the plan lives

| Thing | Where |
| --- | --- |
| Scope, bars, rules | This page |
| What is open and how bad | Issue labels `beta:blocker`, `beta:quality`, `post-beta` |
| Which journey an issue serves | Labels `journey:J1` to `journey:J9` |
| Which root cause an issue belongs to | Labels `cause:*`, and the `epic` issue for that cause |
| Beta milestone | [Beta](https://github.com/calebn/sharecut-studio/milestone/1) |
| Release candidate date | Phases, below |
| Later product work | [ROADMAP.md](../ROADMAP.md) |

## Journeys

Shells are the desktop app (Tauri on macOS, plus Windows for J9), the desktop
browser (Chromium and WebKit), the tablet (iPad Safari) and the phone (iPhone
Safari). The lab tape is the private multitrack recording with real bleed and
gating, run with and without the forced word aligner. The holdout is one
independent, commercially usable multitrack recording (#1273). The simulator is
the local iOS Simulator. A device run is the owner's physical phone or iPad,
used where feel matters. Device and listening runs are tracked in #960.

| Id | Journey | Pass bar | Shells | Proof |
| --- | --- | --- | --- | --- |
| J1 | Remote multitrack to a mastered episode | Export QC passes at the target loudness. No other speaker is audible as an echo, and no speaker's own words are removed. The result is the same with one mic 24 dB quieter. | Desktop app, desktop browser, agent over MCP | Lab before and after, the same run on the holdout, a gain-scaled lab run at -12 and -24 dB, owner listening to the master |
| J2 | One room recording split by speaker | The split is one undo step. A misattributed reply can be fixed without redoing the split. | Desktop app, desktop browser, tablet | Lab mixdown split, Vitest and axe on the dialog |
| J3 | Live record room to saved tracks | Every consented guest's audio lands, with no lost segment after a network drop. "Saved to project" appears only when the project has registered the audio. | Desktop app as host, desktop browser and phone as guests | Record e2e specs, one real two-device session on the public relay, a listen to the landed audio |
| J4 | Edit on desktop | Every change is one undo step with a visible way back. No error is a dead end. The editor shows whether the project is saved (#1448). | Desktop app, Chromium, WebKit | E2e suites, one scripted edit pass on the lab project that is saved, reloaded and undone |
| J5 | Tighten with review | Laughs are kept or lowered. No real word is cut by default. A cut over another speaker ripples every dialogue track and is counted. The whole pass is one undo, and any one action can change later. | Desktop app, tablet, phone sheet | Lab proposal counts by action, the owner's ruled clips, the holdout run, owner listening |
| J6 | Edit on phone and tablet | Every touch action has a visible equivalent. Targets are 44 px or follow the dense-target pattern. Nothing sits behind a scrim or an inner scroller. | iPhone and iPad, both orientations | Simulator runs on iPhone 15 Pro, iPhone SE and iPad Pro 11-inch, one owner device session |
| J7 | Guest reviews by link on a phone | The first comment posts within five minutes. Guest identity survives reconnects. An offline host shows the offline page. | Phone and desktop browser as guest, desktop app as host | Simulator through the public relay, one owner device session of at least ten minutes, guest-journey e2e specs |
| J8 | An agent edits while the host watches | Agent jobs show in Activity. Agent edits arrive as pending proposals. The selection the host adopts is the one shown. | Desktop app plus an MCP client | MCP tool tests, one scripted agent session on the lab project |
| J9 | Install and first run | Signed installers for macOS (both chips) and Windows. First run fetches its assets with no terminal. | Desktop app | Fresh-machine installs per platform, recorded in the private release record (#962) |

Chapter-bearing MP3 export is v1, not beta. No journey needs it.

### Current blockers and quality items

Snapshot of 2026-10-13. Run `gh issue list --label beta:blocker` and
`--label beta:quality`, optionally with `--label journey:J5`, for the live set.

| Journey | `beta:blocker` | `beta:quality` |
| --- | --- | --- |
| J1 | #960, #1273, #1374, #1376, #1443 | #1131, #1333, #1377 |
| J2 | none | #1318, #1319, #1329, #1341 |
| J3 | #960 (proof not yet run) | none |
| J4 | none | #1138, #1314, #1325, #1326, #1328, #1391, #1444, #1448 |
| J5 | #1062, #1273, #1407, #1419, #1434, #1443 | #1079, #1357, #1365, #1401, #1403 |
| J6 | #960 | #1056, #1138, #1184, #1320, #1328, #1347, #1422, #1432, #1433, #1436, #1445 |
| J7 | #960, #1349 | #1350, #1444 |
| J8 | none | #1423, #1432 |
| J9 | #962 | none |

## Not in beta

- Video of any kind, including video ingest, multicam, MP4 export and video social clips.
- Native iOS and Android apps, and the in-app bring-your-own-key agent.
- Word, pause and repetition auto-tighten. `tighten.enabled` stays false.
  The pipeline applies only non-speech suggested actions by default.
- Multilingual transcription (#18) and legacy MCP cancellation (#151).
- Waiting room, producer talkback, room chat, self-hosted TURN or SFU, and
  fail-closed revoke of in-flight media.
- v1 trust work: packaged client auth, WebView deny-by-default and the updater.
- The per-track alignment timing map (#1089) and Fill with room tone (#1136).
- Prosody phase 2, alternate takes, music ducking, stem freeze, show-notes
  suggestions, user studies and telemetry.

## Bug bar

Severity decides whether a defect holds the beta.

| Severity | Meaning | Beta rule |
| --- | --- | --- |
| S1 | A journey cannot finish, data is lost, or security is exposed. | Zero open to ship. |
| S2 | The journey finishes but below its bar, and a workaround exists. | Fix it if cheap. Otherwise ship it on the known-issues list with its workaround. |
| S3 | Cosmetic or rare, and nobody is blocked. | Post-beta. |

`beta:blocker` marks an S1 or a defect that keeps a journey from its bar.
`beta:quality` marks an S2. `post-beta` marks everything else.

### Decision: Beta scope is nine journeys

<!-- decision
id: D-beta-scope-journeys
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- 265 issues were filed since 2026-10-01 and 73 were open on 2026-10-13, with no definition of done
- Sorting the 73 against the nine journeys gave 10 beta blockers, 28 beta quality items, 24 post-beta items and 11 closes
- Owner approval of the journeys, the not-in-beta list and the architecture order on 2026-10-13
- Chapter-bearing MP3 export is v1 and the editor save state is a J4 quality item (#1448), both decided on 2026-10-13
- Release candidate target 2026-11-03, set by the owner on 2026-10-13 and moved from 2026-10-27 for an owner vacation week
manual-review: calebn at the weekly beta review checks the journeys, the not-in-beta list and the target date, and cuts scope rather than lowering a bar
enforced-by:
- tests/test_docs_layout.py::test_beta_plan_names_every_journey_and_agents_links_it
-->

The nine journeys above are the scope. A new issue joins the beta only if it
breaks a journey, loses data or exposes security. Everything else is
post-beta, which is not a judgment that the idea is bad.

### Decision: Beta bug bar is S1, S2, S3

<!-- decision
id: D-beta-bug-bar
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- 183 of the issues filed since 2026-10-01 were follow-ups, 69 percent of the inflow, each filed at equal weight
- Of those follow-ups, 36 say the defect predated the fix that exposed it and about 6 were caused by a fix
manual-review: calebn at the weekly beta review confirms that no S1 is open and that every open S2 is fixed or listed with a workaround
-->

The beta ships when every journey's proof run passes, no S1 is open, and every
S2 is fixed or listed with its workaround. A short known-issues list is
shippable. Waiting for zero issues means never shipping.

## Exit criteria

1. Every journey's proof run passes on the lab tape, the holdout and the
   simulator, and on a device where the journey names one.
2. Zero S1 defects are open.
3. Every S2 is fixed or on the known-issues list with a workaround.
4. The owner has edited one real episode end to end, with a real guest on a
   review link.
5. Signed installers install on a clean machine for each platform in J9.

## Phases

| Phase | What happens |
| --- | --- |
| Build (current) | Land the blockers and architecture decisions 1 to 5. New features stop. |
| Stabilize | Fixes only. Verifiers file regressions and S1s. |
| Release candidate | The owner edits one real episode end to end, with a real guest on a review link. |
| Beta | Three to five hosts, a feedback channel, a weekly triage. |

Release candidate target: 2026-11-03 (set by the owner on 2026-10-13; moved
from 2026-10-27 for an owner vacation week), reviewed weekly; at each review, cut scope (a journey or a shell) rather than
lower a bar.

### Schedule

The owner is unavailable from 2026-10-28 to 2026-11-04.

| Date | What happens |
| --- | --- |
| 2026-10-20 and 2026-10-27 | Weekly reviews. |
| By 2026-10-27 | The steps that need the owner happen. These are the #960 device and listening session (around 2026-10-22), the #962 signing and installers, and a release candidate dry run in which the owner edits one real episode end to end. |
| 2026-10-28 to 2026-11-03 | Stabilize, run by agents. Fixes only. File new issues only for regressions and S1 defects. Agents run the journey proofs and prepare the known-issues list for the owner. |
| 2026-11-03 | Release candidate target. |
| 2026-11-05 | The owner signs off the release candidate. |

The owner sources the holdout recording from their own catalogue (#1273).

## Convergence

Each week, count the open beta-labelled issues and compare beta-labelled issues
opened against closed. The beta is converging when closes beat opens for two
weeks in a row. Total issue count is the wrong number, because `post-beta`
ideas should keep accumulating.

## Cut scope, not quality

If a journey cannot reach its bar in time, cut the journey or one of its shells.
Tablet editing is the likeliest cut. Do not lower the bar quietly. A smaller
beta that works earns more trust than a broad one that half works.

## Filing rules

### Decision: Agents file only reachable harm

<!-- decision
id: D-issue-filing-rules
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- 69 percent of the 265 issues filed since 2026-10-01 were follow-ups, and 48 of the 96 opened since 2026-10-12 were follow-ups
- The seven costliest root causes each spawned 12 to 23 follow-ups, filed one site at a time (defect census, 2026-10-13)
manual-review: calebn at the weekly beta review samples the week's new issues for a missing label or a filing that breaks a rule
-->

1. File a follow-up issue only for reachable harm. It reproduces on a real
   recording or a real UI on a supported shell or device with an effect a user
   notices, or it loses data or exposes security.
2. Label every new issue when you file it. Use one of `beta:blocker`,
   `beta:quality` or `post-beta`, a `journey:J#` label, and a `cause:` label
   when one fits. If an `epic` issue with a `cause:` label covers the class,
   add a checklist line to its Ledger section instead of opening an issue.
3. Two issues from the same premise mean the premise is wrong. Stop point fixes
   in that class, report it, and fix the structure first.
4. Fix test-quality and doc notes in the same PR, or drop them. Never file them.
5. A regression the PR caused blocks the PR. Never file it as a follow-up.
6. Synthetic-only and precision findings go on the ledger issue (#1449) or the
   class epic's Ledger section.

The same rules, in imperative form for agents, are in
[issue claims](../.agents/skills/sharecut-poteto/references/issue-claims.md).

## Pick work

1. Start `beta:blocker` issues first.
2. Then start `beta:quality` issues, ordered by milestone and by the
   journey whose bar is furthest away.
3. Skip `post-beta` issues. Two exceptions apply. The owner names the issue, or
   the issue is D5 CI-cost work (#1446, and CI cost work such as #1409).
4. In-flight work finishes. Check the result against the bar of the journey the
   issue carries.
5. Apply the claim protocol in
   [issue claims](../.agents/skills/sharecut-poteto/references/issue-claims.md)
   before you start.

## Architecture decisions

Five structural fixes stop the root causes that produced 55 of the 113 issues
filed since 2026-10-11. Each is a rule enforced by a type, a module boundary, a
lint or a contract test, not another guard. Land them in this order,
interleaved with the blockers. Each audio change still needs the lab before and
after proof.

| Order | Decision | Epic | Enforced by |
| --- | --- | --- | --- |
| D3 | Errors are typed at the boundary. A refusal carries a code, a host message and a fix. A disabled control carries its reason. | #1444 | Lint on bare raises in services, one contract test over guest routes, a required prop |
| D5 | Tests never wait on time. They wait on an event or a state. | #1446 | Lint on sleeps and fixed timeouts in tests |
| D1 | Detection levels are relative to each track's own floor and speech level, from one level-profile module. | #1443 | Lint on dB literals in audio code, one gain-invariance contract test over every detector |
| D2 | One module owns each cut-safety rule, fed by the non-speech action table. | #1403 | Boundary test that only that module calls the safety checks, one sabotage test per rule |
| D4 | One table decides what each selection shows on phone, tablet and desktop, with one 44 px reachability sweep. | #1445 | Generated unit test over selection kinds and sizes, one Playwright sweep |
| D6 | One API answers "is the other speaker talking" at the measured lag. | #1447 | Boundary test on cross-track level reads. Start only if lag issues return. |

D7 (one client command journal) is skipped, because most of it already landed.
The full alignment timing map (#1089), an integer-sample time model and a shared
client and server edit engine wait until after the beta.

### Decision: Architecture order is D3, D5, D1, D2, D4

<!-- decision
id: D-beta-architecture-order
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- Decisions D3, D5, D1, D2 and D4 target classes behind 55 of the 113 issues filed since 2026-10-11
- The census traced a 14-issue chain to overlapping cut guards and an 11-issue chain to fixed dB levels
- Guest permissions and touch input stopped producing bugs once one module owned each
- D6 targets a class that has gone quiet, and D7 is mostly landed, so D6 waits and D7 is skipped
enforcement: pending #1444
-->

The epics above build the checks. This block is complete when each epic's lint
or test exists. Until then, review a change in one of these classes against the
decision it falls under.

## Known issues

No known issues are listed yet. Each entry names the journey, the symptom, the
workaround and the issue number.
