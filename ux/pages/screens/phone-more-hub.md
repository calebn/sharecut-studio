## Phone — where the More hub went

The More hub was removed. Its destinations:

| Old destination | Now | Source |
|-----------------|-----|--------|
| Mix | Mix button on Edit: full-height track sheet; saved Volume/M and local S | Existing mix/listen state |
| Comments | Review → Queue: comments are queue items with the thread on the card | `review.comments` |
| History | Edit → History sheet (right-click the header's Undo, or the palette): undo/redo · grouped steps (follows document snapshots) | `history` |
| Review queue | Review → Queue: pending suggestions decided one at a time or by group | `editorial.edit_decisions` |
| Pipeline | Prepare: Sources · Getting ready · Help the transcriber · Cleanup; Advanced steps behind a button | working-set config + live job |
| Commands and shortcuts | Header search | command catalog |
| Gestures | Commands and shortcuts, Gestures group (touch pointer, in a project) | static |
| View options | Eye popover | static |

In Commands and shortcuts, each option's accessible name starts with the command
label, followed by its visible category during search, shortcut, and collision
note or unavailable reason. Spaces separate the fragments. The shortcut and note
appear once in the name. Search keeps focus while the arrow keys move through
all commands, including unavailable ones; Enter runs only an available command.

With Search empty, Commands and shortcuts lists Recent, then the commands by
category, then a **Stages** group (Go to Record, Prepare, Edit, Review and
Deliver; a stage the link cannot enter shows its reason), then Projects, People
and Chapters, a **Gestures** group (touch pointer, in a project: one row per gesture), and a **Help**
group (Report a problem…, shown disabled with its reason on guest and review
links). Searching lists matches in one ranked list; "stages" and "help" find
those rows. Commands with a verb icon, and every stage, show a small decorative
icon before the label; it adds nothing to the option's accessible name.

**Guest** (Commenter): Review alone, with Comments and the eye popover. History / Pipeline and the host queue stay host-only.

Long-lived panels are stages or sections; do not stack sheets to reach them.
