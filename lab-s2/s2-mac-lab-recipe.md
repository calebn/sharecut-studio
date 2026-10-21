# S2 (#1944) Mac lab before/after recipe, with S1 and PR 1949

Arms, all from the same Daniela clone state, one run each at N=20 and N=102 (same machine, quiet, record load average):

| Arm | Ref | What it adds |
| --- | --- | --- |
| A | 7741ffc | main before any S2 change |
| B | 632704d | + PR 1949 (transcript word index kept on the words) |
| C1 | PR 1950 first commit (5aa5c18) | + one autocorrelation answer per distinct frame per batch |
| C2 | PR 1950 head (33c57ef) | + clip membership by identity in `exact_source_span` (no model equality) |
| D | S1 (PR 1948) head | chain tracks on the evaluator (separate thread's recipe) |
| E | D + C2 merged | the combination, once S1 lands |

Later S2 PRs (audio facts store, `_owned_peer_frames` readers) add arms F, G on this table.

Build and run per arm (the S1 recipe's steps 1 to 3 give the clone and the warm state). For S2 use the in-process harness so the autocorrelation hit rate is read too:

    git checkout <ref>   # in a worktree, never the main checkout
    cp -Rc <daniela-102-state> /tmp/arm-<X>   # fresh clone per arm
    nice -n 10 python lab-s2/autocorr_hits.py /tmp/arm-<X>/episode.project.json 102

(The S1 recipe's HTTP route `POST /api/document/command` with `ApproveEdits` is the same code path; use it for the arm that must match S1's numbers exactly. Never port 8801, never `pkill -f "gui --project"`.)

Compare with the S1 comparer: `python lab-s1/diff_projects.py <arm-A project json> <arm-X project json>`.

Pass criteria (any difference in approved or held ids is a FAIL, even a single one):
1. Project JSON after the batch equals arm A's (ids and timestamps ignored, floats within 1 ms): same clips, same edit-log rows, same pending list.
2. The printed `held` list is identical across arms.
3. Run the whole matrix twice: once with the forced word aligner (`pipeline run --only transcribe_tracks --retime-words`) and once with Whisper word times alone (poteto lab rule: boundary-sensitive changes are checked both ways).
4. Report per arm: `wall_sec`, `autocorr_calls`, `autocorr_distinct` (hit rate = 1 - distinct/calls), load average.

What the lab must settle:
- Arm B vs A: the word index memo is exact by construction (invalidated on any word or list change); expect ids equal and the transcript scan cost gone. Report the wall delta.
- Arm C1 vs B: on the cloud tile the audio repeats 24 times, so the 99.9% hit rate is a lab number. On Daniela the hit rate is what decides whether PR 1950 is worth keeping: if distinct/calls stays above ~0.7, say so and PR 1950 should be closed instead of merged.
- Arm C2 vs C1: only the model-equality cost should move; ids must stay equal.
- Peak memory (RSS) of arm C1 at N=102 should stay below arm B plus about 100 MB (16-byte digest plus a tuple per distinct frame, kept until the batch ends).

Daniela audio stays on the Mac; nothing from the clone, its audio or its results beyond the numbers above goes into the repo or a PR comment.

## S3 arm (PR 1956, #1945, first slice: per-cut copy keeps word objects)

Arm S3 = PR 1956 head (branch `claude/s3-cut-copy`, base a410add) against arm A' = a410add (current main; arm A's 7741ffc predates #1813). Same recipe, same clone, same harness:

    git worktree add /tmp/wt-s3 origin/claude/s3-cut-copy
    cp -Rc <daniela-102-state> /tmp/arm-S3
    nice -n 10 python lab-s2/autocorr_hits.py /tmp/arm-S3/episode.project.json 102

Pass: approved and held ids and the project JSON equal arm A' (`lab-s1/diff_projects.py`), with and without the forced word aligner. Report `wall_sec` and peak RSS (RSS should drop: no per-cut word copies). The change assumes no cut writer edits a word's own fields; any word difference between arms is a FAIL. Cloud tile: ids and clips byte-identical, wall 124 s to 96 s under cProfile.

S3 slice 2 gate (hold restarts): also report, per arm, how many times `cut_application._apply_source_remove` ran against the number of pending removes (wrap it with a counter in the harness). On the cloud tile it is one call per remove (a single pass, 96 of 96, 0.62 s per cut after PR 1956), so a "single hold pass" change would save nothing there. Slice 2 is only worth building if Daniela shows calls well above removes (a restart from `mute_base`); if the ratio is about 1.0, close the idea.
