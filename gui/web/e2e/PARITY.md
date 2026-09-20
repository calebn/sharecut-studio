# Mobile / responsive parity checklist

Use with Playwright phone smoke (`e2e/sharecut.mobile.spec.ts`) and manual share-link checks.

## Host (phone)

- [ ] Listen: one body transport (no header row), play/pause, scrub, ±15s, status chips
- [ ] Timeline: fixed playhead, pinch/ctrl-wheel zoom, Fit, select clip → sheet
- [ ] Text: transcript follow / seek / Edit word → sheet
- [ ] More: Comments, History, Impact, Pipeline (hub → back)
- [ ] Transport Menu: layers, zoom, theme, audition

## Guest `view` (phone share)

- [ ] No History / Impact / Pipeline in More
- [ ] Listen + Text + Comments available
- [ ] Inspector sheet read-only / capability-gated actions

## Guest `suggest` / `edit`

- [ ] Pending approve/reject or suggest cut per capability
- [ ] Play around on pending sheet

## Tablet

- [ ] Timeline + track headers; selection opens peek sheet
- [ ] Landscape can still scroll timeline; Fit works

## Desktop

- [ ] Reaper grid intact; transport Menu declutter
- [ ] Focus `1`–`4` (default / timeline / text / review)
- [ ] Status chips jump to Impact / Pipeline / Comments
- [ ] Fade handles usable; pinch/ctrl-wheel zoom
