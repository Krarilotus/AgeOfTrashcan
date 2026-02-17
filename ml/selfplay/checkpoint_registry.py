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
        default="../assets/ml/checkpoints/index.json",
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
        checkpoint_file = (run_dir / filename)
        if not checkpoint_file.exists() or not checkpoint_file.is_file():
            continue
        step = int(item.get("step", 0) or 0)
        kind = str(item.get("kind", "periodic"))
        timestamp_utc = str(item.get("timestamp_utc", ""))
        metrics = item.get("metrics", {})
        archetype = ""
        codename = ""
        winrate_vs_mock: Optional[float] = None
        strategy_aggression: Optional[float] = None
        strategy_teching: Optional[float] = None
        strategy_defense: Optional[float] = None
        if isinstance(metrics, dict):
            archetype = str(metrics.get("strategy_archetype", "") or "").strip()
            codename = str(metrics.get("strategy_codename", "") or "").strip()
            if isinstance(metrics.get("winrate_vs_mock"), (int, float)):
                winrate_vs_mock = float(metrics.get("winrate_vs_mock"))
            if isinstance(metrics.get("strategy_aggression"), (int, float)):
                strategy_aggression = float(metrics.get("strategy_aggression"))
            if isinstance(metrics.get("strategy_teching"), (int, float)):
                strategy_teching = float(metrics.get("strategy_teching"))
            if isinstance(metrics.get("strategy_defense"), (int, float)):
                strategy_defense = float(metrics.get("strategy_defense"))
        checkpoint_id = f"{run_name}/{filename}"
        label = f"{run_name} {kind} step {step}"
        if codename:
            if archetype:
                label = f"{run_name} {codename} [{archetype}] {kind} step {step}"
            else:
                label = f"{run_name} {codename} {kind} step {step}"
        entries.append(
            {
                "id": checkpoint_id,
                "label": label,
                "runName": run_name,
                "fileName": filename,
                "kind": kind,
                "step": step,
                "timestampUtc": timestamp_utc,
                "strategyArchetype": archetype or None,
                "strategyCodename": codename or None,
                "winrateVsMock": winrate_vs_mock,
                "strategyAggression": strategy_aggression,
                "strategyTeching": strategy_teching,
                "strategyDefense": strategy_defense,
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
                "strategyArchetype": None,
                "strategyCodename": None,
                "winrateVsMock": None,
                "strategyAggression": None,
                "strategyTeching": None,
                "strategyDefense": None,
                "relativePath": f"checkpoints/{run_name}/{filename}",
            }
        )
    return entries


def _slugify_alias(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", text.strip()).strip("_")
    if not slug:
        return "Agent"
    return slug[:40]


def _style_summary(archetype: str, aggression: Optional[float], teching: Optional[float], defense: Optional[float]) -> str:
    if archetype:
        return archetype
    values = {
        "aggressive": float(aggression or 0.0),
        "techer": float(teching or 0.0),
        "defensive": float(defense or 0.0),
    }
    return max(values, key=values.get)


def _entry_score(item: Dict[str, Any], latest_checkpoint_id: Optional[str]) -> float:
    kind = str(item.get("kind", "checkpoint"))
    kind_bonus = {
        "best": 35.0,
        "milestone": 22.0,
        "periodic": 16.0,
        "checkpoint": 10.0,
    }.get(kind, 8.0)
    winrate = float(item.get("winrateVsMock") or 0.0)
    step_bonus = float(int(item.get("step", 0))) / 1_000_000.0
    latest_bonus = 4.0 if latest_checkpoint_id and item.get("id") == latest_checkpoint_id else 0.0
    return kind_bonus + winrate * 100.0 + step_bonus + latest_bonus


def _build_featured_agents(
    sorted_items: List[Dict[str, Any]],
    latest_checkpoint_id: Optional[str],
    max_agents: int = 5,
) -> List[Dict[str, Any]]:
    candidates = [item for item in sorted_items if str(item.get("strategyCodename") or "").strip()]
    if not candidates:
        return []

    best_by_signature: Dict[tuple[str, str], Dict[str, Any]] = {}
    for item in candidates:
        archetype = str(item.get("strategyArchetype") or "").strip().lower() or "balanced"
        codename = str(item.get("strategyCodename") or "").strip().lower()
        signature = (archetype, codename)
        best = best_by_signature.get(signature)
        if best is None or _entry_score(item, latest_checkpoint_id) > _entry_score(best, latest_checkpoint_id):
            best_by_signature[signature] = item
    unique_candidates = list(best_by_signature.values())

    best_by_archetype: Dict[str, Dict[str, Any]] = {}
    for item in unique_candidates:
        archetype = str(item.get("strategyArchetype") or "").strip().lower() or "balanced"
        best = best_by_archetype.get(archetype)
        if best is None or _entry_score(item, latest_checkpoint_id) > _entry_score(best, latest_checkpoint_id):
            best_by_archetype[archetype] = item

    selected: List[Dict[str, Any]] = sorted(
        best_by_archetype.values(),
        key=lambda item: _entry_score(item, latest_checkpoint_id),
        reverse=True,
    )[:max_agents]

    if len(selected) < max_agents:
        for item in sorted(unique_candidates, key=lambda entry: _entry_score(entry, latest_checkpoint_id), reverse=True):
            if item in selected:
                continue
            selected.append(item)
            if len(selected) >= max_agents:
                break

    featured: List[Dict[str, Any]] = []
    used_aliases: set[str] = set()
    for item in selected:
        codename = str(item.get("strategyCodename") or "Agent")
        archetype = str(item.get("strategyArchetype") or "balanced").strip().lower()
        alias_base = f"SMART_ML_{_slugify_alias(codename).upper()}"
        alias = alias_base
        suffix = 2
        while alias in used_aliases:
            alias = f"{alias_base}_{suffix}"
            suffix += 1
        used_aliases.add(alias)
        winrate = item.get("winrateVsMock")
        winrate_text = f"{float(winrate):.2f}" if isinstance(winrate, (int, float)) else "n/a"
        style = _style_summary(
            archetype=archetype,
            aggression=item.get("strategyAggression"),
            teching=item.get("strategyTeching"),
            defense=item.get("strategyDefense"),
        )
        featured.append(
            {
                "alias": alias,
                "id": item.get("id"),
                "label": f"{alias} ({style}, wr {winrate_text})",
                "codename": codename,
                "archetype": archetype,
                "style": style,
                "winrateVsMock": float(winrate) if isinstance(winrate, (int, float)) else None,
                "step": int(item.get("step", 0)),
                "runName": item.get("runName"),
            }
        )
    return featured


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
    featured_agents = _build_featured_agents(sorted_items, latest_checkpoint_id, max_agents=5)

    return {
        "generatedAtUtc": _iso_now(),
        "latestCheckpointId": latest_checkpoint_id,
        "featuredAgents": featured_agents,
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
