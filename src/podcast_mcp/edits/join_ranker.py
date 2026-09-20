"""Numpy logistic-regression join ranker trained on explicit join_labels.

Fail-closed: inference may only elevate risk / worsen verdict. Threshold chosen
so false-pass rate on labeled fails is ≤ 5% when enough labels exist.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.edits.join_continuity import JoinContinuityReport
from podcast_mcp.edits.join_labels import JoinLabel, export_training_table


@dataclass
class JoinRankerModel:
    weights: np.ndarray
    bias: float
    feature_names: list[str]
    threshold: float
    false_pass_rate: float
    n_train: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "weights": self.weights.tolist(),
            "bias": float(self.bias),
            "feature_names": list(self.feature_names),
            "threshold": float(self.threshold),
            "false_pass_rate": float(self.false_pass_rate),
            "n_train": int(self.n_train),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> JoinRankerModel:
        return cls(
            weights=np.asarray(d["weights"], dtype=np.float64),
            bias=float(d["bias"]),
            feature_names=list(d["feature_names"]),
            threshold=float(d["threshold"]),
            false_pass_rate=float(d.get("false_pass_rate", 1.0)),
            n_train=int(d.get("n_train", 0)),
        )


def _sigmoid(z: np.ndarray) -> np.ndarray:
    z = np.clip(z, -30, 30)
    return 1.0 / (1.0 + np.exp(-z))


def train_join_ranker(
    labels: list[JoinLabel],
    *,
    max_false_pass: float = 0.05,
    lr: float = 0.15,
    epochs: int = 400,
) -> JoinRankerModel:
    X, y, names = export_training_table(labels)
    if X.shape[0] < 4 or not names:
        # Degenerate: always predict fail (fail-closed)
        return JoinRankerModel(
            weights=np.zeros(1),
            bias=5.0,
            feature_names=["risk"],
            threshold=0.5,
            false_pass_rate=0.0,
            n_train=int(X.shape[0]),
        )
    # Standardize
    mu = X.mean(axis=0)
    sd = X.std(axis=0) + 1e-6
    Xs = (X - mu) / sd
    w = np.zeros(Xs.shape[1], dtype=np.float64)
    b = 0.0
    for _ in range(epochs):
        p = _sigmoid(Xs @ w + b)
        err = p - y
        w -= lr * (Xs.T @ err) / Xs.shape[0]
        b -= lr * float(np.mean(err))
    scores = _sigmoid(Xs @ w + b)
    # Threshold: among fails (y=1), allow ≤5% scored below threshold (false pass)
    fail_scores = scores[y >= 0.5]
    if fail_scores.size == 0:
        thr = 0.5
        fpr = 0.0
    else:
        # Sort ascending; threshold = percentile so that ≤5% of fails are below
        thr = float(np.percentile(fail_scores, max_false_pass * 100.0))
        fpr = float(np.mean(fail_scores < thr))
        # Fold standardization into weights: score(x) = sigmoid( ((x-mu)/sd) @ w + b )
        # = sigmoid( x @ (w/sd) + (b - mu·(w/sd)) )
    w_raw = w / sd
    b_raw = float(b - np.dot(mu, w / sd))
    return JoinRankerModel(
        weights=w_raw,
        bias=b_raw,
        feature_names=names,
        threshold=thr,
        false_pass_rate=fpr,
        n_train=int(X.shape[0]),
    )


def save_ranker(model: JoinRankerModel, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model.to_dict(), indent=2), encoding="utf-8")


def load_ranker(path: Path) -> JoinRankerModel | None:
    if not path.is_file():
        return None
    return JoinRankerModel.from_dict(json.loads(path.read_text(encoding="utf-8")))


def default_ranker_path(project_artifacts: Path | None = None) -> Path:
    if project_artifacts is not None:
        return project_artifacts / "join_ranker.json"
    return Path("artifacts") / "join_ranker.json"


def _feature_vector(report: JoinContinuityReport, names: list[str]) -> np.ndarray:
    flat: dict[str, float] = {"risk": float(report.risk)}
    for h in report.detectors:
        flat[f"det:{h.name}"] = float(h.score)
    neural = report.neural or {}
    if isinstance(neural.get("nisqa"), dict):
        n = neural["nisqa"]
        for k in ("discontinuity_delta", "mos_delta"):
            if isinstance(n.get(k), (int, float)):
                flat[f"neural:{k}"] = float(n[k])
    if isinstance(neural.get("wavlm"), dict) and isinstance(neural["wavlm"].get("z"), (int, float)):
        flat["neural:z"] = float(neural["wavlm"]["z"])
    return np.asarray([float(flat.get(n, 0.0)) for n in names], dtype=np.float64)


def predict_fail_proba(model: JoinRankerModel, report: JoinContinuityReport) -> float:
    x = _feature_vector(report, model.feature_names)
    return float(_sigmoid(np.asarray([np.dot(x, model.weights) + model.bias]))[0])


def apply_ranker_to_report(
    report: JoinContinuityReport,
    *,
    model_path: Path | None = None,
) -> JoinContinuityReport:
    """Elevate risk/verdict when ranker says fail; never lower them."""
    if model_path is None or not model_path.is_file():
        return report
    model = load_ranker(model_path)
    if model is None or model.n_train < 4:
        return report
    p = predict_fail_proba(model, report)
    report.ranker = {
        "available": True,
        "fail_proba": round(p, 4),
        "threshold": model.threshold,
        "n_train": model.n_train,
    }
    if p >= model.threshold:
        report.risk = max(report.risk, 0.48)
        report.invisibility = max(0.0, 1.0 - report.risk)
        if report.verdict == "pass":
            report.verdict = "review"
            report.reasons.append("ranker elevated pass→review")
        elif report.verdict == "review" and p >= min(0.85, model.threshold + 0.2):
            report.verdict = "fail"
            report.reasons.append("ranker elevated review→fail")
            report.risk = max(report.risk, 0.48)
    return report
