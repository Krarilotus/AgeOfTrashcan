from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil
from typing import Callable, List


def _parse_milestone_fractions(raw: str) -> List[float]:
    values: List[float] = []
    for token in raw.split(","):
        stripped = token.strip()
        if not stripped:
            continue
        value = float(stripped)
        if value <= 0 or value > 1:
            raise ValueError(f"Milestone fraction out of range (0, 1]: {value}")
        values.append(value)
    return sorted(set(values))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Age of Trashcan SMART_ML self-play policy")
    default_registry_output = str(
        (Path(__file__).resolve().parent.parent / "public" / "ml" / "checkpoints" / "index.json")
    )
    parser.add_argument("--total-steps", type=int, default=10_000_000, help="Total environment steps")
    parser.add_argument("--num-envs", type=int, default=8, help="Number of parallel envs")
    parser.add_argument("--rollout-horizon", type=int, default=256, help="Rollout steps per env per update")
    parser.add_argument("--device", type=str, default="cuda", help="Torch device (cuda/cpu)")
    parser.add_argument("--save-dir", type=str, default="checkpoints", help="Root directory for run outputs")
    parser.add_argument("--run-name", type=str, default="", help="Run name (default: timestamp)")
    parser.add_argument("--resume-from", type=str, default="", help="Checkpoint path to resume from")
    parser.add_argument(
        "--additional-steps",
        type=int,
        default=0,
        help="If resuming, train this many extra steps beyond checkpoint step",
    )
    parser.add_argument("--checkpoint-every", type=int, default=100_000, help="Checkpoint interval in steps")
    parser.add_argument("--eval-every", type=int, default=200_000, help="Evaluation interval in steps")
    parser.add_argument("--eval-matches", type=int, default=200, help="Evaluation matches per eval interval")
    parser.add_argument(
        "--eval-workers",
        type=int,
        default=0,
        help="Parallel workers for evaluation matches (0 = auto from num-envs)",
    )
    parser.add_argument("--log-interval", type=int, default=2_048, help="Log interval in steps")
    parser.add_argument(
        "--model-preset",
        type=str,
        default="base",
        choices=["tiny", "base", "large"],
        help="Model size preset for quick tests vs long runs",
    )
    parser.add_argument("--model-d-model", type=int, default=0, help="Override transformer model dim (>0)")
    parser.add_argument("--model-layers", type=int, default=0, help="Override number of transformer layers (>0)")
    parser.add_argument("--model-heads", type=int, default=0, help="Override number of attention heads (>0)")
    parser.add_argument("--model-ffn-dim", type=int, default=0, help="Override transformer FFN dim (>0)")
    parser.add_argument("--model-sequence-len", type=int, default=0, help="Override sequence length (>0)")
    parser.add_argument("--minibatch-size", type=int, default=0, help="PPO minibatch size override (>0)")
    parser.add_argument(
        "--mixed-precision",
        dest="mixed_precision",
        action="store_true",
        help="Enable mixed precision for PPO updates on CUDA (default)",
    )
    parser.add_argument(
        "--no-mixed-precision",
        dest="mixed_precision",
        action="store_false",
        help="Disable mixed precision for PPO updates",
    )
    parser.set_defaults(mixed_precision=True)
    parser.add_argument(
        "--milestone-fractions",
        type=str,
        default="0.2,0.4,0.6,0.8,1.0",
        help="Comma-separated fractions of total steps for milestone checkpoints",
    )
    parser.add_argument(
        "--disable-milestones",
        action="store_true",
        help="Disable milestone checkpoint saving",
    )
    parser.add_argument(
        "--env-backend",
        type=str,
        default="auto",
        choices=["auto", "mock", "game"],
        help="Environment backend: auto (prefer game bridge), mock, or game",
    )
    parser.add_argument(
        "--opponent-difficulty",
        type=str,
        default="SMART",
        help="Opponent difficulty for game bridge backend",
    )
    parser.add_argument(
        "--self-difficulty",
        type=str,
        default="SMART_ML",
        help="Controlled side difficulty profile for game bridge backend",
    )
    parser.add_argument(
        "--episode-seconds",
        type=int,
        default=1200,
        help="Episode timeout in seconds for game bridge backend",
    )
    parser.add_argument(
        "--decision-frames",
        type=int,
        default=30,
        help="Frames (60Hz) per policy decision step in game bridge backend",
    )
    parser.add_argument(
        "--reward-dense-start",
        type=float,
        default=1.0,
        help="Initial scale for dense intermediate rewards",
    )
    parser.add_argument(
        "--reward-dense-end",
        type=float,
        default=1.0,
        help="Final scale for dense intermediate rewards",
    )
    parser.add_argument(
        "--reward-dense-decay-interval",
        type=float,
        default=0.2,
        help="Progress fraction interval for stepwise dense decay (0.2 means 20%% checkpoints)",
    )
    parser.add_argument(
        "--reward-dense-decay-factor",
        type=float,
        default=0.9,
        help="Dense reward multiplier applied every decay interval",
    )
    parser.add_argument(
        "--reward-terminal-start",
        type=float,
        default=1.0,
        help="Initial scale for terminal win/loss reward",
    )
    parser.add_argument(
        "--reward-terminal-end",
        type=float,
        default=5.0,
        help="Final scale for terminal win/loss reward",
    )
    parser.add_argument(
        "--reward-curriculum-steps",
        type=int,
        default=0,
        help="Steps to finish reward schedule annealing (0 = use total-steps)",
    )
    parser.add_argument(
        "--dead-unit-revival",
        dest="dead_unit_revival",
        action="store_true",
        help="Enable conservative dead-neuron revival checks (default)",
    )
    parser.add_argument(
        "--no-dead-unit-revival",
        dest="dead_unit_revival",
        action="store_false",
        help="Disable dead-neuron revival checks",
    )
    parser.set_defaults(dead_unit_revival=True)
    parser.add_argument(
        "--dead-unit-check-every",
        type=int,
        default=10,
        help="Run dead-neuron checks every N PPO updates",
    )
    parser.add_argument(
        "--dead-unit-zero-epsilon",
        type=float,
        default=1e-10,
        help="Absolute threshold for considering a neuron exactly zeroed",
    )
    parser.add_argument(
        "--dead-unit-streak",
        type=int,
        default=50,
        help="Consecutive checks required before reviving a zeroed neuron",
    )
    parser.add_argument(
        "--league-keep-top",
        type=int,
        default=5,
        help="Number of strongest agents to always keep in league",
    )
    parser.add_argument(
        "--league-keep-diverse",
        type=int,
        default=5,
        help="Additional diversity slots reserved for strategy outliers",
    )
    parser.add_argument(
        "--league-max-agents",
        type=int,
        default=10,
        help="Max retained league agents (top + diverse)",
    )
    parser.add_argument(
        "--league-min-promote-winrate",
        type=float,
        default=0.55,
        help="Default winrate gate for promotion into active league roster",
    )
    parser.add_argument(
        "--league-archetype-winrate-floor",
        type=float,
        default=0.52,
        help="Lower winrate gate allowed for best-in-archetype specialists",
    )
    parser.add_argument(
        "--clean-run",
        dest="clean_run",
        action="store_true",
        help="Delete existing run directory before non-resume training starts (default)",
    )
    parser.add_argument(
        "--no-clean-run",
        dest="clean_run",
        action="store_false",
        help="Do not delete existing run directory for non-resume training",
    )
    parser.set_defaults(clean_run=True)
    parser.add_argument(
        "--registry-output",
        type=str,
        default=default_registry_output,
        help="Checkpoint registry JSON output for UI auto-discovery",
    )
    parser.add_argument(
        "--export-registry",
        dest="export_registry",
        action="store_true",
        help="Export UI checkpoint registry after training (default)",
    )
    parser.add_argument(
        "--no-export-registry",
        dest="export_registry",
        action="store_false",
        help="Skip UI checkpoint registry export after training",
    )
    parser.set_defaults(export_registry=True)
    return parser.parse_args()


