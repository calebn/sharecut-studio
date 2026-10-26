# Open product questions for Caleb

Questions from the three specs, merged and cut down to the ones only Caleb can answer. Every other disagreement is decided in design-system.md section 5. Each question names its default. The default is recorded below as a decision and the work follows it until Caleb says otherwise. Only Q1 affects code in the foundation slice (#2291): the stage ids and their order in `gui/web/src/system/`.

Sources: E = spec-edit, R = spec-record, D = spec-review-deliver.

**Q1. Stage order.** (R Q1)
- Options: (a) Record, Prepare, Edit, Review, Deliver. (b) Prepare, Record, Edit, Review, Deliver.
- Decision (default, until Caleb overrides): (a). Recording is how most episodes start, and Prepare is "what happens to the audio".
- Consequence: Record is Mod+1 and Prepare is Mod+2. Edit, Review and Deliver keep Mod+3 to Mod+5 either way. An import-first project opens on Prepare and never has to visit Record.

**Q2. Which stage a project opens to.** (D Q6; E's landing rule)
- Options: (a) the stage it needs next: Prepare while processing, Review if anything is undecided, otherwise Edit. (b) the stage you last used.
- Decision (default, until Caleb overrides): (a), with the Project card's chip naming the stage before you click, and (b) as the fallback when nothing is waiting.
- Consequence: (a) anticipates the next job but can move you somewhere you didn't leave. (b) is predictable but sometimes opens on finished work.

**Q3. Where a later recording session lands.** (R Q2)
- Options:
  - (a) At its target. "At the end" and "Starts the episode" apply directly. Insert and Replace become Review suggestions with before and after listening.
  - (b) Always append, and you move it in Edit.
  - (c) Land in an unplaced takes bin, and you drag it in.
  - (d) Each session becomes its own version of the episode.
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) needs the Session target chip and a pickup suggestion type. (b) is simplest, but pickups need hand cutting. (c) adds a step every time. (d) is the heaviest model.

**Q4. Recording alone.** (R Q3)
- Options: (a) allow a solo take, for intros, pickups and solo shows. (b) keep "Start needs a guest".
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) needs a server rule change. Pickups from Edit only work with (a).

**Q5. Invite links for recording.** (R Q4)
- Options: (a) a new link per session. (b) one standing "studio door" link per project that always opens the current session.
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) means an old link can't drop someone into today's room, and the expiry and recovery rules stay as they are. (b) is easier for repeat co-hosts but needs a revocation story.

**Q6. Who sees comments during a recording.** (R Q5)
- Options: (a) markers are visible to everyone, and written notes default to host and producers, with an "Everyone" toggle in the Composer. (b) everything is visible to everyone.
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) keeps "Jon's level is low" private and adds one chip to the Composer. (b) is simpler and more shared.

**Q7. Headphones as a hard gate to join a recording.** (R Q6)
- Options: (a) a hard gate on desktop and a strong warning on phones. (b) a hard gate everywhere. (c) a warning everywhere.
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) lets a phone guest with no headphones record, relying on echo cancellation. (b) turns some guests away.

**Q8. Video in recording.** (R Q7)
- Options: (a) audio only now, with 4:3 tiles that can hold video later. (b) a video monitor only. (c) recorded video.
- Decision (default, until Caleb overrides): (a).
- Consequence: (b) and (c) are roadmap items. (a) costs nothing now and needs no layout change later.

**Q9. Does approving a cut after listening count as checking the transcript?** (D Q1)
- Options: (a) yes. "Cut anyway" records a waiver with the reason "Approved after listening in Review" and your name, once per session. (b) no. Someone must step through the unsure words, or type a reason.
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) removes the dead end, and the Checks group still offers the unsure-word pass. (b) is safer but blocks the main Review flow.

**Q10. Word timing in the default download.** (D Q2)
- Options: (a) include the word aligner in "Get ready", about 2 GB in total. (b) leave it optional, about 1.6 GB.
- Decision (default, until Caleb overrides): (a).
- Consequence: without it, cuts may clip word edges. That is the main risk of losing a real word.

**Q11. Find suggestions automatically after transcription.** (D Q3)
- Options: (a) yes, at "How tight: Medium". It proposes and never applies. (b) only when you ask.
- Decision (default, until Caleb overrides): (a).
- Consequence: (a) means Review is populated the first time you open it, and the Review badge shows a count straight away.

**Q12. How far text editing reaches into audio.** (E Q7, Q8)
- Options:
  - (a) Typing on words corrects the transcript only, and dragging words to reorder audio waits.
  - (b) Add drag-to-reorder now.
  - (c) Add voice regeneration (typing makes new audio).
- Decision (default, until Caleb overrides): (a).
- Consequence: (b) adds a move gesture to the Script and a ripple model. (c) is a product and ethics decision with consent implications for guests.
