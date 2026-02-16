from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True, slots=True)
class TorchInstallPlan:
    stack: str
    index_url: str
    torch_version: str
    torchvision_version: str
    torchaudio_version: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install a CUDA-enabled PyTorch stack")
    parser.add_argument(
        "--stack",
        choices=["auto", "legacy", "modern"],
        default=os.getenv("TORCH_STACK", "auto"),
        help="Install profile: auto (detect GPU), legacy (GTX 10xx-safe), modern (newer GPUs)",
    )
    return parser.parse_args()


def _run(cmd: List[str]) -> None:
    subprocess.run(cmd, check=True)


def _detect_compute_capability() -> float | None:
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    for line in output.splitlines():
        raw = line.strip().split(",")[0].strip()
        if not raw:
            continue
        match = re.search(r"(\d+(?:\.\d+)?)", raw)
        if not match:
            continue
        try:
            return float(match.group(1))
        except ValueError:
            continue
    return None


def _choose_stack(requested: str, capability: float | None) -> str:
    if requested in {"legacy", "modern"}:
        return requested
    if capability is not None and capability < 7.0:
        return "legacy"
    if capability is None:
        return "legacy"
    return "modern"


def _plan_for_stack(stack: str) -> TorchInstallPlan:
    if stack == "legacy":
        return TorchInstallPlan(
            stack="legacy",
            index_url=os.getenv("TORCH_INDEX_URL", "https://download.pytorch.org/whl/cu118"),
            torch_version=os.getenv("TORCH_VERSION", "2.5.1+cu118"),
            torchvision_version=os.getenv("TORCHVISION_VERSION", "0.20.1+cu118"),
            torchaudio_version=os.getenv("TORCHAUDIO_VERSION", "2.5.1+cu118"),
        )
    return TorchInstallPlan(
        stack="modern",
        index_url=os.getenv("TORCH_INDEX_URL", "https://download.pytorch.org/whl/cu128"),
        torch_version=os.getenv("TORCH_VERSION", ""),
        torchvision_version=os.getenv("TORCHVISION_VERSION", ""),
        torchaudio_version=os.getenv("TORCHAUDIO_VERSION", ""),
    )


def _spec(package: str, version: str) -> str:
    return f"{package}=={version}" if version else package


def main() -> None:
    args = parse_args()
    capability = _detect_compute_capability()
    selected_stack = _choose_stack(args.stack, capability)
    plan = _plan_for_stack(selected_stack)
    capability_text = f"{capability:.1f}" if capability is not None else "unknown"
    print(f"[torch-install] gpu_compute_capability={capability_text}")
    print(f"[torch-install] stack={plan.stack}")
    print(f"[torch-install] index={plan.index_url}")
    print(
        "[torch-install] packages="
        + " ".join(
            [
                _spec("torch", plan.torch_version),
                _spec("torchvision", plan.torchvision_version),
                _spec("torchaudio", plan.torchaudio_version),
            ]
        )
    )

    _run([sys.executable, "-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio"])
    install_cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--index-url",
        plan.index_url,
        _spec("torch", plan.torch_version),
        _spec("torchvision", plan.torchvision_version),
        _spec("torchaudio", plan.torchaudio_version),
    ]
    _run(install_cmd)
    _run(
        [
            sys.executable,
            "-c",
            (
                "import torch; "
                "print(torch.__version__); "
                "print('cuda=', torch.cuda.is_available()); "
                "print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO CUDA GPU')"
            ),
        ]
    )


if __name__ == "__main__":
    main()
