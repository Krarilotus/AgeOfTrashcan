from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import time
from typing import List

import numpy as np
import torch

from .config import ModelConfig
from .env import ACTIONS, GameBridgeEnv
from .resource_monitor import ResourceMonitor, ResourceSample
from .schemas import Action, Observation


def _parse_int_list(raw: str) -> List[int]:
    values: List[int] = []
    for token in str(raw or "").split(","):
        stripped = token.strip()
        if not stripped:
            continue
        try:
            value = int(stripped)
        except ValueError as exc:
            raise SystemExit(f"Invalid integer list token: {stripped!r}") from exc
        if value <= 0:
            raise SystemExit(f"List values must be > 0: {value}")
        values.append(value)
    if not values:
        raise SystemExit("Expected at least one positive integer value")
    return sorted(set(values))


def _resource_text(sample: ResourceSample | None) -> str:
    if sample is None:
        return "cpu=n/a ram=n/a gpu=n/a gpu_mem=n/a"
    gpu = "n/a" if sample.gpu_util_percent is None else f"{sample.gpu_util_percent:.1f}%"
    gpu_mem = "n/a" if sample.gpu_mem_percent is None else f"{sample.gpu_mem_percent:.1f}%"
    return (
        f"cpu={sample.cpu_percent:.1f}% "
        f"ram={sample.ram_percent:.1f}% "
        f"gpu={gpu} "
        f"gpu_mem={gpu_mem}"
    )


def _pick_action(obs: Observation, rng: np.random.Generator) -> Action:
    legal_action_indices = [
        idx
        for idx, flag in enumerate(obs.action_type_mask[: len(ACTIONS)])
        if int(flag) > 0
    ]
    if not legal_action_indices:
        return Action(action_type="WAIT")

    action_idx = int(rng.choice(legal_action_indices))
    action_type = ACTIONS[action_idx]

    if action_type == "RECRUIT_UNIT":
        legal_units = [idx for idx, flag in enumerate(obs.unit_mask) if int(flag) > 0]
        if not legal_units:
            return Action(action_type="WAIT")
        unit_idx = int(rng.choice(legal_units))
        return Action(action_type=action_type, unit_id=f"unit_{unit_idx}")

    if action_type == "BUY_TURRET_ENGINE":
        legal_turrets = [idx for idx, flag in enumerate(obs.turret_mask) if int(flag) > 0]
        legal_slots = [idx for idx, flag in enumerate(obs.buy_slot_mask) if int(flag) > 0]
        if not legal_turrets or not legal_slots:
            return Action(action_type="WAIT")
        turret_idx = int(rng.choice(legal_turrets))
        slot_idx = int(rng.choice(legal_slots))
        return Action(action_type=action_type, turret_id=f"turret_{turret_idx}", slot_index=slot_idx)

    if action_type == "SELL_TURRET_ENGINE":
        legal_slots = [idx for idx, flag in enumerate(obs.sell_slot_mask) if int(flag) > 0]
        if not legal_slots:
            return Action(action_type="WAIT")
        slot_idx = int(rng.choice(legal_slots))
        return Action(action_type=action_type, slot_index=slot_idx)

    return Action(action_type=action_type)


