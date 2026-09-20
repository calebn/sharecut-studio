# Minimal episode example

```bash
# From repo root after install
podcast episode init --dir ./examples/minimal_episode/workspace
# Add your WAV files to workspace/raw/ then:
podcast track add --project ./examples/minimal_episode/workspace/episode.project.json \
  --id host --file ./examples/minimal_episode/workspace/raw/host.wav
podcast pipeline run --project ./examples/minimal_episode/workspace/episode.project.json
```
