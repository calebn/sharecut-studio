# Mobile / responsive parity checklist

Use with Playwright phone smoke (`e2e/sharecut.mobile.spec.ts`) and manual share-link checks.

## Host (phone)

- [ ] Listen: one body transport (no header row), play/pause, scrub, ±15s, status chips
- [ ] Timeline: fixed playhead, pinch/ctrl-wheel zoom, Fit, select clip → sheet
- [ ] Select a pending edit and scroll it away: the dock keeps its verbs and shows a short "Show" control (named Show edit) before Clear (Show selection for any other selection); it fits at 320 px
- [ ] Text: transcript follow / seek / Edit word → sheet
- [ ] More: History, Pipeline (hub → back)
- [ ] Transport Menu: layers, zoom, theme, audition

## Guest `view` (phone share)

- [ ] No History / Pipeline in More
- [ ] Listen + Text available; Review has the Queue, and C opens the comment field above the card (host)
- [ ] Inspector sheet read-only / capability-gated actions

## Guest `suggest` / `edit`

- [ ] Pending approve/reject or suggest cut per capability
- [ ] Hear before and Hear after (A and B) on the pending sheet's Action bar, Seek to start under More (a Viewer link: Hear only, no Seek)

## Tablet

- [ ] Timeline + track headers; Inspect opens the compact drawer
- [ ] Landscape can still scroll timeline; Fit works
- [ ] Select a pending edit and scroll the timeline away: the Action bar stays on screen with its verbs and Show edit; Show edit scrolls it back and the button goes away (Show selection for any other selection)

## Desktop

- [ ] Reaper grid intact; transport Menu declutter
- [ ] Focus `1`–`4` (default / timeline / text / review)
- [ ] Status chips jump to Queue / Pipeline
- [ ] Fade handles usable; pinch/ctrl-wheel zoom
- [ ] Same on desktop: the pinned Action bar keeps its verbs and Show edit; the playhead and selection do not move
