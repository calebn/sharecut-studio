# Progress

- Read native poteto-mode in full, including Principles and Harness, companion Git/issue policy, and applicable architecture, contributing, UI, communication, interaction, decisions, beta, frontend, engineering, CSS, TypeScript, and leaf principle guidance.
- Read the unchanged model routing pin and both prior review artifacts. Checkout begins at `10a8f27926799bb1ad82e7ba3d9f3b98500ceea3`, base `80f05940f`.
- Confirmed `gui/mapper.py::_mapped_row` maps utterance source coverage through clips; `map_source_span` merges adjacent timeline results; `_mapped_word_index` maps each word through its own recording clips. `RollClipJoin` changes left `source_end` and right `source_start`, maintaining flush timeline clips. The defect concerns source coverage not the utterance bounds/spans.
- Confirmed DecisionCard's composite key remounts ActionPrompt and UnsureWord together. ReviewStage unsure target identity is `wordIdOf(track_id, source_id, word_index)`.
- Next: establish local reds, commit regression tests, apply the narrow repair, then focused checks and local fix commit.
