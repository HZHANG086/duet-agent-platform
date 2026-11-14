import io
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from duet_platform.agent import MAX_BYTES
from duet_platform.server import create_app


def sample():
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16)).save(buffer, "PNG")
    return buffer.getvalue()


class ControlledDetector:
    model_id = "test detector"

    def __init__(self, scores):
        self.scores = iter(scores)

    def score(self, image, filename):
        score, votes = next(self.scores)
        return {"score": score, "label": "synthetic" if score > 0.5 else "real", "votes": votes}


class InspectionTests(unittest.TestCase):
    def test_single_pass(self):
        detector = ControlledDetector([(0.1, [0.05, 0.1, 0.12])])
        with TestClient(create_app(lambda: detector)) as client:
            self.assertEqual(client.get("/api/health").json()["status"], "ready")
            response = client.post("/api/inspect", files={"image": ("sample.png", sample(), "image/png")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "complete")
        self.assertIsNone(response.json()["recompression_check"])

    def test_disagreement_triggers_check_and_flags_changed_verdict(self):
        detector = ControlledDetector([(0.4, [0, 0.9, 0]), (0.6, [0.6, 0.7, 0.5])])
        with TestClient(create_app(lambda: detector)) as client:
            response = client.post("/api/inspect", files={"image": ("sample.png", sample(), "image/png")})
        self.assertEqual(response.status_code, 200)
        report = response.json()
        self.assertEqual(report["status"], "review")
        self.assertEqual(report["primary"]["label"], "real")
        self.assertEqual(report["recompression_check"]["label"], "synthetic")
        self.assertEqual(report["reasons"], [
            "near_decision_threshold", "expert_disagreement", "verdict_changed_after_recompression"
        ])

    def test_reject_invalid_and_oversized_uploads(self):
        with TestClient(create_app(lambda: ControlledDetector([]))) as client:
            invalid = client.post("/api/inspect", files={"image": ("bad.png", b"bad", "image/png")})
            oversized = client.post("/api/inspect", files={"image": ("huge.png", bytes(MAX_BYTES + 1), "image/png")})
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(oversized.status_code, 413)


if __name__ == "__main__":
    unittest.main()
