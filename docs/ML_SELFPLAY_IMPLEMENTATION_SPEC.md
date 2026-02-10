# ML Self-Play Implementation Spec (No Code)

This document is the execution spec for a coding agent that will implement ML training for Age of Trashcan.  
Scope here is planning and architecture only.

## Implementation Status (Current Repo)

Implemented in this repository:

- Runtime `SMART_ML` behavior path:
  - `src/ai/behaviors/MLSelfPlayBehavior.ts`
  - `src/ai/ml/*` (action catalog, legality masks, history buffer, observation encoder, policy interface)
  - `GameEngine` now routes `SMART_ML` to `MLSelfPlayBehavior` while `SMART` remains symbolic planner.
- Data contracts:
  - `ml/schemas/observation_schema.json`
  - `ml/schemas/action_schema.json`
  - `ml/schemas/transition_schema.json`
- Overnight PPO trainer package:
  - `ml/selfplay/model.py` (GTrXL-style transformer actor-critic)
  - `ml/selfplay/ppo.py` (PPO + GAE + KL guard)
  - `ml/selfplay/league.py` (checkpoint pool/promotion utilities)
  - `ml/selfplay/trainer.py` + `ml/train_selfplay.py` (training loop and checkpoints)
  - `ml/selfplay/env.py` (deterministic mock env + real bridge contract)

Run entrypoint:

```bash
cd ml
train-selfplay --total-steps 10000000 --num-envs 8 --rollout-horizon 256 --device cuda
```

## Target Outcome

- Add a separate ML policy path (not replacing symbolic planner code).
- Train by self-play with PPO overnight on a GTX 1080 (8 GB VRAM).
- Use a sequence model that consumes:
  - current game state
  - last 2 minutes of both sides' action history with timestamps
- Predict next action from full action space with legality masking.

## Files The ML Agent Must Understand First

- `src/GameEngine.ts`
  - game tick loop, AI decision cadence, action execution bridge, queue rules, difficulty economics
- `src/ai/AIBehavior.ts`
  - `GameStateSnapshot` shape, action enum (`AIAction`), helper threat logic
- `src/ai/AIController.ts`
  - endpoint abstraction and controller lifecycle
- `src/ai/endpoints/IAIEndpoint.ts`
  - endpoint contract for policy integration
- `src/ai/behaviors/SmartPlannerAI.ts`
  - strong symbolic baseline for curriculum/opponent pool
- `src/config/gameBalance.ts`
  - difficulty multipliers, purchase discounts, economy functions
- `src/config/units.ts`
  - unit catalog, stats, skills, age gating
- `src/config/turrets.ts`
  - turret catalog, attack types, costs, slot upgrade costs
- `src/systems/EntitySystem.ts`
  - combat interactions and unit behavior
- `src/systems/ProjectileSystem.ts`
  - projectile resolution and hit timing
- `src/systems/TurretSystem.ts`
  - defensive damage models
- `docs/ML_SELFPLAY_ROADMAP.md`
  - prior roadmap baseline

## Industry-Standard Architecture

## 1) Environment Layer

Create a headless deterministic env wrapper:

- `reset(seed) -> observation`
- `step(action) -> observation, reward, done, info`
- fixed-step deterministic simulation (no rendering)
- explicit action mask each step

Use vectorized env workers (multiple processes) for rollout throughput.

## 2) Observation Encoding

Observation = `static_state + event_sequence`.

- Static state (dense vector):
  - all `GameStateSnapshot` numeric fields
  - normalized by stable scales (health, gold, mana, distances, DPS)
- Event sequence (last 2 min):
  - at 2 Hz decision interval: 240 timesteps
  - token contains:
    - actor (player/enemy)
    - action type
    - parameters (`unitId`, `slotIndex`, `turretId`, etc.)
    - timestamp delta
    - optional reward delta / damage delta

## 3) Policy Network (State of the Art, GPU-Fit for GTX 1080)

