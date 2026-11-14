"""Deploy the live DUET API with its private inputs mounted read-only."""

from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent

app = modal.App("duet-v3")
model_inputs = modal.Volume.from_name("duet-v3-inputs").with_mount_options(read_only=True)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.9.1", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install_from_requirements(str(ROOT / "requirements.txt"))
    .pip_install("transformers==4.57.3", "huggingface-hub>=0.34,<1", "numpy>=1.24,<3")
    .env({
        "DUET_DEVICE": "cpu",
        "DUET_SOURCE": "/duet-inputs/upstream",
        "DUET_CHECKPOINTS": "/duet-inputs/checkpoints",
        "DUET_DOCS_PATH": "/opt/duet/docs",
        "HF_HOME": "/opt/duet/hf",
        "OMP_NUM_THREADS": "4",
    })
    .run_commands(
        "hf download facebook/dinov2-giant --revision 611a9d42f2335e0f921f1e313ad3c1b7178d206d "
        "--include config.json preprocessor_config.json model.safetensors"
    )
    .env({"HF_HUB_OFFLINE": "1"})
    .add_local_python_source("duet_platform")
    .add_local_dir(ROOT / "docs", remote_path="/opt/duet/docs")
)


@app.function(
    image=image,
    volumes={"/duet-inputs": model_inputs},
    cpu=4,
    memory=12288,
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
    timeout=120,
)
@modal.asgi_app()
def web():
    from duet_platform.server import create_app

    return create_app(allowed_origin="https://hzhang086.github.io")
