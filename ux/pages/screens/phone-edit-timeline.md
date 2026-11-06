## Phone — Edit: Timeline

| | |
|--|--|
| **Purpose** | Spatial seek/edit with **a playhead that starts at 0**; drag timeline to scrub. The timeline loads with time 0 right after the track headers and the line on it, with no gap. The line shows the transport time at its place in the view, from 0 to the end even at Fit, with overlay or classic scrollbars: playback moves it right until it reaches the center and then holds it there while the timeline scrolls. Margins before 0 and after the end give a scrub the room to reach either end, and switching Listen → Timeline, fitting, or zooming from the menu or keys never moves the time. Pinch zooms anywhere on the timeline except the lane rail, and scrubbing stops at the session end: zoomed out below Fit, the lanes and ruler end there and the margin shows beyond it. |
| **Primary actions** | Scrub · Fit · layer chips · select clip/edit → sheet · drag clip · tap lane gutter → track sheet |
| **Always visible** | Player bar (comment at the playhead) · corner (Range, Fit) · eye sheet ·  sticky lane gutter (44pt lane-colored initials chip per lane, lane-colored edge, compact playback meter and clearable clip light) + waveforms whose clip labels lead with speaker or track identity and a readable duration · mode nav |
| **Data shown** | `timeline.tracks` · `timeline.clips` rectangles · overlay layers (edits/levels/markers/comments) |
| **Empty** | Loading episode: skeleton lanes in the same header/gutter grid. No tracks after load → ghost drop lane + dismissible coach (“one file per speaker”, and “One recording of everyone? Import it, then choose Split speakers.”); tracks with no clips → empty lane until Import/Replace |
| **Out of scope** | Desktop moving-playhead metaphor; dense mixer strip on narrow panes; disconnected chip strip above lanes; full-page upload card |

```
┌─ header ─────────────  [👁] ────────┐
│ Pending edits  Volume envelope  Markers  Comments │
│ ref │░░░░│░░░░░│░░░░░░░░░░░░░░░░   │
│ gue │░░░░│░░░░░░░░│░░░░░▼░░░░░░░   │  ← Ferrite gutter + CapCut ▼
│ [Range]  [Fit][−][+][👁]         │  ← corner (Undo/Redo are in the header)
├─ ▶ 12:34   Hear original ────────────┤
├─ Record │ Prepare │ Edit │ Review │ Deliver ─┤
│ ┌ sheet: track / Pending cut ── X ┐ │
│ │ Track: Name/Level/M/S + Tools     │ │
│ │ Clip: paired fades / transition │ │
│ │ Pending: Snap to silence + review │ │
│ └────────────────────────────────┘ │
```

Elapsed timers and clipping-report ranges switch to h:mm:ss from one hour. Recorded takes show mic clipping (sample peak) as red flags in a `clipping` marker row (one per span per track, labelled with the track; tap to select the track and seek) and a red tint on the clipped span of the clip. When the encoder hit its region cap, the clip's last flag says later clipping was not recorded. Up to 100 flags are kept per recording; a dense burst after that lengthens the last flag instead of adding one.

Lane identity is a slim sticky gutter in the same scroller as the waveforms. Tap the gutter row (› disclosure) → track sheet with **M**/**S** and the **Volume** fader (saved; host and editors; envelopes on Volume envelope). Solid M = muted in the mix; dashed = only you hear it that way (a guest's listen-only mute, or a track your solo silences). Unheard tracks go grey: row, lane, initials chip fill, clips and waveform; the chip and identity stripe are dashed when only you hear it that way. While any track is soloed, **Solo on · Clear solo** shows in the status row above every mode. Pane density uses `@container timeline` (gutter vs mid/full rail) — not viewport width alone.
