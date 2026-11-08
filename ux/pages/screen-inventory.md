# Screen inventory — ShareCut Studio

Per-surface **display schemas**: what regions exist, what data they show, empty/loading states, and what’s out of scope. Pair with [Domain glossary](#/glossary) for field definitions.

**Breakpoints:** phone &lt;768 · tablet 768–1180 · desktop &gt;1180. Spec: [docs/gui-mobile.md](https://github.com/calebn/sharecut-studio/blob/main/docs/gui-mobile.md).

**Live reference:** [See the UI](#/demo) — screenshots + [`sharecut_ux_demo`](https://github.com/calebn/sharecut-studio/tree/main/tests/fixtures/sharecut_ux_demo) fixture.

---

## Pages

One file per page under `ux/pages/screens/`, so parallel UI changes edit different files.

| Page | File |
|--|--|
| [Host home (no project)](#/screens/host-home) | `screens/host-home.md` |
| [Help report flow (Home and Studio host)](#/screens/help-report-flow) | `screens/help-report-flow.md` |
| [Information architecture](#/screens/information-architecture) | `screens/information-architecture.md` |
| [Shared: App header, Stage bar and Player bar](#/screens/app-header-stage-bar-player-bar) | `screens/app-header-stage-bar-player-bar.md` |
| [Podcast listing (Deliver section)](#/screens/podcast-listing) | `screens/podcast-listing.md` |
| [Transcript export (Deliver section)](#/screens/transcript-export) | `screens/transcript-export.md` |
| [Host: Share (Deliver section)](#/screens/host-share) | `screens/host-share.md` |
| [Host: Connect agent dialog](#/screens/host-connect-agent) | `screens/host-connect-agent.md` |
| [Shared: Selection → Inspector / Bottom sheet](#/screens/selection-inspector) | `screens/selection-inspector.md` |
| [Phone — Review (the old Listen)](#/screens/phone-review) | `screens/phone-review.md` |
| [Phone — Edit: Timeline](#/screens/phone-edit-timeline) | `screens/phone-edit-timeline.md` |
| [Phone — Edit: Script](#/screens/phone-edit-script) | `screens/phone-edit-script.md` |
| [Phone — Mix](#/screens/phone-mix) | `screens/phone-mix.md` |
| [Phone — where the More hub went](#/screens/phone-more-hub) | `screens/phone-more-hub.md` |
| [Tablet](#/screens/tablet) | `screens/tablet.md` |
| [Desktop — Edit stage](#/screens/desktop-edit-stage) | `screens/desktop-edit-stage.md` |
| [Guest / share (`/r/{token}`)](#/screens/guest-share) | `screens/guest-share.md` |
| [Guest / record (`/rec/{token}`) (Join sheet + full-quality recording + mix-minus + landing + live comments shipped)](#/screens/guest-record) | `screens/guest-record.md` |
| [Cross-cutting states](#/screens/cross-cutting-states) | `screens/cross-cutting-states.md` |
| [Wireframe coverage checklist](#/screens/wireframe-coverage) | `screens/wireframe-coverage.md` |
