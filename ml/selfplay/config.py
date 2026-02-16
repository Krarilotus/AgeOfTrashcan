from dataclasses import dataclass, field


@dataclass(slots=True)
class PPOConfig:
    gamma: float = 0.995
    gae_lambda: float = 0.95
    clip_epsilon: float = 0.2
    value_coef: float = 0.5
    entropy_coef: float = 0.01
    entropy_coef_min: float = 0.001
    entropy_anneal_steps: int = 3_000_000
    learning_rate: float = 3e-4
    weight_decay: float = 1e-2
    grad_clip_norm: float = 0.5
    ppo_epochs: int = 4
    minibatch_size: int = 64
    kl_target: float = 0.03
    kl_hard_stop: float = 0.08


@dataclass(slots=True)
class ModelConfig:
    static_dim: int = 112
    sequence_len: int = 240
    token_dim: int = 8
    action_dim: int = 8
    unit_dim: int = 128
    turret_dim: int = 32
    slot_dim: int = 4
    d_model: int = 256
    n_heads: int = 8
    n_layers: int = 8
    ffn_dim: int = 1024
    dropout: float = 0.1


@dataclass(slots=True)
class RuntimeConfig:
    seed: int = 1337
    num_envs: int = 8
    rollout_horizon: int = 256
    total_steps: int = 10_000_000
    checkpoint_every: int = 100_000
    eval_every: int = 200_000
    eval_matches: int = 200
    eval_workers: int = 0
    save_dir: str = "checkpoints"
    device: str = "cuda"
    mixed_precision: bool = True
    reward_normalize: bool = True
    reward_clip_abs: float = 10.0
    reward_dense_scale_start: float = 1.0
    reward_dense_scale_end: float = 1.0
    reward_dense_decay_interval: float = 0.2
    reward_dense_decay_factor: float = 0.9
    reward_terminal_scale_start: float = 1.0
    reward_terminal_scale_end: float = 5.0
    reward_curriculum_steps: int = 0
    league_keep_top_n: int = 5
    league_keep_diverse_n: int = 5
    league_max_agents: int = 10
    league_min_promote_winrate: float = 0.55
    league_archetype_winrate_floor: float = 0.52
    dead_unit_revival_enabled: bool = True
    dead_unit_check_every: int = 10
    dead_unit_zero_epsilon: float = 1e-10
    dead_unit_streak: int = 50
    log_interval: int = 2_048
    entropy_floor_alert: float = 0.003


@dataclass(slots=True)
class OvernightConfig:
    ppo: PPOConfig = field(default_factory=PPOConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
