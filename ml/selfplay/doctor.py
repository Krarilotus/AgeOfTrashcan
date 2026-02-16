from __future__ import annotations

import argparse
import platform
import sys


def _ok(value: bool) -> str:
    return "OK" if value else "FAIL"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate self-play training runtime")
    parser.add_argument(
        "--expect-cuda",
        action="store_true",
        help="Fail if CUDA is not available",
    )
    parser.add_argument(
        "--min-vram-gb",
        type=float,
        default=7.0,
        help="Minimum VRAM expected on CUDA device 0",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    failures: list[str] = []

    print(f"[{_ok(sys.version_info >= (3, 10))}] Python {platform.python_version()} (requires >=3.10)")
    if sys.version_info < (3, 10):
        failures.append("Python version is below 3.10")

    try:
        import torch  # type: ignore
    except ModuleNotFoundError:
        print("[FAIL] PyTorch not installed")
        failures.append("PyTorch not installed")
        torch = None  # type: ignore

    if torch is not None:
        print(f"[OK] PyTorch {torch.__version__}")
        cuda_available = bool(torch.cuda.is_available())
        print(f"[{_ok(cuda_available)}] CUDA available: {cuda_available}")

        if args.expect_cuda and not cuda_available:
            failures.append("CUDA is required but unavailable")

        if cuda_available:
            device_name = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            vram_gb = props.total_memory / (1024**3)
            vram_ok = vram_gb >= args.min_vram_gb
            print(f"[{_ok(vram_ok)}] GPU: {device_name} ({vram_gb:.2f} GB VRAM)")
            if not vram_ok:
                failures.append(
                    f"VRAM {vram_gb:.2f} GB is below expected minimum {args.min_vram_gb:.2f} GB"
                )

    if failures:
        print("[doctor] Training environment is NOT ready.")
        for item in failures:
            print(f"  - {item}")
        raise SystemExit(1)

    print("[doctor] Training environment is ready.")


if __name__ == "__main__":
    main()
