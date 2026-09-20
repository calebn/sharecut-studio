---
name: podcast-focus-episode
description: >-
  Narrative content edit: read the full transcript, infer the episode's natural
  theme and spine, cut tangents and repeats that don't serve it. Use when the
  user wants the most interesting succinct conversation — not filler tightening
  (podcast-tighten-dialogue), cut-by-phrase / transition handoffs
  (podcast-edit-natural-language), social clips, or duration-only trimming
  unless they ask.
---

# Focus episode (narrative content edit)

Shape the episode around the **theme that already lives in the conversation** —
discovered from the full transcript, not assumed upfront. Cuts serve **clarity and
momentum** toward that theme. **Duration targets are optional** and secondary; do
not sacrifice the best material just to hit a minute count.

This is editorial judgment (content edit + rough cut), not mechanical density
(**podcast-tighten-dialogue**) or highlight export (**podcast-social-clips**).

## What this skill does (and does not)

| Does | Does not |
|------|----------|
| Read whole transcript → infer dominant theme(s) | Require user to supply the theme first |
| Propose cuts that sharpen the natural spine | Trim to a target length by default |
| Flag repeats, dead starts, off-theme tangents | Replace human listen + approval |
| Write `artifacts/focus_brief.md` for the user | Auto-apply cuts without review |

## Editorial principles

- **Discover, then focus:** the speakers usually already have a spine; your job is
  to name it and remove what fights it.
- **Three buckets** (relative to the **discovered** theme):
  - **Core** — defines the episode; almost always keep
  - **Support** — context, stories, emotion that earn their place; keep unless redundant
  - **Divert** — interesting but off-theme or repeated; cut to protect core
- Cut **good** tangents when they compete with **better** on-theme material.
- Same idea twice → keep the sharper take.
- Duration: only tighten **support** or **divert** blocks if the user gives a
  target; never cut **core** to hit a number.

## Harness

**Prerequisite:** clear `require_transcript_refine` (`transcript_refine_status_tool` → done/waived) via **podcast-transcript-refine**. Narrative cuts are blocked while status is pending.

**Read:** `artifacts/focus_outline.md` (from `analyze_focus_cuts`), or
`get_transcript(combined=true, format=timestamps)`.

**Write:** `artifacts/focus_brief.md` (agent-produced theme analysis + cut plan).

**Mutate:** `apply_edit_plan_tool`, `approve_edits_tool`, `edit_impact_report_tool`,
`play_transcript_query_tool`, `play_audio_tool`, `history_snapshot`, `history_undo`.

See **podcast-play-audition** for playback rules (`track:` vs source vs `processed:`).

## Workflow

### Phase 0 — Preconditions

1. Transcript workflow complete through **podcast-transcript-refine** agent gate
   (`render_dialogue_stems` → reconcile → precorrect → refine). See
   **podcast-transcript-workflow**.
2. `merge_transcript` done; read **entire** dialogue (outline or timestamps).
3. Transcript word times = **source media time** and stay that way through edits
   (ripple/tighten move clips, not words). To audition a span on the edited audio,
   use the match's mapped `timeline_start`/`timeline_end` (see **podcast-play-audition**),
   not the raw word times — see alignment note in example below.
4. `history_snapshot` — `before narrative focus`.
5. Optional: light filler pass first (**podcast-tighten-dialogue**) so themes are
   easier to hear.

### Phase 1 — Theme discovery (whole transcript)

Read `artifacts/focus_outline.md` or full combined transcript **start → end**.
Do not propose cuts until this pass is done.

Produce **`artifacts/focus_brief.md`** with:

```markdown
# Focus brief — {episode name}

## Dominant theme (recommended focus)
One sentence: what this episode is *really* about.

## Evidence
- Segment indices / time ranges that carry the theme
- Recurring words, stories, or tensions (3–5 bullets)
- What the cold open and last 5 minutes suggest

## Secondary threads
Topics that appear but are not the spine (ranked).

## Candidate alternative focuses (if ambiguous)
1. … — when this fits better
2. …

## Suggested editorial shape
- Core beats to protect (index + one-line summary)
- Likely diverts (index + why)
- Weak transitions / repeats (index)

## Duration note
Current ~X min. Cuts below are for focus, not length. (Add target only if user asked.)
```

**How to infer theme** (use all, not one):

