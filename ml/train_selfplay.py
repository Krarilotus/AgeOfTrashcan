from __future__ import annotations

import argparse

from selfplay.config import OvernightConfig
from selfplay.trainer import SelfPlayTrainer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Age of Trashcan SMART_ML self-play policy")
    parser.add_argument("--total-steps", type=int, default=10_000_000, help="Total environment steps")
    parser.add_argument("--num-envs", type=int, default=8, help="Number of parallel envs")
    parser.add_argument("--rollout-horizon", type=int, default=256, help="Rollout steps per env per update")
    parser.add_argument("--device", type=str, default="cuda", help="Torch device (cuda/cpu)")
    parser.add_argument("--save-dir", type=str, default="checkpoints", help="Checkpoint directory")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cfg = OvernightConfig()
    cfg.runtime.total_steps = args.total_steps
    cfg.runtime.num_envs = args.num_envs
    cfg.runtime.rollout_horizon = args.rollout_horizon
    cfg.runtime.device = args.device
    cfg.runtime.save_dir = args.save_dir

    trainer = SelfPlayTrainer(cfg)
    trainer.train()


if __name__ == "__main__":
    main()