def _run_case(
    *,
    model_cfg: ModelConfig,
    num_envs: int,
    decision_frames: int,
    warmup_sec: float,
    bench_sec: float,
    episode_seconds: int,
    self_difficulty: str,
    opponent_difficulty: str,
    seed: int,
    monitor: ResourceMonitor | None,
) -> dict:
    envs: List[GameBridgeEnv] = []
    obs: List[Observation] = []
    pool: ThreadPoolExecutor | None = None
    rng = np.random.default_rng(seed + num_envs * 10_000 + decision_frames * 1_000_000)
    seed_cursor = int(seed)

    case_start = time.perf_counter()
    try:
        envs = [
            GameBridgeEnv(
                model_cfg,
                opponent_difficulty=opponent_difficulty,
                self_difficulty=self_difficulty,
                episode_seconds=episode_seconds,
                decision_frames=decision_frames,
            )
            for _ in range(num_envs)
        ]
        obs = []
        for _env in envs:
            obs.append(_env.reset(seed_cursor))
            seed_cursor += 1
        if len(envs) > 1:
            pool = ThreadPoolExecutor(max_workers=len(envs))

        warmup_end = case_start + max(0.0, float(warmup_sec))
        stop_at = warmup_end + max(0.0, float(bench_sec))
        bench_started_at: float | None = None
        bench_env_steps = 0
        bench_completed_games = 0
        bench_iterations = 0
        bench_env_step_wall = 0.0

        while True:
            iter_start = time.perf_counter()
            if iter_start >= stop_at:
                break
            in_bench = iter_start >= warmup_end
            if in_bench and bench_started_at is None:
                bench_started_at = iter_start

            actions = [_pick_action(item, rng) for item in obs]
            step_start = time.perf_counter()
            if pool is not None:
                futures = [pool.submit(envs[idx].step, actions[idx]) for idx in range(len(envs))]
                results = [future.result() for future in futures]
            else:
                results = [envs[idx].step(actions[idx]) for idx in range(len(envs))]
            step_elapsed = max(0.0, time.perf_counter() - step_start)

            if in_bench:
                bench_env_step_wall += step_elapsed
                bench_env_steps += len(envs)
                bench_iterations += 1

            for idx, (next_obs, _reward, done, _info, _reward_components) in enumerate(results):
                if done:
                    if in_bench:
                        bench_completed_games += 1
                    obs[idx] = envs[idx].reset(seed_cursor)
                    seed_cursor += 1
                else:
                    obs[idx] = next_obs

        case_end = time.perf_counter()
        bench_start = bench_started_at if bench_started_at is not None else case_end
        bench_elapsed = max(1e-6, case_end - bench_start)
        sample = None if monitor is None else monitor.averaged_between(bench_start, case_end)

        decisions_per_sec = bench_env_steps / bench_elapsed
        frames_per_sec = decisions_per_sec * float(decision_frames)
        avg_batch_step_ms = (bench_env_step_wall / max(1, bench_iterations)) * 1000.0
        done_per_min = bench_completed_games * 60.0 / bench_elapsed
        per_env_decisions_per_sec = decisions_per_sec / max(1, num_envs)

        return {
            "num_envs": int(num_envs),
            "decision_frames": int(decision_frames),
            "bench_elapsed_s": bench_elapsed,
            "decisions_per_sec": decisions_per_sec,
            "per_env_decisions_per_sec": per_env_decisions_per_sec,
            "frames_per_sec": frames_per_sec,
            "done_per_min": done_per_min,
            "avg_batch_step_ms": avg_batch_step_ms,
            "resource_sample": sample,
        }
    finally:
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=False)
        for env in envs:
            try:
                env.close()
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark headless GameBridgeEnv throughput")
    parser.add_argument(
        "--num-envs-list",
        type=str,
        default="8,16,24,32,40,48",
        help="Comma-separated env counts to benchmark",
    )
    parser.add_argument(
        "--decision-frames-list",
        type=str,
        default="30",
        help="Comma-separated decision_frames values to benchmark",
    )
    parser.add_argument("--warmup-sec", type=float, default=8.0, help="Warmup duration per case")
    parser.add_argument("--bench-sec", type=float, default=20.0, help="Measurement duration per case")
    parser.add_argument("--seed", type=int, default=1337, help="Base seed")
    parser.add_argument(
        "--episode-seconds",
        type=int,
        default=3600,
        help="Episode timeout in seconds passed to bridge env",
    )
    parser.add_argument("--self-difficulty", type=str, default="MEDIUM")
    parser.add_argument("--opponent-difficulty", type=str, default="MEDIUM")
    parser.add_argument("--monitor-sample-hz", type=float, default=10.0)
    parser.add_argument("--monitor-gpu-probe-hz", type=float, default=2.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    num_envs_list = _parse_int_list(args.num_envs_list)
    decision_frames_list = _parse_int_list(args.decision_frames_list)
    warmup_sec = max(0.0, float(args.warmup_sec))
    bench_sec = max(1.0, float(args.bench_sec))
    model_cfg = ModelConfig()

    monitor: ResourceMonitor | None = None
    try:
        history_sec = max(30.0, warmup_sec + bench_sec + 10.0)
        monitor = ResourceMonitor(
            sample_hz=max(0.5, float(args.monitor_sample_hz)),
            gpu_probe_hz=max(0.2, float(args.monitor_gpu_probe_hz)),
            enable_gpu=bool(torch.cuda.is_available()),
            history_sec=history_sec,
        )
        monitor.start()
    except Exception as exc:
        monitor = None
        print(f"[bench] resource monitor disabled: {exc}")

    print(
        f"[bench] envs={num_envs_list} decision_frames={decision_frames_list} "
        f"warmup={warmup_sec:.1f}s bench={bench_sec:.1f}s "
        f"self={args.self_difficulty} opp={args.opponent_difficulty}"
    )

    results: List[dict] = []
    case_index = 0
    total_cases = len(num_envs_list) * len(decision_frames_list)
    for decision_frames in decision_frames_list:
        for num_envs in num_envs_list:
            case_index += 1
            print(
                f"[bench-case-start] {case_index}/{total_cases} envs={num_envs} decision_frames={decision_frames}"
            )
            case = _run_case(
                model_cfg=model_cfg,
                num_envs=num_envs,
                decision_frames=decision_frames,
                warmup_sec=warmup_sec,
                bench_sec=bench_sec,
                episode_seconds=int(args.episode_seconds),
                self_difficulty=str(args.self_difficulty),
                opponent_difficulty=str(args.opponent_difficulty),
                seed=int(args.seed),
                monitor=monitor,
            )
            results.append(case)
            print(
                f"[bench-case] envs={case['num_envs']} decision_frames={case['decision_frames']} "
                f"decisions/s={case['decisions_per_sec']:.1f} "
                f"per_env={case['per_env_decisions_per_sec']:.2f} "
                f"frames/s={case['frames_per_sec']:.1f} "
                f"done/min={case['done_per_min']:.2f} "
                f"avg_batch_step={case['avg_batch_step_ms']:.2f}ms "
                f"{_resource_text(case.get('resource_sample'))}"
            )

    if monitor is not None:
        monitor.stop()

    if not results:
        print("[bench] no results")
        return

    ranked = sorted(results, key=lambda item: float(item["decisions_per_sec"]), reverse=True)
    print("[bench-summary] ranked by decisions/s")
    for idx, item in enumerate(ranked[:10], start=1):
        print(
            f"[bench-rank] #{idx} envs={item['num_envs']} "
            f"decision_frames={item['decision_frames']} "
            f"decisions/s={item['decisions_per_sec']:.1f} "
            f"frames/s={item['frames_per_sec']:.1f} "
            f"avg_batch_step={item['avg_batch_step_ms']:.2f}ms"
        )

    best = ranked[0]
    print(
        f"[bench-best] envs={best['num_envs']} decision_frames={best['decision_frames']} "
        f"decisions/s={best['decisions_per_sec']:.1f} frames/s={best['frames_per_sec']:.1f}"
    )


if __name__ == "__main__":
    main()
