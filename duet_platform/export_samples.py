"""Recompute the sample reports with a configured upstream checkout and v3 weights."""

import json
from pathlib import Path

from .agent import inspect_image
from .detector import UPSTREAM_COMMIT, Detector

DOCS = Path(__file__).resolve().parents[1] / "docs"


def main():
    detector = Detector()
    samples = (
        ("NASA original", "astronaut.png"),
        ("Resized and compressed", "astronaut-recompressed.jpg"),
        ("Gaussian blur", "astronaut-blurred.png"),
    )
    reports = []
    for title, filename in samples:
        path = DOCS / "samples" / filename
        report = inspect_image(detector, path.read_bytes(), filename)
        reports.append({"title": title, "url": f"samples/{filename}", "report": report})
    output = {"upstream_commit": UPSTREAM_COMMIT, "samples": reports}
    (DOCS / "samples.json").write_text(json.dumps(output, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
