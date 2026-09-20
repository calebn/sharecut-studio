#!/usr/bin/env bash
# Download Mini LibriSpeech dev-clean-2 and copy 20 utterances into tests/fixtures/asr_gold/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/fixtures/asr_gold"
CACHE="${TMPDIR:-/tmp}/podcast_mcp_librispeech"
ARCHIVE="$CACHE/dev-clean-2.tar.gz"
URL="https://www.openslr.org/resources/31/dev-clean-2.tar.gz"
COUNT="${ASR_GOLD_COUNT:-20}"

mkdir -p "$CACHE" "$OUT/audio" "$OUT/reference"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "==> Downloading Mini LibriSpeech dev-clean-2"
  curl -L -o "$ARCHIVE" "$URL"
fi

if [[ ! -d "$CACHE/LibriSpeech/dev-clean-2" ]]; then
  echo "==> Extracting archive"
  tar -xzf "$ARCHIVE" -C "$CACHE"
fi

python3 - "$CACHE/LibriSpeech/dev-clean-2" "$OUT" "$COUNT" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
count = int(sys.argv[3])
flacs = sorted(src.rglob("*.flac"))[:count]
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


for i, flac_path in enumerate(flacs):
    stem = flac_path.stem
    text = _reference_text(flac_path)
    dest_audio = out / "audio" / f"{i:02d}_{stem}.flac"
    dest_audio.write_bytes(flac_path.read_bytes())
    ref_path = out / "reference" / f"{i:02d}_{stem}.txt"
    ref_path.write_text(text + "\n", encoding="utf-8")
    entries.append(
        {
            "id": f"{i:02d}_{stem}",
            "audio": str(dest_audio.relative_to(out)),
            "reference": str(ref_path.relative_to(out)),
            "text": text,
        }
    )
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

Mini LibriSpeech slice for ASR WER regression tests.

Regenerate:

```bash
./scripts/download_fixture_asr_gold.sh
```
EOF

echo "Done: $OUT"
