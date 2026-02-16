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

type Owner = 'PLAYER' | 'ENEMY';

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
        archetype?: string;
        aggression?: number;
        teching?: number;
        defense?: number;
      };
    }
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

console.log = toStderr('[bridge]');
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

class BridgeRuntime {
  private engine: GameEngine | null = null;
  private history = new MLHistoryBuffer({ horizonSeconds: 120 });
  private staticDim = 112;
  private sequenceLen = 240;
  private tokenDim = 8;
  private actionDim = 8;
  private unitDim = 128;
  private turretDim = 32;
  private slotDim = 4;
  private episodeSeconds = 1200;
  private decisionFrames = 30;
  private selfDifficulty: GameDifficulty = 'SMART_ML';
  private opponentDifficulty: GameDifficulty = 'SMART';
  private opponentCheckpointId: string | null = null;
  private opponentArchetype = 'balanced';
  private opponentAggression = 0.5;
  private opponentTeching = 0.5;
  private opponentDefense = 0.5;
  private ownBaseMilestonesAwarded = new Set<number>();
  private opponentBaseMilestonesAwarded = new Set<number>();

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
      },
    };
  }

  setOpponentProfile(command: Extract<BridgeCommand, { cmd: 'set_opponent_profile' }>): Record<string, unknown> {
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
    const elo = command.profile?.elo ?? 1000;
    // If we have a checkpoint identity, force SMART_ML proxy to preserve strategy diversity.
    if (this.opponentCheckpointId) {
      this.opponentDifficulty = 'SMART_ML';
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
    };
  }

  reset(command: Extract<BridgeCommand, { cmd: 'reset' }>): Record<string, unknown> {
    this.ownBaseMilestonesAwarded.clear();
    this.opponentBaseMilestonesAwarded.clear();
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
      onStateUpdate: () => undefined,
      onGameOver: () => undefined,
    });
    this.engine.setAIDecisionEnabled('ENEMY', false);
    this.engine.startHeadless();
    this.history.reset();
    const snapshot = this.engine.getAISnapshot('ENEMY');
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
    const legal = this.isDecisionLegal(decision, prevMask);
    const applied = legal ? this.engine.applyAIDecision(decision, 'ENEMY') : false;
    this.history.recordDecision(prev, decision, legal && applied ? 0 : -0.35);
    this.engine.stepHeadless(this.decisionFrames);

    const next = this.engine.getAISnapshot('ENEMY');
    this.history.ingestState(next);
    const doneByBase = next.enemyBaseHealth <= 0 || next.playerBaseHealth <= 0;
    const doneByTimeout = next.gameTime >= this.episodeSeconds;
    const done = doneByBase || doneByTimeout;
    const terminalCause = next.playerBaseHealth <= 0
      ? 'player_win'
      : next.enemyBaseHealth <= 0
        ? 'enemy_win'
        : doneByTimeout
          ? 'timeout'
          : 'none';
    const rewardComponents = this.computeReward(prev, next, legal && applied, terminalCause, done);
    const reward =
      rewardComponents.enemy_unit_kill_value +
      rewardComponents.own_unit_loss_value +
      rewardComponents.enemy_base_damage +
      rewardComponents.own_base_damage +
      rewardComponents.safe_age_up_bonus +
      rewardComponents.lane_control_delta +
      rewardComponents.illegal_action_penalty +
      rewardComponents.terminal_outcome;
    if (done) {
      this.engine.stopHeadless();
    }
    const obs = this.encodeSnapshot(next);
    return {
      ok: true,
      observation: obs,
      reward,
      done,
      info: {
        own_base_hp: next.enemyBaseHealth,
        opp_base_hp: next.playerBaseHealth,
        own_units: next.enemyUnitCount,
        opp_units: next.playerUnitCount,
        own_gold: next.enemyGold,
        own_mana: next.enemyMana,
        game_time: next.gameTime,
        terminal_cause: terminalCause,
      },
      reward_components: rewardComponents,
    };
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
    done: boolean
  ): Record<string, number> {
    const enemyUnitKillValue = 0;
    const ownUnitLossValue = 0;
    const enemyBaseDamage = this.computeOneTimeBaseMilestones(
      prev.playerBaseHealth / Math.max(1, prev.playerBaseMaxHealth),
      next.playerBaseHealth / Math.max(1, next.playerBaseMaxHealth),
      this.opponentBaseMilestonesAwarded,
      [2, 4, 8]
    );
    const ownBaseDamage = -this.computeOneTimeBaseMilestones(
      prev.enemyBaseHealth / Math.max(1, prev.enemyBaseMaxHealth),
      next.enemyBaseHealth / Math.max(1, next.enemyBaseMaxHealth),
      this.ownBaseMilestonesAwarded,
      [2, 4, 8]
    );
    const safeAgeUpBonus =
      next.enemyAge > prev.enemyAge && next.enemyBaseHealth / Math.max(1, next.enemyBaseMaxHealth) > 0.6
        ? 1.2
        : 0;
    const laneControlDelta = 0;
    const illegalActionPenalty = legalAndApplied ? 0 : -0.5;
    let terminalOutcome = 0;
    if (done) {
      if (terminalCause === 'player_win') terminalOutcome = 40.0;
      else if (terminalCause === 'enemy_win') terminalOutcome = -40.0;
      else if (terminalCause === 'timeout') {
        const ownRatio = next.enemyBaseHealth / Math.max(1, next.enemyBaseMaxHealth);
        const oppRatio = next.playerBaseHealth / Math.max(1, next.playerBaseMaxHealth);
        terminalOutcome = clamp((ownRatio - oppRatio) * 10, -10.0, 10.0);
      }
    }
    return {
      enemy_unit_kill_value: enemyUnitKillValue,
      own_unit_loss_value: ownUnitLossValue,
      enemy_base_damage: enemyBaseDamage,
      own_base_damage: ownBaseDamage,
      safe_age_up_bonus: safeAgeUpBonus,
      lane_control_delta: laneControlDelta,
      illegal_action_penalty: illegalActionPenalty,
      terminal_outcome: terminalOutcome,
    };
  }

  private computeOneTimeBaseMilestones(
    prevHealthRatio: number,
    nextHealthRatio: number,
    awarded: Set<number>,
    rewards: [number, number, number]
  ): number {
    const thresholds: [number, number, number] = [0.75, 0.5, 0.25];
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
