## Wireframe coverage checklist

Use this when auditing mocks:

- [ ] Header, Stage bar and Player bar fit on ≤720px width  
- [ ] Phone Review has no Fit control  
- [ ] Sheet Close + no stacking  
- [x] Player-first footer on every modifier (pending: Current / Suggested / A/B, only on a sheet with no Action bar; otherwise Hear before / Hear after on the bar) 
- [ ] Guest capability chrome  
- [x] Record lobby / room / full / declined (`/rec/{token}`); full-quality recording + mix-minus shipped  
- [ ] Empty comments / no transcript / no pending  

### Transcript speaker editing

Speaker labels in the transcript open a name editor for hosts and shares with the `edit` capability. Enter a new name or choose an existing speaker, then select **Save speaker** or press Enter. The change applies to every turn on that track through the same `SetTrackMeta` command as the Track inspector. It preserves source audio, word timing, and track identity. **Cancel** or Escape discards the draft. History Undo restores the previous speaker. The adjacent timecode seeks the turn. Queued saves immediately update the visible speaker labels and announce that delivery is pending. Rejected saves restore the previous view only if the originating project and optimistic snapshot are still active.

### Transcript find and replace

Hosts can open **Find and replace** in the Transcript toolbar or command palette. On desktop and tablet, the palette action reveals Transcript when the editor panels are hidden, including after reload. The panels return at their previous height and stay visible on the next reload. The transcript layout stays in place when it already shows Transcript. Running the action again closes the form.

Enter a word or phrase and its replacement, choose **Match case** if needed, then select **Preview replacements**. Search matches whole word tokens, ignores surrounding punctuation for matching, and keeps existing edge punctuation unless the replacement explicitly supplies that edge. Case matching is off by default; replacement case is exactly what the host enters. Regular expressions and partial-word replacement are not supported.

The preview lists before/after text with track, source recording, and source-media time. It searches every stored source transcript, including cut-away text. Suppressed and ignored words are skipped and cannot bridge a phrase; the preview reports their count. Unchanged replacements do not create history. Preview rows load into the list in groups of 100; **Show more replacements** reveals the next group, while **Replace all** applies the complete counted set.

Equal word counts preserve each word's source timing and audibility flags. Different word counts use manual phrase correction's timing policy: replacement words share the original phrase's outer source span. The preview warns before applying this redistribution. Source audio, clip positions, and recording identities remain unchanged.

**Replace all** is one undoable history action. The server checks the complete source-keyed candidate set, exact words, timing, and flags under the project transaction before applying anything. A stale preview changes nothing and asks for a new preview. Queued commands keep their preview token and are checked again at replay; the form reports pending delivery. **Undo replacements** appears next to the result and is disabled after a newer view arrives; History remains available to review and undo changes.

Replacement tokens must each contain a letter or number; attach punctuation to the adjacent word. When word counts differ, an explicit audibility lock anywhere in the original phrase is preserved on every replacement word.

### Selected-word timing

The host word inspector includes **Adjust timing**. It expands an inline raw-source waveform with start/end handles, source-second fields and bounded preview. The same inspector content is used by the responsive transcript editor. Drag release saves once; keyboard and numeric changes require **Apply timing**. **Undo timing** closes the draft and restores the stored boundaries. See the [Wordbar guide](https://github.com/calebn/sharecut-studio/blob/main/docs/daw-editing.md#wordbar-source-timing) for source identity, warnings and audio consequences.

### Realtime connection

Studio uses one host realtime connection for collaboration, document edits and recording.
Reconnect restores each plane from its initial state. Recording roster updates apply
before following connection signals, including when guests join between paints.

Timeline fade corners and trim strips support focused Left/Right nudges, Shift for larger steps, release or blur to save one undo step, and Escape to discard the preview. A held arrow stops at the playhead, a chapter or a neighbouring edge with a bump and a spoken note; a fresh press goes past it. On touch, a second finger on the timeline cancels any one-finger edit in progress without saving it, so a pinch only zooms.

Inspector trim release keeps its preview owned while saving. Other edits use
the clean geometry, and a returned document change retires the preview atomically.
