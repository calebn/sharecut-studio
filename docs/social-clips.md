# Social clips

Propose short highlight clips from combined transcripts and export WAV + JSON sidecars to `export/clips/`.

## MCP

- `propose_social_clips_tool` — heuristic ranking (hooks, energy, duration, sentence-like starts; mid-utterance chunks are demoted)
- `social_clip_report_tool` — markdown summary
- `approve_social_clips_tool` / `reject_social_clips_tool`
- `export_social_clips_tool` — audio only

Titles/captions truncate at word boundaries. Platform presets: `.agents/defaults/pipeline.yaml` → `social_clips.platforms`.

## Timebase

`SocialClipCandidate.start`/`end` are **timeline** (deliverable) seconds. Clips are
scored on source-clock combined utterances, but each candidate's times are mapped
through `SessionTimeline` because export cuts the premix/mastered audio, which lives
on the edited timeline clock. Utterances that fall entirely inside removed material
are dropped. See [docs/episode-format-v2.md](episode-format-v2.md) for the two clocks.

## Skill

`.agents/skills/podcast-social-clips/SKILL.md`

## Video (planned)

See [ROADMAP.md § Video podcast (minimum)](../ROADMAP.md#video-podcast-minimum) and [§ Video — social repurposing](../ROADMAP.md#video--social-repurposing). Timestamps on `SocialClipCandidate` are canonical for future video work.
