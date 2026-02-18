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
    warnings: list[str] = []

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
            capability = torch.cuda.get_device_capability(0)
            arch = f"sm_{capability[0]}{capability[1]}"
            arch_list = set(torch.cuda.get_arch_list())
            arch_supported = arch in arch_list
            print(f"[{_ok(arch_supported)}] CUDA arch support: device={arch}, torch={sorted(arch_list)}")

            cuda_runtime_ok = False
            cuda_runtime_error = ""
            try:
                # Real runtime check: catches kernels that would fail despite CUDA being "available".
                x = torch.randn((2048, 2048), device="cuda", dtype=torch.float32)
                y = torch.randn((2048, 2048), device="cuda", dtype=torch.float32)
                z = (x @ y).sum()
                _ = float(z.item())
                torch.cuda.synchronize()
                cuda_runtime_ok = True
            except Exception as exc:  # noqa: BLE001
                cuda_runtime_error = str(exc)
            print(f"[{_ok(cuda_runtime_ok)}] CUDA runtime smoke-test (matmul)")

            if not cuda_runtime_ok:
                failures.append(
                    "CUDA runtime smoke-test failed. "
                    f"Kernel launch/inference may be unstable. Error: {cuda_runtime_error}"
                )
            elif not arch_supported:
                warnings.append(
                    f"Torch arch list does not include {arch}, but runtime smoke-test passed. "
                    "Proceeding with PTX/JIT fallback."
                )

    if failures:
        print("[doctor] Training environment is NOT ready.")
        for item in failures:
            print(f"  - {item}")
        raise SystemExit(1)

    if warnings:
        for item in warnings:
            print(f"[warn] {item}")

    print("[doctor] Training environment is ready.")


if __name__ == "__main__":
    main()
