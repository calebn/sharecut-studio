# aligned_dialogue

Two-speaker episode project (60s) for e2e tests, MCP tools, and skills.

**Project:** `episode.project.json`  
**Tracks:** `reference`, `guest`  
**Overview peaks:** `artifacts/peaks/{reference,guest}.json` (uint8, tracked so Playwright e2e can hit `/api/peaks/` without generating on the runner)

## Quick commands

```bash
PROJECT=tests/fixtures/aligned_dialogue/episode.project.json

podcast fixture seed-transcript --project "$PROJECT" \
  --from tests/fixtures/canned_transcript_aligned.json

podcast play --project "$PROJECT" --compare --start 18 --end 28 --rerender
podcast propose-edits --project "$PROJECT"
podcast render-preview --project "$PROJECT"
```

**Transcript search terms:** `documented`, `people`, `today`, `going`, `great`

E2e tests copy this tree into `tmp_path` and rewrite `workspace_dir` to the copy (`e2e_workspace`), so runs never write into these committed files. Prefer that copied workspace over this committed path when experimenting locally.
