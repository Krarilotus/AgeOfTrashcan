from dataclasses import dataclass, field
from typing import Any, Dict

from .defaults import (
    DEFAULT_ACTION_DIM,
    DEFAULT_CHECKPOINT_EVERY,
    DEFAULT_CLIP_EPSILON,
    DEFAULT_D_MODEL,
    DEFAULT_DEAD_UNIT_CHECK_EVERY,
    DEFAULT_DEAD_UNIT_REVIVAL_ENABLED,
    DEFAULT_DEAD_UNIT_STREAK,
    DEFAULT_DEAD_UNIT_ZERO_EPSILON,
    DEFAULT_DEVICE,
    DEFAULT_DROPOUT,
    DEFAULT_ENTROPY_ANNEAL_STEPS,
    DEFAULT_ENTROPY_COEF,
    DEFAULT_ENTROPY_COEF_MIN,
    DEFAULT_ENTROPY_FLOOR_ALERT,
    DEFAULT_EVAL_EVERY,
    DEFAULT_EVAL_MATCHES,
    DEFAULT_EVAL_WORKERS,
    DEFAULT_FFN_DIM,
    DEFAULT_GAE_LAMBDA,
    DEFAULT_GAMMA,
    DEFAULT_GRAD_CLIP_NORM,
    DEFAULT_KL_HARD_STOP,
    DEFAULT_KL_TARGET,
    DEFAULT_LEAGUE_ARCHETYPE_WINRATE_FLOOR,
    DEFAULT_LEAGUE_ARBITERS,
    DEFAULT_LEAGUE_ELO_RANDOM_FACTOR,
    DEFAULT_LEAGUE_KEEP_DIVERSE,
    DEFAULT_LEAGUE_KEEP_TOP,
    DEFAULT_LEAGUE_MAX_AGENTS,
    DEFAULT_LEAGUE_MIN_GAMES_PER_AGENT,
    DEFAULT_LEAGUE_MIN_PROMOTE_WINRATE,
    DEFAULT_LEAGUE_SPINOFF_NOISE,
    DEFAULT_LEAGUE_SPINOFFS_PER_ANCHOR,
    DEFAULT_LEAGUE_USE_CHECKPOINT_OPPONENTS,
    DEFAULT_LEARNING_RATE,
    DEFAULT_LOG_INTERVAL,
    DEFAULT_MIXED_PRECISION,
    DEFAULT_N_HEADS,
    DEFAULT_N_LAYERS,
    DEFAULT_NUM_ENVS,
    DEFAULT_PPO_EPOCHS,
    DEFAULT_PPO_MINIBATCH_SIZE,
    DEFAULT_REWARD_CLIP_ABS,
    DEFAULT_REWARD_CURRICULUM_STEPS,
    DEFAULT_REWARD_DENSE_CUTOFF_PROGRESS,
    DEFAULT_REWARD_DENSE_DECAY_FACTOR,
    DEFAULT_REWARD_DENSE_DECAY_INTERVAL,
    DEFAULT_REWARD_DENSE_SCALE_END,
    DEFAULT_REWARD_DENSE_SCALE_START,
    DEFAULT_REWARD_KEEP_ENEMY_BASE_MILESTONE_AFTER_DENSE_CUTOFF,
    DEFAULT_REWARD_NORMALIZE,
    DEFAULT_REWARD_TERMINAL_SCALE_END,
    DEFAULT_REWARD_TERMINAL_SCALE_START,
    DEFAULT_REWARD_UNIT_CURRICULUM_END_PROGRESS,
    DEFAULT_REWARD_UNIT_CURRICULUM_END_SCALE,
    DEFAULT_REWARD_UNIT_CURRICULUM_START_SCALE,
    DEFAULT_ROLLOUT_HORIZON,
    DEFAULT_SAVE_DIR,
    DEFAULT_SEED,
    DEFAULT_SEQUENCE_LEN,
    DEFAULT_SLOT_DIM,
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
    DEFAULT_STATIC_DIM,
    DEFAULT_TOKEN_DIM,
    DEFAULT_TOTAL_STEPS,
    DEFAULT_TURRET_DIM,
    DEFAULT_UNIT_DIM,
    DEFAULT_VALUE_COEF,
    DEFAULT_WEIGHT_DECAY,
)


@dataclass(slots=True)
class PPOConfig:
    gamma: float = DEFAULT_GAMMA
    gae_lambda: float = DEFAULT_GAE_LAMBDA
    clip_epsilon: float = DEFAULT_CLIP_EPSILON
    value_coef: float = DEFAULT_VALUE_COEF
    entropy_coef: float = DEFAULT_ENTROPY_COEF
    entropy_coef_min: float = DEFAULT_ENTROPY_COEF_MIN
    entropy_anneal_steps: int = DEFAULT_ENTROPY_ANNEAL_STEPS
    learning_rate: float = DEFAULT_LEARNING_RATE
    weight_decay: float = DEFAULT_WEIGHT_DECAY
    grad_clip_norm: float = DEFAULT_GRAD_CLIP_NORM
    ppo_epochs: int = DEFAULT_PPO_EPOCHS
    minibatch_size: int = DEFAULT_PPO_MINIBATCH_SIZE
    kl_target: float = DEFAULT_KL_TARGET
    kl_hard_stop: float = DEFAULT_KL_HARD_STOP


@dataclass(slots=True)
class ModelConfig:
    static_dim: int = DEFAULT_STATIC_DIM
    sequence_len: int = DEFAULT_SEQUENCE_LEN
    token_dim: int = DEFAULT_TOKEN_DIM
    action_dim: int = DEFAULT_ACTION_DIM
    unit_dim: int = DEFAULT_UNIT_DIM
    turret_dim: int = DEFAULT_TURRET_DIM
    slot_dim: int = DEFAULT_SLOT_DIM
    d_model: int = DEFAULT_D_MODEL
    n_heads: int = DEFAULT_N_HEADS
    n_layers: int = DEFAULT_N_LAYERS
    ffn_dim: int = DEFAULT_FFN_DIM
    dropout: float = DEFAULT_DROPOUT


