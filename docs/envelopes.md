# Track volume envelopes

The canonical volume parameter is `volume`. Saved points require explicit stable IDs. New-point command/service inputs allocate IDs before storage.

Volume automation belongs to a track and uses destination timeline seconds. It multiplies the assembled track audio independently of the mixer fader. Two occurrences of the same source at different timeline positions receive the gain at their respective destination times. Showing the envelope layer or opening an editor does not create automation.

An empty envelope has unity gain. A single point supplies constant gain throughout the track. With multiple points, the first value holds before the first time, distinct times interpolate linearly, and the last value holds after the last time. A first point at 0 seconds with gain 1 therefore preserves unity automation. Gain values are linear multipliers: 0 silences and 1 is unity. Backend point times must be finite and nonnegative; values must be finite. Backend validation does not impose the GUI’s gain range on other envelope parameters or current domain callers.

The current point-array domain also supports coincident times as explicit steps. Stable time ordering preserves saved order within a tie: the preceding interval approaches the first point in that group, and the last point supplies the value at and after the timestamp. A group at the first timestamp holds its first value before that timestamp. GUI creation may reject a new collision without discarding or merging saved points.

## Rendering and playback caches

The host track renderer evaluates envelope gain once per FFmpeg audio frame after track assembly. Frame evaluation approximates a continuously varying curve at frame boundaries; it does not promise sample-by-sample interpolation. Segment rendering adds the destination window’s start to its local filter clock, so a segment beginning at 4 seconds evaluates the same destination curve as the full track. Processing-effect filter ordering is unchanged.

Renderer semantics revision 11 invalidates stems and host play-segment cache keys generated under the preceding envelope behavior. Existing guest source-clock proxies do not evaluate volume envelopes; this change does not alter that route or guest permissions. Offline rendered PCM evidence does not establish physical playback, heard quality, or guest playback parity.

## Concurrent edits

`SetEnvelope` replaces the track’s volume points while preserving other envelope parameters. Clients send the exact ordered `expected_points` ID/time/value array from the state they read. Order is part of the conflict baseline because rearranging coincident points changes their step. A stale value, identity, count, or order causes a conflict instead of an overwrite. Echo the raw saved baseline without sorting, rounding, clamping, or regenerating IDs.

A document command also checks that the target track still exists under the project lock, returning a conflict before history or logging if it disappeared. The common service mutation independently refuses absent tracks for direct domain callers. Neither path creates an orphan envelope.

An accepted command uses the existing document transaction and undo history. An empty point list removes automation’s gain effect and can be undone through the same history. Repeating the same command ID is idempotent. Selection and draft cancellation alone do not submit a document edit.
