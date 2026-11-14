"""A bounded review workflow that delegates classification to DUET."""

import io
from pathlib import PurePosixPath

from PIL import Image, UnidentifiedImageError

MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 20_000_000
FORMATS = {"JPEG", "PNG", "WEBP"}
BORDERLINE_MARGIN = 0.15
STRONG_DISAGREEMENT = 0.8


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


def inspect_image(detector, payload, filename):
    image = decode_image(payload)
    name = PurePosixPath(filename.replace("\\", "/")).name or "upload"
    primary = detector.score(image, name)
    reasons = []
    if abs(primary["score"] - 0.5) <= BORDERLINE_MARGIN:
        reasons.append("near_decision_threshold")
    if max(primary["votes"]) - min(primary["votes"]) >= STRONG_DISAGREEMENT:
        reasons.append("expert_disagreement")

    check = None
    if reasons:
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=65)
        buffer.seek(0)
        with Image.open(buffer) as recompressed:
            check = detector.score(recompressed.convert("RGB"), name)
        if primary["label"] != check["label"]:
            reasons.append("verdict_changed_after_recompression")

    return {
        "filename": name,
        "width": image.width,
        "height": image.height,
        "model": detector.model_id,
        "primary": primary,
        "recompression_check": check,
        "status": "review" if reasons else "complete",
        "reasons": reasons,
    }
