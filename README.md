# DUET Agent Platform

[Open the public demo](https://hzhang086.github.io/duet-agent-platform/)

The platform wraps the original DUET v3 image detector with an image-review workflow. The report shows the model score, the selected route and expert votes. The workflow runs a second, controlled JPEG pass on scores close to the threshold or strong disagreement between experts, and flags those cases for human review. The initial verdict stays in the report alongside the second pass.

The public site replays three reports generated with the original DUET model and v3 checkpoints, including both the early exit and deep route. You can add a JPEG, PNG or WebP to preview the original and a browser-generated JPEG. The image stays in the browser during this preview. To score a new upload, run the Python service with access to the upstream code and model checkpoints.

You can also open `docs/index.html` directly in a browser to replay the samples and preview your own image. Keep the full `docs` folder together.

The review assistant answers supported questions in English or Chinese about the active report: why review was triggered, whether JPEG changed the verdict, model routing, expert votes and thresholds. Evidence buttons jump to the backend trace. The assistant uses the report directly and does not call a language model. On a connected backend, upload a new image and ask “Run DUET on this image” or “Run a fresh JPEG recheck.” A fresh run performs the initial pass and one JPEG pass, even if the original score is far from the threshold. The record distinguishes an explicit recheck request from a policy trigger.

## Run your own inspection

Use Python 3.12 or later and a checkout of [the original DUET project](https://github.com/kelvinchua1099-alt/DUET_v0) at commit `829ca4cb4e83d35d8be4d2ddafc5359524b4649a`. Access to the team repository and the [v3 checkpoints](https://huggingface.co/TechJam2026-Jamlai-Bench/squade-vitg) is managed by their owners. Follow the upstream installation instructions for the PyTorch build on your device.

```sh
python -m venv .venv
source .venv/bin/activate
export DUET_SOURCE=/absolute/path/to/DUET_v0
export DUET_CHECKPOINTS=/absolute/path/to/ckpt/v3
python -m pip install -r requirements.txt -r "$DUET_SOURCE/requirements.txt"
python -m uvicorn duet_platform.server:app --host 127.0.0.1 --port 8000
```

Open [the local workbench](http://127.0.0.1:8000/). The upstream runtime automatically chooses the device. Set `DUET_DEVICE=cpu`, `mps` or `cuda` to select one explicitly. `DUET_BACKBONE` optionally points to a trusted local copy of `facebook/dinov2-giant`. The v3 weight tree must contain `mix2_shallow/stage1.pt`, `mix2_deep/stage1.pt`, and `mix2_gate.pt`.

The same inspection is available via multipart HTTP at `POST /api/inspect`.

```sh
curl -F 'image=@sample.jpg' http://127.0.0.1:8000/api/inspect
```

The local service accepts single-frame JPEG, PNG and WebP files up to 8 MiB and 20 megapixels. It loads the detector once and serializes inference. Original uploads are not written to the project or included in reports.

## Deploy live inference

`modal_app.py` serves the same FastAPI app on Modal CPU. It scales to zero and uses a read-only workspace volume for the upstream code and DUET v3 checkpoints. GitHub Pages uses the live API when `docs/backend-config.js` contains the verified HTTPS endpoint. Keeping that value empty preserves the recorded report demo.

1. Confirm the team permits its code and checkpoints to be stored in the chosen workspace and used for public inference. Check the workspace's billing and spend limits.
2. Install Modal locally and authenticate in your own workspace. Create a v2 volume named `duet-v3-inputs`.
3. Populate `/upstream` in the volume from a clean archive of the pinned upstream commit and `/checkpoints` with the three v3 model files in the layout above. The deployment downloads the separately published DINOv2 backbone at a fixed revision. The public GitHub repository needs only the platform code and the backend URL.
4. Run `modal deploy modal_app.py`. Verify `/api/health` and post a test image to `/api/inspect`. Then put the endpoint URL, with a trailing slash, in `docs/backend-config.js` and verify an upload from the public site.

Visitors can submit images to the public API without an account. The API allows requests from the GitHub Pages origin and keeps one model container at a time. Direct API requests are still possible, so configure the hosting provider's spend limit before sharing the endpoint.

## Review logic

1. Validate and decode the input and run the original DUET predictor.
2. Record the ranking score, early-exit or deep route, and expert votes.
3. If the score is within 0.15 of 0.5 or expert votes differ by 0.80 or more, rescore a JPEG version at quality 65 and report any verdict change.
4. Export the score, route and review reasons as JSON.

Every completed inspection includes a run ID, checkpoint fingerprints, and an ordered trace with the inputs, outputs, status and wall time of each executed step. The policy trace records the score margin, vote spread, thresholds and reason for its next action. A failed recheck preserves the initial result and flags the case for human review. Uploaded image bytes are excluded from the trace. The public workflow replay renders the trace from the backend-generated sample reports. A local upload with `Run DUET` creates a new trace through the same code path.

The follow-up thresholds are review heuristics. The public examples are three versions of the same photograph and illustrate the workflow. They do not establish model accuracy. Timing reflects the recorded CPU run or the configured live runtime.

## Reproduce the public samples

```sh
python -m duet_platform.export_samples
```

Run the export command with the same model configuration as the server. The original sample is NASA’s photograph of [astronaut Eileen Collins](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut), distributed by scikit-image. The second sample is resized to 240 × 240 and recompressed as JPEG at quality 28. The third is Gaussian blurred with a radius of 6 pixels.

Install `httpx2` and run `python -m unittest discover -s tests` to test the API and review workflow using controlled detector outputs.

Original DUET model and algorithm by the [DUET team](https://devpost.com/software/freedepth). Platform integration by Heng Zhang. This repository includes the platform source and the public sample reports. Upstream source and model files are loaded separately at runtime.
