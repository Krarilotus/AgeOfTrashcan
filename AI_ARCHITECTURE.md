# AI Architecture (Current State)

This document replaces the previous architecture write-up and reflects the current implementation in this repository.

## Status

- Scope: Rule-based AI currently in production.
- Primary behavior: `BalancedAI`.
- Deprecated assumptions from old docs:
  - Multiple behavior classes (`AggressiveAI`, `DefensiveAI`) are not active in this codebase.
  - Legacy action `BUILD_TURRET` is replaced by slot/engine actions.

## Source Map

- Controller: `src/ai/AIController.ts`
- Behavior interface/utilities: `src/ai/AIBehavior.ts`
- Active behavior: `src/ai/behaviors/BalancedAI.ts`
- AI execution bridge: `src/GameEngine.ts` (`updateEnemyAI`, `executeAIDecision`)
- Turret catalog and scoring helpers: `src/config/turrets.ts`
- Debug UI: `src/App.tsx`

## Runtime Flow

1. Game loop ticks in `GameEngine.update(...)`.
2. AI is evaluated on an interval (`aiAccumulatorMs` gate) in `updateEnemyAI()`.
3. `GameEngine.extractGameStateForAI()` builds `GameStateSnapshot`.
4. `AIController.makeDecision(...)`:
   - updates strategic state (`ThreatLevel`, `StrategicState`)
   - delegates to `BalancedAI.decide(...)`
   - records recent actions
5. `GameEngine.executeAIDecision(...)` executes one action:
   - `RECRUIT_UNIT`
   - `AGE_UP`
   - `UPGRADE_MANA`
   - `UPGRADE_TURRET_SLOTS`
   - `BUY_TURRET_ENGINE`
   - `SELL_TURRET_ENGINE`
   - `REPAIR_BASE`
   - `WAIT`
6. If AI decides `WAIT`, engine now runs opportunistic fallback turret management under pressure.

## GameStateSnapshot (What AI Sees)

`GameStateSnapshot` includes:
- Economy: gold/mana, income, age, mana level for both sides
- Base state: health, turret slots unlocked, installed turret summaries
- Turret metrics: DPS, max range, avg range, protection multipliers
- Unit summaries: count + per-unit lightweight combat snapshot
- Queue sizes
- Tactical indicators: units near enemy/player base
- Difficulty level

Definition: `src/ai/AIBehavior.ts`.

## Decision Pipeline (BalancedAI)

BalancedAI now emits a stage-by-stage debug trace as `decisionStages`.

### Stage 1: Strategic Assessment
- Inputs: threat, strategic state, strategy bias
- Output: informational context for this tick

### Stage 2: Economy Gates
- Computes spendable gold from:
  - total gold
  - warchest
  - minimum reserve
- Emergency unlock condition can allow full spending (base crisis)

### Stage 3: Turret Planning
- First-class slot/engine logic via `considerTurretSlotsAndEngines(...)`
- Handles:
  - fill empty unlocked slots
  - unlock next slot if gates pass
  - sell-and-replace weak engines with stronger alternatives
- Uses risk-aware scoring:
  - swarm pressure -> prioritize multi-target engines
  - heavy pressure -> prioritize strong single-target pressure
  - incoming pressure -> bonus for range/protection

### Stage 4: Emergency Defense Override
- Desperate branch for panic conditions
- Can force immediate recruitment

### Stage 5: Empty Field Guard
- If AI has no field presence and enemies encroach, recruits best HP/gold frontline

### Stage 6: Urgent Candidates
- Collects high-priority candidates in one set:
  - age up
  - OP unit conditions (where applicable)
  - threshold triggers
  - repair
  - mana upgrade
- Selects one via weighted logic (age-up preference where applicable)

### Stage 7: Recruitment
- If no urgent candidate wins, runs normal recruitment logic

### Stage 8: Wait Fallback
- If no other action is selected, returns `WAIT`

## Decision Tree (Operational)

