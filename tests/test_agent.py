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
        result = next(self.scores)
        if isinstance(result, Exception):
            raise result
        score, votes = result
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
        self.assertEqual([step["tool"] for step in response.json()["trace"]], [
            "decode_image", "duet_primary", "evaluate_review_policy", "finalize_review"
        ])
        self.assertEqual(response.json()["trace"][2]["output"]["next_action"], "complete")

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
        policy, recheck, outcome = report["trace"][2:]
        self.assertEqual(policy["output"]["next_action"], "recheck_jpeg")
        self.assertEqual(policy["output"]["reasons"], ["near_decision_threshold", "expert_disagreement"])
        self.assertEqual(recheck["input"]["jpeg_quality"], 65)
        self.assertEqual(recheck["output"], report["recompression_check"])
        self.assertEqual(outcome["output"]["reasons"], report["reasons"])

    def test_requested_recheck_runs_even_below_review_threshold(self):
        detector = ControlledDetector([(0.1, [0.1, 0.1]), (0.2, [0.2, 0.2])])
        with TestClient(create_app(lambda: detector)) as client:
            response = client.post(
                "/api/inspect",
                data={"force_recheck": "true"},
                files={"image": ("sample.png", sample(), "image/png")},
            )
        self.assertEqual(response.status_code, 200)
        report = response.json()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["reasons"], [])
        self.assertEqual(report["recompression_check"]["score"], 0.2)
        policy, recheck = report["trace"][2:4]
        self.assertTrue(policy["output"]["requested_recheck"])
        self.assertEqual(recheck["status"], "succeeded")

    def test_recheck_failure_preserves_primary_and_requests_review(self):
        detector = ControlledDetector([(0.49, [0.4, 0.5, 0.6]), RuntimeError("private details")])
        with TestClient(create_app(lambda: detector)) as client:
            response = client.post("/api/inspect", files={"image": ("sample.png", sample(), "image/png")})
        self.assertEqual(response.status_code, 200)
        report = response.json()
        self.assertEqual(report["primary"]["score"], 0.49)
        self.assertEqual(report["status"], "review")
        self.assertIsNone(report["recompression_check"])
        self.assertEqual(report["trace"][3]["status"], "failed")
        self.assertIn("recheck_failed", report["reasons"])
        self.assertNotIn("private details", response.text)

    def test_reject_invalid_and_oversized_uploads(self):
        with TestClient(create_app(lambda: ControlledDetector([]))) as client:
            invalid = client.post("/api/inspect", files={"image": ("bad.png", b"bad", "image/png")})
            oversized = client.post("/api/inspect", files={"image": ("huge.png", bytes(MAX_BYTES + 1), "image/png")})
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(oversized.status_code, 413)

    def test_pages_origin_can_read_live_reports(self):
        origin = "https://hzhang086.github.io"
        detector = ControlledDetector([(0.1, [0.05, 0.1, 0.12])])
        with TestClient(create_app(lambda: detector, allowed_origin=origin)) as client:
            response = client.post(
                "/api/inspect",
                headers={"Origin": origin},
                files={"image": ("sample.png", sample(), "image/png")},
            )
            unrelated = client.get("/api/health", headers={"Origin": "https://example.org"})
            oversized = client.post(
                "/api/inspect",
                headers={"Origin": origin, "Content-Length": str(MAX_BYTES * 2)},
                content=b"",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
        self.assertNotIn("Access-Control-Allow-Origin", unrelated.headers)
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(oversized.headers["Access-Control-Allow-Origin"], origin)


if __name__ == "__main__":
    unittest.main()