@dataclass(slots=True)
class RuntimeConfig:
    seed: int = DEFAULT_SEED
    num_envs: int = DEFAULT_NUM_ENVS
    rollout_horizon: int = DEFAULT_ROLLOUT_HORIZON
    total_steps: int = DEFAULT_TOTAL_STEPS
    checkpoint_every: int = DEFAULT_CHECKPOINT_EVERY
    eval_every: int = DEFAULT_EVAL_EVERY
    eval_matches: int = DEFAULT_EVAL_MATCHES
    eval_workers: int = DEFAULT_EVAL_WORKERS
    save_dir: str = DEFAULT_SAVE_DIR
    device: str = DEFAULT_DEVICE
    mixed_precision: bool = DEFAULT_MIXED_PRECISION
    reward_normalize: bool = DEFAULT_REWARD_NORMALIZE
    reward_clip_abs: float = DEFAULT_REWARD_CLIP_ABS
    reward_dense_scale_start: float = DEFAULT_REWARD_DENSE_SCALE_START
    reward_dense_scale_end: float = DEFAULT_REWARD_DENSE_SCALE_END
    reward_dense_decay_interval: float = DEFAULT_REWARD_DENSE_DECAY_INTERVAL
    reward_dense_decay_factor: float = DEFAULT_REWARD_DENSE_DECAY_FACTOR
    reward_terminal_scale_start: float = DEFAULT_REWARD_TERMINAL_SCALE_START
    reward_terminal_scale_end: float = DEFAULT_REWARD_TERMINAL_SCALE_END
    reward_curriculum_steps: int = DEFAULT_REWARD_CURRICULUM_STEPS
    reward_unit_curriculum_end_progress: float = DEFAULT_REWARD_UNIT_CURRICULUM_END_PROGRESS
    reward_unit_curriculum_start_scale: float = DEFAULT_REWARD_UNIT_CURRICULUM_START_SCALE
    reward_unit_curriculum_end_scale: float = DEFAULT_REWARD_UNIT_CURRICULUM_END_SCALE
    reward_dense_cutoff_progress: float = DEFAULT_REWARD_DENSE_CUTOFF_PROGRESS
    reward_keep_enemy_base_milestone_after_dense_cutoff: bool = (
        DEFAULT_REWARD_KEEP_ENEMY_BASE_MILESTONE_AFTER_DENSE_CUTOFF
    )
    bridge_reward_profile: Dict[str, Any] = field(default_factory=dict)
    league_keep_top_n: int = DEFAULT_LEAGUE_KEEP_TOP
    league_keep_diverse_n: int = DEFAULT_LEAGUE_KEEP_DIVERSE
    league_max_agents: int = DEFAULT_LEAGUE_MAX_AGENTS
    league_min_promote_winrate: float = DEFAULT_LEAGUE_MIN_PROMOTE_WINRATE
    league_archetype_winrate_floor: float = DEFAULT_LEAGUE_ARCHETYPE_WINRATE_FLOOR
    league_use_checkpoint_opponents: bool = DEFAULT_LEAGUE_USE_CHECKPOINT_OPPONENTS
    league_spinoffs_per_anchor: int = DEFAULT_LEAGUE_SPINOFFS_PER_ANCHOR
    league_spinoff_noise: float = DEFAULT_LEAGUE_SPINOFF_NOISE
    league_arbiters: str = DEFAULT_LEAGUE_ARBITERS
    league_min_games_per_agent: int = DEFAULT_LEAGUE_MIN_GAMES_PER_AGENT
    league_elo_random_factor: float = DEFAULT_LEAGUE_ELO_RANDOM_FACTOR
    dead_unit_revival_enabled: bool = DEFAULT_DEAD_UNIT_REVIVAL_ENABLED
    dead_unit_check_every: int = DEFAULT_DEAD_UNIT_CHECK_EVERY
    dead_unit_zero_epsilon: float = DEFAULT_DEAD_UNIT_ZERO_EPSILON
    dead_unit_streak: int = DEFAULT_DEAD_UNIT_STREAK
    log_interval: int = DEFAULT_LOG_INTERVAL
    entropy_floor_alert: float = DEFAULT_ENTROPY_FLOOR_ALERT
    smart_env_autoscale: bool = DEFAULT_SMART_ENV_AUTOSCALE
    smart_env_target_util_percent: float = DEFAULT_SMART_ENV_TARGET_UTIL_PERCENT
    smart_env_scale_down_trigger_percent: float = DEFAULT_SMART_ENV_SCALE_DOWN_TRIGGER_PERCENT
    smart_env_scale_step: int = DEFAULT_SMART_ENV_SCALE_STEP
    smart_env_adjust_cooldown_sec: float = DEFAULT_SMART_ENV_ADJUST_COOLDOWN_SEC
    smart_env_min_envs: int = DEFAULT_SMART_ENV_MIN_ENVS
    smart_env_max_envs: int = DEFAULT_SMART_ENV_MAX_ENVS
    smart_env_sample_hz: float = DEFAULT_SMART_ENV_SAMPLE_HZ
    smart_env_gpu_probe_hz: float = DEFAULT_SMART_ENV_GPU_PROBE_HZ
    smart_env_gpu_sustain_sec: float = DEFAULT_SMART_ENV_GPU_SUSTAIN_SEC


@dataclass(slots=True)
class OvernightConfig:
    ppo: PPOConfig = field(default_factory=PPOConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
