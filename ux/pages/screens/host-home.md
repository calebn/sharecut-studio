## Host home (no project)

| | |
|--|--|
| **Purpose** | Start a new episode (Import audio or Record) or reopen a recent one on the host |
| **Primary actions** | **Import audio** · **Record** · recent episode cards (**Find…** when a folder moved) · **Open other…** (OS folder picker via the local engine, or a path field) · the app menu on the ShareCut wordmark (no Help or More button of its own): **Settings** (a side sheet: Appearance, Saved in, Models, Keyboard shortcuts; inside a project also the Longest automatic join fade), **Connect agent**, **Help** (a 320 px popover under the wordmark on a desktop, a sheet on phone and tablet: Shortcuts and gestures, Report a problem, Guides; the report step has Back beside its title and each step change is announced; Report a problem lets you create and preview a sanitized diagnostics zip; optionally submit a public report after consent, or open a prefilled GitHub issue and attach the local zip; local **Exporting…** busy, not StatusBar) |
| **Data shown** | Recent episodes (name, length, last edited, the stage they open to); a path to the episode folder (Open other, browsers without a folder picker) |
| **Pinned project** | Opening `/` while a project is pinned goes straight to that project; `/?home=1` (the not-served cover’s “All projects”, Studio **New project**) shows home. Only New project unpins (a reload of `/` returns to the open project, keeping the desktop close-guard marker); if the unpin fails or takes over 10 s, Studio stays open, says so in the status line, and best-effort re-pins the open project (the server may still finish the stalled unpin late). New and Open are refused while this browser tab is recording, in a plain browser as well as the desktop app. |
| **Empty / error** | Missing OS dialog tool → keep paste field + alert; wrong filename → server error |
| **Out of scope** | Guests / share tokens; uploading project JSON as a browser File |