def _export_checkpoint_registry(checkpoints_root: Path, output_path: Path) -> None:
    from selfplay.checkpoint_registry import build_registry

    checkpoints_root = checkpoints_root.resolve()
    output_path = output_path.resolve()
    registry = build_registry(checkpoints_root)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        import json

        json.dump(registry, handle, indent=2)
    print(f"[registry] wrote {len(registry.get('checkpoints', []))} checkpoints to {output_path}")
    latest_id = registry.get("latestCheckpointId")
    if latest_id:
        print(f"[registry] latest={latest_id}")


def main() -> None:
    args = parse_args()

    try:
        from selfplay.config import OvernightConfig
        from selfplay.env import GameBridgeEnv, MockSelfPlayEnv, SelfPlayEnv
        from selfplay.trainer import SelfPlayTrainer
    except ModuleNotFoundError as exc:
        missing_name = getattr(exc, "name", "unknown")
        raise SystemExit(
            f"Missing dependency: {missing_name}. Install dependencies with "
            f"`python -m pip install -e .` from the ml directory."
        ) from exc

    cfg = OvernightConfig()
    if args.model_preset == "tiny":
        cfg.model.d_model = 128
        cfg.model.n_layers = 4
        cfg.model.n_heads = 4
        cfg.model.ffn_dim = 384
        cfg.model.sequence_len = 160
        cfg.model.dropout = 0.05
    elif args.model_preset == "large":
        cfg.model.d_model = 320
        cfg.model.n_layers = 10
        cfg.model.n_heads = 10
        cfg.model.ffn_dim = 1280
        cfg.model.sequence_len = 240
        cfg.model.dropout = 0.1

    if args.model_d_model > 0:
        cfg.model.d_model = int(args.model_d_model)
    if args.model_layers > 0:
        cfg.model.n_layers = int(args.model_layers)
    if args.model_heads > 0:
        cfg.model.n_heads = int(args.model_heads)
    if args.model_ffn_dim > 0:
        cfg.model.ffn_dim = int(args.model_ffn_dim)
    if args.model_sequence_len > 0:
        cfg.model.sequence_len = int(args.model_sequence_len)
    if cfg.model.d_model % max(1, cfg.model.n_heads) != 0:
        raise SystemExit("model-d-model must be divisible by model-heads")

    cfg.runtime.total_steps = args.total_steps
    cfg.runtime.num_envs = args.num_envs
    cfg.runtime.rollout_horizon = args.rollout_horizon
    cfg.runtime.device = args.device
    cfg.runtime.checkpoint_every = args.checkpoint_every
    cfg.runtime.eval_every = args.eval_every
    cfg.runtime.eval_matches = args.eval_matches
    cfg.runtime.eval_workers = max(0, int(args.eval_workers))
    cfg.runtime.log_interval = args.log_interval
    cfg.runtime.mixed_precision = bool(args.mixed_precision)
    cfg.runtime.reward_dense_scale_start = float(args.reward_dense_start)
    cfg.runtime.reward_dense_scale_end = float(args.reward_dense_end)
    cfg.runtime.reward_dense_decay_interval = float(args.reward_dense_decay_interval)
    cfg.runtime.reward_dense_decay_factor = float(args.reward_dense_decay_factor)
    cfg.runtime.reward_terminal_scale_start = float(args.reward_terminal_start)
    cfg.runtime.reward_terminal_scale_end = float(args.reward_terminal_end)
    cfg.runtime.reward_curriculum_steps = max(0, int(args.reward_curriculum_steps))
    cfg.runtime.league_keep_top_n = max(1, int(args.league_keep_top))
    cfg.runtime.league_keep_diverse_n = max(0, int(args.league_keep_diverse))
    cfg.runtime.league_max_agents = max(
        cfg.runtime.league_keep_top_n,
        int(args.league_max_agents),
    )
    cfg.runtime.league_min_promote_winrate = float(args.league_min_promote_winrate)
    cfg.runtime.league_archetype_winrate_floor = float(args.league_archetype_winrate_floor)
    cfg.runtime.dead_unit_revival_enabled = bool(args.dead_unit_revival)
    cfg.runtime.dead_unit_check_every = max(1, int(args.dead_unit_check_every))
    cfg.runtime.dead_unit_zero_epsilon = max(0.0, float(args.dead_unit_zero_epsilon))
    cfg.runtime.dead_unit_streak = max(1, int(args.dead_unit_streak))
    if cfg.runtime.reward_dense_scale_start < 0 or cfg.runtime.reward_dense_scale_end < 0:
        raise SystemExit("reward-dense-start and reward-dense-end must be >= 0")
    if cfg.runtime.reward_terminal_scale_start < 0 or cfg.runtime.reward_terminal_scale_end < 0:
        raise SystemExit("reward-terminal-start and reward-terminal-end must be >= 0")
    if cfg.runtime.reward_dense_decay_interval < 0:
        raise SystemExit("reward-dense-decay-interval must be >= 0")
    if cfg.runtime.reward_dense_decay_factor <= 0:
        raise SystemExit("reward-dense-decay-factor must be > 0")
    if cfg.runtime.league_min_promote_winrate < 0 or cfg.runtime.league_min_promote_winrate > 1:
        raise SystemExit("league-min-promote-winrate must be in [0, 1]")
    if cfg.runtime.league_archetype_winrate_floor < 0 or cfg.runtime.league_archetype_winrate_floor > 1:
        raise SystemExit("league-archetype-winrate-floor must be in [0, 1]")
    if cfg.runtime.league_archetype_winrate_floor > cfg.runtime.league_min_promote_winrate:
        raise SystemExit("league-archetype-winrate-floor must be <= league-min-promote-winrate")
    if cfg.runtime.dead_unit_zero_epsilon > 1e-4:
        raise SystemExit("dead-unit-zero-epsilon is too large; keep it <= 1e-4 for safety")
    if args.minibatch_size and args.minibatch_size > 0:
        cfg.ppo.minibatch_size = int(args.minibatch_size)

    resume_path = args.resume_from.strip()
    if resume_path:
        resume_resolved = Path(resume_path).resolve()
        run_dir = resume_resolved.parent
        run_name = run_dir.name
    else:
        run_name = args.run_name.strip() or datetime.now(timezone.utc).strftime("run_%Y%m%d_%H%M%S")
        run_dir = (Path(args.save_dir) / run_name).resolve()
        if args.clean_run and run_dir.exists():
            shutil.rmtree(run_dir)

    cfg.runtime.save_dir = str(run_dir)
    checkpoints_root = run_dir.parent.resolve()

    env_backend = args.env_backend
    env_factory: Callable[[], SelfPlayEnv]
    if env_backend == "mock":
        env_factory = lambda: MockSelfPlayEnv(cfg.model)
    elif env_backend == "game":
        env_factory = lambda: GameBridgeEnv(
            cfg.model,
            opponent_difficulty=args.opponent_difficulty,
            self_difficulty=args.self_difficulty,
            episode_seconds=args.episode_seconds,
            decision_frames=args.decision_frames,
        )
    else:
        try:
            probe_env = GameBridgeEnv(
                cfg.model,
                opponent_difficulty=args.opponent_difficulty,
                self_difficulty=args.self_difficulty,
                episode_seconds=args.episode_seconds,
                decision_frames=args.decision_frames,
            )
            probe_env.close()
            env_factory = lambda: GameBridgeEnv(
                cfg.model,
                opponent_difficulty=args.opponent_difficulty,
                self_difficulty=args.self_difficulty,
                episode_seconds=args.episode_seconds,
                decision_frames=args.decision_frames,
            )
            print("[env] backend=game (auto)")
        except Exception as exc:
            print(f"[env] backend=mock (auto fallback): {exc}")
            env_factory = lambda: MockSelfPlayEnv(cfg.model)

    trainer = SelfPlayTrainer(cfg, env_factory=env_factory, eval_env_factory=env_factory, run_name=run_name)

    if resume_path:
        trainer.resume_from_checkpoint(resume_path)
        if args.additional_steps > 0:
            cfg.runtime.total_steps = trainer.get_global_step() + args.additional_steps
        if cfg.runtime.total_steps <= trainer.get_global_step():
            raise SystemExit(
                "total-steps must be greater than resumed step; either increase --total-steps "
                "or use --additional-steps."
            )

    if args.disable_milestones:
        trainer.set_milestone_steps([])
    else:
        try:
            fractions = _parse_milestone_fractions(args.milestone_fractions)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        milestone_steps = [
            int(cfg.runtime.total_steps * fraction)
            for fraction in fractions
            if int(cfg.runtime.total_steps * fraction) > 0
        ]
        trainer.set_milestone_steps(sorted(set(milestone_steps)))

    try:
        trainer.train()
    finally:
        if args.export_registry:
            try:
                _export_checkpoint_registry(checkpoints_root, Path(args.registry_output))
            except Exception as exc:  # noqa: BLE001
                print(f"[registry] export failed: {exc}")


if __name__ == "__main__":
    main()
