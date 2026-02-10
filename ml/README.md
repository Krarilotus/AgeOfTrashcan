# Age of Trashcan ML Self-Play Trainer

This package contains an overnight PPO training stack for the `SMART_ML` policy path.

## What Is Implemented

- Transformer actor-critic (shared trunk, policy/value heads).
- PPO with GAE, KL guard, gradient clipping, entropy anneal.
- League checkpoint pool for self-play opponent sampling.
- Safety controls:
  - NaN/Inf guard
  - checkpoint rollback
  - entropy floor alert
  - periodic evaluation hook
- GTX 1080-oriented default config (12-14 hour run target).

## Environment Bridge

The trainer uses a pluggable environment interface (`selfplay.env.SelfPlayEnv`).

- `MockSelfPlayEnv` is included for deterministic smoke tests.
- For real training, connect `GameBridgeEnv` to the actual game simulator bridge.

## Quick Start

```bash
cd ml
python -m venv .venv
. .venv/Scripts/activate
pip install -e .
train-selfplay
```

## Overnight Config (Defaults)

- `d_model=256`, `n_layers=8`, `n_heads=8`, `ffn_dim=1024`
- `sequence_len=240`
- `rollout_horizon=256`
- `num_envs=8`
- `total_steps=10_000_000`
- `checkpoint_every=100_000`
- `eval_every=200_000`

Adjust in `selfplay/config.py`.
