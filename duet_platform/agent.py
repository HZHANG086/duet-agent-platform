"""A bounded review workflow that delegates classification to DUET."""

import io
import logging
from pathlib import PurePosixPath
from time import perf_counter
from uuid import uuid4

from PIL import Image, UnidentifiedImageError

MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 20_000_000
FORMATS = {"JPEG", "PNG", "WEBP"}
BORDERLINE_MARGIN = 0.15
STRONG_DISAGREEMENT = 0.8
JPEG_QUALITY = 65
LOGGER = logging.getLogger(__name__)


class InvalidImage(ValueError):
    pass


def decode_image(payload):
    if not payload:
        raise InvalidImage("Choose a JPEG, PNG or WebP image.")
    if len(payload) > MAX_BYTES:
        raise InvalidImage("The image exceeds 8 MiB.")
    try:
        with Image.open(io.BytesIO(payload)) as source:
            width, height = source.size
            if source.format not in FORMATS or getattr(source, "n_frames", 1) != 1:
                raise InvalidImage("Use a single-frame JPEG, PNG or WebP image.")
            if width * height > MAX_PIXELS:
                raise InvalidImage("The image exceeds 20 megapixels.")
            return source.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise InvalidImage("The image could not be decoded.") from exc


def inspect_image(detector, payload, filename, force_recheck=False):
    started = perf_counter()
    image = decode_image(payload)
    name = PurePosixPath(filename.replace("\\", "/")).name or "upload"
    width, height = image.size
    trace = []

    def record(tool, status, start, inputs, outputs):
        trace.append({
            "tool": tool,
            "status": status,
            "elapsed_ms": round((perf_counter() - start) * 1000, 2),
            "input": inputs,
            "output": outputs,
        })

    record("decode_image", "succeeded", started, {"bytes": len(payload)}, {
        "width": width, "height": height, "color_mode": image.mode,
    })
    started = perf_counter()
    primary = detector.score(image, name)
    record("duet_primary", "succeeded", started, {"image": "original"}, primary)

    started = perf_counter()
    reasons = []
    margin = abs(primary["score"] - 0.5)
    spread = max(primary["votes"]) - min(primary["votes"])
    if margin <= BORDERLINE_MARGIN:
        reasons.append("near_decision_threshold")
    if spread >= STRONG_DISAGREEMENT:
        reasons.append("expert_disagreement")
    record("evaluate_review_policy", "succeeded", started, {
        "score_margin": margin,
        "expert_vote_spread": spread,
        "maximum_borderline_margin": BORDERLINE_MARGIN,
        "minimum_disagreement": STRONG_DISAGREEMENT,
        "maximum_rechecks": 1,
    }, {
        "next_action": "recheck_jpeg" if reasons or force_recheck else "complete",
        "reasons": reasons.copy(),
        "requested_recheck": force_recheck,
    })

    check = None
    if reasons or force_recheck:
        started = perf_counter()
        inputs = {"image": "original", "jpeg_quality": JPEG_QUALITY}
        try:
            with io.BytesIO() as buffer:
                image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
                buffer.seek(0)
                with Image.open(buffer) as recompressed:
                    check = detector.score(recompressed.convert("RGB"), name)
        except (RuntimeError, ValueError, OSError) as exc:
            LOGGER.warning("DUET JPEG recheck failed (%s)", type(exc).__name__)
            record("duet_jpeg_recheck", "failed", started, inputs, {"error": "recheck_failed"})
            reasons.append("recheck_failed")
        else:
            record("duet_jpeg_recheck", "succeeded", started, inputs, check)
            if primary["label"] != check["label"]:
                reasons.append("verdict_changed_after_recompression")

    started = perf_counter()
    status = "review" if reasons else "complete"
    record("finalize_review", "succeeded", started, {
        "primary_label": primary["label"],
        "recheck_label": check["label"] if check else None,
    }, {"status": status, "reasons": reasons.copy()})
    return {
        "filename": name,
        "width": width,
        "height": height,
        "model": detector.model_id,
        "run_id": str(uuid4()),
        "trace_version": 1,
        "model_runtime": getattr(detector, "runtime", {}),
        "primary": primary,
        "recompression_check": check,
        "status": status,
        "reasons": reasons,
        "trace": trace,
    }
