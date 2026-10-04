# Volume envelope workflow evidence

Previously an empty track told users to drag existing points. The track Inspector now exposes **Add volume envelope**. The workspace explains track gain and offers **Add point**, exact timeline seconds and level, explicit Save/Cancel, and stable-ID point selection.

| Scene | Before | After |
| --- | --- | --- |
| Desktop, light | [Track details](before-desktop.png) | [First local draft](after-desktop-draft.png) |
| Phone, dark | [Track details](before-phone.png) | [Empty workspace](after-phone-empty.png), [saved point edit](after-phone-saved-edit.png) |

The screenshots come from real browser sessions. Before uses archived production GUI assets with the current backend and establishes visible discoverability only. After uses the plain production build. Observed JS/CSS response body hashes matched each selected build. [Screenshot provenance](screenshots.json) records exact image hashes and scenes.

Desktop and phone empty-track journeys each completed eight matching Applied commands across creation, Undo/Redo, edit/reorder, reload, deletion and Undo of final removal. Selection, layer visibility and canceled drafts wrote nothing. A genuine stale server compare-and-swap returned 409 without changing the winning state; a held accepted response produced one save and preserved a newer track selection.

On short phone screens, choose **Expand** before entering the envelope workspace. Opening the workspace does not expand the sheet automatically. Four ordinary responsive profiles passed; the two short-height profiles passed through this public Expand action. The original compact-sheet failures remain in the external run evidence.

[The 200% root-font inspection](phone-root-font-200.png) used a 360×740 viewport and doubled the CSS root font from 16px to 32px; it was not browser zoom. In the expanded sheet, Playwright’s `scrollIntoViewIfNeeded` brought the center of each Time, Level, Save and Cancel control into a hit-testable region. This did not test wheel scrolling. Cancel was activated without a document write. The 63px field region clips 88px controls, and the shared sheet title overlaps. This records limited reachability before the separate sheet fix, not full-text visibility or an accessibility certificate.

Real rendered PCM passed 12 full/window envelope cases with fixed gain expectations. Actual host media playback passed with a captured native-response prefix matched to the same complete versioned resource, same-object clock advancement and the fixed 0.4× PCM bound. The complete PCM came from a separate full-resource fetch; this is not proof of a complete native response body. All six existing native-owner recovery cases passed with trusted capture and explicitly synthetic foreign events. The corrected full Python run passed 8,840 tests but retained three boundary-audio failures at 95.62% coverage. Matched main/current evidence reproduced variable truncation in the unchanged shared full-stem renderer; this feature does not waive those failures. Full frontend passed 5,618 tests with one skip.

Physical touch, stylus, iOS, assistive technology, OS zoom and heard quality were not verified by these cloud sessions.

Two independent visual inspections reviewed the current draft scenes. The scoped Impeccable CLI detector exited 0 with no findings. Actual live-overlay injection was blocked by the production `script-src 'self'` policy; no live overlay or human-visible browser is claimed. The source policy was left intact.
