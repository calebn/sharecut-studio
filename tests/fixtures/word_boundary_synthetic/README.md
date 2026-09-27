# Synthetic word-boundary fixture

This fixture exists to prove the `word_boundary_metrics` metric and the
`benchmark_word_boundaries.py` harness exactly, with hand-computable numbers.
`tones.wav` is a 2.5 s, 16 kHz mono square-wave tone-burst WAV, not speech,
and is not used to judge aligner accuracy — see
`tests/fixtures/word_boundary/` for that.

## Gold words (`tones.gold.json`)

| word  | start | end  |
| ----- | ----- | ---- |
| one   | 0.20  | 0.50 |
| two   | 0.60  | 0.90 |
| three | 1.00  | 1.40 |
| four  | 1.50  | 1.80 |
| five  | 1.90  | 2.20 |

## Prediction (`tones.prediction.json`)

| word  | start | end  | Δstart ms | Δend ms |
| ----- | ----- | ---- | --------- | ------- |
| one   | 0.22  | 0.46 | +20       | −40     |
| two   | 0.60  | 0.90 | 0         | 0       |
| um    | 0.92  | 0.98 | (extra)   |         |
| three | 1.20  | 1.36 | +200      | −40     |
| four  | 1.44  | 1.80 | −60       | 0       |
| five  | —     | —    | (missed)  |         |

## Hand-computed results

| metric                | value                                       |
| ---------------------- | -------------------------------------------- |
| matched                | 4                                            |
| reference / predicted  | 5 / 5                                        |
| missed / extra         | 1 / 1                                        |
| MAE                    | (20+40+0+0+200+40+60+0) / 8 = **45.0 ms**    |
| over 150 ms            | 1 ("three")                                  |
| over-150 fraction      | **0.25**                                     |
| mean start error       | (20+0+200−60) / 4 = **+40.0 ms**             |
| mean end error         | (−40+0−40+0) / 4 = **−20.0 ms**              |

`measure_word_boundaries(gold["words"], prediction["words"])` and
`scripts/benchmark_word_boundaries.py --gold tones.gold.json --prediction
tones.prediction.json` both reproduce this table exactly.

## License and regeneration

`tones.wav` is generated in-repo and released under CC0-1.0. Regenerate it
byte-for-byte with:

```bash
uv run python -c "import sys; sys.path.insert(0, 'tests'); from test_word_boundary_metrics import tone_burst_wav_bytes, SYNTH_SPANS; open('tests/fixtures/word_boundary_synthetic/tones.wav', 'wb').write(tone_burst_wav_bytes(SYNTH_SPANS))"
```

Then update `audio_sha256` in both JSON files with `sha256_file`.
