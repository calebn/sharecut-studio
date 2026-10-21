# #1816 overlay-owner: Mac simulator recipe

Purpose: prove that moving each optimistic write into the draft overlay changes no visible timing. Run once per slice branch (A = main, B = slice PR), same project, same device. Pass = no visible difference between A and B in any step below.

## Setup
- Devices: iPhone 15 Plus (B9048612-B499-4D88-9774-1B067797FED7), iPad Pro 11 "Sharecut-1445", iPhone SE "Sharecut-1714-iPhone-SE-20261018".
- Ports 8815-8818 (never 8801; 8812-8814 are often taken). Never `pkill -f "gui --project"`. Do not touch Caleb's Studio (b2942764).
- Use a throwaway copy of a small project with 3+ tracks (not Daniela). Screen-record each step on both arms, 60 fps if available.
- Run each step with the network normal, then once with the Studio throttled or stopped for 2 s (to see the queued and failed paths).

## Already merged (PR 1957): quick regression look
1. Track reorder (long-press drag a lane, and moveUp/moveDown keys): lane moves at once; with the Studio stopped, it reverts on failure with the "Reorder failed" toast.
2. Rename a track in the inspector: label shows on blur, reverts on failure.
3. Envelope point edit while queued: point stays shown, no flicker on the later reply.

## Held slices (run when the slice PR exists)
S4 clip move (`commands/editing.ts` ~437)
- Drag a clip 5 times on each device: the clip follows the finger, lands on release with no one-frame jump back, no flash on the server reply.
- Drag across tracks, and with snap on. Release, then immediately drag again before the reply.
- Pass: frame-by-frame the clip start/end positions match A.

S5 mix fold (`commands/trackMix.ts`: premixBehind, fader and mute)
- Hold a fader and sweep; tap mute 3 times fast; hold arrow key for volume.
- Pass: the fader/mute value follows input with no lag or snap-back; the "premix behind" badge appears at the same moment as on A; one undo step per burst.

S6 nudge (`inspector/useNudgeRun.ts` ~189, ~335)
- Hold nudge (Enter) on a clip for 2 s, release, repeat key, unmount mid-hold by switching track.
- Pass: clip position steps at the same cadence; release lands on the same final time; no returned-comment loss.

S7 precision driver (`timeline/precision/precisionDrivers.ts` ~71)
- Open precision on a fade and a trim handle; scrub slowly and fast; release.
- Pass: handle tracks the pointer with no extra frame of latency; final value equals A.

## Results
Post per slice on #1816: device, arm, step, pass/fail, and a link to the recording (do not commit recordings or audio).
