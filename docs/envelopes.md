# Track volume envelopes

The canonical volume parameter is `volume`. Saved points require explicit stable IDs. New-point command/service inputs allocate IDs before storage.

Volume automation belongs to a track and uses destination timeline seconds. It multiplies the assembled track audio independently of the mixer fader. Two occurrences of the same source at different timeline positions receive the gain at their respective destination times. Showing the envelope layer or opening an editor does not create automation.

An empty envelope has unity gain. A saved curve with exactly one point supplies constant gain throughout the track. When the GUI adds the first point, it inserts endpoint anchors at the prior curve value; changing an interior point therefore leaves that value at the ends. With multiple points, the first value holds before the first time, distinct times interpolate linearly, and the last value holds after the last time. A first point at 0 seconds with gain 1 therefore preserves unity automation. Gain values are linear multipliers: 0 silences and 1 is unity. Backend point times must be finite and nonnegative; values must be finite. Backend validation does not impose the GUI’s gain range on other envelope parameters or current domain callers.

The GUI's visible empty line is an implicit unity guide. Dragging it vertically
creates equal-level anchors at timeline start and end in one `SetEnvelope` edit;
a zero-duration timeline gets one point at time zero. A saved flat curve stays
draggable, and its existing point IDs, times, and order remain intact. The GUI
classifies flatness by exact saved value equality, so an authored shaped curve
never becomes a whole-line target through rounding. Showing the layer or a
no-change gesture still saves nothing.

The current point-array domain also supports coincident times as explicit steps. Stable time ordering preserves saved order within a tie: the preceding interval approaches the first point in that group, and the last point supplies the value at and after the timestamp. A group at the first timestamp holds its first value before that timestamp. GUI creation may reject a new collision without discarding or merging saved points.

## Ducking

`ApplyDucking` (`apply_ducking_tool`, `podcast edit duck`) writes the dip of a bed under dialogue as ordinary volume points, so every point stays editable and undoable. `engines/ducking.py` holds the pure engine; `services/document_sync/ducking.py` picks the tracks and plans.

**Where speech comes from.** Transcript words of every unmuted dialogue track (or the `dialogue_track_ids` you name), mapped through the clip map onto the timeline clock, so cuts, ripples, moves and inserted gaps are already counted. Words marked ignored, suppressed or suspect, and spans a clip mutes in place, do not duck; a lowered span still plays, so it still ducks. Speech with no transcript does not duck, and a project with no dialogue words refuses with `ducking_no_dialogue_activity`. There is no threshold: transcript activity is on or off.

**Which tracks dip.** `track_ids` omitted: every unmuted music track with media, plus every non-dialogue track holding a library segment marked duck-under-dialogue (a segment the library cannot read is skipped with a warning). An intro, outro or sound track dips only when named. A dialogue track is refused (`ducking_dialogue_target`).

**Shape.** Defaults: depth is `mix.music_under_vo_db` (-18 dB; the `depth_db` payload field overrides it), attack 0.25 s, hold 0.35 s, release 0.8 s, minimum gap 0.8 s (the release time, so a short pause never lets the bed swell back and dip again), minimum speech 0.12 s. Speech shorter than the minimum is dropped, pauses no longer than the hold are bridged, and two dips merge when the bed would sit at full level between them for less than the minimum gap. Each dip is four points: unity at onset minus attack, depth at the onset (the ramp ends on the first word), depth until last word plus hold, unity after the release. A ramp cut by the timeline edge keeps its slope. A depth of 0 dB writes no dip and removes an earlier one.

**Composing with what is there.** The result is the exact minimum of the track's existing envelope and the dip, so a fade or a hand-placed point is never raised: it is lowered where the dip is deeper, and a boost above unity is lowered only where the dip is below it: between dips, and wherever no speech is near, it plays as saved. A point of yours past the timeline end plays nothing and is left as saved; a lowered or moved generated point past the end is still restored on the next run.

