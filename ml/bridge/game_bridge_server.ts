import readline from 'node:readline';

import { GameEngine, type GameConfig } from '../../src/GameEngine';
import type { AIDecision, GameStateSnapshot } from '../../src/ai/AIBehavior';
import {
  ML_SLOT_INDICES,
  ML_TURRET_IDS,
  ML_UNIT_IDS,
  getActionTypeIndex,
  getTurretIndex,
  getUnitIndex,
} from '../../src/ai/ml/actionCatalog';
import { MLHistoryBuffer } from '../../src/ai/ml/historyBuffer';
import { buildLegalActionMask } from '../../src/ai/ml/legalActionMask';
import { encodeObservation } from '../../src/ai/ml/observationEncoder';
import { BASE_CONFIG, INCOME_CONFIG, type GameDifficulty } from '../../src/config/gameBalance';
import { getTurretEngineDef } from '../../src/config/turrets';

type Owner = 'PLAYER' | 'ENEMY';
type RewardComponentKey =
  | 'enemy_unit_kill_value'
  | 'own_unit_loss_value'
  | 'enemy_base_damage'
  | 'own_base_damage'
  | 'safe_age_up_bonus'
  | 'age_up_delay_penalty'
  | 'action_discovery_bonus'
  | 'lane_control_delta'
  | 'illegal_action_penalty'
  | 'terminal_outcome';

interface RewardProfileResolved {
  componentWeights: Record<RewardComponentKey, number>;
  enemyUnitKillPerUnit: number;
  ownUnitLossPerUnit: number;
  laneControlDeltaPerUnit: number;
  baseMilestoneThresholds: [number, number, number];
  baseMilestoneRewards: [number, number, number];
  safeAgeUpBonus: number;
  illegalActionPenalty: number;
  quickSellPenalty: number;
  quickSellWindowSec: number;
  ageDelayGracePerAgeSec: number;
  ageDelayRampSec: number;
  ageDelayPenaltyWeight: number;
  actionDiscoveryActionBonus: number;
  actionDiscoveryUnitBonus: number;
  actionDiscoveryTurretBonus: number;
  actionDiscoveryEpisodeCap: number;
  terminalWin: number;
  terminalLoss: number;
  timeoutLoss: number;
}

type BridgeCommand =
  | {
      cmd: 'init';
      model: {
        static_dim?: number;
        sequence_len?: number;
        token_dim?: number;
        action_dim?: number;
        unit_dim?: number;
        turret_dim?: number;
        slot_dim?: number;
      };
      options?: {
        self_difficulty?: GameDifficulty;
        opponent_difficulty?: GameDifficulty;
        episode_seconds?: number;
        decision_frames?: number;
        reward_profile?: Record<string, unknown> | null;
      };
    }
  | { cmd: 'reset'; seed: number }
  | {
      cmd: 'step';
      action: {
        action_type: string;
        unit_id?: string;
        turret_id?: string;
        slot_index?: number;
        confidence?: number;
      };
    }
  | {
      cmd: 'set_opponent_profile';
      profile?: {
        elo?: number;
        winrate_vs_smart?: number;
        steps?: number;
        checkpoint_id?: string;
        difficulty?: GameDifficulty | 'MOCK_RANDOM';
        archetype?: string;
        aggression?: number;
        teching?: number;
        defense?: number;
      };
    }
  | { cmd: 'get_env_state' }
  | { cmd: 'set_env_state'; state?: Record<string, unknown> }
  | { cmd: 'close' }
  | { cmd: 'ping' };

function safeToString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toStderr(prefix: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const text = args.map((arg) => safeToString(arg)).join(' ');
    process.stderr.write(`${prefix} ${text}\n`);
  };
}

const BRIDGE_VERBOSE = process.env.BRIDGE_VERBOSE === '1';
console.log = BRIDGE_VERBOSE ? toStderr('[bridge]') : () => undefined;
console.warn = toStderr('[bridge:warn]');
console.error = toStderr('[bridge:error]');

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function padArray(values: number[], target: number, fill = 0): number[] {
  if (target <= 0) return [];
  if (values.length === target) return values;
  if (values.length > target) return values.slice(0, target);
  return [...values, ...new Array<number>(target - values.length).fill(fill)];
}

function parseIndexedId(raw: string | undefined, prefix: string): number {
  if (!raw) return -1;
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(raw);
  if (!match) return -1;
  return Number.parseInt(match[1] ?? '-1', 10);
}

function normalizeDifficulty(raw: unknown, fallback: GameDifficulty): GameDifficulty {
  if (
    raw === 'EASY' ||
    raw === 'MEDIUM' ||
    raw === 'HARD' ||
    raw === 'SMART' ||
    raw === 'SMART_ML' ||
    raw === 'CHEATER'
  ) {
    return raw;
  }
  return fallback;
}

const ACTION_TYPES_IN_ORDER: AIDecision['action'][] = [
  'WAIT',
  'RECRUIT_UNIT',
  'AGE_UP',
  'UPGRADE_MANA',
  'UPGRADE_TURRET_SLOTS',
  'BUY_TURRET_ENGINE',
  'SELL_TURRET_ENGINE',
  'REPAIR_BASE',
];

