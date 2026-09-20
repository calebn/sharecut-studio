---
name: podcast-transcript-audition
description: >-
  Resolve one ambiguous transcript span at a time: play audio, present fix
  options, wait for the user, apply that single correction, then move on. Use
  when garbled or low-confidence ASR needs listen-first decisions — not bulk
  refine (podcast-transcript-refine) or single known-word fixes
  (podcast-transcript-correct). Hub: podcast-transcript-workflow.
---

# Transcript audition (one issue at a time)

**Per-issue skill** — not a batch presenter. Each questionable span gets its own cycle: **play → options → user answer → apply → verify → next**. Never play multiple clips or show multiple audition forms in one turn.

Hub: [podcast-transcript-workflow](../podcast-transcript-workflow/SKILL.md). Pair with [podcast-transcript-refine](../podcast-transcript-refine/SKILL.md) (batch fixes) and [podcast-play-audition](../podcast-play-audition/SKILL.md) (ad-hoc play).

## Core rule

```
ONE issue per agent turn until the user responds.

  play (single clip)
    → present (single form)
    → STOP (wait)
    → user picks A/B/C/D or custom text
    → apply (single span, single undo step)
    → verify
    → optionally surface "next issue" count — do NOT play it yet
```

**Forbidden in one turn:**

- Playing clip 1, then clip 2, then clip 3 in sequence
- Dumping Audition 1–4 forms in one message
- Applying fixes for issues the user has not answered yet

**Allowed:**

- Keeping an internal backlog (ordered list of deferred spans)
- Mentioning *"N issues remain after this one"* at the end of a resolved issue
- Playing a **reference** clip on the other track only if the user asks (*"play what vicky said too"*)

## When to use

- Deferred cleanup items (bleed, homophones, both tracks garble differently)
- `low_confidence_words_tool` hits where meaning is unclear
- User: *"play it"*, *"what did they say?"*, *"audition this line"*

## Backlog (internal only)

Build once, work down **one item at a time**:

1. User-named time or quote
2. Deferred list from prior cleanup
3. `low_confidence_words_tool` — nonsense phrases only (not filler `like`/`uh`)
4. Cross-track mismatch at same wall-clock

Each backlog entry: `{track_id, start_sec, end_sec, start_word_index, end_word_index, heard, reason}`.

Pick the **first unresolved** entry. Do not show the full backlog unless the user asks.

## Per-issue cycle

### Step 1 — Play one clip

```bash
podcast play --project episode.project.json \
  --source track:<track_id> \
  --start <start_sec> --end <end_sec>
```

±1–2s padding. Prefer **raw** `track:<id>`. **One** `podcast play` (or `play_audio_tool`) per issue.

Tell the user: *"Playing now: `<track_id>` mm:ss–mm:ss"* and the WAV path.

### Step 2 — Present one form (then stop)

Use **only this issue's** template — nothing else below it:

```markdown
## Transcript audition — `<track_id>` @ mm:ss

**Now playing:** track:<track_id> `start`–`end`s

**ASR heard:**
> "{verbatim span}"

**Context:** …{before} **[{span}]** {after}…

**Confidence:** min {min_conf} · words `{start_index}`–`end_index}`

| Option | Proposed text | Why |
|--------|---------------|-----|
| A | … | … |
| B | … | … |
| C | Leave as-is | No change |
| D | Your wording | Reply: `D: <exact phrase>` |

**Reply with:** `A`, `B`, `C`, or `D: …`
```

Then **end the turn**. Do not play the next clip. Do not list other open issues except optionally: *"(3 more deferred after this one)"*.

### Step 3 — Apply single fix (after user replies)

One issue → one history step:

- `correct_transcript_phrase_tool` or `apply_transcript_cleanup_tool` with **only that span**
- Re-read word indices immediately before apply
- Label: `after transcript cleanup` (one `history_undo` reverts this issue)

If the fix must match on **both tracks** (user chose aligned wording), apply **olga then vicky as two separate undo steps** in the same turn *only after* the user confirmed one wording applies to both — still one conceptual issue.

### Step 4 — Verify this issue only

- Grep old garbled string for this span → zero hits
- Spot-check `combined.json` around that time

### Step 5 — Next issue

Ask briefly: *"Ready for the next audition?"* or start Step 1 for the next backlog item **in a new turn** (or if user said *"keep going"*, still one play + one form per message).

## Option rules

- 2–4 concrete options + Leave as-is + Custom (`D: …`)
- Bleed: include align-to-other-track, suppress, leave-for-audio-cleanup
- Spanish/Spanglish: include keep-original when intentional
- Custom text applied **verbatim**

## NL triggers

| User says | Agent does |
|-----------|------------|
| "Play the unclear parts" | Start backlog; **issue 1 only**: play → form → wait |
| "Next" / "keep going" | Next backlog item; one play → form → wait |
| "D: foster parents" | Apply that issue only; verify; offer next |
| "Play vicky's version too" | One extra play (reference); still one form |

## Non-destructive

`apply_transcript_cleanup_tool` / `mutate` only. Never edit raw audio or hash ASR caches.
