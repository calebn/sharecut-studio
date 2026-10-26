# Critique rubric (per screen, modal and interaction)

Base: coordinator's rubric for Caleb (project chat, 2026-10-25 22:01Z). Additions marked (+) fill gaps we hit in the 10-22 UX audit.

**Purpose**
- What is the user trying to get done here, and what brought them here?
- What is the one main thing this is for? Does it get the most space and attention?
- (+) Who uses it and how often: host, guest reviewer, record guest; desktop or phone; every edit or once per episode? Frequent things must be fastest.

**Anticipation**
- What will they most likely do next? Is that action the most obvious and closest at hand, without moving the mouse or opening a menu?
- What would they do after that? Does the screen set it up?

**Hierarchy and layout**
- Squint test: can you tell what matters most? Is anything competing?
- Is every element earning its space, or could it hide until needed?
- Do related controls sit together, in the order people use them?

**Interaction cost**
- How many clicks, keys or drags does the common case take? Could it be one?
- Can you act directly on the object (drag the clip, click the word) instead of a panel or dialog?
- Does this need to be a modal, or could it happen in place?
- (+) Does it respond instantly? Anything that waits must show progress and never block the next edit.

**Feedback and state**
- After an action, is it obvious what changed, and can you undo it?
- Does every state (empty, loading, error, in progress, offline) say what's going on and what to do?
- Can you hear or preview the result before committing?
- (+) Are destructive actions safe (undo first, confirm only when undo is impossible)?

**Language** (+)
- Does every label use the user's words, not command or model names (no "refine gate", "reports unsupported 6.1.1")?
- Is help shown once, at the moment it's needed, instead of as permanent text?

**Consistency and reach**
- Does the same kind of thing look and behave the same everywhere?
- Do keyboard, mouse and touch all feel first-class?
- (+) Does it hold from 320 px phone to 1920 desktop, in both orientations, with 44 px touch targets, visible focus and enough contrast?

**Bar**
- Would it look at home next to Logic, Descript or Figma? If not, what one thing gives it away?
- Would you screenshot it for the website?

## The bar, raised (Caleb, 2026-10-25 22:02Z)
"I'd kind of like us to hold ourselves to a higher bar cause we're designing this from the ground up in a world where we've learned so much from mobile."

Judge each item against the best mobile-native apps (Ferrite, Things, Apple Photos and Voice Memos editing, Procreate, Linear, Figma), not only desktop DAWs. Principles every spec must satisfy or say why not:
1. Direct manipulation first: act on the content (words, clips, waveforms), not on panels.
2. Progressive disclosure: show only what this moment needs; the rest appears on selection or intent.
3. One primary action per context, visually unmistakable.
4. Touch is first-class: thumb reach, 44 px targets, gestures designed in, not desktop shrunk down.
5. The content is the interface; chrome is minimal and recedes.
6. Immediate feedback and forgiving undo instead of confirmation dialogs.
7. Sensible defaults: the common path needs no settings.
8. Sheets, popovers and in-place edits over modals.
9. One model across phone, tablet and desktop: same objects, same verbs, layouts adapt.
10. One element per kind of thing (Caleb 22:04Z): reuse the same component, icon, color and gesture for the same concept everywhere (a cut is drawn one way in text, timeline, review and phone). Every spec names the shared element it uses or proposes.
11. Self-evident without labels (Caleb 22:04Z): "it should be clear what everything does without needing text labels." Shape, icon, position and behavior carry meaning; one consistent icon language. Labels and tooltips stay as accessible names and for first use, but nothing may depend on reading them. (This refines the Language check: words that do appear must be plain.)
