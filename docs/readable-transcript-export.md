# Readable transcript export

Choose `readable.txt` in Transcript to write a paragraph-style reading copy next to the audio. The file uses the episode title, then one speaker and edited-time header for each adjacent speaker turn. Existing `txt`, `md`, `srt`, and `vtt` exports keep their current output. The default remains Markdown and SRT. Copy and preview continue to use the detailed text layout.

The exporter maps unsuppressed timed words through the edited timeline. It omits fully cut words, keeps a word when any part survives, and uses stored corrected text and punctuation. Repeated placements produce separate entries. Overlapping speakers stay in separate runs rather than interleaving individual words.

The exporter joins fragments for the same adjacent speaker. It preserves blank paragraph breaks stored in transcript text. It targets a paragraph break after 80 whitespace-delimited words at the next `.`, `!`, `?`, or `…`, including a closing quote or bracket. Without terminal punctuation, it breaks at an entry boundary after 160 words. It does not split a decimal or a token. A single long unpunctuated entry stays intact. This is a readability heuristic, not topic or sentence understanding.

Projects that contain only combined text can export intact utterances and omit fully removed utterances. If a cut removes only part of a combined-only utterance, `readable.txt` export and its dry run fail with `readable_timing_unavailable`. No file is published. Export a detailed format or restore word timings to proceed.

Audio export does not refresh `readable.txt`. An existing reading copy stays on disk and becomes stale when its source transcript changes. Select `readable.txt` again to refresh it. File listing reports its `text/plain` MIME type, exact safe name, and currentness.
