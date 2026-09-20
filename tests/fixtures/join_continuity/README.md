# join_continuity

Tiny in-repo fixture (~3 s sine stems, ~570 KB total) for join-quality scoring,
label harvest, and ranker smoke tests.

**Do not** point harvest/tools at huge external episode trees. If you need real
speech examples, copy **short** clips into `raw/` here (keep under a few MB).

```bash
PROJECT=tests/fixtures/join_continuity/episode.project.json

# Prefer a tmp copy so harvest does not write into the fixture:
podcast fixture sandbox --project "$PROJECT"   # if available
# or:
uv run python scripts/harvest_join_labels.py --project "$PROJECT" --min-pass 2 --min-fail 20
```

Committed audio: `raw/host.wav`, `raw/guest.wav` (3 s mono 48 kHz).
