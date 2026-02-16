import type { GameStateSnapshot } from '../AIBehavior';
import { MAX_TURRET_SLOTS } from '../../config/turrets';
import { ML_ACTION_TYPES, ML_TURRET_IDS, ML_UNIT_IDS, getActionTypeIndex, getTurretIndex, getUnitIndex, normalizeDiscreteIndex } from './actionCatalog';
import type { MLHistoryToken } from './historyBuffer';
import { countLegal, type MLLegalActionMask } from './legalActionMask';

const ACTION_LABELS = [...ML_ACTION_TYPES, 'INFERRED_DAMAGE', 'INFERRED_UNIT_DELTA'];
const ACTION_LABEL_TO_INDEX = new Map<string, number>(
  ACTION_LABELS.map((label, index) => [label, index])
);
const STATE_TOKEN_BUDGET = 112;

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

function averageShortfall(values: number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
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

function encodeCurrentStateTokens(state: GameStateSnapshot, maxTokens: number): number[][] {
  const tokens: number[][] = [];
  const width = Math.max(1, state.battlefieldWidth);
  const opponentBaseX = Number.isFinite(state.playerBaseX) ? state.playerBaseX : 0;
  const ownBaseX = Number.isFinite(state.enemyBaseX) ? state.enemyBaseX : width;
  const pushToken = (token: number[]) => {
    if (tokens.length >= maxTokens) return;
    tokens.push(token.map((value) => clamp(value, -1, 1)));
  };

  const ownUnits = [...state.enemyUnits]
    .sort((a, b) => Math.abs(a.position - opponentBaseX) - Math.abs(b.position - opponentBaseX))
    .slice(0, 32);
  const opponentUnits = [...state.playerUnits]
    .sort((a, b) => Math.abs(a.position - ownBaseX) - Math.abs(b.position - ownBaseX))
    .slice(0, 32);

  ownUnits.forEach((unit) => {
    pushToken([
      0.12,
      normalizeDiscreteIndex(getUnitIndex(unit.unitId), ML_UNIT_IDS.length),
      normalize(unit.health, Math.max(1, unit.maxHealth)),
      normalize(unit.damage, 400),
      normalize(unit.range, 60),
      normalize(unit.position, width),
      normalize(unit.laneY ?? 0, 20),
      normalize((unit.attackCooldownRemaining ?? 0) + (unit.skillCooldownRemaining ?? 0), 12),
    ]);
  });

  opponentUnits.forEach((unit) => {
    pushToken([
      0.24,
      normalizeDiscreteIndex(getUnitIndex(unit.unitId), ML_UNIT_IDS.length),
      normalize(unit.health, Math.max(1, unit.maxHealth)),
      normalize(unit.damage, 400),
      normalize(unit.range, 60),
      normalize(unit.position, width),
      normalize(unit.laneY ?? 0, 20),
      normalize((unit.attackCooldownRemaining ?? 0) + (unit.skillCooldownRemaining ?? 0), 12),
    ]);
  });

  const projectiles = state.projectiles ?? [];
  const ownProjectiles = projectiles.filter((projectile) => projectile.owner === 'SELF').slice(0, 16);
  const opponentProjectiles = projectiles.filter((projectile) => projectile.owner === 'OPPONENT').slice(0, 16);

  ownProjectiles.forEach((projectile) => {
    pushToken([
      0.36,
      projectile.hasDroneGuidance ? 0.75 : projectile.isFalling ? 0.5 : 0.25,
      normalize(projectile.damage, 600),
      normalize(projectile.splashRadius, 15),
      normalize(projectile.x, width),
      normalize(projectile.y, 20),
      normalize(projectile.vx, 80),
      normalize(projectile.lifeMs, 6000),
    ]);
  });

  opponentProjectiles.forEach((projectile) => {
    pushToken([
      0.48,
      projectile.hasDroneGuidance ? 0.75 : projectile.isFalling ? 0.5 : 0.25,
      normalize(projectile.damage, 600),
      normalize(projectile.splashRadius, 15),
      normalize(projectile.x, width),
      normalize(projectile.y, 20),
      normalize(projectile.vx, 80),
      normalize(projectile.lifeMs, 6000),
    ]);
  });

  const effects = state.activeAbilityEffects ?? [];
  const ownEffects = effects.filter((effect) => effect.owner === 'SELF').slice(0, 8);
  const opponentEffects = effects.filter((effect) => effect.owner === 'OPPONENT').slice(0, 8);
  const encodeEffectType = (type: string): number => {
    if (type === 'ability_cast') return 0.33;
    if (type === 'ability_impact') return 0.66;
    return 1.0;
  };

  ownEffects.forEach((effect) => {
    pushToken([
      0.60,
      encodeEffectType(effect.type),
      0,
      0,
      normalize(effect.x, width),
      normalize(effect.y, 20),
      normalize(effect.lifeMs, 2000),
      0,
    ]);
  });

  opponentEffects.forEach((effect) => {
    pushToken([
      0.72,
      encodeEffectType(effect.type),
      0,
      0,
      normalize(effect.x, width),
      normalize(effect.y, 20),
      normalize(effect.lifeMs, 2000),
      0,
    ]);
  });

  return tokens.slice(0, maxTokens);
}

function buildStaticStateVector(state: GameStateSnapshot, actionMask: MLLegalActionMask): number[] {
  const width = Math.max(1, state.battlefieldWidth);
  const opponentBaseX = Number.isFinite(state.playerBaseX) ? state.playerBaseX : 0;
  const ownBaseX = Number.isFinite(state.enemyBaseX) ? state.enemyBaseX : width;
  const playerUnitHealth = state.playerUnits.map((unit) => unit.health);
  const enemyUnitHealth = state.enemyUnits.map((unit) => unit.health);
  const playerUnitDamage = state.playerUnits.map((unit) => unit.damage);
  const enemyUnitDamage = state.enemyUnits.map((unit) => unit.damage);
  const playerUnitRange = state.playerUnits.map((unit) => unit.range);
  const enemyUnitRange = state.enemyUnits.map((unit) => unit.range);
  const playerUnitPositions = state.playerUnits.map((unit) => unit.position);
  const enemyUnitPositions = state.enemyUnits.map((unit) => unit.position);
  const playerUnitCooldown = state.playerUnits.map((unit) => unit.attackCooldownRemaining ?? 0);
  const enemyUnitCooldown = state.enemyUnits.map((unit) => unit.attackCooldownRemaining ?? 0);
  const playerSkillCooldown = state.playerUnits.map((unit) => unit.skillCooldownRemaining ?? 0);
  const enemySkillCooldown = state.enemyUnits.map((unit) => unit.skillCooldownRemaining ?? 0);

  const playerTotalUnitHealth = sum(playerUnitHealth);
  const enemyTotalUnitHealth = sum(enemyUnitHealth);
  const playerTotalUnitDamage = sum(playerUnitDamage);
  const enemyTotalUnitDamage = sum(enemyUnitDamage);

  const projectileState = state.projectiles ?? [];
  const ownProjectiles = projectileState.filter((projectile) => projectile.owner === 'SELF');
  const opponentProjectiles = projectileState.filter((projectile) => projectile.owner === 'OPPONENT');
  const ownProjectileDamage = sum(ownProjectiles.map((projectile) => projectile.damage));
  const opponentProjectileDamage = sum(opponentProjectiles.map((projectile) => projectile.damage));
  const ownProjectileNearEnemyBase = ownProjectiles.filter(
    (projectile) => Math.abs(projectile.x - opponentBaseX) < 15
  ).length;
  const opponentProjectileNearOwnBase = opponentProjectiles.filter(
    (projectile) => Math.abs(projectile.x - ownBaseX) < 15
  ).length;
  const ownProjectileSplash = ownProjectiles.filter((projectile) => projectile.splashRadius > 0).length;
  const opponentProjectileSplash = opponentProjectiles.filter((projectile) => projectile.splashRadius > 0).length;
  const ownProjectileFalling = ownProjectiles.filter((projectile) => projectile.isFalling).length;
  const opponentProjectileFalling = opponentProjectiles.filter((projectile) => projectile.isFalling).length;
  const ownProjectileDrone = ownProjectiles.filter((projectile) => projectile.hasDroneGuidance).length;
  const opponentProjectileDrone = opponentProjectiles.filter((projectile) => projectile.hasDroneGuidance).length;
  const ownProjectileLife = mean(ownProjectiles.map((projectile) => projectile.lifeMs));
  const opponentProjectileLife = mean(opponentProjectiles.map((projectile) => projectile.lifeMs));

  const abilityEffects = state.activeAbilityEffects ?? [];
  const ownAbilityEffects = abilityEffects.filter((effect) => effect.owner === 'SELF');
  const opponentAbilityEffects = abilityEffects.filter((effect) => effect.owner === 'OPPONENT');
  const ownAbilityCast = ownAbilityEffects.filter((effect) => effect.type === 'ability_cast').length;
  const opponentAbilityCast = opponentAbilityEffects.filter((effect) => effect.type === 'ability_cast').length;
  const ownAbilityImpact = ownAbilityEffects.filter((effect) => effect.type === 'ability_impact').length;
  const opponentAbilityImpact = opponentAbilityEffects.filter((effect) => effect.type === 'ability_impact').length;
  const ownFlamethrowerEffects = ownAbilityEffects.filter((effect) => effect.type === 'flamethrower').length;
  const opponentFlamethrowerEffects = opponentAbilityEffects.filter((effect) => effect.type === 'flamethrower').length;

  const unitDiag = state.unitCatalogDiagnostics ?? [];
  const turretDiag = state.turretCatalogDiagnostics ?? [];
  const summary = state.actionConstraintSummary;
  const legalUnits = summary?.legalUnits ?? unitDiag.filter((item) => item.legalNow).length;
  const legalTurrets = summary?.legalTurrets ?? turretDiag.filter((item) => item.legalNow).length;
  const unitBlockedByAge = summary?.unitBlockedByAge ?? unitDiag.filter((item) => item.ageLocked).length;
  const unitBlockedByGold =
    summary?.unitBlockedByGold ??
    unitDiag.filter((item) => !item.ageLocked && item.goldShortfall > 0).length;
  const unitBlockedByMana =
    summary?.unitBlockedByMana ??
    unitDiag.filter((item) => !item.ageLocked && item.manaShortfall > 0).length;
  const unitBlockedByQueue =
    summary?.unitBlockedByQueue ??
    unitDiag.filter((item) => !item.ageLocked && item.queueBlocked).length;
  const turretBlockedByAge = summary?.turretBlockedByAge ?? turretDiag.filter((item) => item.ageLocked).length;
  const turretBlockedByGold =
    summary?.turretBlockedByGold ??
    turretDiag.filter((item) => !item.ageLocked && item.goldShortfall > 0).length;
  const turretBlockedByMana =
    summary?.turretBlockedByMana ??
    turretDiag.filter((item) => !item.ageLocked && item.manaShortfall > 0).length;
  const turretBlockedBySlot =
    summary?.turretBlockedBySlot ??
    turretDiag.filter((item) => !item.ageLocked && item.slotBlocked).length;
  const turretBlockedByQueue =
    summary?.turretBlockedByQueue ??
    turretDiag.filter((item) => !item.ageLocked && item.queueBlocked).length;

  const avgUnitGoldShortfall = averageShortfall(unitDiag.map((item) => item.goldShortfall));
  const avgUnitManaShortfall = averageShortfall(unitDiag.map((item) => item.manaShortfall));
  const avgTurretGoldShortfall = averageShortfall(turretDiag.map((item) => item.goldShortfall));
  const avgTurretManaShortfall = averageShortfall(turretDiag.map((item) => item.manaShortfall));
  const maxUnitPower = unitDiag.length > 0 ? Math.max(...unitDiag.map((item) => item.scorePower)) : 0;
  const avgAffordableUnitPower = mean(unitDiag.filter((item) => item.legalNow).map((item) => item.scorePower));
  const maxTurretPower = turretDiag.length > 0 ? Math.max(...turretDiag.map((item) => item.scorePower)) : 0;
  const avgAffordableTurretPower = mean(
    turretDiag.filter((item) => item.legalNow).map((item) => item.scorePower)
  );

  const legalActionTypes = countLegal(actionMask.actionTypeMask);
  const legalBuySlots = countLegal(actionMask.buySlotMask);
  const legalSellSlots = countLegal(actionMask.sellSlotMask);

  return [
    // Provide relative age progression timing (instead of absolute clock/tick).
    normalize(state.enemyTimeSinceLastAgeUp ?? 0, 1800),
    normalize(state.playerTimeSinceLastAgeUp ?? 0, 1800),
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
    normalize(mean(enemyUnitPositions), Math.max(1, state.battlefieldWidth)),
    normalize(mean(playerUnitPositions), Math.max(1, state.battlefieldWidth)),
    normalize(mean(enemyUnitCooldown), 3),
    normalize(mean(playerUnitCooldown), 3),
    normalize(mean(enemySkillCooldown), 8),
    normalize(mean(playerSkillCooldown), 8),
    normalize(ownProjectiles.length, 80),
    normalize(opponentProjectiles.length, 80),
    normalize(ownProjectileDamage, 2500),
    normalize(opponentProjectileDamage, 2500),
    normalize(ownProjectileNearEnemyBase, 30),
    normalize(opponentProjectileNearOwnBase, 30),
    normalize(ownProjectileSplash, 40),
    normalize(opponentProjectileSplash, 40),
    normalize(ownProjectileFalling, 40),
    normalize(opponentProjectileFalling, 40),
    normalize(ownProjectileDrone, 20),
    normalize(opponentProjectileDrone, 20),
    normalize(ownProjectileLife, 6000),
    normalize(opponentProjectileLife, 6000),
    normalize(ownAbilityEffects.length, 80),
    normalize(opponentAbilityEffects.length, 80),
    normalize(ownAbilityCast, 40),
    normalize(opponentAbilityCast, 40),
    normalize(ownAbilityImpact, 40),
    normalize(opponentAbilityImpact, 40),
    normalize(ownFlamethrowerEffects, 20),
    normalize(opponentFlamethrowerEffects, 20),
    normalize(legalActionTypes, ML_ACTION_TYPES.length),
    normalize(legalUnits, Math.max(1, ML_UNIT_IDS.length)),
    normalize(legalTurrets, Math.max(1, ML_TURRET_IDS.length)),
    normalize(legalBuySlots, Math.max(1, MAX_TURRET_SLOTS)),
    normalize(legalSellSlots, Math.max(1, MAX_TURRET_SLOTS)),
    normalize(unitBlockedByAge, Math.max(1, ML_UNIT_IDS.length)),
    normalize(unitBlockedByGold, Math.max(1, ML_UNIT_IDS.length)),
    normalize(unitBlockedByMana, Math.max(1, ML_UNIT_IDS.length)),
    normalize(unitBlockedByQueue, Math.max(1, ML_UNIT_IDS.length)),
    normalize(turretBlockedByAge, Math.max(1, ML_TURRET_IDS.length)),
    normalize(turretBlockedByGold, Math.max(1, ML_TURRET_IDS.length)),
    normalize(turretBlockedByMana, Math.max(1, ML_TURRET_IDS.length)),
    normalize(turretBlockedBySlot, Math.max(1, ML_TURRET_IDS.length)),
    normalize(turretBlockedByQueue, Math.max(1, ML_TURRET_IDS.length)),
    normalize(avgUnitGoldShortfall, 1500),
    normalize(avgUnitManaShortfall, 800),
    normalize(avgTurretGoldShortfall, 2000),
    normalize(avgTurretManaShortfall, 800),
    normalize(maxUnitPower, 4000),
    normalize(avgAffordableUnitPower, 4000),
    normalize(maxTurretPower, 800),
    normalize(avgAffordableTurretPower, 800),
  ];
}

export function encodeObservation(
  state: GameStateSnapshot,
  historyTokens: MLHistoryToken[],
  actionMask: MLLegalActionMask,
  config: ObservationEncoderConfig = {}
): EncodedMLObservation {
  const sequenceLength = config.sequenceLength ?? 240;
  const stateTokenBudget = Math.max(0, Math.min(sequenceLength, STATE_TOKEN_BUDGET));
  const stateTokens = encodeCurrentStateTokens(state, stateTokenBudget);
  const historyBudget = Math.max(0, sequenceLength - stateTokens.length);
  const encodedTokens = historyTokens.slice(-historyBudget).map(encodeHistoryToken);
  const tokenFeatureSize = 8;
  const zeroToken = new Array<number>(tokenFeatureSize).fill(0);
  const paddedSequence = [
    ...Array.from({ length: Math.max(0, historyBudget - encodedTokens.length) }, () => [...zeroToken]),
    ...encodedTokens,
    ...stateTokens,
  ];
  const staticState = buildStaticStateVector(state, actionMask);

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
