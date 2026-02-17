from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
from typing import Any, Callable, Dict, List

from selfplay.defaults import (
    DEFAULT_CHECKPOINT_EVERY,
    DEFAULT_CLEAN_RUN,
    DEFAULT_DECISION_FRAMES,
    DEFAULT_DEAD_UNIT_CHECK_EVERY,
    DEFAULT_DEAD_UNIT_REVIVAL_ENABLED,
    DEFAULT_DEAD_UNIT_STREAK,
    DEFAULT_DEAD_UNIT_ZERO_EPSILON,
    DEFAULT_DEVICE,
    DEFAULT_ENV_BACKEND,
    DEFAULT_EPISODE_SECONDS,
    DEFAULT_EVAL_EVERY,
    DEFAULT_EVAL_EARLY_EVERY,
    DEFAULT_EVAL_LATE_EVERY,
    DEFAULT_EVAL_MATCHES,
    DEFAULT_EVAL_SWITCH_PROGRESS,
    DEFAULT_EVAL_WORKERS,
    DEFAULT_EXPORT_REGISTRY,
    DEFAULT_KEEP_AWAKE,
    DEFAULT_KEEP_AWAKE_INTERVAL_SEC,
    DEFAULT_LEAGUE_ARBITERS,
    DEFAULT_LEAGUE_ARCHETYPE_WINRATE_FLOOR,
    DEFAULT_LEAGUE_ELO_RANDOM_FACTOR,
    DEFAULT_LEAGUE_KEEP_DIVERSE,
    DEFAULT_LEAGUE_KEEP_TOP,
    DEFAULT_LEAGUE_MAX_AGENTS,
    DEFAULT_LEAGUE_MIN_GAMES_PER_AGENT,
    DEFAULT_LEAGUE_MIN_PROMOTE_WINRATE,
    DEFAULT_LEAGUE_SPINOFF_NOISE,
    DEFAULT_LEAGUE_SPINOFFS_PER_ANCHOR,
    DEFAULT_LEAGUE_USE_CHECKPOINT_OPPONENTS,
    DEFAULT_LOG_INTERVAL,
    DEFAULT_MILESTONE_FRACTIONS,
    DEFAULT_MIXED_PRECISION,
    DEFAULT_MODEL_PRESET,
    DEFAULT_NUM_ENVS,
    DEFAULT_OPPONENT_DIFFICULTY,
    DEFAULT_REWARD_CURRICULUM_STEPS,
    DEFAULT_REWARD_DENSE_CUTOFF_PROGRESS,
    DEFAULT_REWARD_DENSE_DECAY_FACTOR,
    DEFAULT_REWARD_DENSE_DECAY_INTERVAL,
    DEFAULT_REWARD_DENSE_SCALE_END,
    DEFAULT_REWARD_DENSE_SCALE_START,
    DEFAULT_REWARD_KEEP_ENEMY_BASE_MILESTONE_AFTER_DENSE_CUTOFF,
    DEFAULT_REWARD_TERMINAL_SCALE_END,
    DEFAULT_REWARD_TERMINAL_SCALE_START,
    DEFAULT_REWARD_UNIT_CURRICULUM_END_PROGRESS,
    DEFAULT_REWARD_UNIT_CURRICULUM_END_SCALE,
    DEFAULT_REWARD_UNIT_CURRICULUM_START_SCALE,
    DEFAULT_ROLLOUT_HORIZON,
    DEFAULT_SAVE_DIR,
    DEFAULT_SELF_DIFFICULTY,
    DEFAULT_SMART_ENV_ADJUST_COOLDOWN_SEC,
    DEFAULT_SMART_ENV_AUTOSCALE,
    DEFAULT_SMART_ENV_GPU_PROBE_HZ,
    DEFAULT_SMART_ENV_GPU_SUSTAIN_SEC,
    DEFAULT_SMART_ENV_MAX_ENVS,
    DEFAULT_SMART_ENV_MIN_ENVS,
    DEFAULT_SMART_ENV_SAMPLE_HZ,
    DEFAULT_SMART_ENV_SCALE_DOWN_TRIGGER_PERCENT,
    DEFAULT_SMART_ENV_SCALE_STEP,
    DEFAULT_SMART_ENV_TARGET_UTIL_PERCENT,
    DEFAULT_TOTAL_STEPS,
    MODEL_PRESET_OVERRIDES,
)


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


