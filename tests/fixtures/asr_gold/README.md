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
