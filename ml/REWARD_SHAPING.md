# Reward Shaping Reference

This file documents all reward inputs used by self-play training and how to tune them from `ml/reward_profile.json`.

## Where Reward Is Computed

- Bridge reward components (raw game-side terms): `ml/bridge/game_bridge_server.ts`
- Trainer composition and curriculum scaling: `ml/selfplay/trainer.py`
- Default editable profile: `ml/reward_profile.json`

`train_selfplay.py` loads `ml/reward_profile.json` by default (or `REWARD_PROFILE=/path/to/file`), applies:
- `schedule` -> trainer reward scale schedule
- `bridge` -> game bridge reward component configuration

Important:

- Profile values are applied as the final reward configuration for a run.
- If you want full CLI-only control, run with `--reward-profile ""`.

## Raw Reward Components (Bridge)

At each decision step, the bridge emits these component values:

- `enemy_unit_kill_value`
- `own_unit_loss_value`
- `enemy_base_damage`
- `own_base_damage`
- `safe_age_up_bonus`
- `age_up_delay_penalty`
- `lane_control_delta`
- `illegal_action_penalty`
- `terminal_outcome`

Current behavior in this repo:

- `enemy_unit_kill_value`:
  - computed as `max(0, prev.playerUnitCount - next.playerUnitCount) * enemy_unit_kill_per_unit`
- `own_unit_loss_value`:
  - computed as `max(0, prev.enemyUnitCount - next.enemyUnitCount) * own_unit_loss_per_unit`
- `enemy_base_damage`: one-time milestone reward when enemy base crosses HP thresholds:
  - 75%, 50%, 25% using `base_milestone_rewards`
- `own_base_damage`: one-time mirrored penalty with same thresholds
- `safe_age_up_bonus`: awarded on every successful age-up
- `age_up_delay_penalty`: per-step penalty after grace window:
  - grace = `current_age * age_delay_grace_per_age_sec`
  - ramp to full over `age_delay_ramp_sec`
  - penalty magnitude scales with `required_gold / current_gold`
- `illegal_action_penalty`:
  - applied when action illegal (`illegal_action_penalty`)
  - plus extra quick sell penalty if selling within `quick_sell_window_sec` after buy (`quick_sell_penalty`)
- `lane_control_delta`:
  - computed as lane-pressure delta:
  - `((next.enemyUnitsNearPlayerBase - next.playerUnitsNearEnemyBase) - (prev.enemyUnitsNearPlayerBase - prev.playerUnitsNearEnemyBase)) * lane_control_delta_per_unit`
- `terminal_outcome`:
  - win = `terminal_win`
  - loss = `terminal_loss`
  - timeout = `timeout_loss`

All components are multiplied by `bridge.component_weights.<component_name>` before being returned.

## Defaults (from `ml/reward_profile.json`)

Bridge defaults:

- `component_weights.* = 1.0`
- `enemy_unit_kill_per_unit = 0.0`
- `own_unit_loss_per_unit = 0.0`
- `lane_control_delta_per_unit = 0.0`
- `base_milestone_rewards = [2.0, 4.0, 8.0]`
- `safe_age_up_bonus = 1.2`
- `illegal_action_penalty = -0.5`
- `quick_sell_penalty = -0.5`
- `quick_sell_window_sec = 3.0`
- `age_delay_grace_per_age_sec = 180.0`
- `age_delay_ramp_sec = 180.0`
- `age_delay_penalty_weight = 1.0`
- `terminal_win = 40.0`
- `terminal_loss = -40.0`
- `timeout_loss = -40.0`

Schedule defaults:

- `dense_start = 1.0`
- `dense_end = 1.0`
- `dense_decay_interval = 0.2`
- `dense_decay_factor = 0.9`
- `terminal_start = 1.0`
- `terminal_end = 5.0`
- `curriculum_steps = 0` (means total training steps)
- `reward_normalize = true`
- `reward_clip_abs = 10.0`

`lane_control_delta` note:

- It is now configurable through `lane_control_delta_per_unit`.
- Default is `0.0` (disabled) to avoid reward-hacking by positional farming.
- Keeping it explicit in the schema avoids breaking model/replay contracts when lane-control shaping is introduced later.

## Final Training Reward (Trainer)

Trainer composes reward as:

`final_reward = dense_reward * dense_scale + terminal_outcome * terminal_scale`

Where:

- `dense_reward` is the sum of:
  - `enemy_unit_kill_value + own_unit_loss_value + enemy_base_damage + own_base_damage + safe_age_up_bonus + age_up_delay_penalty + lane_control_delta + illegal_action_penalty`
- `dense_scale` and `terminal_scale` come from `schedule` and training progress.
- optional reward normalization/clipping is controlled by:
  - `schedule.reward_normalize`
  - `schedule.reward_clip_abs`

Why dense and terminal are scaled separately:

- Dense terms teach short-horizon behavior (build orders, timing, legality).
- Terminal term teaches the real objective (win/loss).
- Separate scales let you keep early learning signal while forcing late-stage policy to optimize match outcome.

Terminal-dominance rule of thumb:

- Keep `|terminal_outcome * terminal_scale|` at least several times larger than a typical dense-sum swing at convergence.
- Practical setup: strong terminal (`terminal_win/loss` high), dense scale decaying over training.

## Schedule Controls (`reward_profile.json`)

- `dense_start`, `dense_end`
- `dense_decay_interval`, `dense_decay_factor`
- `terminal_start`, `terminal_end`
- `curriculum_steps` (`0` means full run length)
- `reward_normalize`, `reward_clip_abs`

## Terminal-Dominant Preset (Recommended for anti-reward-hacking)

If you want intermediate shaping to fade strongly over time and win/loss to dominate:

- `schedule`:
  - `dense_start: 0.8`
  - `dense_end: 0.05`
  - `dense_decay_interval: 0.2`
  - `dense_decay_factor: 0.8`
  - `terminal_start: 1.0`
  - `terminal_end: 8.0`
- `bridge.component_weights`:
  - keep only meaningful dense terms > 0
  - optionally set low-value terms to `0`

## About `strongest_tower_engines=...` in Batch Telemetry

Example:

- `strongest_tower_engines=chicken_eggomat:19.5`

Meaning:

- This is **not a reward**.
- It is telemetry: average number of buys per sampled game for top-ranked (strongest) turret engines.
- The engine ranking uses `turret_strength__<id>` metadata from bridge (based on engine age/cost/protection), then reports average buys.
