from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, Dict, List, Optional


STEP_RE = re.compile(r".*?_step_(\d+)\.pt$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export checkpoint registry for game UI")
    parser.add_argument(
        "--checkpoints-dir",
        type=str,
        default="checkpoints",
        help="Root directory containing checkpoint run folders",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="../public/ml/checkpoints/index.json",
        help="Output JSON path for UI registry",
    )
    return parser.parse_args()


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _step_from_name(filename: str) -> int:
    match = STEP_RE.match(filename)
    if not match:
        return 0
    return int(match.group(1))


def _load_manifest(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
            if isinstance(payload, dict):
                return payload
    except Exception:
        return None
    return None


def _collect_from_manifest(run_dir: Path, manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    run_name = run_dir.name
    entries: List[Dict[str, Any]] = []
    checkpoints = manifest.get("checkpoints", [])
    if not isinstance(checkpoints, list):
        return entries

    for item in checkpoints:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("path", "")).strip()
        if not filename:
            continue
        step = int(item.get("step", 0) or 0)
        kind = str(item.get("kind", "periodic"))
        timestamp_utc = str(item.get("timestamp_utc", ""))
        checkpoint_id = f"{run_name}/{filename}"
        label = f"{run_name} {kind} step {step}"
        entries.append(
            {
                "id": checkpoint_id,
                "label": label,
                "runName": run_name,
                "fileName": filename,
                "kind": kind,
                "step": step,
                "timestampUtc": timestamp_utc,
                "relativePath": f"checkpoints/{run_name}/{filename}",
            }
        )
    return entries


def _collect_from_files(run_dir: Path) -> List[Dict[str, Any]]:
    run_name = run_dir.name
    entries: List[Dict[str, Any]] = []
    for file_path in sorted(run_dir.glob("*.pt")):
        filename = file_path.name
        if filename in {"latest.pt", "best.pt"}:
            continue
        step = _step_from_name(filename)
        kind = "checkpoint"
        if filename.startswith("best_"):
            kind = "best"
        elif filename.startswith("milestone_"):
            kind = "milestone"
        elif filename.startswith("periodic_"):
            kind = "periodic"
        checkpoint_id = f"{run_name}/{filename}"
        label = f"{run_name} {kind} step {step}"
        entries.append(
            {
                "id": checkpoint_id,
                "label": label,
                "runName": run_name,
                "fileName": filename,
                "kind": kind,
                "step": step,
                "timestampUtc": datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc).isoformat(),
                "relativePath": f"checkpoints/{run_name}/{filename}",
            }
        )
    return entries


def build_registry(checkpoints_dir: Path) -> Dict[str, Any]:
    checkpoints: List[Dict[str, Any]] = []

    if checkpoints_dir.exists():
        for run_dir in sorted([path for path in checkpoints_dir.iterdir() if path.is_dir()]):
            manifest = _load_manifest(run_dir / "run_manifest.json")
            if manifest:
                checkpoints.extend(_collect_from_manifest(run_dir, manifest))
            else:
                checkpoints.extend(_collect_from_files(run_dir))

    deduped: Dict[str, Dict[str, Any]] = {}
    for item in checkpoints:
        deduped[item["id"]] = item

    sorted_items = sorted(
        deduped.values(),
        key=lambda item: (
            int(item.get("step", 0)),
            str(item.get("timestampUtc", "")),
            str(item.get("id", "")),
        ),
        reverse=True,
    )

    latest_checkpoint_id = sorted_items[0]["id"] if sorted_items else None

    return {
        "generatedAtUtc": _iso_now(),
        "latestCheckpointId": latest_checkpoint_id,
        "checkpoints": sorted_items,
    }


def main() -> None:
    args = parse_args()
    checkpoints_dir = Path(args.checkpoints_dir).resolve()
    output_path = Path(args.output).resolve()

    registry = build_registry(checkpoints_dir)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(registry, handle, indent=2)

    print(
        f"[registry] wrote {len(registry['checkpoints'])} checkpoints to {output_path}"
    )
    if registry["latestCheckpointId"]:
        print(f"[registry] latest={registry['latestCheckpointId']}")


if __name__ == "__main__":
    main()