**Reruns, without a format change.** Mix fade points (`mix:fade:`, see [Mix fades](#mix-fades)) are base points like yours: a dip can lower one (`duck:b:mix:fade:...`) and the next run puts it back. Generated points carry `duck:g:<sha1 of time and value>` ids. A point counts as generated only while its time and value still hash to its id; a point you moved or retyped is yours and stays as a local ceiling (its id becomes `duck:u:...`, with a numeric suffix when that id is already taken, so ids stay unique; a lowered point put back takes the same suffix if its original id is taken): it can lower the result at its own time but never anchors the rest of the track, so the dips elsewhere are unchanged. A saved point the dip lowered keeps its identity in its id, `duck:b:<original id>:<original value>:<lowered value>`. A rerun drops pristine generated points, puts lowered points back, and recomputes, so the same input gives the same points, a rerun with another depth equals a fresh run, and a rerun that changes nothing makes no history entry. A lowered point you retype is yours: it keeps the value you typed as its own, and the dip still lowers it wherever the dip is deeper.

**Errors.** Every refusal carries a code: `ducking_no_targets` (no track to duck), `ducking_bad_param` (a non-finite or negative setting, or a depth above 0 dB), `ducking_unknown_track` (a named dialogue track does not exist), `ducking_not_dialogue` (a named dialogue source is not a dialogue track), alongside `ducking_no_dialogue_activity`, `ducking_dialogue_target` and `ducking_too_many_points`. A write that would give two points one id fails with `envelope_duplicate_point_id`.

**Size.** The envelope holds at most 10 000 points. Over that, the minimum gap doubles up to six times and the result says `coarsened`; if it still does not fit the command refuses with `ducking_too_many_points`.

**Preview, then apply.** `dry_run` plans without writing: no history entry, no journal row. The reply carries `plan_token`; send it as `expected_plan_token` and the apply is a conflict if the plan changed since. One apply is one undo step for every track.

**Mix and duck in either order.** A `mix_with_music` run keeps the dip ([Mix fades](#mix-fades)); only a cut or a changed fade length moves the fade points, and then a dip near them is stale until ducking runs again. Ducking is host only. Rendered stems go stale with the reason "envelope" after an apply. The sound of the result (the bed's level under speech, the first word not clipped, no pumping) needs a listen on a render; unit tests prove the points.

## Mix fades

`mix_with_music` fades each music, intro and outro track that has a recording in and out over its whole stem (`mix.fade_in_sec`, `mix.fade_out_sec`). It writes the fade into the track's volume envelope as four points, ids `mix:fade:in0`, `in1`, `out0`, `out1` followed by a hash of the point's time and value, and keeps every other point as it is. As with ducking, ownership is by content: a fade point whose id still matches its time and value belongs to the step, which re-places it when the stem length or the fade settings change; a fade point you moved or retyped is yours, and that slot is not written again. A dip's lowered fade point is kept while its time is unchanged. At the same time a fade point goes first and your point after it, so yours wins. Points of yours between fade points shape the ramp there (the points are the curve), and points past the stem end play nothing and stay. A stem shorter than the fade-in fades in over its whole length. A project written by an earlier version holds exactly four uuid points in the fade shape: the first run adopts them as the fade. The run also no longer deletes a `pan` envelope on the track. Projects with no points other than the fade keep the same envelope values, stem hash and premix bytes.

## Rendering and playback caches

The host track renderer evaluates envelope gain once per FFmpeg audio frame after track assembly; a track with an envelope is cut into 256-sample frames first, so the gain steps at most about 5 ms late at 48 kHz. The expression is a balanced tree of `if` tests, so an envelope of thousands of points stays within FFmpeg's nesting limit. Frame evaluation approximates a continuously varying curve at frame boundaries; it does not promise sample-by-sample interpolation. Segment rendering adds the destination window’s start to its local filter clock, so a segment beginning at 4 seconds evaluates the same destination curve as the full track. Processing-effect filter ordering is unchanged.

Renderer semantics revision 11 invalidates stems and host play-segment cache keys generated under the preceding envelope behavior. Existing guest source-clock proxies do not evaluate volume envelopes; this change does not alter that route or guest permissions. Offline rendered PCM evidence does not establish physical playback, heard quality, or guest playback parity.

## Concurrent edits

`SetEnvelope` replaces the track’s volume points while preserving other envelope parameters. Clients send the exact ordered `expected_points` ID/time/value array from the state they read. Order is part of the conflict baseline because rearranging coincident points changes their step. A stale value, identity, count, or order causes a conflict instead of an overwrite. Echo the raw saved baseline without sorting, rounding, clamping, or regenerating IDs.

A document command also checks that the target track still exists under the project lock, returning a conflict before history or logging if it disappeared. The common service mutation independently refuses absent tracks for direct domain callers. Neither path creates an orphan envelope.

An accepted command uses the existing document transaction and undo history. An empty point list removes automation’s gain effect and can be undone through the same history. Repeating the same command ID is idempotent. Selection and draft cancellation alone do not submit a document edit.
