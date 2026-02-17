from __future__ import annotations

import argparse
from collections import OrderedDict
from dataclasses import fields
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from typing import Any, Dict, List

import numpy as np
import torch

from .config import ModelConfig
from .model import TransformerActorCritic


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve SMART_ML checkpoint inference over HTTP")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8765, help="Bind port")
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="Inference device",
    )
    parser.add_argument(
        "--checkpoints-dir",
        type=str,
        default="checkpoints",
        help="Root directory containing run checkpoints",
    )
    parser.add_argument(
        "--max-loaded",
        type=int,
        default=3,
        help="Maximum checkpoint models kept in memory (LRU)",
    )
    parser.add_argument(
        "--allow-absolute-checkpoints",
        action="store_true",
        help="Allow absolute checkpoint paths outside --checkpoints-dir (disabled by default)",
    )
    return parser.parse_args()


def _fit_1d(values: List[float], target: int) -> List[float]:
    if target <= 0:
        return []
    if len(values) >= target:
        return [float(v) for v in values[:target]]
    return [float(v) for v in values] + [0.0] * (target - len(values))


def _fit_2d(values: List[List[float]], rows: int, cols: int) -> List[List[float]]:
    if rows <= 0 or cols <= 0:
        return []
    out: List[List[float]] = []
    for row_idx in range(rows):
        row = values[row_idx] if row_idx < len(values) and isinstance(values[row_idx], list) else []
        out.append(_fit_1d([float(v) for v in row], cols))
    return out


class InferenceRuntime:
    def __init__(self, checkpoint_path: Path, device: torch.device) -> None:
        self.checkpoint_path = checkpoint_path
        self.device = device
        self.model_cfg = ModelConfig()
        payload = torch.load(str(checkpoint_path), map_location=device, weights_only=False)
        cfg_dict = payload.get("config", {})
        model_cfg_dict = cfg_dict.get("model", {}) if isinstance(cfg_dict, dict) else {}
        if isinstance(model_cfg_dict, dict):
            for field in fields(ModelConfig):
                if field.name in model_cfg_dict:
                    setattr(self.model_cfg, field.name, int(model_cfg_dict[field.name]))

        self.model = TransformerActorCritic(self.model_cfg).to(device)
        model_state = payload.get("model")
        if not isinstance(model_state, dict):
            raise RuntimeError(f"Checkpoint missing model state: {checkpoint_path}")
        self.model.load_state_dict(model_state, strict=True)
        self.model.eval()

    def infer(self, observation: Dict[str, Any], deterministic: bool) -> Dict[str, Any]:
        static_raw = observation.get("static_state", [])
        seq_raw = observation.get("event_sequence", [])
        if not isinstance(static_raw, list) or not isinstance(seq_raw, list):
            raise RuntimeError("observation.static_state and observation.event_sequence must be lists")

        static_state = _fit_1d([float(v) for v in static_raw], self.model_cfg.static_dim)
        event_sequence = _fit_2d(seq_raw, self.model_cfg.sequence_len, self.model_cfg.token_dim)

        static_t = torch.tensor(np.asarray([static_state], dtype=np.float32), device=self.device)
        seq_t = torch.tensor(np.asarray([event_sequence], dtype=np.float32), device=self.device)
        with torch.no_grad():
            outputs = self.model(static_t, seq_t)
        action_logits = outputs.action_logits[0].detach().cpu().tolist()
        unit_logits = outputs.unit_logits[0].detach().cpu().tolist()
        turret_logits = outputs.turret_logits[0].detach().cpu().tolist()
        buy_slot_logits = outputs.buy_slot_logits[0].detach().cpu().tolist()
        sell_slot_logits = outputs.sell_slot_logits[0].detach().cpu().tolist()
        value_estimate = float(outputs.value[0].detach().cpu().item())

        mode = "deterministic" if deterministic else "stochastic"
        return {
            "ok": True,
            "model_version": f"{self.checkpoint_path.name}:{mode}",
            "value_estimate": value_estimate,
            "action_type_logits": action_logits,
            "unit_logits": unit_logits,
            "turret_logits": turret_logits,
            "buy_slot_logits": buy_slot_logits,
            "sell_slot_logits": sell_slot_logits,
        }