const FORCED_TIMEOUT_LOSS_SEC = 60 * 60;
const DEFAULT_REWARD_PROFILE: RewardProfileResolved = {
  componentWeights: {
    enemy_unit_kill_value: 1.0,
    own_unit_loss_value: 1.0,
    enemy_base_damage: 1.0,
    own_base_damage: 1.0,
    safe_age_up_bonus: 1.0,
    age_up_delay_penalty: 1.0,
    action_discovery_bonus: 1.0,
    lane_control_delta: 1.0,
    illegal_action_penalty: 1.0,
    terminal_outcome: 1.0,
  },
  enemyUnitKillPerUnit: 0.0,
  ownUnitLossPerUnit: 0.0,
  laneControlDeltaPerUnit: 0.0,
  baseMilestoneThresholds: [0.75, 0.5, 0.25],
  baseMilestoneRewards: [2, 4, 8],
  safeAgeUpBonus: 1.2,
  illegalActionPenalty: -0.5,
  quickSellPenalty: -0.5,
  quickSellWindowSec: 3.0,
  ageDelayGracePerAgeSec: 180,
  ageDelayRampSec: 180,
  ageDelayPenaltyWeight: 1.0,
  actionDiscoveryActionBonus: 0.03,
  actionDiscoveryUnitBonus: 0.01,
  actionDiscoveryTurretBonus: 0.01,
  actionDiscoveryEpisodeCap: 0.12,
  terminalWin: 40.0,
  terminalLoss: -40.0,
  timeoutLoss: -40.0,
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mergeRewardProfile(raw: unknown): RewardProfileResolved {
  const merged: RewardProfileResolved = {
    componentWeights: { ...DEFAULT_REWARD_PROFILE.componentWeights },
    enemyUnitKillPerUnit: DEFAULT_REWARD_PROFILE.enemyUnitKillPerUnit,
    ownUnitLossPerUnit: DEFAULT_REWARD_PROFILE.ownUnitLossPerUnit,
    laneControlDeltaPerUnit: DEFAULT_REWARD_PROFILE.laneControlDeltaPerUnit,
    baseMilestoneThresholds: [...DEFAULT_REWARD_PROFILE.baseMilestoneThresholds],
    baseMilestoneRewards: [...DEFAULT_REWARD_PROFILE.baseMilestoneRewards],
    safeAgeUpBonus: DEFAULT_REWARD_PROFILE.safeAgeUpBonus,
    illegalActionPenalty: DEFAULT_REWARD_PROFILE.illegalActionPenalty,
    quickSellPenalty: DEFAULT_REWARD_PROFILE.quickSellPenalty,
    quickSellWindowSec: DEFAULT_REWARD_PROFILE.quickSellWindowSec,
    ageDelayGracePerAgeSec: DEFAULT_REWARD_PROFILE.ageDelayGracePerAgeSec,
    ageDelayRampSec: DEFAULT_REWARD_PROFILE.ageDelayRampSec,
    ageDelayPenaltyWeight: DEFAULT_REWARD_PROFILE.ageDelayPenaltyWeight,
    actionDiscoveryActionBonus: DEFAULT_REWARD_PROFILE.actionDiscoveryActionBonus,
    actionDiscoveryUnitBonus: DEFAULT_REWARD_PROFILE.actionDiscoveryUnitBonus,
    actionDiscoveryTurretBonus: DEFAULT_REWARD_PROFILE.actionDiscoveryTurretBonus,
    actionDiscoveryEpisodeCap: DEFAULT_REWARD_PROFILE.actionDiscoveryEpisodeCap,
    terminalWin: DEFAULT_REWARD_PROFILE.terminalWin,
    terminalLoss: DEFAULT_REWARD_PROFILE.terminalLoss,
    timeoutLoss: DEFAULT_REWARD_PROFILE.timeoutLoss,
  };
  if (!raw || typeof raw !== 'object') return merged;
  const src = raw as Record<string, unknown>;
  const weightsRaw = src.component_weights;
  if (weightsRaw && typeof weightsRaw === 'object') {
    const weightsObj = weightsRaw as Record<string, unknown>;
    (Object.keys(merged.componentWeights) as RewardComponentKey[]).forEach((key) => {
      merged.componentWeights[key] = finiteOr(weightsObj[key], merged.componentWeights[key]);
    });
  }
  const milestoneThresholds = src.base_milestone_thresholds;
  if (Array.isArray(milestoneThresholds) && milestoneThresholds.length >= 3) {
    const raw = [
      finiteOr(milestoneThresholds[0], merged.baseMilestoneThresholds[0]),
      finiteOr(milestoneThresholds[1], merged.baseMilestoneThresholds[1]),
      finiteOr(milestoneThresholds[2], merged.baseMilestoneThresholds[2]),
    ].map((value) => clamp(value, 0.0, 1.0)) as [number, number, number];
    merged.baseMilestoneThresholds = raw;
  }
  const milestones = src.base_milestone_rewards;
  if (Array.isArray(milestones) && milestones.length >= 3) {
    merged.baseMilestoneRewards = [
      finiteOr(milestones[0], merged.baseMilestoneRewards[0]),
      finiteOr(milestones[1], merged.baseMilestoneRewards[1]),
      finiteOr(milestones[2], merged.baseMilestoneRewards[2]),
    ];
  }
  merged.safeAgeUpBonus = finiteOr(src.safe_age_up_bonus, merged.safeAgeUpBonus);
  merged.enemyUnitKillPerUnit = finiteOr(src.enemy_unit_kill_per_unit, merged.enemyUnitKillPerUnit);
  merged.ownUnitLossPerUnit = finiteOr(src.own_unit_loss_per_unit, merged.ownUnitLossPerUnit);
  merged.laneControlDeltaPerUnit = finiteOr(src.lane_control_delta_per_unit, merged.laneControlDeltaPerUnit);
  merged.illegalActionPenalty = finiteOr(src.illegal_action_penalty, merged.illegalActionPenalty);
  merged.quickSellPenalty = finiteOr(src.quick_sell_penalty, merged.quickSellPenalty);
  merged.quickSellWindowSec = Math.max(0, finiteOr(src.quick_sell_window_sec, merged.quickSellWindowSec));
  merged.ageDelayGracePerAgeSec = Math.max(
    1,
    finiteOr(src.age_delay_grace_per_age_sec, merged.ageDelayGracePerAgeSec)
  );
  merged.ageDelayRampSec = Math.max(1, finiteOr(src.age_delay_ramp_sec, merged.ageDelayRampSec));
  merged.ageDelayPenaltyWeight = finiteOr(src.age_delay_penalty_weight, merged.ageDelayPenaltyWeight);
  merged.actionDiscoveryActionBonus = Math.max(
    0,
    finiteOr(src.action_discovery_action_bonus, merged.actionDiscoveryActionBonus)
  );
  merged.actionDiscoveryUnitBonus = Math.max(
    0,
    finiteOr(src.action_discovery_unit_bonus, merged.actionDiscoveryUnitBonus)
  );
  merged.actionDiscoveryTurretBonus = Math.max(
    0,
    finiteOr(src.action_discovery_turret_bonus, merged.actionDiscoveryTurretBonus)
  );
  merged.actionDiscoveryEpisodeCap = Math.max(
    0,
    finiteOr(src.action_discovery_episode_cap, merged.actionDiscoveryEpisodeCap)
  );
  merged.terminalWin = finiteOr(src.terminal_win, merged.terminalWin);
  merged.terminalLoss = finiteOr(src.terminal_loss, merged.terminalLoss);
  merged.timeoutLoss = finiteOr(src.timeout_loss, merged.timeoutLoss);
  return merged;
}

class BridgeRuntime {
  private engine: GameEngine | null = null;
  private history = new MLHistoryBuffer({ horizonSeconds: 120 });
  private staticDim = 128;
  private sequenceLen = 240;
  private tokenDim = 8;
  private actionDim = 8;
  private unitDim = 128;
  private turretDim = 32;
  private slotDim = 4;
  private episodeSeconds = FORCED_TIMEOUT_LOSS_SEC;
  private decisionFrames = 30;
  private selfDifficulty: GameDifficulty = 'SMART_ML';
  private opponentDifficulty: GameDifficulty = 'SMART';
  private opponentCheckpointId: string | null = null;
  private opponentUseMockRandom = false;
  private mockRandomActionGap = 4;
  private mockRandomWaitStepsRemaining = 0;
  private opponentArchetype = 'balanced';
  private opponentAggression = 0.5;
  private opponentTeching = 0.5;
  private opponentDefense = 0.5;
  private ownBaseMilestonesAwarded = new Set<number>();
  private opponentBaseMilestonesAwarded = new Set<number>();
  private lastBuyTimeBySlot = new Map<number, number>();
  private enemyLastAgeUpTimeSec = 0;
  private episodeGoldSpent = 0;
  private episodeManaSpent = 0;
  private peakEnemyAge = 1;
  private peakEnemyTurretCount = 0;
  private rewardProfile: RewardProfileResolved = mergeRewardProfile(null);
  private discoveredActionTypes = new Set<string>();
  private discoveredUnitTypes = new Set<string>();
  private discoveredTurretTypes = new Set<string>();
  private discoveryBudgetRemaining = 0;

  init(command: Extract<BridgeCommand, { cmd: 'init' }>): Record<string, unknown> {
    this.staticDim = Math.max(1, command.model.static_dim ?? this.staticDim);
    this.sequenceLen = Math.max(1, command.model.sequence_len ?? this.sequenceLen);
    this.tokenDim = Math.max(1, command.model.token_dim ?? this.tokenDim);
    this.actionDim = Math.max(1, command.model.action_dim ?? this.actionDim);
    this.unitDim = Math.max(1, command.model.unit_dim ?? this.unitDim);
    this.turretDim = Math.max(1, command.model.turret_dim ?? this.turretDim);
    this.slotDim = Math.max(1, command.model.slot_dim ?? this.slotDim);
    this.episodeSeconds = Math.max(60, command.options?.episode_seconds ?? this.episodeSeconds);
    this.decisionFrames = Math.max(1, command.options?.decision_frames ?? this.decisionFrames);
    this.selfDifficulty = normalizeDifficulty(command.options?.self_difficulty, this.selfDifficulty);
    this.opponentDifficulty = normalizeDifficulty(
      command.options?.opponent_difficulty,
      this.opponentDifficulty
    );
    this.rewardProfile = mergeRewardProfile(command.options?.reward_profile);

    return {
      ok: true,
      runtime: {
        static_dim: this.staticDim,
        sequence_len: this.sequenceLen,
        token_dim: this.tokenDim,
        action_dim: this.actionDim,
        unit_dim: this.unitDim,
        turret_dim: this.turretDim,
        slot_dim: this.slotDim,
        self_difficulty: this.selfDifficulty,
        opponent_difficulty: this.opponentDifficulty,
        reward_profile: this.rewardProfile,
      },
    };
  }

  setOpponentProfile(command: Extract<BridgeCommand, { cmd: 'set_opponent_profile' }>): Record<string, unknown> {
    const requestedDifficulty =
      typeof command.profile?.difficulty === 'string'
        ? command.profile.difficulty.trim().toUpperCase()
        : '';
    this.opponentUseMockRandom = requestedDifficulty === 'MOCK_RANDOM';
    this.opponentCheckpointId =
      typeof command.profile?.checkpoint_id === 'string' && command.profile.checkpoint_id.trim().length > 0
        ? command.profile.checkpoint_id.trim()
        : null;
    this.opponentArchetype =
      typeof command.profile?.archetype === 'string' && command.profile.archetype.trim().length > 0
        ? command.profile.archetype.trim()
        : 'balanced';
    this.opponentAggression = clamp(Number(command.profile?.aggression ?? 0.5), 0, 2);
    this.opponentTeching = clamp(Number(command.profile?.teching ?? 0.5), 0, 2);
    this.opponentDefense = clamp(Number(command.profile?.defense ?? 0.5), 0, 2);
    if (this.opponentUseMockRandom) {
      this.opponentCheckpointId = null;
      this.opponentDifficulty = 'MEDIUM';
      this.mockRandomWaitStepsRemaining = 0;
      return {
        ok: true,
        opponent_difficulty: this.opponentDifficulty,
        checkpoint_id: null,
        archetype: this.opponentArchetype,
        opponent_mode: 'mock_random',
      };
    }

    const elo = command.profile?.elo ?? 1000;
    const forcedDifficulty = normalizeDifficulty(command.profile?.difficulty, this.opponentDifficulty);
    // If we have a checkpoint identity, force SMART_ML proxy to preserve strategy diversity.
    if (this.opponentCheckpointId) {
      this.opponentDifficulty = 'SMART_ML';
    } else if (command.profile?.difficulty) {
      this.opponentDifficulty = forcedDifficulty;
    } else if (elo >= 1200) this.opponentDifficulty = 'CHEATER';
    else if (elo >= 1100) this.opponentDifficulty = 'SMART_ML';
    else if (elo >= 1025) this.opponentDifficulty = 'SMART';
    else if (elo >= 950) this.opponentDifficulty = 'HARD';
    else this.opponentDifficulty = 'MEDIUM';
    return {
      ok: true,
      opponent_difficulty: this.opponentDifficulty,
      checkpoint_id: this.opponentCheckpointId,
      archetype: this.opponentArchetype,
      opponent_mode: 'ai',
    };
  }

  reset(command: Extract<BridgeCommand, { cmd: 'reset' }>): Record<string, unknown> {
    this.ownBaseMilestonesAwarded.clear();
    this.opponentBaseMilestonesAwarded.clear();
    this.lastBuyTimeBySlot.clear();
    this.enemyLastAgeUpTimeSec = 0;
    this.episodeGoldSpent = 0;
    this.episodeManaSpent = 0;
    this.peakEnemyAge = 1;
    this.peakEnemyTurretCount = 0;
    this.discoveredActionTypes.clear();
    this.discoveredUnitTypes.clear();
    this.discoveredTurretTypes.clear();
    this.discoveryBudgetRemaining = this.rewardProfile.actionDiscoveryEpisodeCap;
    const opponentDifficulty = this.pickOpponentDifficulty(command.seed);
    const config: GameConfig = {
      difficulty: this.selfDifficulty,
      mode: 'WATCH',
      startingGold: BASE_CONFIG.startingGold,
      startingMana: BASE_CONFIG.startingMana,
      goldIncomeBase: INCOME_CONFIG.baseGoldPerSecond,
      manaIncomeBase: BASE_CONFIG.baseManaPerSecond,
      laneLength: 50,
      basePositions: { player: 0, enemy: 50 },
      sideControl: {
        PLAYER: {
          control: 'AI',
          difficulty: opponentDifficulty,
          mlCheckpointId: opponentDifficulty === 'SMART_ML' ? this.opponentCheckpointId ?? undefined : undefined,
        },
        ENEMY: { control: 'AI', difficulty: this.selfDifficulty },
      },
    };
    this.engine = new GameEngine(config, command.seed, {
      onGameOver: () => undefined,
    });
    this.engine.setAIDecisionEnabled('ENEMY', false);
    this.engine.setAIDecisionEnabled('PLAYER', !this.opponentUseMockRandom);
    this.engine.startHeadless();
    this.mockRandomWaitStepsRemaining = 0;
    this.history.reset();
    const snapshot = this.engine.getAISnapshot('ENEMY');
    this.peakEnemyAge = Math.max(this.peakEnemyAge, snapshot.enemyAge);
    this.peakEnemyTurretCount = Math.max(this.peakEnemyTurretCount, snapshot.enemyTurretInstalledCount);
    this.history.ingestState(snapshot);
    const obs = this.encodeSnapshot(snapshot);
    return { ok: true, observation: obs };
  }

  step(command: Extract<BridgeCommand, { cmd: 'step' }>): Record<string, unknown> {
    if (!this.engine) {
      throw new Error('Bridge not initialized: call reset first');
    }
    const prev = this.engine.getAISnapshot('ENEMY');
    this.history.ingestState(prev);
    const prevMask = buildLegalActionMask(prev);
    const decision = this.decodeDecision(command.action);
    const decisionParams = (decision.parameters ?? {}) as Record<string, unknown>;
    const executedUnitType =
      typeof decisionParams.unitType === 'string' && decisionParams.unitType.trim().length > 0
        ? decisionParams.unitType.trim()
        : null;
    const executedTurretId =
      typeof decisionParams.turretId === 'string' && decisionParams.turretId.trim().length > 0
        ? decisionParams.turretId.trim()
        : null;
    const legal = this.isDecisionLegal(decision, prevMask);
    const applied = legal ? this.engine.applyAIDecision(decision, 'ENEMY') : false;
    if (legal && applied) {
      const postAction = this.engine.getAISnapshot('ENEMY');
      this.episodeGoldSpent += Math.max(0, prev.enemyGold - postAction.enemyGold);
      this.episodeManaSpent += Math.max(0, prev.enemyMana - postAction.enemyMana);
    }
    const decisionSlot =
      typeof (decision.parameters as Record<string, unknown> | undefined)?.slotIndex === 'number'
        ? Math.floor((decision.parameters as Record<string, unknown>).slotIndex as number)
        : null;
    if (legal && applied && decision.action === 'BUY_TURRET_ENGINE' && decisionSlot !== null) {
      this.lastBuyTimeBySlot.set(decisionSlot, prev.gameTime);
    }
    this.history.recordDecision(prev, decision, legal && applied ? 0 : -0.35);
    if (this.opponentUseMockRandom) {
      this.applyMockRandomOpponentDecision();
    }
    this.engine.stepHeadless(this.decisionFrames);

    const next = this.engine.getAISnapshot('ENEMY');
    this.peakEnemyAge = Math.max(this.peakEnemyAge, next.enemyAge);
    this.peakEnemyTurretCount = Math.max(this.peakEnemyTurretCount, next.enemyTurretInstalledCount);
    this.history.ingestState(next);
    if (next.enemyAge > prev.enemyAge) {
      this.enemyLastAgeUpTimeSec = prev.gameTime;
    }
    const doneByBase = next.enemyBaseHealth <= 0 || next.playerBaseHealth <= 0;
    const doneByConfiguredTimeout = next.gameTime >= this.episodeSeconds;
    const doneByForcedTimeout = next.gameTime >= FORCED_TIMEOUT_LOSS_SEC;
    const doneByTimeout = doneByConfiguredTimeout || doneByForcedTimeout;
    const done = doneByBase || doneByTimeout;
    const terminalCause = next.playerBaseHealth <= 0
      ? 'player_win'
      : next.enemyBaseHealth <= 0
        ? 'enemy_win'
        : doneByTimeout
          ? 'timeout'
          : 'none';
    const rewardComponents = this.computeReward(
      prev,
      next,
      legal && applied,
      terminalCause,
      done,
      decision.action,
      executedUnitType,
      executedTurretId,
      decisionSlot,
      prev.gameTime
    );
    if (legal && applied && decision.action === 'SELL_TURRET_ENGINE' && decisionSlot !== null) {
      this.lastBuyTimeBySlot.delete(decisionSlot);
    }
    const reward =
      rewardComponents.enemy_unit_kill_value +
      rewardComponents.own_unit_loss_value +
      rewardComponents.enemy_base_damage +
      rewardComponents.own_base_damage +
      rewardComponents.safe_age_up_bonus +
      rewardComponents.action_discovery_bonus +
      rewardComponents.lane_control_delta +
      rewardComponents.illegal_action_penalty +
      rewardComponents.terminal_outcome;
    if (done) {
      this.engine.stopHeadless();
    }
    const obs = this.encodeSnapshot(next);
    const includeDetailedTelemetry = done;
    const telemetry = includeDetailedTelemetry ? this.engine.getTelemetrySnapshot() : null;
    const ownTelemetry = telemetry ? telemetry.bySide.ENEMY : null;
    const info: Record<string, number | string> = {
      own_base_hp: next.enemyBaseHealth,
      opp_base_hp: next.playerBaseHealth,
      own_units: next.enemyUnitCount,
      opp_units: next.playerUnitCount,
      own_gold: next.enemyGold,
      own_mana: next.enemyMana,
      game_time: next.gameTime,
      own_age: next.enemyAge,
      highest_age: this.peakEnemyAge,
      highest_turret_count: this.peakEnemyTurretCount,
      total_gold_spent: this.episodeGoldSpent,
      total_mana_spent: this.episodeManaSpent,
      enemy_time_since_last_age_up: Math.max(0, next.gameTime - this.enemyLastAgeUpTimeSec),
      terminal_cause: terminalCause,
    };

    if (includeDetailedTelemetry && ownTelemetry) {
      info.mana_upgrade_count = ownTelemetry.manaUpgradeCount;
      info.turret_slot_upgrade_count = ownTelemetry.turretSlotUpgradeCount;
      Object.entries(ownTelemetry.unitBuildCounts).forEach(([unitId, count]) => {
        info[`unit_build__${unitId}`] = Number(count) || 0;
      });
      Object.entries(ownTelemetry.turretEngineBuys).forEach(([turretId, count]) => {
        info[`turret_buy__${turretId}`] = Number(count) || 0;
        const def = getTurretEngineDef(turretId);
        if (def) {
          const strength = def.age * 1000 + def.cost + def.protectionMultiplier * 100;
          info[`turret_strength__${turretId}`] = strength;
        }
      });
      Object.entries(ownTelemetry.turretEngineSells).forEach(([turretId, count]) => {
        info[`turret_sell__${turretId}`] = Number(count) || 0;
      });
    }

    return {
      ok: true,
      observation: obs,
      reward,
      done,
      info,
      reward_components: rewardComponents,
    };
  }

  getEnvState(): Record<string, unknown> {
    if (!this.engine) {
      throw new Error('Bridge not initialized: call reset first');
    }
    return {
      ok: true,
      state: {
        game: this.engine.exportSerializableState(),
        history: this.history.exportState(),
        runtime: {
          staticDim: this.staticDim,
          sequenceLen: this.sequenceLen,
          tokenDim: this.tokenDim,
          actionDim: this.actionDim,
          unitDim: this.unitDim,
          turretDim: this.turretDim,
          slotDim: this.slotDim,
          episodeSeconds: this.episodeSeconds,
          decisionFrames: this.decisionFrames,
          selfDifficulty: this.selfDifficulty,
          opponentDifficulty: this.opponentDifficulty,
          opponentCheckpointId: this.opponentCheckpointId,
          opponentUseMockRandom: this.opponentUseMockRandom,
          mockRandomActionGap: this.mockRandomActionGap,
          mockRandomWaitStepsRemaining: this.mockRandomWaitStepsRemaining,
          opponentArchetype: this.opponentArchetype,
          opponentAggression: this.opponentAggression,
          opponentTeching: this.opponentTeching,
          opponentDefense: this.opponentDefense,
          ownBaseMilestonesAwarded: Array.from(this.ownBaseMilestonesAwarded),
          opponentBaseMilestonesAwarded: Array.from(this.opponentBaseMilestonesAwarded),
          lastBuyTimeBySlot: Array.from(this.lastBuyTimeBySlot.entries()),
          enemyLastAgeUpTimeSec: this.enemyLastAgeUpTimeSec,
          episodeGoldSpent: this.episodeGoldSpent,
          episodeManaSpent: this.episodeManaSpent,
          peakEnemyAge: this.peakEnemyAge,
          peakEnemyTurretCount: this.peakEnemyTurretCount,
          rewardProfile: this.rewardProfile,
          discoveredActionTypes: Array.from(this.discoveredActionTypes),
          discoveredUnitTypes: Array.from(this.discoveredUnitTypes),
          discoveredTurretTypes: Array.from(this.discoveredTurretTypes),
          discoveryBudgetRemaining: this.discoveryBudgetRemaining,
        },
      },
    };
  }

  setEnvState(command: Extract<BridgeCommand, { cmd: 'set_env_state' }>): Record<string, unknown> {
    if (!this.engine) {
      throw new Error('Bridge not initialized: call reset first');
    }
    const payload = command.state;
    if (!payload || typeof payload !== 'object') {
      throw new Error('set_env_state requires a state object payload');
    }
    const stateObj = payload as Record<string, unknown>;
    const gameRaw = stateObj.game;
    if (!gameRaw || typeof gameRaw !== 'object') {
      throw new Error('set_env_state missing game snapshot');
    }
    const imported = this.engine.importSerializableState(gameRaw);
    if (!imported) {
      throw new Error('Failed to import serialized game state');
    }
    this.engine.setAIDecisionEnabled('ENEMY', false);

    const runtimeRaw = stateObj.runtime;
    if (runtimeRaw && typeof runtimeRaw === 'object') {
      const runtime = runtimeRaw as Record<string, unknown>;
      this.staticDim = Math.max(1, Number(runtime.staticDim ?? this.staticDim));
      this.sequenceLen = Math.max(1, Number(runtime.sequenceLen ?? this.sequenceLen));
      this.tokenDim = Math.max(1, Number(runtime.tokenDim ?? this.tokenDim));
      this.actionDim = Math.max(1, Number(runtime.actionDim ?? this.actionDim));
      this.unitDim = Math.max(1, Number(runtime.unitDim ?? this.unitDim));
      this.turretDim = Math.max(1, Number(runtime.turretDim ?? this.turretDim));
      this.slotDim = Math.max(1, Number(runtime.slotDim ?? this.slotDim));
      this.episodeSeconds = Math.max(60, Number(runtime.episodeSeconds ?? this.episodeSeconds));
      this.decisionFrames = Math.max(1, Number(runtime.decisionFrames ?? this.decisionFrames));
      this.selfDifficulty = normalizeDifficulty(runtime.selfDifficulty, this.selfDifficulty);
      this.opponentDifficulty = normalizeDifficulty(runtime.opponentDifficulty, this.opponentDifficulty);
      this.opponentUseMockRandom = Boolean(runtime.opponentUseMockRandom);
      this.mockRandomActionGap = Math.max(0, Math.floor(Number(runtime.mockRandomActionGap ?? this.mockRandomActionGap)));
      this.mockRandomWaitStepsRemaining = Math.max(
        0,
        Math.floor(Number(runtime.mockRandomWaitStepsRemaining ?? this.mockRandomWaitStepsRemaining))
      );
      this.opponentCheckpointId =
        typeof runtime.opponentCheckpointId === 'string' && runtime.opponentCheckpointId.trim().length > 0
          ? runtime.opponentCheckpointId.trim()
          : null;
      this.opponentArchetype =
        typeof runtime.opponentArchetype === 'string' && runtime.opponentArchetype.trim().length > 0
          ? runtime.opponentArchetype.trim()
          : 'balanced';
      this.opponentAggression = clamp(Number(runtime.opponentAggression ?? this.opponentAggression), 0, 2);
      this.opponentTeching = clamp(Number(runtime.opponentTeching ?? this.opponentTeching), 0, 2);
      this.opponentDefense = clamp(Number(runtime.opponentDefense ?? this.opponentDefense), 0, 2);
      this.enemyLastAgeUpTimeSec = Math.max(0, Number(runtime.enemyLastAgeUpTimeSec ?? this.enemyLastAgeUpTimeSec));
      this.episodeGoldSpent = Math.max(0, Number(runtime.episodeGoldSpent ?? this.episodeGoldSpent));
      this.episodeManaSpent = Math.max(0, Number(runtime.episodeManaSpent ?? this.episodeManaSpent));
      this.peakEnemyAge = Math.max(1, Number(runtime.peakEnemyAge ?? this.peakEnemyAge));
      this.peakEnemyTurretCount = Math.max(
        0,
        Number(runtime.peakEnemyTurretCount ?? this.peakEnemyTurretCount)
      );
      this.discoveryBudgetRemaining = Math.max(
        0,
        Number(runtime.discoveryBudgetRemaining ?? this.discoveryBudgetRemaining)
      );
      this.rewardProfile = mergeRewardProfile(runtime.rewardProfile ?? this.rewardProfile);

      this.ownBaseMilestonesAwarded.clear();
      const ownMilestones = Array.isArray(runtime.ownBaseMilestonesAwarded)
        ? runtime.ownBaseMilestonesAwarded
        : [];
      ownMilestones.forEach((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) this.ownBaseMilestonesAwarded.add(value);
      });
      this.opponentBaseMilestonesAwarded.clear();
      const oppMilestones = Array.isArray(runtime.opponentBaseMilestonesAwarded)
        ? runtime.opponentBaseMilestonesAwarded
        : [];
      oppMilestones.forEach((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) this.opponentBaseMilestonesAwarded.add(value);
      });
      this.lastBuyTimeBySlot.clear();
      const buyEntries = Array.isArray(runtime.lastBuyTimeBySlot) ? runtime.lastBuyTimeBySlot : [];
      for (const pair of buyEntries) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const slot = Number(pair[0]);
        const ts = Number(pair[1]);
        if (Number.isFinite(slot) && Number.isFinite(ts)) {
          this.lastBuyTimeBySlot.set(Math.floor(slot), ts);
        }
      }

      this.discoveredActionTypes = new Set<string>();
      (Array.isArray(runtime.discoveredActionTypes) ? runtime.discoveredActionTypes : []).forEach((value) => {
        if (typeof value === 'string') this.discoveredActionTypes.add(value);
      });
      this.discoveredUnitTypes = new Set<string>();
      (Array.isArray(runtime.discoveredUnitTypes) ? runtime.discoveredUnitTypes : []).forEach((value) => {
        if (typeof value === 'string') this.discoveredUnitTypes.add(value);
      });
      this.discoveredTurretTypes = new Set<string>();
      (Array.isArray(runtime.discoveredTurretTypes) ? runtime.discoveredTurretTypes : []).forEach((value) => {
        if (typeof value === 'string') this.discoveredTurretTypes.add(value);
      });
    }

    this.history.reset();
    if (stateObj.history && typeof stateObj.history === 'object') {
      this.history.importState(stateObj.history);
    }
    const snapshot = this.engine.getAISnapshot('ENEMY');
    this.peakEnemyAge = Math.max(this.peakEnemyAge, snapshot.enemyAge);
    this.peakEnemyTurretCount = Math.max(this.peakEnemyTurretCount, snapshot.enemyTurretInstalledCount);
    this.engine.setAIDecisionEnabled('PLAYER', !this.opponentUseMockRandom);
    const obs = this.encodeSnapshot(snapshot);
    return { ok: true, observation: obs };
  }

  close(): Record<string, unknown> {
    if (this.engine) {
      this.engine.stopHeadless();
      this.engine = null;
    }
    return { ok: true };
  }

  private decodeDecision(rawAction: Extract<BridgeCommand, { cmd: 'step' }>['action']): AIDecision {
    const action = rawAction.action_type;
    const confidence = typeof rawAction.confidence === 'number' ? rawAction.confidence : 0;
    if (action === 'RECRUIT_UNIT') {
      const indexFromId = parseIndexedId(rawAction.unit_id, 'unit');
      const explicitIndex = getUnitIndex(rawAction.unit_id);
      const resolvedIndex = indexFromId >= 0 ? indexFromId : explicitIndex;
      const normalizedIndex = clamp(resolvedIndex, 0, Math.max(0, ML_UNIT_IDS.length - 1));
      return {
        action,
        confidence,
        parameters: {
          unitType: ML_UNIT_IDS[normalizedIndex] ?? ML_UNIT_IDS[0] ?? 'stone_clubman',
          priority: 'normal',
        },
      };
    }
    if (action === 'BUY_TURRET_ENGINE') {
      const turretFromId = parseIndexedId(rawAction.turret_id, 'turret');
      const explicitIndex = getTurretIndex(rawAction.turret_id);
      const resolvedTurret = turretFromId >= 0 ? turretFromId : explicitIndex;
      const turretIndex = clamp(resolvedTurret, 0, Math.max(0, ML_TURRET_IDS.length - 1));
      const slot = Number.isFinite(rawAction.slot_index)
        ? clamp(Math.floor(rawAction.slot_index as number), 0, Math.max(0, ML_SLOT_INDICES.length - 1))
        : 0;
      return {
        action,
        confidence,
        parameters: {
          turretId: ML_TURRET_IDS[turretIndex] ?? ML_TURRET_IDS[0],
          slotIndex: slot,
        },
      };
    }
    if (action === 'SELL_TURRET_ENGINE') {
      const slot = Number.isFinite(rawAction.slot_index)
        ? clamp(Math.floor(rawAction.slot_index as number), 0, Math.max(0, ML_SLOT_INDICES.length - 1))
        : 0;
      return {
        action,
        confidence,
        parameters: { slotIndex: slot },
      };
    }
    if (
      action === 'WAIT' ||
      action === 'AGE_UP' ||
      action === 'UPGRADE_MANA' ||
      action === 'UPGRADE_TURRET_SLOTS' ||
      action === 'REPAIR_BASE'
    ) {
      return { action, confidence };
    }
    return { action: 'WAIT', confidence };
  }

  private isDecisionLegal(
    decision: AIDecision,
    mask: ReturnType<typeof buildLegalActionMask>
  ): boolean {
    const actionTypeIndex = getActionTypeIndex(decision.action);
    if (actionTypeIndex < 0 || actionTypeIndex >= mask.actionTypeMask.length) return false;
    if (mask.actionTypeMask[actionTypeIndex] <= 0) return false;

    if (decision.action === 'RECRUIT_UNIT') {
      const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
      const unitIndex = getUnitIndex(typeof parameters.unitType === 'string' ? parameters.unitType : undefined);
      return unitIndex >= 0 && unitIndex < mask.unitMask.length && mask.unitMask[unitIndex] > 0;
    }

    if (decision.action === 'BUY_TURRET_ENGINE') {
      const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
      const turretIndex = getTurretIndex(
        typeof parameters.turretId === 'string' ? parameters.turretId : undefined
      );
      const slotIndex = typeof parameters.slotIndex === 'number' ? Math.floor(parameters.slotIndex) : -1;
      return (
        turretIndex >= 0 &&
        slotIndex >= 0 &&
        turretIndex < mask.turretMask.length &&
        slotIndex < mask.buySlotMask.length &&
        mask.turretMask[turretIndex] > 0 &&
        mask.buySlotMask[slotIndex] > 0
      );
    }

    if (decision.action === 'SELL_TURRET_ENGINE') {
      const parameters = (decision.parameters ?? {}) as Record<string, unknown>;
      const slotIndex = typeof parameters.slotIndex === 'number' ? Math.floor(parameters.slotIndex) : -1;
      return slotIndex >= 0 && slotIndex < mask.sellSlotMask.length && mask.sellSlotMask[slotIndex] > 0;
    }

    return true;
  }

  private encodeSnapshot(snapshot: GameStateSnapshot): Record<string, unknown> {
    const mask = buildLegalActionMask(snapshot);
    const encoded = encodeObservation(
      snapshot,
      this.history.getRecentTokens(),
      mask,
      { sequenceLength: this.sequenceLen }
    );

    const staticState = padArray(encoded.staticState, this.staticDim, 0);
    const eventSequence = encoded.eventSequence.map((token) => padArray(token, this.tokenDim, 0));

    const paddedSequence: number[][] = [];
    for (let i = 0; i < this.sequenceLen; i++) {
      const token = eventSequence[i] ?? [];
      paddedSequence.push(padArray(token, this.tokenDim, 0));
    }

    return {
      tick: snapshot.tick,
      game_time: snapshot.gameTime,
      static_state: staticState,
      event_sequence: paddedSequence,
      action_type_mask: padArray(mask.actionTypeMask, this.actionDim, 0),
      unit_mask: padArray(mask.unitMask, this.unitDim, 0),
      turret_mask: padArray(mask.turretMask, this.turretDim, 0),
      buy_slot_mask: padArray(mask.buySlotMask, this.slotDim, 0),
      sell_slot_mask: padArray(mask.sellSlotMask, this.slotDim, 0),
    };
  }

  private computeReward(
    prev: GameStateSnapshot,
    next: GameStateSnapshot,
    legalAndApplied: boolean,
    terminalCause: 'none' | 'player_win' | 'enemy_win' | 'timeout',
    done: boolean,
    executedAction: AIDecision['action'],
    executedUnitType: string | null,
    executedTurretId: string | null,
    executedSlotIndex: number | null,
    decisionTimeSec: number
  ): Record<RewardComponentKey, number> {
    const rp = this.rewardProfile;
    const enemyUnitDelta = Math.max(0, prev.playerUnitCount - next.playerUnitCount);
    const ownUnitDelta = Math.max(0, prev.enemyUnitCount - next.enemyUnitCount);
    const enemyUnitKillValue = enemyUnitDelta * rp.enemyUnitKillPerUnit;
    const ownUnitLossValue = ownUnitDelta * rp.ownUnitLossPerUnit;
    const enemyBaseDamage = this.computeOneTimeBaseMilestones(
      prev.playerBaseHealth / Math.max(1, prev.playerBaseMaxHealth),
      next.playerBaseHealth / Math.max(1, next.playerBaseMaxHealth),
      this.opponentBaseMilestonesAwarded,
      rp.baseMilestoneThresholds,
      rp.baseMilestoneRewards
    );
    const ownBaseDamage = -this.computeOneTimeBaseMilestones(
      prev.enemyBaseHealth / Math.max(1, prev.enemyBaseMaxHealth),
      next.enemyBaseHealth / Math.max(1, next.enemyBaseMaxHealth),
      this.ownBaseMilestonesAwarded,
      rp.baseMilestoneThresholds,
      rp.baseMilestoneRewards
    );
    const safeAgeUpBonus = next.enemyAge > prev.enemyAge ? rp.safeAgeUpBonus : 0;
    const prevLaneControl = prev.enemyUnitsNearPlayerBase - prev.playerUnitsNearEnemyBase;
    const nextLaneControl = next.enemyUnitsNearPlayerBase - next.playerUnitsNearEnemyBase;
    const laneControlDelta = (nextLaneControl - prevLaneControl) * rp.laneControlDeltaPerUnit;
    const ageUpDelayPenalty = this.computeAgeUpDelayPenalty(prev, next);
    const actionDiscoveryBonus = this.computeActionDiscoveryBonus(
      legalAndApplied,
      executedAction,
      executedUnitType,
      executedTurretId
    );
    let illegalActionPenalty = legalAndApplied ? 0 : rp.illegalActionPenalty;
    if (legalAndApplied && executedAction === 'SELL_TURRET_ENGINE') {
      // Penalize quick buy->sell flips (within 3 seconds on same slot).
      if (executedSlotIndex !== null) {
        const lastBuyTime = this.lastBuyTimeBySlot.get(executedSlotIndex);
        if (lastBuyTime !== undefined) {
          const sinceBuySec = Math.max(0, decisionTimeSec - lastBuyTime);
          if (sinceBuySec <= rp.quickSellWindowSec) {
            illegalActionPenalty += rp.quickSellPenalty;
          }
        }
      }
    }
    let terminalOutcome = 0;
    if (done) {
      if (terminalCause === 'player_win') terminalOutcome = rp.terminalWin;
      else if (terminalCause === 'enemy_win') terminalOutcome = rp.terminalLoss;
      else if (terminalCause === 'timeout') {
        // Timeouts are treated as forced losses to eliminate draw farming.
        terminalOutcome = rp.timeoutLoss;
      }
    }
    const raw: Record<RewardComponentKey, number> = {
      enemy_unit_kill_value: enemyUnitKillValue,
      own_unit_loss_value: ownUnitLossValue,
      enemy_base_damage: enemyBaseDamage,
      own_base_damage: ownBaseDamage,
      safe_age_up_bonus: safeAgeUpBonus,
      age_up_delay_penalty: ageUpDelayPenalty,
      action_discovery_bonus: actionDiscoveryBonus,
      lane_control_delta: laneControlDelta,
      illegal_action_penalty: illegalActionPenalty,
      terminal_outcome: terminalOutcome,
    };
    return this.applyRewardComponentWeights(raw);
  }

  private computeAgeUpDelayPenalty(prev: GameStateSnapshot, next: GameStateSnapshot): number {
    const rp = this.rewardProfile;
    if (next.enemyAge >= 6) return 0;
    const elapsedSinceAgeUp = Math.max(0, next.gameTime - this.enemyLastAgeUpTimeSec);
    const graceSeconds = next.enemyAge * rp.ageDelayGracePerAgeSec;
    if (elapsedSinceAgeUp <= graceSeconds) return 0;
    const rampSeconds = rp.ageDelayRampSec;
    const overdue = elapsedSinceAgeUp - graceSeconds;
    const ramp = clamp(overdue / rampSeconds, 0, 1);
    const requiredGold = Math.max(1, next.enemyAgeCost);
    const currentGold = Math.max(1, next.enemyGold);
    const ratio = requiredGold / currentGold;
    const deltaSeconds = Math.max(0, next.gameTime - prev.gameTime);
    return -(ratio * ramp * deltaSeconds * rp.ageDelayPenaltyWeight);
  }

  private computeActionDiscoveryBonus(
    legalAndApplied: boolean,
    executedAction: AIDecision['action'],
    executedUnitType: string | null,
    executedTurretId: string | null
  ): number {
    if (!legalAndApplied) return 0;
    if (this.discoveryBudgetRemaining <= 0) return 0;
    if (executedAction === 'WAIT') return 0;

    const rp = this.rewardProfile;
    let bonus = 0;

    if (!this.discoveredActionTypes.has(executedAction)) {
      this.discoveredActionTypes.add(executedAction);
      bonus += rp.actionDiscoveryActionBonus;
    }

    if (executedAction === 'RECRUIT_UNIT' && executedUnitType) {
      if (!this.discoveredUnitTypes.has(executedUnitType)) {
        this.discoveredUnitTypes.add(executedUnitType);
        bonus += rp.actionDiscoveryUnitBonus;
      }
    }

    if (executedAction === 'BUY_TURRET_ENGINE' && executedTurretId) {
      if (!this.discoveredTurretTypes.has(executedTurretId)) {
        this.discoveredTurretTypes.add(executedTurretId);
        bonus += rp.actionDiscoveryTurretBonus;
      }
    }

    if (bonus <= 0) return 0;
    const granted = Math.min(bonus, this.discoveryBudgetRemaining);
    this.discoveryBudgetRemaining = Math.max(0, this.discoveryBudgetRemaining - granted);
    return granted;
  }

  private applyRewardComponentWeights(
    values: Record<RewardComponentKey, number>
  ): Record<RewardComponentKey, number> {
    const weighted: Partial<Record<RewardComponentKey, number>> = {};
    (Object.keys(values) as RewardComponentKey[]).forEach((key) => {
      const weight = finiteOr(this.rewardProfile.componentWeights[key], 1.0);
      weighted[key] = values[key] * weight;
    });
    return weighted as Record<RewardComponentKey, number>;
  }

  private computeOneTimeBaseMilestones(
    prevHealthRatio: number,
    nextHealthRatio: number,
    awarded: Set<number>,
    thresholds: [number, number, number],
    rewards: [number, number, number]
  ): number {
    let reward = 0;
    thresholds.forEach((threshold, idx) => {
      if (prevHealthRatio > threshold && nextHealthRatio <= threshold && !awarded.has(threshold)) {
        awarded.add(threshold);
        reward += rewards[idx];
      }
    });
    return reward;
  }

  private pickOpponentDifficulty(seed: number): GameDifficulty {
    if (this.opponentUseMockRandom) {
      return this.opponentDifficulty;
    }
    const ladder: GameDifficulty[] = ['MEDIUM', 'HARD', 'SMART', 'SMART_ML', 'CHEATER'];
    const baseIdx = Math.max(0, ladder.indexOf(this.opponentDifficulty));
    const rng = this.seededRandom(seed ^ 0x9e3779b9);
    if (this.opponentCheckpointId) {
      // Keep SMART_ML for strategy-conditioned opponents; only small jitter for robustness.
      const roll = rng();
      if (roll < 0.1 && baseIdx > 0) return ladder[baseIdx - 1];
      if (roll > 0.9 && baseIdx < ladder.length - 1) return ladder[baseIdx + 1];
      return ladder[baseIdx];
    }
    let roll = rng();
    // Archetype-biased perturbation yields varied sparring styles in non-checkpoint matches.
    if (this.opponentArchetype === 'swarm' || this.opponentArchetype === 'raider') {
      roll += 0.1 + this.opponentAggression * 0.05;
    } else if (this.opponentArchetype === 'techer' || this.opponentArchetype === 'scaler') {
      roll += (this.opponentTeching - 0.5) * 0.1;
    } else if (this.opponentArchetype === 'fortress' || this.opponentArchetype === 'turtle') {
      roll -= 0.08 + this.opponentDefense * 0.03;
    }
    if (roll < 0.2 && baseIdx > 0) return ladder[baseIdx - 1];
    if (roll > 0.8 && baseIdx < ladder.length - 1) return ladder[baseIdx + 1];
    return ladder[baseIdx];
  }

  private applyMockRandomOpponentDecision(): void {
    if (!this.engine) return;
    if (this.mockRandomWaitStepsRemaining > 0) {
      this.mockRandomWaitStepsRemaining -= 1;
      return;
    }
    const snapshot = this.engine.getAISnapshot('PLAYER');
    const mask = buildLegalActionMask(snapshot);
    const decision = this.buildMockRandomDecision(mask);
    if (decision.action === 'WAIT') {
      return;
    }
    if (this.isDecisionLegal(decision, mask)) {
      this.engine.applyAIDecision(decision, 'PLAYER');
      this.mockRandomWaitStepsRemaining = this.mockRandomActionGap;
    }
  }

  private buildMockRandomDecision(mask: ReturnType<typeof buildLegalActionMask>): AIDecision {
    const legalActionTypes = ACTION_TYPES_IN_ORDER.filter((_, idx) => mask.actionTypeMask[idx] > 0);
    const action = this.randomChoice(legalActionTypes) ?? 'WAIT';

    if (action === 'RECRUIT_UNIT') {
      const legalUnits = ML_UNIT_IDS.filter((_, idx) => mask.unitMask[idx] > 0);
      const unitType = this.randomChoice(legalUnits);
      if (!unitType) return { action: 'WAIT', confidence: 0 };
      return { action, confidence: 0, parameters: { unitType, priority: 'normal' } };
    }

    if (action === 'BUY_TURRET_ENGINE') {
      const legalTurrets = ML_TURRET_IDS.filter((_, idx) => mask.turretMask[idx] > 0);
      const legalSlots = ML_SLOT_INDICES.filter((slot) => mask.buySlotMask[slot] > 0);
      const turretId = this.randomChoice(legalTurrets);
      const slotIndex = this.randomChoice(legalSlots);
      if (!turretId || slotIndex === undefined) return { action: 'WAIT', confidence: 0 };
      return { action, confidence: 0, parameters: { turretId, slotIndex } };
    }

    if (action === 'SELL_TURRET_ENGINE') {
      const legalSlots = ML_SLOT_INDICES.filter((slot) => mask.sellSlotMask[slot] > 0);
      const slotIndex = this.randomChoice(legalSlots);
      if (slotIndex === undefined) return { action: 'WAIT', confidence: 0 };
      return { action, confidence: 0, parameters: { slotIndex } };
    }

    return { action, confidence: 0 };
  }

  private randomChoice<T>(values: T[]): T | undefined {
    if (!Array.isArray(values) || values.length <= 0) return undefined;
    const idx = Math.floor(Math.random() * values.length);
    return values[Math.max(0, Math.min(values.length - 1, idx))];
  }

  private seededRandom(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value = (value + 0x6d2b79f5) | 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

const runtime = new BridgeRuntime();

function emit(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function handle(command: BridgeCommand): Record<string, unknown> {
  if (command.cmd === 'ping') return { ok: true, pong: true };
  if (command.cmd === 'init') return runtime.init(command);
  if (command.cmd === 'set_opponent_profile') return runtime.setOpponentProfile(command);
  if (command.cmd === 'reset') return runtime.reset(command);
  if (command.cmd === 'step') return runtime.step(command);
  if (command.cmd === 'get_env_state') return runtime.getEnvState();
  if (command.cmd === 'set_env_state') return runtime.setEnvState(command);
  if (command.cmd === 'close') return runtime.close();
  return { ok: false, error: `unknown command ${(command as { cmd?: string }).cmd}` };
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const payload = JSON.parse(trimmed) as BridgeCommand;
    const response = handle(payload);
    emit(response);
    if (payload.cmd === 'close') {
      rl.close();
      process.exit(0);
    }
  } catch (error) {
    emit({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
