import type { GameStateSnapshot } from '../AIBehavior';
import { MAX_TURRET_SLOTS } from '../../config/turrets';
import { ML_ACTION_TYPES, ML_TURRET_IDS, ML_UNIT_IDS, getActionTypeIndex, getTurretIndex, getUnitIndex, normalizeDiscreteIndex } from './actionCatalog';
import type { MLHistoryToken } from './historyBuffer';
import type { MLLegalActionMask } from './legalActionMask';

const ACTION_LABELS = [...ML_ACTION_TYPES, 'INFERRED_DAMAGE', 'INFERRED_UNIT_DELTA'];
const ACTION_LABEL_TO_INDEX = new Map<string, number>(
  ACTION_LABELS.map((label, index) => [label, index])
);

export interface EncodedMLObservation {
  staticState: number[];
  eventSequence: number[][];
  actionMask: MLLegalActionMask;
  metadata: {
    tick: number;
    gameTime: number;
    sequenceLength: number;
    staticFeatureCount: number;
  };
}

export interface ObservationEncoderConfig {
  sequenceLength?: number;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function normalize(value: number, scale: number): number {
  if (scale <= 0) return 0;
  return clamp(value / scale, -1, 1);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function encodeHistoryToken(token: MLHistoryToken): number[] {
  const actorNorm =
    token.actor === 'PLAYER' ? 1 / 3 : token.actor === 'ENEMY' ? 2 / 3 : 1;
  const actionIndex = ACTION_LABEL_TO_INDEX.get(token.actionLabel) ?? -1;

  return [
    actorNorm,
    normalizeDiscreteIndex(actionIndex, ACTION_LABELS.length),
    normalizeDiscreteIndex(getUnitIndex(token.unitId), ML_UNIT_IDS.length),
    normalizeDiscreteIndex(getTurretIndex(token.turretId), ML_TURRET_IDS.length),
    normalizeDiscreteIndex(token.slotIndex ?? -1, MAX_TURRET_SLOTS),
    normalize(token.deltaSec, 2),
    normalize(token.rewardDelta, 10),
    normalize(token.damageDelta, 600),
  ];
}

function buildStaticStateVector(state: GameStateSnapshot): number[] {
  const playerUnitHealth = state.playerUnits.map((unit) => unit.health);
  const enemyUnitHealth = state.enemyUnits.map((unit) => unit.health);
  const playerUnitDamage = state.playerUnits.map((unit) => unit.damage);
  const enemyUnitDamage = state.enemyUnits.map((unit) => unit.damage);
  const playerUnitRange = state.playerUnits.map((unit) => unit.range);
  const enemyUnitRange = state.enemyUnits.map((unit) => unit.range);

  const playerTotalUnitHealth = sum(playerUnitHealth);
  const enemyTotalUnitHealth = sum(enemyUnitHealth);
  const playerTotalUnitDamage = sum(playerUnitDamage);
  const enemyTotalUnitDamage = sum(enemyUnitDamage);

  return [
    normalize(state.gameTime, 600),
    normalize(state.tick, 36000),
    normalize(state.enemyGold, 10000),
    normalize(state.playerGold, 10000),
    normalize(state.enemyGold - state.playerGold, 10000),
    normalize(state.enemyMana, 5000),
    normalize(state.playerMana, 5000),
    normalize(state.enemyMana - state.playerMana, 5000),
    normalize(state.enemyGoldIncome, 80),
    normalize(state.playerGoldIncome, 80),
    normalize(state.enemyManaIncome, 80),
    normalize(state.playerManaIncome, 80),
    normalize(state.enemyAge, 6),
    normalize(state.playerAge, 6),
    normalize(state.enemyAge - state.playerAge, 6),
    normalize(state.enemyManaLevel, 40),
    normalize(state.playerManaLevel, 40),
    normalize(state.enemyManaLevel - state.playerManaLevel, 40),
    normalize(state.enemyBaseHealth, state.enemyBaseMaxHealth),
    normalize(state.playerBaseHealth, state.playerBaseMaxHealth),
    normalize(state.enemyBaseHealth - state.playerBaseHealth, Math.max(state.enemyBaseMaxHealth, state.playerBaseMaxHealth)),
    normalize(state.enemyTurretDps, 600),
    normalize(state.playerTurretDps, 600),
    normalize(state.enemyTurretDps - state.playerTurretDps, 600),
    normalize(state.enemyTurretMaxRange, 60),
    normalize(state.playerTurretMaxRange, 60),
    normalize(state.enemyTurretAvgRange, 60),
    normalize(state.playerTurretAvgRange, 60),
    normalize(state.enemyTurretProtectionMultiplier, 1),
    normalize(state.playerTurretProtectionMultiplier, 1),
    normalize(state.enemyTurretSlotsUnlocked, 4),
    normalize(state.playerTurretSlotsUnlocked, 4),
    normalize(state.enemyTurretInstalledCount, 4),
    normalize(state.playerTurretInstalledCount, 4),
    normalize(state.enemyUnitCount, 40),
    normalize(state.playerUnitCount, 40),
    normalize(state.enemyUnitCount - state.playerUnitCount, 40),
    normalize(playerTotalUnitHealth, 20000),
    normalize(enemyTotalUnitHealth, 20000),
    normalize(enemyTotalUnitHealth - playerTotalUnitHealth, 20000),
    normalize(playerTotalUnitDamage, 4000),
    normalize(enemyTotalUnitDamage, 4000),
    normalize(enemyTotalUnitDamage - playerTotalUnitDamage, 4000),
    normalize(mean(enemyUnitHealth), 2500),
    normalize(mean(playerUnitHealth), 2500),
    normalize(mean(enemyUnitDamage), 300),
    normalize(mean(playerUnitDamage), 300),
    normalize(mean(enemyUnitRange), 40),
    normalize(mean(playerUnitRange), 40),
    normalize(state.enemyQueueSize, 10),
    normalize(state.playerQueueSize, 10),
    normalize(state.enemyTurretQueueCount, 6),
    normalize(state.playerTurretQueueCount, 6),
    normalize(state.playerUnitsNearEnemyBase, 20),
    normalize(state.enemyUnitsNearPlayerBase, 20),
    normalize(state.battlefieldWidth, 400),
    normalize(state.lastEnemyBaseAttackTime, 600),
  ];
}

export function encodeObservation(
  state: GameStateSnapshot,
  historyTokens: MLHistoryToken[],
  actionMask: MLLegalActionMask,
  config: ObservationEncoderConfig = {}
): EncodedMLObservation {
  const sequenceLength = config.sequenceLength ?? 240;
  const encodedTokens = historyTokens.slice(-sequenceLength).map(encodeHistoryToken);
  const tokenFeatureSize = 8;
  const zeroToken = new Array<number>(tokenFeatureSize).fill(0);
  const paddedSequence = [
    ...Array.from({ length: Math.max(0, sequenceLength - encodedTokens.length) }, () => [...zeroToken]),
    ...encodedTokens,
  ];
  const staticState = buildStaticStateVector(state);

  return {
    staticState,
    eventSequence: paddedSequence,
    actionMask,
    metadata: {
      tick: state.tick,
      gameTime: state.gameTime,
      sequenceLength,
      staticFeatureCount: staticState.length,
    },
  };
}

export function summarizeActionMask(mask: MLLegalActionMask): Record<string, number> {
  const sumMask = (values: number[]) => values.reduce((total, value) => total + (value > 0 ? 1 : 0), 0);
  return {
    legalActionTypes: sumMask(mask.actionTypeMask),
    legalUnits: sumMask(mask.unitMask),
    legalTurrets: sumMask(mask.turretMask),
    legalBuySlots: sumMask(mask.buySlotMask),
    legalSellSlots: sumMask(mask.sellSlotMask),
    totalActionTypes: mask.actionTypeMask.length,
  };
}

export function actionTypeNameFromIndex(index: number): string {
  return ML_ACTION_TYPES[index] ?? 'WAIT';
}

export function actionTypeIndexFromName(action: string): number {
  return getActionTypeIndex(action as any);
}
