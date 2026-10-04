# Volume envelope workflow evidence

Previously an empty track told users to drag existing points. The track Inspector now exposes **Add volume envelope**. The workspace explains track gain and offers **Add point**, exact timeline seconds and level, explicit Save/Cancel, and stable-ID point selection.

| Scene | Before | After |
| --- | --- | --- |
| Desktop, light | [Track details](before-desktop.png) | [First local draft](after-desktop-draft.png) |
| Phone, dark | [Track details](before-phone.png) | [Empty workspace](after-phone-empty.png), [saved point edit](after-phone-saved-edit.png) |

The screenshots come from real browser sessions. Before uses archived production GUI assets with the current backend and establishes visible discoverability only. After uses the plain production build. Observed JS/CSS response body hashes matched each selected build. [Screenshot provenance](screenshots.json) records exact image hashes and scenes.

Desktop and phone empty-track journeys each completed eight matching Applied commands across creation, Undo/Redo, edit/reorder, reload, deletion and Undo of final removal. Selection, layer visibility and canceled drafts wrote nothing. A genuine stale server compare-and-swap returned 409 without changing the winning state; a held accepted response produced one save and preserved a newer track selection.

On short phone screens, choose **Expand** before entering the envelope workspace. Opening the workspace does not expand the sheet automatically. Four ordinary responsive profiles passed; the two short-height profiles passed through this public Expand action. The original compact-sheet failures remain in the external run evidence.

[The historical 200% root-font inspection](phone-root-font-200.png) used a 360×740 viewport and doubled the CSS root font from 16px to 32px; it was not browser zoom. Before the separate sheet fix, Playwright’s `scrollIntoViewIfNeeded` brought control centers into a hit-testable region, and Cancel wrote nothing. The 63px region clipped 88px controls. This did not test wheel scrolling.

After the sheet fix in #958, a separate check used the same viewport, dark theme and reduced motion. [Initially all four form controls were below the visible region](phone-root-font-200-post-mac-initial.png). Nine native Tabs and Enter opened the track, public Expand opened the full sheet, and actual wheel input over measured noninteractive body areas reached the controls. Time and Level became fully visible; Save and Cancel had hit-testable centers but remained partly clipped. One Save created the default stable-ID point at 0 seconds and 1× with matching Applied identity and one history mutation. Editing Time to 2 and activating Cancel exited the draft without another write; the raw saved-state receipt remained unchanged. [The post-Cancel screenshot](phone-root-font-200-post-mac-cancel.png) shows the resulting viewport, with the focused point selector above the visible region. Observed JS/CSS bytes matched the fresh plain build, and wheel input left draft values unchanged.

This is qualified keyboard-entry and wheel/mouse control evidence. Two earlier pointer-entry attempts hit the unchanged track meter’s clear-clip button at the track identity center; that limitation remains. Another attempt exhausted its wheel budget while the body-center anchor lay over the focused Time input; it did not establish that all scroll positions were blocked. All three failed attempts remain in the external evidence. The passing check does not establish full-text visibility, pointer-entry success, a keyboard-only journey or general accessibility acceptance.

Real rendered PCM passed 12 full/window envelope cases with fixed gain expectations. Actual host media playback passed with a captured native-response prefix matched to the same complete versioned resource, same-object clock advancement and the fixed 0.4× PCM bound. The complete PCM came from a separate full-resource fetch; this is not proof of a complete native response body. All six existing native-owner recovery cases passed with trusted capture and explicitly synthetic foreign events. The corrected full Python run passed 8,840 tests but retained three boundary-audio failures at 95.62% coverage. Matched main/current evidence reproduced variable truncation in the unchanged shared full-stem renderer; this feature does not waive those failures. Full frontend passed 5,618 tests with one skip.

Physical touch, stylus, iOS, assistive technology, OS zoom and heard quality were not verified by these cloud sessions.

Two independent visual inspections reviewed the current draft scenes. The scoped Impeccable CLI detector exited 0 with no findings. Actual live-overlay injection was blocked by the production `script-src 'self'` policy; no live overlay or human-visible browser is claimed. The source policy was left intact.
