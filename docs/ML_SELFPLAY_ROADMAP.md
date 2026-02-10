# ML Self-Play Roadmap (SMART_ML Difficulty)

This roadmap defines how to add a new AI difficulty that keeps Smart AI economy perks but routes decisions through a fully modular AI endpoint so we can train and run ML policies (PPO + self-play).

Detailed implementation spec for the ML coding agent:
- `docs/ML_SELFPLAY_IMPLEMENTATION_SPEC.md`

## Goals

- Add a new difficulty tier for ML policy control: `SMART_ML`.
- Keep `SMART_ML` economy/discout profile aligned to Smart policy constraints.
- Decouple action selection from `BalancedAI`/`SmartPlannerAI` internals using a pluggable endpoint contract.
- Build deterministic, accelerated, headless simulation for training.
- Train self-play policy with PPO using sequence-aware transformer actor-critic.
- Support league/evolution style opponent pools (not only latest-vs-latest).

## Non-Goals (Phase 1)

- No direct replacement of all symbolic AIs.
- No browser-side training.
- No forced online inference service in production runtime.

## Current Baseline

- Runtime AI calls `IAIBehavior.decide(...)` through `AIController`.
- AI tick cadence is fixed in game runtime loop (~2 Hz).
- Game loop currently assumes render/game speed coupling for normal play.
- Debug panel already exposes state, reasoning, and staged decision traces.

## Target Architecture

## 1) AI Endpoint Layer

Introduce explicit endpoint boundary between game and policy:

- `IAIEndpoint`
  - `decide(input): PromiseOrValue<AIDecision>`
  - `reset(matchContext)`
  - `onTransition(transition)` for optional online adaptation/logging
- Endpoint implementations:
  - `RuleEndpoint` (wraps existing `IAIBehavior`)
  - `MLLocalEndpoint` (loads exported model for inference)
  - `MLRemoteEndpoint` (optional gRPC/WebSocket policy service)

`AIController` should use endpoint only; rule behaviors become one endpoint implementation.

## 2) Deterministic Headless Simulator

Add a non-rendering simulation runner:

- configurable tick rate multiplier (for example x8, x16, x32 wall-clock speed)
- fixed deterministic stepping and seeded RNG per episode
- disabled DOM/canvas dependencies
- optional batched episodes (N env workers)

## 3) RL Environment Wrapper

Expose game as Gym-like API:

- `reset(seed) -> obs`
- `step(action) -> obs, reward, done, info`
- action mask for legal actions
- trajectory logging hooks

## 4) Sequence Transformer Policy

Policy receives:

- current structured game state vector
- rolling action+state history window (last 60s)
  - at 2 Hz decision interval: 120 tokens per side timeline

Model shape (initial):

- dual-stream encoder:
  - stream A: current scalar snapshot projection
  - stream B: sequence transformer for history
- fusion block
- heads:
  - policy logits over discrete action schema
  - value head (critic)
  - optional action-parameter heads (`unitType`, `slotIndex`, `turretId`)

## 5) Self-Play + Evolutionary PPO

Training loop:

- collect rollouts from parallel self-play envs
- PPO update with clipped surrogate objective
- opponent pool management:
  - latest checkpoint
  - top historical checkpoints
  - diverse/random snapshot sampling
- Elo-style evaluation gating for promotion

## Difficulty Contract for `SMART_ML`

`SMART_ML` should mirror Smart economy behavior unless explicitly configured:

- Same base income multiplier as Smart.
- Same mana income multiplier as Smart.
- Same unit discount as requested parity target.
- Same turret upgrade + turret engine discounts as Smart profile.
- Same sell refund behavior as Smart profile.

If we later want stronger ML difficulty, add separate profile (`SMART_ML_PLUS`) instead of silently mutating parity.

## Implementation Phases

## Phase 0: Plumbing + Safety (short)

1. Add `SMART_ML` enum/type through:
   - difficulty types
   - start screen selection
   - config lookup tables
2. Add endpoint abstraction and wire `AIController` to endpoint.
3. Default `SMART_ML` endpoint = rule endpoint (SmartPlanner or Balanced fallback).
4. Add debug fields:
   - endpoint type
   - policy latency
   - model version/checkpoint id
   - action mask statistics

Exit criteria:

- Playable game with `SMART_ML` selected.
- No regression in existing difficulties.
- `npx tsc --noEmit` clean.

## Phase 1: Headless Fast Simulation

1. Create simulation mode in `GameEngine`:
   - `renderEnabled: boolean`
   - `speedMultiplier`
2. Add CLI harness to run episodes without UI.
3. Ensure deterministic replay from `(seed, action sequence)`.
4. Emit compact trajectory records (obs/action/reward/done/info).

Exit criteria:

- 100 deterministic replay checks pass.
- Headless throughput > real-time by target factor on local machine.

## Phase 2: Python Training Stack (`uv` + CUDA)

1. Create `ml/` workspace:
   - `pyproject.toml`
   - `uv.lock`
   - `train.py`, `evaluate.py`, `selfplay.py`
2. Framework:
   - `torch` with CUDA
   - `numpy`, `pydantic`, `tensorboard`, optional `ray` for scale-out
3. IPC bridge choices:
   - Option A: subprocess/stdin-json (simple bootstrap)
   - Option B: gRPC policy/env service (recommended medium term)
4. Add scripts:
   - `uv run train-selfplay`
   - `uv run eval-checkpoint`

Exit criteria:

- CUDA visible from training script.
- One full short training run completes and saves checkpoint.

## Phase 3: PPO + Transformer + League

1. Implement transformer actor-critic.
2. Add PPO trainer with:
   - GAE
   - entropy bonus
   - value clipping (optional)
3. Add opponent league manager.
4. Add evaluation ladder and checkpoint promotion policy.

Exit criteria:

- New checkpoints beat baseline Smart policy over agreed match count.
- Training stability metrics within defined thresholds.

## Phase 4: Inference Integration

1. Load exported checkpoint into `MLLocalEndpoint`.
2. Add action masking and legality fallback.
3. Add safe fallback to rule endpoint on inference error/timeout.
4. Expose runtime toggle: `SMART_ML (rule fallback)` vs `SMART_ML (model)`.

Exit criteria:

- Inference runs in gameplay without stalls.
- No illegal actions reaching engine executor.

## Action Space and Parameterization

Use structured multi-head action output:

- Head A: action type (`WAIT`, `RECRUIT_UNIT`, `AGE_UP`, `UPGRADE_MANA`, `UPGRADE_TURRET_SLOTS`, `BUY_TURRET_ENGINE`, `SELL_TURRET_ENGINE`, `REPAIR_BASE`)
- Head B: unit id (conditional)
- Head C: turret id (conditional)
- Head D: slot index (conditional)

Apply dynamic masks so impossible/invalid choices are suppressed before sampling.

## Reward Design (Initial)

Dense rewards:

- +damage to enemy base (scaled)
- -damage to own base
- +enemy unit kills
- -own unit losses
- +economic efficiency deltas
- +successful age timing windows

Terminal:

- big win/loss reward

Regularizers:

- penalty for long inactivity
- penalty for illegal-action attempts (should be near zero with masking)

## Data and Logging

Track per episode:

- seed, version hashes, config id
- cumulative rewards + decomposed components
- action distributions
- policy entropy
- value loss/policy loss/KL
- opponent checkpoint id and Elo deltas

## Testing Matrix

- Unit tests:
  - endpoint legality mapping
  - action masks
  - deterministic stepping
- Integration tests:
  - full episode in headless mode
  - rule endpoint and ML endpoint parity on legal action formatting
- Regression tests:
  - existing difficulties unchanged behavior envelope

## Risks and Mitigations

- Risk: non-determinism kills PPO signal.
  - Mitigation: deterministic mode and seed locking first.
- Risk: huge action space slows convergence.
  - Mitigation: hierarchical action heads + masks.
- Risk: policy collapse vs narrow opponent distribution.
  - Mitigation: league pool and Elo-gated checkpoint promotion.
- Risk: inference latency.
  - Mitigation: local model, quantization, timeout fallback.

## Concrete Task Breakdown (first coding sprint)

1. Add `SMART_ML` difficulty enum and config parity with `SMART`.
2. Introduce `IAIEndpoint` and `RuleEndpoint`.
3. Refactor `AIController` to call endpoint.
4. Route `SMART_ML` to modular endpoint with Smart-equivalent rule policy first.
5. Expose endpoint debug metadata in `App` debug view.