class InferenceService:
    def __init__(
        self,
        checkpoints_dir: Path,
        device: torch.device,
        max_loaded: int = 3,
        allow_absolute_checkpoints: bool = False,
    ) -> None:
        self.checkpoints_dir = checkpoints_dir.resolve()
        self.device = device
        self.max_loaded = max(1, int(max_loaded))
        self.allow_absolute_checkpoints = bool(allow_absolute_checkpoints)
        self._cache: "OrderedDict[str, InferenceRuntime]" = OrderedDict()
        self._lock = threading.Lock()

    def _is_within_root(self, path: Path) -> bool:
        try:
            path.relative_to(self.checkpoints_dir)
            return True
        except ValueError:
            return False

    def _resolve_checkpoint_path(self, checkpoint_id: str) -> Path:
        candidate = Path(checkpoint_id)
        if candidate.is_absolute():
            if not self.allow_absolute_checkpoints:
                raise RuntimeError("Absolute checkpoint paths are disabled")
            path = candidate.resolve()
        else:
            path = (self.checkpoints_dir / checkpoint_id).resolve()
        if not self._is_within_root(path):
            if not (candidate.is_absolute() and self.allow_absolute_checkpoints):
                raise RuntimeError("Checkpoint path escapes --checkpoints-dir")
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"Checkpoint not found: {checkpoint_id}")
        return path

    def _get_runtime(self, checkpoint_id: str) -> InferenceRuntime:
        with self._lock:
            runtime = self._cache.get(checkpoint_id)
            if runtime is not None:
                self._cache.move_to_end(checkpoint_id)
                return runtime

        checkpoint_path = self._resolve_checkpoint_path(checkpoint_id)
        runtime = InferenceRuntime(checkpoint_path=checkpoint_path, device=self.device)
        with self._lock:
            self._cache[checkpoint_id] = runtime
            self._cache.move_to_end(checkpoint_id)
            while len(self._cache) > self.max_loaded:
                self._cache.popitem(last=False)
        return runtime

    def infer(self, checkpoint_id: str, observation: Dict[str, Any], deterministic: bool) -> Dict[str, Any]:
        runtime = self._get_runtime(checkpoint_id)
        return runtime.infer(observation=observation, deterministic=deterministic)


class InferenceHandler(BaseHTTPRequestHandler):
    service: InferenceService

    def _send_json(self, payload: Dict[str, Any], status: int = HTTPStatus.OK) -> bool:
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            # Browser/client cancelled request while response was being written.
            return False

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_json({"ok": True}, status=HTTPStatus.NO_CONTENT)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/infer":
            self._send_json({"ok": False, "error": f"unknown path {self.path}"}, status=HTTPStatus.NOT_FOUND)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8"))
            checkpoint_id = str(payload.get("checkpoint_id", "")).strip()
            if not checkpoint_id:
                raise RuntimeError("checkpoint_id is required")
            observation = payload.get("observation")
            if not isinstance(observation, dict):
                raise RuntimeError("observation object is required")
            deterministic = bool(payload.get("deterministic", True))
            response = self.service.infer(checkpoint_id, observation, deterministic=deterministic)
            self._send_json(response, status=HTTPStatus.OK)
        except FileNotFoundError as exc:
            print(f"[inference] 404: {exc}")
            self._send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.NOT_FOUND)
        except Exception as exc:  # noqa: BLE001
            print(f"[inference] 400: {exc}")
            self._send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)


def _resolve_device(raw: str) -> torch.device:
    choice = raw.strip().lower()
    if choice == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("CUDA requested but unavailable")
        return torch.device("cuda")
    if choice == "cpu":
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def main() -> None:
    args = parse_args()
    device = _resolve_device(args.device)
    checkpoints_dir = Path(args.checkpoints_dir)
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    service = InferenceService(
        checkpoints_dir=checkpoints_dir,
        device=device,
        max_loaded=args.max_loaded,
        allow_absolute_checkpoints=args.allow_absolute_checkpoints,
    )
    InferenceHandler.service = service
    server = ThreadingHTTPServer((args.host, int(args.port)), InferenceHandler)
    print(
        f"[inference] serving on http://{args.host}:{args.port} "
        f"device={device.type} checkpoints_dir={checkpoints_dir.resolve()} max_loaded={args.max_loaded} "
        f"allow_absolute_checkpoints={bool(args.allow_absolute_checkpoints)}"
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[inference] stopped")


if __name__ == "__main__":
    main()