Use transformer actor-critic with shared trunk:

- Sequence encoder: GTrXL-style transformer
  - layers: 8
  - model dim: 256
  - heads: 8
  - FFN dim: 1024
  - sequence length: 240
- Static encoder: MLP
  - 3 layers: 512 -> 256 -> 256
- Fusion:
  - cross-attention or gated concat to 256-d latent
- Heads:
  - policy logits (action type)
  - parameter heads (unit, turret, slot, etc.)
  - value head

Why this size:

- Large enough to model tactical temporal structure
- Fits 8 GB VRAM with mixed precision and micro-batching

## 4) Action Space Modeling

Use hierarchical factorized decoding:

1. action type head
2. conditional parameter heads
3. legality masking before sampling

Mask illegal actions using game rules:

- affordability checks (gold/mana)
- age gating
- queue limits
- slot occupancy and unlock state

## 5) PPO Training Setup

- Algorithm: PPO with GAE
- Self-play: league pool (current, top-N, random past checkpoints)
- Parallel envs: 8-16 (CPU-dependent)
- Rollout horizon per env: 256 steps
- PPO epochs: 3-5
- mini-batch size: 1024 effective (accumulated)
- gamma: 0.995
- lambda: 0.95
- clip epsilon: 0.2
- entropy coef: 0.01 (anneal)
- value coef: 0.5
- grad clip: 0.5
- optimizer: AdamW
- lr: 3e-4 with cosine decay
- mixed precision: enabled (FP16 autocast)

## 6) Reward Model

Dense + terminal:

- + enemy unit kill value
- - own unit loss value
- + enemy base damage
- - own base damage
- + age-up when timed safely
- + lane control improvements
- - illegal action attempts
- terminal win/loss bonus

Important:

- reward scale normalization per batch
- keep terminal reward dominant but not overwhelming

## Overnight GTX 1080 Training Recipe (12-14 Hours)

## Runtime Budget

- GPU: GTX 1080 8 GB
- CPU workers: 8 preferred
- Expected run: 12h continuous

## Config

- model: 8-layer transformer (`d_model=256`)
- sequence length: 240
- env workers: 8
- rollout horizon: 256
- total steps target: 8-12 million
- checkpoint every 100k steps
- eval every 200k steps (200 matches vs symbolic baselines)

## Stability Controls

- automatic NaN guard + rollback to last good checkpoint
- KL divergence early stop in PPO epoch
- gradient norm logging
- action entropy floor alarms (collapse detection)

## Promotion Policy

- promote checkpoint to league only if:
  - >55% winrate vs current production `SmartPlannerAI`
  - non-regression vs previous top-3 league members

## Data Contracts

Define schema files before coding:

- `ml/schemas/observation_schema.json`
- `ml/schemas/action_schema.json`
- `ml/schemas/transition_schema.json`

Each transition record stores:

- seed, tick, gameTime
- obs vector
- seq tokens
- action + params
- mask
- reward components
- done + terminal cause

## Implementation Phases For The ML Coding Agent

1. Deterministic headless env wrapper
2. Action mask + decoder schema
3. Dataset and replay logging utilities
4. Transformer actor-critic implementation
5. PPO loop with self-play league
6. Evaluation harness and Elo tracking
7. Endpoint integration (`MLLocalEndpoint`) with fallback to rule endpoint

Each phase must ship with:

- unit tests
- integration tests
- performance metrics
- rollback-safe checkpointing

## Acceptance Criteria

- deterministic replay reproducibility on fixed seed/action trace
- overnight training completes without crash
- policy improves over random + balanced symbolic baseline
- policy reaches competitive rate against `SmartPlannerAI`
- runtime inference under target latency budget per decision tick

## Integration Guardrails

- Keep ML path separate from symbolic AI logic.
- Do not mutate game rules for ML convenience.
- Keep action legality centralized and shared with runtime.
- Preserve debug traceability:
  - chosen action
  - logits summary
  - top masked alternatives