1. **Recurrence** — what subjects, metaphors, and named entities come back?
2. **Energy** — where do stakes rise (fear, anger, hope, organizing, family)?
3. **Question arc** — what problem is opened early and revisited?
4. **Turning stories** — 2–3 anecdotes that other segments reference later.
5. **Speaker intent** — what are they trying to explain to each other?

If the user **overrides** theme (“actually focus on X”), replace the dominant theme
section and re-map segments — do not restart from scratch.

**Ask the user only when:**

- Two themes are equally weighted and cuts differ materially.
- A proposed cut removes a story they might care about (flag as REVIEW first).
- User gave a duration target that conflicts with the discovered spine.

### Phase 2 — Segment map

Using macro segments from `focus_outline.md` (not word-level utterances), label each:

| Label | Meaning |
|-------|---------|
| `CORE` | Central to discovered theme |
| `SUPPORT` | Helps listener follow the theme |
| `DIVERT` | Off-theme or redundant |
| `REVIEW` | Borderline — audition before cut |

**Cut triggers** (theme-relative):

- `focus:divert` — clear tangent vs discovered theme
- `focus:repeat` — same point made again, weaker take
- `focus:host_windup` — long setup before the point lands
- `focus:dead_start` — pre-show chatter, false starts
- `focus:weak_transition` — re-introduces already-established context

Do **not** remove >**15%** in one batch without explicit user consent.

### Phase 3 — Propose cuts

`apply_edit_plan_tool` with **`review_required: true`** and segment-aligned
`start`/`end` from the outline.

Present the brief + impact report. **Lead with theme**, not minutes removed.

### Phase 4 — Listen loop

Audition `REVIEW` and any disputed cut on **one track** (**podcast-play-audition**).
User approves → `approve_edits_tool` → `assemble_timeline` → `merge_transcript`.

### Phase 5 — Optional duration pass

**Only if user requested a target length:**

1. After theme focus is approved, measure new duration.
2. Trim longest **SUPPORT** segments that repeat known context; then **DIVERT** if any remain.
3. Never cut **CORE** beats to hit a number.

## Pipeline (`analyze_focus_cuts`)

Runs after `merge_transcript`, before filler tighten. Writes
`artifacts/focus_outline.md` (thought blocks). Heuristic `focus:*` hints are
**optional noise** — verify against the theme brief. Primary intelligence is
**this skill**, not the pipeline step.

**Requires `focus.enabled: true`** in pipeline defaults / working set. With the
default `focus.enabled: false`, `podcast pipeline run --only analyze_focus_cuts`
finishes in ~0s and writes **nothing** (summary: `skipped (focus.enabled=false)`).
Enable first (GUI Pipeline tab / `pipeline_set_config_tool` / project pipeline
params), or skip the step and build `focus_brief.md` from the combined transcript
alone.

```bash
# After enabling focus.enabled:
podcast pipeline run --project episode.project.json --only analyze_focus_cuts
```

## Rules for agents

- **Theme before scissors** — infer focus from the transcript; duration is optional.
- Default `review_required: true` on all focus cuts.
- Write `artifacts/focus_brief.md` before proposing cuts.
- Chunk reading is for context limits only; judgments must use the whole-episode map.
- Bilingual / Spanglish: prefer REVIEW over aggressive divert labels.
- `analyze_focus_cuts` hints ≠ approved edits.

## Example — `podcast-cleanup-test`

Likely discovered theme (verify by reading outline): **organizing and safety under
immigration enforcement** — ICE, community mutual aid, fear, and staying in the work
— with personal/family stories as **support**, not a separate episode.

Session without duration goal:

1. Run `analyze_focus_cuts` → read full `focus_outline.md`.
2. Write `focus_brief.md` with theme + core/support/divert map.
3. Propose 4–8 REVIEW/DIVERT cuts (repeats, travel digressions that don't pay off).
4. User: “Keep the Facebook-group safety story” → reclassify that segment as CORE.
5. Approve → assemble → premix audition at act boundaries.

**Alignment:** if audition text ≠ audio, fix transcript source times before bulk cuts.

## v2 (engine, not required for agents)

- Topic clustering on macro segments (embeddings / keywords) to seed theme candidates.
- `focus.episode_promise` in `pipeline.yaml` as **override only**, not default input.
- Drift check before focus pass.
