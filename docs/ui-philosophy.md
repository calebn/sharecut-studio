# Sharecut Studio UI philosophy: earn trust in the beta

This document is the design contract for beta UI work. It describes intended
behavior, not a claim that every surface already implements it. Apply it when
planning a feature, reviewing a screen, or deciding how automation appears to
an editor. Track missing surfaces as follow-up work rather than treating these
principles as evidence that they have shipped.

The companion [interaction and communication work in issue #80](https://github.com/calebn/sharecut-studio/issues/80)
covers voice, copy, placement, and ergonomics. Its communication philosophy is
still a draft; do not treat it as a landed document. If its guidance conflicts
with this document, call out the conflict in the PR for a decision.

## 1. Show and undo every automated change

Trust takes priority over convenience. An automated pass must present proposed
changes before applying them. Let the editor inspect and approve or skip each
item, or approve the reviewed pass. Do not offer a blind project-wide AI apply
action. After application, provide one control to undo the entire pass near the
result; History remains a backstop.

Mark low-confidence transcript words in the review queue. Exclude them from
automatic shortening, cutting, and bulk approval until a person reviews them.
Treat transcript corrections as timeline edits with the same approval and undo
path, rather than silently rewriting words elsewhere.

## 2. Make recovery state visible

Show a persistent, understandable save state in desktop transport chrome and
mobile status areas: saved, saving, or saved locally with sync pending. A
generic spinner cannot carry these distinct meanings. Offer undo beside a
mutation, and retain removed material in non-destructive history.

The beta must support a local, offline project path. Failed sync and conflicts
need visible status and a recovery action; neither may silently discard edits.
These are requirements for implementation, not assertions about the current
save or conflict UI.

## 3. Make Tighten a review workflow

Tighten should present a list of proposed cuts and filler hits with an audio
preview and Approve or Skip for each hit. Provide reviewed-pass approval and
one-action pass undo. Flag low-confidence hits and keep them out of bulk
approval until reviewed. The queue must be reachable on desktop, tablet, and
phone; the phone design uses a bottom sheet. Use the terms “tighten hit” and
“pending edit” consistently with issue #80's communication guidance.

## 4. Give each screen one job

On a phone, launch toward recording; on desktop, show the current project's
next step. Keep multitrack, effects, and render options one deliberate action
away. Empty states should explain the next useful action and provide its
control. Frequent tablet actions belong in reachable tool rails, while other
actions remain discoverable through More or overflow. Progressive disclosure
must never make an action unavailable on a shell that supports it.

## 5. Treat export as a completed outcome

An export flow needs configuration before start, progress and cancellation
during rendering, and verification afterward. Show what was exported and where
it went through the same announcement and toast pattern as other results.
Provide podcast-ready presets, including chapter-bearing MP3 and a -16 LUFS
loudness target. Preserve audio quality across export paths. These are beta
design goals; verify the actual format and quality behavior before describing
any preset as shipped.

## 6. Collaborate through links and review

A guest should be able to join through a link without installing software.
The intended asynchronous flow is a review link with comments and cut
approval, rather than project-file handoffs. Distinguish “review link,” “record
room,” “guest link,” and “producer link” in controls and copy; “share” alone is
ambiguous where both rooms and review links exist.

## 7. Preserve precision on mobile

Waveform editing should support pinch zoom, persistent zoom controls, and
snap-to-silence boundary selection. Design precision controls for touch and
stylus input, including Apple Pencil-style interaction, and for accessibility
from the start. Phone actions should use thumb-reachable placement, bottom
sheet dialogs, and touch targets of at least 44 px, in line with issue #80's
mobile checklist.

## 8. Make the free core trustworthy

The product principle is a fully functional freemium experience: capabilities
that cost nothing or negligible money remain free. Paid offerings may provide
convenience for costs the user would otherwise bear, such as podcast hosting
or a cloud-hosted DAW. Keep the local project path honest and usable.

Do not put metered credits on the core record, transcribe, tighten, edit,
share, and export workflow. Do not watermark free-tier exports. If packaging
changes, explain it in-app with lead time rather than surprising an editor at
a paywall.

## Scope and implementation

This philosophy guides future surface work. It does not itself implement the
Tighten review queue, save and sync chrome, mutation undo controls, export job
UI, mobile waveform precision, collaboration review mode, or free-tier UI
audit. Plan and track those changes by surface; keep unrelated surfaces out of
one PR. See [issue #84](https://github.com/calebn/sharecut-studio/issues/84)
for the implementation checklist and research provenance, and issue #80 for
the companion interaction audit.

Beta scope explicitly excludes user-testing studies and interaction telemetry
or usage logging. Feedback comes through the existing error-log submission
flow ([issue #19](https://github.com/calebn/sharecut-studio/issues/19)) and
GitHub issues. Do not add analytics hooks under this philosophy.
