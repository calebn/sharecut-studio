"""Shared fakes for CTC forced-alignment tests."""

from __future__ import annotations

import numpy as np

from podcast_mcp.engines.ctc_forced_align import CtcVocab, log_softmax

HI_BYE_TOKENS = {"<pad>": 0, "|": 1, "H": 2, "I": 3, "B": 4, "Y": 5, "E": 6}
HI_BYE_HOT = {0: 2, 1: 3, 3: 1, 4: 4, 5: 5, 6: 6}


class FakeBackend:
    """Deterministic backend: fixed logits regardless of the sample chunk."""

    def __init__(self, vocab: CtcVocab, hot: dict[int, int], frames: int, vocab_size: int) -> None:
        self._vocab = vocab
        self._hot = hot
        self._frames = frames
        self._vocab_size = vocab_size

    def log_probs(self, samples: np.ndarray) -> np.ndarray:
        lp = np.full((self._frames, self._vocab_size), np.log(0.01))
        lp[:, self._vocab.blank_id] = np.log(0.9)
        for frame, token in self._hot.items():
            lp[frame, :] = np.log(0.01)
            lp[frame, token] = np.log(0.9)
        return log_softmax(lp)
