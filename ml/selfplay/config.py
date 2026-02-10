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
    minibatch_size: int = 1024
    kl_target: float = 0.03
    kl_hard_stop: float = 0.08


@dataclass(slots=True)
class ModelConfig:
    static_dim: int = 56
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
    save_dir: str = "checkpoints"
    device: str = "cuda"
    mixed_precision: bool = True
    log_interval: int = 2_048
    entropy_floor_alert: float = 0.003


@dataclass(slots=True)
class OvernightConfig:
    ppo: PPOConfig = field(default_factory=PPOConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
