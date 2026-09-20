---
name: podcast-pipeline-tune
description: >-
  Read and edit the shared Sharecut Studio pipeline working set (steps + params), run
  heuristic Analyze, then pipeline_run with those visible values. Use when
  configuring production settings in the GUI or via MCP before a run — not for
  an unattended full run with defaults (podcast-pipeline-run).
---

# Pipeline tune (visible params)

**Contract:** What the Pipeline pane shows is what `pipeline_run` uses. Agents and the GUI share the same in-memory working set for a project path.

## Flow

1. **Get** — `pipeline_get_config_tool(project_path)`  
   Returns `config`, `enabled_steps`, `unattended`, step metadata (`depends_on`, components), curated `params`, and `whisper_models` (catalog with `cached`). In the GUI, `transcribe.model` is a catalog picker; missing weights open a confirm Dialog that downloads via host bootstrap (`whisper` only). Pipeline **Run** (Sharecut Studio / MCP / CLI) does not download: missing weights with `transcribe_tracks` selected fail fast (HTTP 409 / tool error). Download via the picker Dialog, first-run wizard, or `podcast bootstrap --component whisper --whisper-model …`.
2. **Optional Analyze** — `pipeline_analyze_tool(project_path, apply=true|false)`  
   Heuristics from cleanup/health (hum, noise floor, gate overreach, bleed, clipping) → proposed patches. With `apply=true`, writes into the working set (same as GUI **Analyze**). Review `reasons[]`; do not treat Analyze as a full production run.
3. **Set** — `pipeline_set_config_tool(...)`  
   Pass `config_json`, `enabled_steps_json`, and/or `unattended`. Enabling a step expands `depends_on`. `reset=true` restores yaml defaults.
4. **Run** — `pipeline_run(project_path, unattended=..., use_working_set=true)`  
   Or pass `config_json` / `skip_steps_json` explicitly. GUI Batch mode = `unattended=true` (waive align + refine gates when their modes are `waive_unattended`). Leave-gates = `unattended=false`; if align or refine blocks, clear that gate then resume `--from` the next step.

## Modes

| Mode | `unattended` | Behavior |
|------|--------------|----------|
| Batch | `true` | Waive `require_align_accept` and refine gates when mode is `waive_unattended` (scorer still ran) |
| Leave gates | `false` | Gates can block; agent/human clears align (`podcast align done`) / refine, then resume |

Align params live under `align.*` (accept mode, max offset, bleed/gap knobs). Uncheck
**Align tracks** when clips are not one conversation — the accept gate follows via `depends_on`.

Do **not** expect the GUI to “summon” an agent. MCP is pull: you call tools.

## Related

- Full step order: **podcast-pipeline-run**
- Align listen/nudge: **podcast-align-audio**
- Audio diagnostics: **podcast-audio-cleanup**, [docs/audio-engineering.md](../../../docs/audio-engineering.md)
- GUI: Pipeline tab / phone More → Pipeline (master-detail checklist + param inspector)
