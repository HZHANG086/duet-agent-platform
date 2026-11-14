"""Adapter for the upstream DUET v3 inference code."""

import os
import sys
from pathlib import Path
from time import perf_counter

UPSTREAM_COMMIT = "829ca4cb4e83d35d8be4d2ddafc5359524b4649a"
MODEL_ID = "DUET v3 · DINOv2 ViT-g/14"
THRESHOLD = -8.7


class Detector:
    model_id = MODEL_ID

    def __init__(self):
        source = Path(os.environ["DUET_SOURCE"]).resolve()
        checkpoints = Path(os.environ["DUET_CHECKPOINTS"]).resolve()
        if not (source / "Inference.py").is_file():
            raise ValueError("DUET_SOURCE must point to the upstream checkout.")
        shallow = checkpoints / "mix2_shallow"
        deep = checkpoints / "mix2_deep"
        gate = checkpoints / "mix2_gate.pt"
        if not all(path.is_file() for path in (shallow / "stage1.pt", deep / "stage1.pt", gate)):
            raise ValueError("DUET_CHECKPOINTS must contain the two v3 expert banks and gate.")
        sys.path.insert(0, str(source))
        import Inference as upstream

        self.upstream = upstream
        device = os.environ.get("DUET_DEVICE") or upstream.default_device()
        backbone = os.environ.get("DUET_BACKBONE", "facebook/dinov2-giant")
        self.network = upstream.DUET(shallow, deep, gate, backbone, device=device)

    def score(self, image, filename):
        upstream = self.upstream
        kernel = upstream.pick_kernel(filename) if min(image.size) < 512 else None
        image = upstream.normalize(image, 512, kernel, fit="crop")
        start = perf_counter()
        logits, clean, gates, votes, _ = self.network.predict([image], [filename])
        logit, shallow = float(logits[0]), bool(clean[0])
        layers = upstream.SHALLOW_LAYERS if shallow else upstream.DEEP_LAYERS
        return {
            "score": upstream.pred_score(logit, THRESHOLD),
            "label": "synthetic" if logit > THRESHOLD else "real",
            "route": "shallow" if shallow else "deep",
            "layers": layers,
            "votes": upstream._sigmoid(votes[0]).tolist(),
            "gate_logit": float(gates[0]),
            "depth": upstream.EXIT_DEPTH if shallow else upstream.FULL_DEPTH,
            "inference_ms": round((perf_counter() - start) * 1000, 1),
        }