```text
Tick
|- Build threat + strategic context
|- Apply economy gates (warchest/reserve)
|- Turret planning action available?
|  |- Yes -> execute turret action (buy/sell/slot unlock)
|  `- No
|- Emergency panic active?
|  |- Yes -> desperate recruit
|  `- No
|- Empty field + enemy encroaching?
|  |- Yes -> emergency frontline recruit
|  `- No
|- Build urgent candidate set (age/op/mana/repair/etc)
|  |- Candidate selected? -> execute
|  `- No
|- Recruitment candidate selected?
|  |- Yes -> execute recruit
|  `- No
`- WAIT
```

## Turret Planning Tree (Detailed)

```text
considerTurretSlotsAndEngines
|- Gather risk profile + target slot count
|- Pending replacement exists?
|  |- Empty slot ready and affordable -> BUY replacement
|  `- else clear pending
|- Empty unlocked slot exists?
|  |- Pick best affordable engine by risk/scoring
|  `- BUY_TURRET_ENGINE
|- Replacement conditions met?
|  |- Find weakest installed engine
|  |- Compute post-sell budget (difficulty refund)
|  |- Better engine exists above improvement threshold?
|  |  |- Yes -> SELL_TURRET_ENGINE and set pending replacement
|  |  `- No
|  `- No
|- Can unlock next slot (age/mana/time gates + affordability)?
|  |- Yes -> UPGRADE_TURRET_SLOTS
|  `- No
`- null
```

## Engine-Side Fallback Turret Management

`GameEngine.autoManageEnemyTurrets()` is now a stronger safety net:
- Triggered by explicit turret actions and also opportunistically from `WAIT` under pressure.
- Uses pressure-aware engine scoring (`estimateEngineDps`, range, protection, risk modifiers).
- Supports sell-and-replace with post-sell affordability and improvement threshold.
- Honors slot progression gates (including late-game 4th-slot constraints).

## Debug Panel Data Model

The debug panel in `src/App.tsx` visualizes:
- Threat breakdown
- Economy and reserve state
- Next action and reason
- Foreseeable plan list
- Decision pipeline (`behaviorParams.decisionStages`)
- Recent actions with reasons

Key behavior debug fields (from `BalancedAI.getParameters()`):
- `strategy`, `warchest`, `plan`, `rejected`
- `futurePlan`
- `nextAction`, `nextReason`
- `decisionStages`
- `decisionOutcome`
- Additional metric fields used by UI (`income`, `taxRate`, `gold`, `reserved`, `pushEst`, `turret`, `manaLvl`)

## Why AI Picked a Decision (How to Read)

Use this quick triage flow in debug UI:
1. Check `Decision Pipeline` for the first `selected` stage.
2. Read that stage `detail` and optional `action`.
3. Confirm `Outcome` and `Next` fields match.
4. Cross-check `Foreseeable Plan` and `Recent Actions` for continuity.

If behavior is unexpected:
- Validate economy gates (`gold`, `reserved`, `warchest`).
- Validate threat/risk signals (swarm/heavy/incoming implications).
- Validate queue pressure (full queue blocks some actions).
- Validate affordability with gold + mana + difficulty discount.

## Current Action Semantics

- `BUY_TURRET_ENGINE`: mounts to a specific empty unlocked slot (queued build).
- `SELL_TURRET_ENGINE`: frees slot and grants refund by difficulty.
- `UPGRADE_TURRET_SLOTS`: unlocks next slot using slot progression costs/gates.
- `WAIT`: no direct spend, but can still invoke fallback turret manager under pressure.

## Maintenance Notes

When changing AI logic:
- Keep `GameStateSnapshot` and UI debug fields in sync.
- Update this document when adding/removing stages or actions.
- Prefer adding explicit stage traces over hidden branching for debuggability.

## Quick Validation Checklist

- `npx tsc --noEmit` passes.
- Debug panel shows:
  - `Decision Pipeline` entries each tick
  - a clear `selected` stage
  - `Outcome` matching executed action
- Under high outnumber pressure, AI:
  - fills empty turret slots with stronger engines
  - upgrades slot count when allowed
  - sells weak engines for better replacements when beneficial
