# audition_defects

By-construction labels for `audition_context` v2 hypothesis scoring. Audio is
**generated at test time** (not committed) via `build_defect_project`:

| Code | Injection |
|------|-----------|
| `hum_in_window` | 60 Hz + 120 Hz mixed into host 2–5 s |
| `clipping_in_window` | +24 dB hard clip on host 6–9 s |

Guest clip `timeline_start` offset 0.6 s is remaining-clip math, not a scored defect.

Gold spec: [`ground_truth/defects.json`](ground_truth/defects.json). Thresholds:
[`../audition_context_eval_thresholds.json`](../audition_context_eval_thresholds.json).

```bash
uv run python scripts/eval_audition_context.py --workspace /tmp/audition-defects
```

Join quality stays on [`../join_continuity`](../join_continuity) (separate tool).
Bleed stays on [`../synthetic_bleed_60s`](../synthetic_bleed_60s).
