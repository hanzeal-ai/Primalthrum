from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn


AGENT_ROOT = Path(__file__).resolve().parents[2] / "agent"


with TemporaryDirectory(prefix="primalthrum-agent-e2e-") as runtime_dir:
    os.chdir(runtime_dir)
    uvicorn.run(
        "main:app",
        app_dir=str(AGENT_ROOT),
        host="127.0.0.1",
        port=48100,
    )
