"""Export SpeechBrain's ECAPA embedding network to the ONNX file the app ships (#1998).

Needs torch, speechbrain, onnx and onnxruntime (``pip install torch speechbrain onnx
onnxruntime soundfile``, CPU torch is enough); none are project dependencies. Writes
``ecapa-voxceleb-embedding.onnx`` and prints its sha256 for ``contracts/bootstrap-assets.json``.
It then checks the export against the torch pipeline on the model card's example audio and
fails when the embeddings' cosine similarity drops below 0.9999.

    python scripts/export_ecapa_onnx.py OUT_DIR
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import numpy as np

from podcast_mcp.engines.models.ecapa_features import ecapa_features
from podcast_mcp.engines.models.speaker_ecapa import SOURCE_REPO, SOURCE_REVISION

OUTPUT_NAME = "ecapa-voxceleb-embedding.onnx"
MIN_COSINE = 0.9999


def main(out_dir: Path) -> int:
    import onnxruntime as ort
    import soundfile
    import torch
    from huggingface_hub import snapshot_download
    from speechbrain.inference.speaker import EncoderClassifier

    out_dir.mkdir(parents=True, exist_ok=True)
    snapshot = Path(
        snapshot_download(SOURCE_REPO, revision=SOURCE_REVISION, local_dir=out_dir / "snapshot")
    )
    classifier = EncoderClassifier.from_hparams(source=str(snapshot), savedir=str(out_dir / "pre"))
    classifier.eval()

    class Embedding(torch.nn.Module):
        def __init__(self, model: torch.nn.Module) -> None:
            super().__init__()
            self.model = model

        def forward(self, features: torch.Tensor) -> torch.Tensor:
            return self.model(features, torch.ones(features.shape[0]))

    target = out_dir / OUTPUT_NAME
    torch.onnx.export(
        Embedding(classifier.mods.embedding_model).eval(),
        (torch.randn(1, 300, 80),),
        str(target),
        input_names=["features"],
        output_names=["embedding"],
        dynamic_axes={"features": {1: "frames"}},
        dynamo=False,
        opset_version=17,
    )

    session = ort.InferenceSession(str(target), providers=["CPUExecutionProvider"])
    worst = 1.0
    for name in ("example1.wav", "example2.flac"):
        samples, rate = soundfile.read(snapshot / name, dtype="float32")
        if samples.ndim > 1:
            samples = samples[:, 0]
        assert rate == 16000, (name, rate)
        with torch.no_grad():
            want = classifier.encode_batch(torch.from_numpy(samples)[None]).squeeze().numpy()
        got = session.run(None, {"features": ecapa_features(samples)[None]})[0].reshape(-1)
        cosine = float(want @ got / np.linalg.norm(want) / np.linalg.norm(got))
        print(f"{name}: cosine {cosine:.6f}")
        worst = min(worst, cosine)
    print(f"sha256 {hashlib.sha256(target.read_bytes()).hexdigest()}  {target}")
    return 0 if worst >= MIN_COSINE else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(Path(sys.argv[1])))
