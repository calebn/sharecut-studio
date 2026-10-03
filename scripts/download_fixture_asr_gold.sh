#!/usr/bin/env bash
# Download Mini LibriSpeech dev-clean-2 and copy the three WER regression utterances into tests/fixtures/asr_gold/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/fixtures/asr_gold"
CACHE="${TMPDIR:-/tmp}/podcast_mcp_librispeech"
ARCHIVE="$CACHE/dev-clean-2.tar.gz"
URL="https://www.openslr.org/resources/31/dev-clean-2.tar.gz"

mkdir -p "$CACHE" "$OUT/audio" "$OUT/reference"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "==> Downloading Mini LibriSpeech dev-clean-2"
  curl -L -o "$ARCHIVE" "$URL"
fi

if [[ ! -d "$CACHE/LibriSpeech/dev-clean-2" ]]; then
  echo "==> Extracting archive"
  tar -xzf "$ARCHIVE" -C "$CACHE"
fi

python3 - "$CACHE/LibriSpeech/dev-clean-2" "$OUT" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
sample_ids = ("01_1272-135031-0001", "02_1272-135031-0002", "03_1272-135031-0003")
flacs = {path.stem: path for path in src.rglob("*.flac")}
entries = []
def _reference_text(flac_path: Path) -> str:
    chapter_dir = flac_path.parent
    chapter_trans = chapter_dir / f"{chapter_dir.parent.name}-{chapter_dir.name}.trans.txt"
    if not chapter_trans.is_file():
        return ""
    utterance_id = flac_path.stem
    for line in chapter_trans.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        token, _, body = line.partition(" ")
        if token == utterance_id:
            return body
    return ""


for sample_id in sample_ids:
    _, stem = sample_id.split("_", 1)
    flac_path = flacs[stem]
    text = _reference_text(flac_path)
    if not text:
        raise ValueError(f"missing reference text for {stem}")
    dest_audio = out / "audio" / f"{sample_id}.flac"
    dest_audio.write_bytes(flac_path.read_bytes())
    ref_path = out / "reference" / f"{sample_id}.txt"
    ref_path.write_text(text + "\n", encoding="utf-8")
    entries.append(
        {
            "id": sample_id,
            "audio": str(dest_audio.relative_to(out)),
            "reference": str(ref_path.relative_to(out)),
            "text": text,
        }
    )
for folder, extension, field in (("audio", ".flac", "audio"), ("reference", ".txt", "reference")):
    retained = {out / entry[field] for entry in entries}
    for path in (out / folder).glob(f"*{extension}"):
        if path not in retained:
            path.unlink()
manifest = {
    "source": "openslr.org/31 dev-clean-2",
    "license": "CC BY 4.0",
    "utterance_count": len(entries),
    "utterances": entries,
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(f"Wrote {len(entries)} utterances to {out}")
PY

cat > "$OUT/README.md" <<'EOF'
# asr_gold

Three Mini LibriSpeech `dev-clean-2` utterances for the ASR WER regression.
The committed audio totals 544,936 bytes. The regression uses all three clips
with the original reference text and a 12% WER ceiling per clip.

The source is [Mini LibriSpeech](https://www.openslr.org/31), derived from
LibriSpeech by Panayotov, Chen, Povey, and Khudanpur. The corpus is licensed
under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Regenerate the same clip IDs and filenames with:

```bash
./scripts/download_fixture_asr_gold.sh
```
EOF

echo "Done: $OUT"
