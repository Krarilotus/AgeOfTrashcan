from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import List


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
    parser.add_argument("--log-interval", type=int, default=2_048, help="Log interval in steps")
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
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    try:
        from selfplay.config import OvernightConfig
        from selfplay.trainer import SelfPlayTrainer
    except ModuleNotFoundError as exc:
        missing_name = getattr(exc, "name", "unknown")
        raise SystemExit(
            f"Missing dependency: {missing_name}. Install dependencies with "
            f"`python -m pip install -e .` from the ml directory."
        ) from exc

    cfg = OvernightConfig()
    cfg.runtime.total_steps = args.total_steps
    cfg.runtime.num_envs = args.num_envs
    cfg.runtime.rollout_horizon = args.rollout_horizon
    cfg.runtime.device = args.device
    cfg.runtime.checkpoint_every = args.checkpoint_every
    cfg.runtime.eval_every = args.eval_every
    cfg.runtime.eval_matches = args.eval_matches
    cfg.runtime.log_interval = args.log_interval

    resume_path = args.resume_from.strip()
    if resume_path:
        resume_resolved = Path(resume_path).resolve()
        run_dir = resume_resolved.parent
        run_name = run_dir.name
    else:
        run_name = args.run_name.strip() or datetime.now(timezone.utc).strftime("run_%Y%m%d_%H%M%S")
        run_dir = (Path(args.save_dir) / run_name).resolve()

    cfg.runtime.save_dir = str(run_dir)

    trainer = SelfPlayTrainer(cfg, run_name=run_name)

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

    trainer.train()


if __name__ == "__main__":
    main()