def _load_reward_profile(path_raw: str) -> Dict[str, Any]:
    path_text = (path_raw or "").strip()
    if not path_text:
        return {}
    profile_path = Path(path_text)
    if not profile_path.is_absolute():
        profile_path = (Path.cwd() / profile_path).resolve()
    if not profile_path.exists():
        return {}
    with profile_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise SystemExit(f"reward-profile must contain a JSON object: {profile_path}")
    return payload


def _apply_reward_profile(cfg, profile: Dict[str, Any]) -> None:
    if not profile:
        return
    schedule = profile.get("schedule")
    if isinstance(schedule, dict):
        float_fields = {
            "dense_start": "reward_dense_scale_start",
            "dense_end": "reward_dense_scale_end",
            "dense_decay_interval": "reward_dense_decay_interval",
            "dense_decay_factor": "reward_dense_decay_factor",
            "terminal_start": "reward_terminal_scale_start",
            "terminal_end": "reward_terminal_scale_end",
            "reward_clip_abs": "reward_clip_abs",
            "unit_curriculum_end_progress": "reward_unit_curriculum_end_progress",
            "unit_curriculum_start_scale": "reward_unit_curriculum_start_scale",
            "unit_curriculum_end_scale": "reward_unit_curriculum_end_scale",
            "dense_cutoff_progress": "reward_dense_cutoff_progress",
        }
        int_fields = {
            "curriculum_steps": "reward_curriculum_steps",
        }
        bool_fields = {
            "reward_normalize": "reward_normalize",
            "keep_enemy_base_milestone_after_dense_cutoff": "reward_keep_enemy_base_milestone_after_dense_cutoff",
        }
        for key, attr in float_fields.items():
            if key in schedule and isinstance(schedule[key], (int, float)):
                setattr(cfg.runtime, attr, float(schedule[key]))
        for key, attr in int_fields.items():
            if key in schedule and isinstance(schedule[key], (int, float)):
                setattr(cfg.runtime, attr, int(schedule[key]))
        for key, attr in bool_fields.items():
            if key in schedule and isinstance(schedule[key], bool):
                setattr(cfg.runtime, attr, bool(schedule[key]))

    bridge = profile.get("bridge")
    if isinstance(bridge, dict):
        cfg.runtime.bridge_reward_profile = bridge


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Age of Trashcan SMART_ML self-play policy")
    model_preset_choices = ["base", *MODEL_PRESET_OVERRIDES.keys()]
    default_registry_output = str(
        (Path(__file__).resolve().parent.parent / "assets" / "ml" / "checkpoints" / "index.json")
    )
    default_reward_profile = os.getenv(
        "REWARD_PROFILE",
        str((Path(__file__).resolve().parent / "reward_profile.json").resolve()),
    )
    parser.add_argument("--total-steps", type=int, default=DEFAULT_TOTAL_STEPS, help="Total environment steps")
    parser.add_argument("--num-envs", type=int, default=DEFAULT_NUM_ENVS, help="Number of parallel envs")
    parser.add_argument(
        "--rollout-horizon",
        type=int,
        default=DEFAULT_ROLLOUT_HORIZON,
        help="Rollout steps per env per update",
    )
    parser.add_argument("--device", type=str, default=DEFAULT_DEVICE, help="Torch device (cuda/cpu)")
    parser.add_argument("--save-dir", type=str, default=DEFAULT_SAVE_DIR, help="Root directory for run outputs")
    parser.add_argument("--run-name", type=str, default="", help="Run name (default: timestamp)")
    parser.add_argument("--resume-from", type=str, default="", help="Checkpoint path to resume from")
    parser.add_argument(
        "--additional-steps",
        type=int,
        default=0,
        help="If resuming, train this many extra steps beyond checkpoint step",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=DEFAULT_CHECKPOINT_EVERY,
        help="Checkpoint interval in steps",
    )
    parser.add_argument("--eval-every", type=int, default=DEFAULT_EVAL_EVERY, help="Evaluation interval in steps")
    parser.add_argument(
        "--eval-early-every",
        type=int,
        default=DEFAULT_EVAL_EARLY_EVERY,
        help="Optional early-phase eval interval in steps (requires eval-late-every > 0)",
    )
    parser.add_argument(
        "--eval-late-every",
        type=int,
        default=DEFAULT_EVAL_LATE_EVERY,
        help="Optional late-phase eval interval in steps (requires eval-early-every > 0)",
    )
    parser.add_argument(
        "--eval-switch-progress",
        type=float,
        default=DEFAULT_EVAL_SWITCH_PROGRESS,
        help="Progress fraction [0..1] where eval cadence switches from early to late interval",
    )
    parser.add_argument(
        "--eval-matches",
        type=int,
        default=DEFAULT_EVAL_MATCHES,
        help="Evaluation matches per eval interval",
    )
    parser.add_argument(
        "--eval-workers",
        type=int,
        default=DEFAULT_EVAL_WORKERS,
        help="Parallel workers for evaluation matches (0 = auto from num-envs)",
    )
    parser.add_argument("--log-interval", type=int, default=DEFAULT_LOG_INTERVAL, help="Log interval in steps")
    parser.add_argument(
        "--model-preset",
        type=str,
        default=DEFAULT_MODEL_PRESET,
        choices=model_preset_choices,
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
    parser.set_defaults(mixed_precision=DEFAULT_MIXED_PRECISION)
    parser.add_argument(
        "--milestone-fractions",
        type=str,
        default=DEFAULT_MILESTONE_FRACTIONS,
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
        default=DEFAULT_ENV_BACKEND,
        choices=["auto", "mock", "game"],
        help="Environment backend: auto (prefer game bridge), mock, or game",
    )
    parser.add_argument(
        "--opponent-difficulty",
        type=str,
        default=DEFAULT_OPPONENT_DIFFICULTY,
        help="Opponent difficulty for game bridge backend",
    )
    parser.add_argument(
        "--self-difficulty",
        type=str,
        default=DEFAULT_SELF_DIFFICULTY,
        help="Controlled side difficulty profile for game bridge backend",
    )
    parser.add_argument(
        "--episode-seconds",
        type=int,
        default=DEFAULT_EPISODE_SECONDS,
        help="Episode timeout in seconds for game bridge backend",
    )
    parser.add_argument(
        "--decision-frames",
        type=int,
        default=DEFAULT_DECISION_FRAMES,
        help="Frames (60Hz) per policy decision step in game bridge backend",
    )
    parser.add_argument(
        "--reward-dense-start",
        type=float,
        default=DEFAULT_REWARD_DENSE_SCALE_START,
        help="Initial scale for dense intermediate rewards",
    )
    parser.add_argument(
        "--reward-dense-end",
        type=float,
        default=DEFAULT_REWARD_DENSE_SCALE_END,
        help="Final scale for dense intermediate rewards",
    )
    parser.add_argument(
        "--reward-dense-decay-interval",
        type=float,
        default=DEFAULT_REWARD_DENSE_DECAY_INTERVAL,
        help="Progress fraction interval for stepwise dense decay (0.2 means 20%% checkpoints)",
    )
    parser.add_argument(
        "--reward-dense-decay-factor",
        type=float,
        default=DEFAULT_REWARD_DENSE_DECAY_FACTOR,
        help="Dense reward multiplier applied every decay interval",
    )
    parser.add_argument(
        "--reward-terminal-start",
        type=float,
        default=DEFAULT_REWARD_TERMINAL_SCALE_START,
        help="Initial scale for terminal win/loss reward",
    )
    parser.add_argument(
        "--reward-terminal-end",
        type=float,
        default=DEFAULT_REWARD_TERMINAL_SCALE_END,
        help="Final scale for terminal win/loss reward",
    )
    parser.add_argument(
        "--reward-curriculum-steps",
        type=int,
        default=DEFAULT_REWARD_CURRICULUM_STEPS,
        help="Steps to finish reward schedule annealing (0 = use total-steps)",
    )
    parser.add_argument(
        "--reward-unit-curriculum-end-progress",
        type=float,
        default=DEFAULT_REWARD_UNIT_CURRICULUM_END_PROGRESS,
        help="Progress fraction where unit kill/loss curriculum scaling reaches its end value",
    )
    parser.add_argument(
        "--reward-unit-curriculum-start-scale",
        type=float,
        default=DEFAULT_REWARD_UNIT_CURRICULUM_START_SCALE,
        help="Initial multiplier for unit kill/loss components",
    )
    parser.add_argument(
        "--reward-unit-curriculum-end-scale",
        type=float,
        default=DEFAULT_REWARD_UNIT_CURRICULUM_END_SCALE,
        help="Final multiplier for unit kill/loss components after curriculum end progress",
    )
    parser.add_argument(
        "--reward-dense-cutoff-progress",
        type=float,
        default=DEFAULT_REWARD_DENSE_CUTOFF_PROGRESS,
        help="Progress fraction after which dense rewards are shut off",
    )
    parser.add_argument(
        "--reward-keep-enemy-base-milestone-after-dense-cutoff",
        dest="reward_keep_enemy_base_milestone_after_dense_cutoff",
        action="store_true",
        help="Keep one-time enemy base milestone rewards active after dense cutoff (default)",
    )
    parser.add_argument(
        "--no-reward-keep-enemy-base-milestone-after-dense-cutoff",
        dest="reward_keep_enemy_base_milestone_after_dense_cutoff",
        action="store_false",
        help="Disable enemy base milestone rewards after dense cutoff",
    )
    parser.set_defaults(
        reward_keep_enemy_base_milestone_after_dense_cutoff=
        DEFAULT_REWARD_KEEP_ENEMY_BASE_MILESTONE_AFTER_DENSE_CUTOFF
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
    parser.set_defaults(dead_unit_revival=DEFAULT_DEAD_UNIT_REVIVAL_ENABLED)
    parser.add_argument(
        "--dead-unit-check-every",
        type=int,
        default=DEFAULT_DEAD_UNIT_CHECK_EVERY,
        help="Run dead-neuron checks every N PPO updates",
    )
    parser.add_argument(
        "--dead-unit-zero-epsilon",
        type=float,
        default=DEFAULT_DEAD_UNIT_ZERO_EPSILON,
        help="Absolute threshold for considering a neuron exactly zeroed",
    )
    parser.add_argument(
        "--dead-unit-streak",
        type=int,
        default=DEFAULT_DEAD_UNIT_STREAK,
        help="Consecutive checks required before reviving a zeroed neuron",
    )
    parser.add_argument(
        "--league-keep-top",
        type=int,
        default=DEFAULT_LEAGUE_KEEP_TOP,
        help="Number of strongest agents to always keep in league",
    )
    parser.add_argument(
        "--league-keep-diverse",
        type=int,
        default=DEFAULT_LEAGUE_KEEP_DIVERSE,
        help="Additional diversity slots reserved for strategy outliers",
    )
    parser.add_argument(
        "--league-max-agents",
        type=int,
        default=DEFAULT_LEAGUE_MAX_AGENTS,
        help="Max retained league agents (top + diverse)",
    )
    parser.add_argument(
        "--league-min-promote-winrate",
        type=float,
        default=DEFAULT_LEAGUE_MIN_PROMOTE_WINRATE,
        help="Default winrate gate for promotion into active league roster",
    )
    parser.add_argument(
        "--league-archetype-winrate-floor",
        type=float,
        default=DEFAULT_LEAGUE_ARCHETYPE_WINRATE_FLOOR,
        help="Lower winrate gate allowed for best-in-archetype specialists",
    )
    parser.add_argument(
        "--league-arbiters",
        type=str,
        default=DEFAULT_LEAGUE_ARBITERS,
        help="Comma-separated fixed baseline league opponents (subset of EASY,MEDIUM,HARD,SMART,CHEATER).",
    )
    parser.add_argument(
        "--league-min-games-per-agent",
        type=int,
        default=DEFAULT_LEAGUE_MIN_GAMES_PER_AGENT,
        help="Minimum sampled games per league agent before sampling cycle resets.",
    )
    parser.add_argument(
        "--league-elo-random-factor",
        type=float,
        default=DEFAULT_LEAGUE_ELO_RANDOM_FACTOR,
        help="Randomness factor for ELO-biased league opponent pairing (0..1).",
    )
    parser.add_argument(
        "--league-use-checkpoint-opponents",
        dest="league_use_checkpoint_opponents",
        action="store_true",
        help="When sampling league opponents, include checkpoint IDs (requires working SMART_ML checkpoint inference).",
    )
    parser.add_argument(
        "--no-league-use-checkpoint-opponents",
        dest="league_use_checkpoint_opponents",
        action="store_false",
        help="Sample league opponents via strategy profile without checkpoint IDs (default, robust for game bridge training).",
    )
    parser.set_defaults(league_use_checkpoint_opponents=DEFAULT_LEAGUE_USE_CHECKPOINT_OPPONENTS)
    parser.add_argument(
        "--league-spinoffs-per-anchor",
        type=int,
        default=DEFAULT_LEAGUE_SPINOFFS_PER_ANCHOR,
        help="Evolutionary spin-offs per anchor agent (0 => auto: max/(top+diverse)-1).",
    )
    parser.add_argument(
        "--league-spinoff-noise",
        type=float,
        default=DEFAULT_LEAGUE_SPINOFF_NOISE,
        help="Mutation noise for evolutionary league spin-offs.",
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
    parser.set_defaults(clean_run=DEFAULT_CLEAN_RUN)
    parser.add_argument(
        "--smart-env-autoscale",
        dest="smart_env_autoscale",
        action="store_true",
        help="Dynamically scale env workers to keep system utilization under target",
    )
    parser.add_argument(
        "--no-smart-env-autoscale",
        dest="smart_env_autoscale",
        action="store_false",
        help="Disable dynamic env autoscaling",
    )
    parser.set_defaults(smart_env_autoscale=DEFAULT_SMART_ENV_AUTOSCALE)
    parser.add_argument(
        "--smart-env-target-util",
        type=float,
        default=DEFAULT_SMART_ENV_TARGET_UTIL_PERCENT,
        help="Utilization target percentage for CPU/RAM autoscale cap",
    )
    parser.add_argument(
        "--smart-env-scale-down-trigger",
        type=float,
        default=DEFAULT_SMART_ENV_SCALE_DOWN_TRIGGER_PERCENT,
        help="High-watermark utilization percentage to trigger gradual env scale-down",
    )
    parser.add_argument(
        "--smart-env-scale-step",
        type=int,
        default=DEFAULT_SMART_ENV_SCALE_STEP,
        help="How many env workers to add per autoscale adjustment (autoscale mode)",
    )
    parser.add_argument(
        "--smart-env-adjust-cooldown-sec",
        type=float,
        default=DEFAULT_SMART_ENV_ADJUST_COOLDOWN_SEC,
        help="Cooldown between autoscale adjustments in seconds (autoscale mode)",
    )
    parser.add_argument(
        "--smart-env-min",
        type=int,
        default=DEFAULT_SMART_ENV_MIN_ENVS,
        help="Minimum env workers when autoscale is enabled",
    )
    parser.add_argument(
        "--smart-env-max",
        type=int,
        default=DEFAULT_SMART_ENV_MAX_ENVS,
        help="Maximum env workers when autoscale is enabled (0 = unbounded)",
    )
    parser.add_argument(
        "--smart-env-sample-hz",
        type=float,
        default=DEFAULT_SMART_ENV_SAMPLE_HZ,
        help="Resource sampling rate in Hz",
    )
    parser.add_argument(
        "--smart-env-gpu-probe-hz",
        type=float,
        default=DEFAULT_SMART_ENV_GPU_PROBE_HZ,
        help="GPU probe rate in Hz (nvidia-smi polling)",
    )
    parser.add_argument(
        "--smart-env-gpu-sustain-sec",
        type=float,
        default=DEFAULT_SMART_ENV_GPU_SUSTAIN_SEC,
        help="Seconds of sustained GPU overload required before autoscale scale-down reacts",
    )
    parser.add_argument(
        "--keep-awake",
        dest="keep_awake",
        action="store_true",
        help="Prevent Windows sleep/screensaver while training is running (default)",
    )
    parser.add_argument(
        "--no-keep-awake",
        dest="keep_awake",
        action="store_false",
        help="Disable keep-awake signaling during training",
    )
    parser.set_defaults(keep_awake=DEFAULT_KEEP_AWAKE)
    parser.add_argument(
        "--keep-awake-interval-sec",
        type=float,
        default=DEFAULT_KEEP_AWAKE_INTERVAL_SEC,
        help="Heartbeat interval in seconds for keep-awake signaling",
    )
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
    parser.set_defaults(export_registry=DEFAULT_EXPORT_REGISTRY)
    parser.add_argument(
        "--reward-profile",
        type=str,
        default=default_reward_profile,
        help="Path to reward profile JSON (schedule + bridge component settings). Empty disables profile loading.",
    )
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
    preset_override = MODEL_PRESET_OVERRIDES.get(args.model_preset)
    if preset_override:
        cfg.model.d_model = int(preset_override["d_model"])
        cfg.model.n_layers = int(preset_override["n_layers"])
        cfg.model.n_heads = int(preset_override["n_heads"])
        cfg.model.ffn_dim = int(preset_override["ffn_dim"])
        cfg.model.sequence_len = int(preset_override["sequence_len"])
        cfg.model.dropout = float(preset_override["dropout"])

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
    cfg.runtime.eval_early_every = max(0, int(args.eval_early_every))
    cfg.runtime.eval_late_every = max(0, int(args.eval_late_every))
    cfg.runtime.eval_switch_progress = float(args.eval_switch_progress)
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
    cfg.runtime.reward_unit_curriculum_end_progress = float(args.reward_unit_curriculum_end_progress)
    cfg.runtime.reward_unit_curriculum_start_scale = float(args.reward_unit_curriculum_start_scale)
    cfg.runtime.reward_unit_curriculum_end_scale = float(args.reward_unit_curriculum_end_scale)
    cfg.runtime.reward_dense_cutoff_progress = float(args.reward_dense_cutoff_progress)
    cfg.runtime.reward_keep_enemy_base_milestone_after_dense_cutoff = bool(
        args.reward_keep_enemy_base_milestone_after_dense_cutoff
    )
    cfg.runtime.league_keep_top_n = max(1, int(args.league_keep_top))
    cfg.runtime.league_keep_diverse_n = max(0, int(args.league_keep_diverse))
    cfg.runtime.league_max_agents = max(
        cfg.runtime.league_keep_top_n,
        int(args.league_max_agents),
    )
    cfg.runtime.league_min_promote_winrate = float(args.league_min_promote_winrate)
    cfg.runtime.league_archetype_winrate_floor = float(args.league_archetype_winrate_floor)
    cfg.runtime.league_arbiters = str(args.league_arbiters or "").strip()
    cfg.runtime.league_min_games_per_agent = max(1, int(args.league_min_games_per_agent))
    cfg.runtime.league_elo_random_factor = max(0.0, float(args.league_elo_random_factor))
    cfg.runtime.league_use_checkpoint_opponents = bool(args.league_use_checkpoint_opponents)
    cfg.runtime.league_spinoffs_per_anchor = max(0, int(args.league_spinoffs_per_anchor))
    cfg.runtime.league_spinoff_noise = max(0.0, float(args.league_spinoff_noise))
    cfg.runtime.dead_unit_revival_enabled = bool(args.dead_unit_revival)
    cfg.runtime.dead_unit_check_every = max(1, int(args.dead_unit_check_every))
    cfg.runtime.dead_unit_zero_epsilon = max(0.0, float(args.dead_unit_zero_epsilon))
    cfg.runtime.dead_unit_streak = max(1, int(args.dead_unit_streak))
    cfg.runtime.smart_env_autoscale = bool(args.smart_env_autoscale)
    cfg.runtime.smart_env_target_util_percent = float(args.smart_env_target_util)
    cfg.runtime.smart_env_scale_down_trigger_percent = float(args.smart_env_scale_down_trigger)
    cfg.runtime.smart_env_scale_step = max(1, int(args.smart_env_scale_step))
    cfg.runtime.smart_env_adjust_cooldown_sec = max(1.0, float(args.smart_env_adjust_cooldown_sec))
    cfg.runtime.smart_env_min_envs = max(1, int(args.smart_env_min))
    cfg.runtime.smart_env_max_envs = max(0, int(args.smart_env_max))
    cfg.runtime.smart_env_sample_hz = max(0.5, float(args.smart_env_sample_hz))
    cfg.runtime.smart_env_gpu_probe_hz = max(0.2, float(args.smart_env_gpu_probe_hz))
    cfg.runtime.smart_env_gpu_sustain_sec = max(1.0, float(args.smart_env_gpu_sustain_sec))
    reward_profile = _load_reward_profile(args.reward_profile)
    _apply_reward_profile(cfg, reward_profile)
    if cfg.runtime.reward_dense_scale_start < 0 or cfg.runtime.reward_dense_scale_end < 0:
        raise SystemExit("reward-dense-start and reward-dense-end must be >= 0")
    if cfg.runtime.reward_terminal_scale_start < 0 or cfg.runtime.reward_terminal_scale_end < 0:
        raise SystemExit("reward-terminal-start and reward-terminal-end must be >= 0")
    if cfg.runtime.reward_dense_decay_interval < 0:
        raise SystemExit("reward-dense-decay-interval must be >= 0")
    if cfg.runtime.reward_dense_decay_factor <= 0:
        raise SystemExit("reward-dense-decay-factor must be > 0")
    if cfg.runtime.reward_unit_curriculum_end_progress < 0 or cfg.runtime.reward_unit_curriculum_end_progress > 1:
        raise SystemExit("reward-unit-curriculum-end-progress must be in [0, 1]")
    if cfg.runtime.reward_dense_cutoff_progress < 0 or cfg.runtime.reward_dense_cutoff_progress > 1:
        raise SystemExit("reward-dense-cutoff-progress must be in [0, 1]")
    if cfg.runtime.reward_unit_curriculum_start_scale < 0 or cfg.runtime.reward_unit_curriculum_end_scale < 0:
        raise SystemExit("reward-unit-curriculum-start-scale and reward-unit-curriculum-end-scale must be >= 0")
    if cfg.runtime.league_min_promote_winrate < 0 or cfg.runtime.league_min_promote_winrate > 1:
        raise SystemExit("league-min-promote-winrate must be in [0, 1]")
    if cfg.runtime.league_archetype_winrate_floor < 0 or cfg.runtime.league_archetype_winrate_floor > 1:
        raise SystemExit("league-archetype-winrate-floor must be in [0, 1]")
    if cfg.runtime.league_archetype_winrate_floor > cfg.runtime.league_min_promote_winrate:
        raise SystemExit("league-archetype-winrate-floor must be <= league-min-promote-winrate")
    if cfg.runtime.league_spinoff_noise < 0 or cfg.runtime.league_spinoff_noise > 1.0:
        raise SystemExit("league-spinoff-noise must be in [0, 1.0]")
    if cfg.runtime.league_elo_random_factor < 0 or cfg.runtime.league_elo_random_factor > 1.0:
        raise SystemExit("league-elo-random-factor must be in [0, 1.0]")
    if cfg.runtime.smart_env_target_util_percent <= 0 or cfg.runtime.smart_env_target_util_percent > 99:
        raise SystemExit("smart-env-target-util must be in (0, 99]")
    if (
        cfg.runtime.smart_env_scale_down_trigger_percent <= cfg.runtime.smart_env_target_util_percent
        or cfg.runtime.smart_env_scale_down_trigger_percent > 100
    ):
        raise SystemExit("smart-env-scale-down-trigger must be > smart-env-target-util and <= 100")
    if cfg.runtime.smart_env_max_envs > 0 and cfg.runtime.smart_env_max_envs < cfg.runtime.smart_env_min_envs:
        raise SystemExit("smart-env-max must be >= smart-env-min (or 0 for auto)")
    if cfg.runtime.smart_env_gpu_sustain_sec < 1.0:
        raise SystemExit("smart-env-gpu-sustain-sec must be >= 1.0")
    if cfg.runtime.eval_switch_progress < 0.0 or cfg.runtime.eval_switch_progress > 1.0:
        raise SystemExit("eval-switch-progress must be in [0, 1]")
    early_set = cfg.runtime.eval_early_every > 0
    late_set = cfg.runtime.eval_late_every > 0
    if early_set != late_set:
        raise SystemExit("eval-early-every and eval-late-every must both be > 0 or both be 0")
    if float(args.keep_awake_interval_sec) < 30.0:
        raise SystemExit("keep-awake-interval-sec must be >= 30")
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
            reward_profile=cfg.runtime.bridge_reward_profile,
        )
    else:
        try:
            probe_env = GameBridgeEnv(
                cfg.model,
                opponent_difficulty=args.opponent_difficulty,
                self_difficulty=args.self_difficulty,
                episode_seconds=args.episode_seconds,
                decision_frames=args.decision_frames,
                reward_profile=cfg.runtime.bridge_reward_profile,
            )
            probe_env.close()
            env_factory = lambda: GameBridgeEnv(
                cfg.model,
                opponent_difficulty=args.opponent_difficulty,
                self_difficulty=args.self_difficulty,
                episode_seconds=args.episode_seconds,
                decision_frames=args.decision_frames,
                reward_profile=cfg.runtime.bridge_reward_profile,
            )
            print("[env] backend=game (auto)")
        except Exception as exc:
            print(f"[env] backend=mock (auto fallback): {exc}")
            env_factory = lambda: MockSelfPlayEnv(cfg.model)

    registry_output_path = Path(args.registry_output)

    def _live_checkpoint_export() -> None:
        if not args.export_registry:
            return
        _export_checkpoint_registry(checkpoints_root, registry_output_path)

    trainer = SelfPlayTrainer(
        cfg,
        env_factory=env_factory,
        eval_env_factory=env_factory,
        run_name=run_name,
        on_checkpoint_saved=_live_checkpoint_export,
    )
    keep_awake_guard = None
    try:
        from selfplay.keep_awake import KeepAwakeGuard

        keep_awake_guard = KeepAwakeGuard(
            enabled=bool(args.keep_awake),
            interval_sec=float(args.keep_awake_interval_sec),
        )
        keep_awake_guard.start()
    except Exception as exc:  # noqa: BLE001
        print(f"[keep-awake] failed to initialize: {exc}")

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
        if keep_awake_guard is not None:
            keep_awake_guard.stop()
        if args.export_registry:
            try:
                _export_checkpoint_registry(checkpoints_root, registry_output_path)
            except Exception as exc:  # noqa: BLE001
                print(f"[registry] export failed: {exc}")


if __name__ == "__main__":
    main()
