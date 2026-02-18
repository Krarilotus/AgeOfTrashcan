import type { GameStateSnapshot } from '../AIBehavior';
import { MAX_TURRET_SLOTS } from '../../config/turrets';
import { UNIT_DEFS } from '../../config/units';
import { ML_ACTION_TYPES, ML_TURRET_IDS, ML_UNIT_IDS, getActionTypeIndex, getTurretIndex, getUnitIndex, normalizeDiscreteIndex } from './actionCatalog';
import type { MLHistoryToken } from './historyBuffer';
import { countLegal, type MLLegalActionMask } from './legalActionMask';

const ACTION_LABELS = [...ML_ACTION_TYPES, 'INFERRED_DAMAGE', 'INFERRED_UNIT_DELTA'];
const TOKEN_FEATURE_SIZE = 12;
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
  minHistoryTokens?: number;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function normalize(value: number, scale: number): number {
  if (scale <= 0) return 0;
  return clamp(value / scale, -1, 1);
}

function meanFromTotal(total: number, count: number): number {
  if (count <= 0) return 0;
  return total / count;
}

function encodeAbilityType(type: string | undefined): number {
  if (type === 'direct') return 0.2;
  if (type === 'aoe') return 0.4;
  if (type === 'flamethrower') return 0.6;
  if (type === 'heal') return 0.8;
  return 0;
}

function estimateMandatoryStateTokenCount(state: GameStateSnapshot): number {
  const ownTurretSlots = Math.max(0, Math.min(MAX_TURRET_SLOTS, state.enemyTurretSlotsUnlocked));
  const opponentTurretSlots = Math.max(0, Math.min(MAX_TURRET_SLOTS, state.playerTurretSlotsUnlocked));
  const presentUnits = Math.max(0, state.enemyUnits.length) + Math.max(0, state.playerUnits.length);
  const availableUnits = ML_UNIT_IDS.reduce((total, unitId) => {
    const unit = UNIT_DEFS[unitId];
    if (!unit) return total;
    return (unit.age ?? 1) <= state.enemyAge ? total + 1 : total;
  }, 0);

  // 3 catalog tokens per unlocked unit:
  // - recruit stats + affordability
  // - skill payload
  // - special ability payload
  return ownTurretSlots + opponentTurretSlots + presentUnits + availableUnits * 3;
}

function encodeHistoryToken(token: MLHistoryToken): number[] {
  const actorNorm =
    token.actor === 'PLAYER' ? 1 / 3 : token.actor === 'ENEMY' ? 2 / 3 : 1;
  const actionIndex = ACTION_LABEL_TO_INDEX.get(token.actionLabel) ?? -1;
  const unitAction = token.actionLabel === 'RECRUIT_UNIT' ? 1 : 0;
  const turretAction =
    token.actionLabel === 'BUY_TURRET_ENGINE' || token.actionLabel === 'SELL_TURRET_ENGINE' ? 1 : 0;
  const systemActor = token.actor === 'SYSTEM' ? 1 : 0;

  return [
    actorNorm,
    normalizeDiscreteIndex(actionIndex, ACTION_LABELS.length),
    normalizeDiscreteIndex(getUnitIndex(token.unitId), ML_UNIT_IDS.length),
    normalizeDiscreteIndex(getTurretIndex(token.turretId), ML_TURRET_IDS.length),
    normalizeDiscreteIndex(token.slotIndex ?? -1, MAX_TURRET_SLOTS),
    normalize(token.deltaSec, 2),
    normalize(token.rewardDelta, 10),
    normalize(token.damageDelta, 600),
    normalize(token.timestampSec, 3600),
    unitAction,
    turretAction,
    systemActor,
  ];
}

function encodeCurrentStateTokens(state: GameStateSnapshot, maxTokens: number): number[][] {
  const tokens: number[][] = [];
  const width = Math.max(1, state.battlefieldWidth);
  const opponentBaseX = Number.isFinite(state.playerBaseX) ? state.playerBaseX : 0;
  const ownBaseX = Number.isFinite(state.enemyBaseX) ? state.enemyBaseX : width;
  const unitDiagById = new Map((state.unitCatalogDiagnostics ?? []).map((item) => [item.unitId, item]));
  const availableUnitIds = ML_UNIT_IDS.filter((unitId) => {
    const def = UNIT_DEFS[unitId];
    if (!def) return false;
    return (def.age ?? 1) <= state.enemyAge;
  });
  const pushToken = (token: number[]): boolean => {
    if (tokens.length >= maxTokens) return false;
    const clamped = new Array<number>(token.length);
    for (let i = 0; i < token.length; i += 1) {
      clamped[i] = clamp(token[i], -1, 1);
    }
    tokens.push(clamped);
    return true;
  };
  const pushTokenLimited = <T>(
    items: T[],
    limit: number,
    encode: (item: T, index: number) => number[]
  ): void => {
    if (limit <= 0) return;
    const capped = Math.min(items.length, limit);
    for (let i = 0; i < capped; i += 1) {
      if (!pushToken(encode(items[i], i))) break;
    }
  };

  const ownTurretSlots = (state.enemyTurretSlots ?? []).slice(
    0,
    Math.max(0, Math.min(MAX_TURRET_SLOTS, state.enemyTurretSlotsUnlocked))
  );
  const opponentTurretSlots = (state.playerTurretSlots ?? []).slice(
    0,
    Math.max(0, Math.min(MAX_TURRET_SLOTS, state.playerTurretSlotsUnlocked))
  );

  // Always encode active turret slot state first so engine IDs/cooldowns are never dropped.
  ownTurretSlots.forEach((slot, slotOrdinal) => {
    pushToken([
      0.84,
      normalizeDiscreteIndex(getTurretIndex(slot.turretId ?? undefined), ML_TURRET_IDS.length),
      normalizeDiscreteIndex(slot.slotIndex ?? slotOrdinal, MAX_TURRET_SLOTS),
      slot.turretId ? 1 : 0,
      normalize(slot.cooldownRemaining ?? 0, 20),
      normalize(state.enemyTurretLevel, 6),
      normalize(state.enemyTurretProtectionMultiplier, 1),
      normalize(state.enemyTurretDps, 600),
      normalize(state.enemyTurretMaxRange, 60),
      normalize(state.enemyTurretAvgRange, 60),
      normalize(state.enemyTurretInstalledCount, MAX_TURRET_SLOTS),
      normalize(state.enemyTurretSlotsUnlocked, MAX_TURRET_SLOTS),
    ]);
  });

  opponentTurretSlots.forEach((slot, slotOrdinal) => {
    pushToken([
      0.96,
      normalizeDiscreteIndex(getTurretIndex(slot.turretId ?? undefined), ML_TURRET_IDS.length),
      normalizeDiscreteIndex(slot.slotIndex ?? slotOrdinal, MAX_TURRET_SLOTS),
      slot.turretId ? 1 : 0,
      normalize(slot.cooldownRemaining ?? 0, 20),
      normalize(state.playerTurretLevel, 6),
      normalize(state.playerTurretProtectionMultiplier, 1),
      normalize(state.playerTurretDps, 600),
      normalize(state.playerTurretMaxRange, 60),
      normalize(state.playerTurretAvgRange, 60),
      normalize(state.playerTurretInstalledCount, MAX_TURRET_SLOTS),
      normalize(state.playerTurretSlotsUnlocked, MAX_TURRET_SLOTS),
    ]);
  });

  const ownUnits = [...state.enemyUnits]
    .sort((a, b) => Math.abs(a.position - opponentBaseX) - Math.abs(b.position - opponentBaseX));
  const opponentUnits = [...state.playerUnits]
    .sort((a, b) => Math.abs(a.position - ownBaseX) - Math.abs(b.position - ownBaseX));

  ownUnits.forEach((unit) => {
    pushToken([
      0.12,
      normalizeDiscreteIndex(getUnitIndex(unit.unitId), ML_UNIT_IDS.length),
      normalize(unit.health, Math.max(1, unit.maxHealth)),
      normalize(unit.damage, 400),
      normalize(unit.range, 60),
      normalize(unit.position, width),
      normalize(unit.laneY ?? 0, 20),
      normalize(unit.attackCooldownRemaining ?? 0, 6),
      normalize(unit.skillCooldownRemaining ?? 0, 12),
      normalize(unit.speed ?? 12, 30),
      normalize(unit.maxHealth, 2500),
      (unit.skillCooldownRemaining ?? 0) <= 0 ? 1 : 0,
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
      normalize(unit.attackCooldownRemaining ?? 0, 6),
      normalize(unit.skillCooldownRemaining ?? 0, 12),
      normalize(unit.speed ?? 12, 30),
      normalize(unit.maxHealth, 2500),
      (unit.skillCooldownRemaining ?? 0) <= 0 ? 1 : 0,
    ]);
  });

  // Explicit per-unit-option catalog tokens so policy receives full buy-option stats/abilities,
  // not only aggregated availability counters.
  availableUnitIds.forEach((unitId) => {
    const def = UNIT_DEFS[unitId];
    if (!def) return;
    const diag = unitDiagById.get(unitId);
    const manaCost = def.manaCost ?? 0;
    const skill = def.skill;

    // Unit recruit token: raw recruit stats + affordability blockers.
    pushToken([
      0.88,
      normalizeDiscreteIndex(getUnitIndex(unitId), ML_UNIT_IDS.length),
      diag?.legalNow ? 1 : 0,
      normalize(diag?.goldCost ?? def.cost, 1500),
      normalize(diag?.manaCost ?? manaCost, 800),
      normalize(diag?.goldShortfall ?? Math.max(0, (diag?.goldCost ?? def.cost) - state.enemyGold), 1500),
      normalize(diag?.manaShortfall ?? Math.max(0, (diag?.manaCost ?? manaCost) - state.enemyMana), 800),
      normalize(def.health, 2500),
      normalize(def.damage, 400),
      normalize(def.range ?? 1, 60),
      normalize(def.speed, 30),
      encodeAbilityType(skill?.type),
    ]);

    // Skill payload token.
    pushToken([
      0.89,
      normalizeDiscreteIndex(getUnitIndex(unitId), ML_UNIT_IDS.length),
      encodeAbilityType(skill?.type),
      normalize(skill?.manaCost ?? 0, 250),
      normalize(skill?.cooldownMs ?? 0, 30000),
      normalize(skill?.power ?? 0, 1000),
      normalize(skill?.damage ?? 0, 1000),
      normalize(skill?.radius ?? 0, 50),
      normalize(skill?.range ?? 0, 80),
      normalize(diag?.scorePower ?? 0, 4000),
      skill ? 1 : 0,
      def.manaShield ? 1 : 0,
    ]);

    // Special ability payload token (burst, teleporter, mana leech).
    pushToken([
      0.90,
      normalizeDiscreteIndex(getUnitIndex(unitId), ML_UNIT_IDS.length),
      normalize(def.burstFire?.shots ?? 0, 64),
      normalize(def.burstFire?.burstCooldown ?? 0, 10000),
      normalize(def.teleporter?.damageReduction ?? 0, 1),
      normalize(def.teleporter?.healPerSecond ?? 0, 100),
      normalize(def.teleporter?.manaPerAttack ?? 0, 100),
      normalize(def.teleporter?.attackCooldown ?? 0, 10000),
      def.teleporter?.canAttackBase ? 1 : 0,
      normalize(def.manaLeech ?? 0, 1),
      normalize(def.trainingMs ?? 0, 12000),
      normalize(def.visualScale ?? 1, 4),
    ]);
  });

  const projectiles = state.projectiles ?? [];
  const ownProjectiles: typeof projectiles = [];
  const opponentProjectiles: typeof projectiles = [];
  for (const projectile of projectiles) {
    if (projectile.owner === 'SELF') ownProjectiles.push(projectile);
    else if (projectile.owner === 'OPPONENT') opponentProjectiles.push(projectile);
  }

  const effects = state.activeAbilityEffects ?? [];
  const ownEffects: typeof effects = [];
  const opponentEffects: typeof effects = [];
  for (const effect of effects) {
    if (effect.owner === 'SELF') ownEffects.push(effect);
    else if (effect.owner === 'OPPONENT') opponentEffects.push(effect);
  }
  const encodeEffectType = (type: string): number => {
    if (type === 'ability_cast') return 0.33;
    if (type === 'ability_impact') return 0.66;
    return 1.0;
  };

  const remainingBudget = Math.max(0, maxTokens - tokens.length);
  const perGroupBudget = Math.max(0, Math.floor(remainingBudget / 4));
  const leftoverBudget = Math.max(0, remainingBudget - perGroupBudget * 4);

  pushTokenLimited(ownProjectiles, perGroupBudget + leftoverBudget, (projectile) => {
    const targetY = (projectile as { targetY?: number }).targetY ?? 0;
    const remainingPierces = (projectile as { remainingPierces?: number }).remainingPierces ?? 0;
    return [
      0.36,
      projectile.hasDroneGuidance ? 0.75 : projectile.isFalling ? 0.5 : 0.25,
      normalize(projectile.damage, 600),
      normalize(projectile.splashRadius, 15),
      normalize(projectile.x, width),
      normalize(projectile.y, 20),
      normalize(projectile.vx, 80),
      normalize(projectile.lifeMs, 6000),
      normalize(projectile.vy, 80),
      normalize(targetY, 20),
      normalize(remainingPierces, 5),
      0,
    ];
  });

  pushTokenLimited(opponentProjectiles, perGroupBudget, (projectile) => {
    const targetY = (projectile as { targetY?: number }).targetY ?? 0;
    const remainingPierces = (projectile as { remainingPierces?: number }).remainingPierces ?? 0;
    return [
      0.48,
      projectile.hasDroneGuidance ? 0.75 : projectile.isFalling ? 0.5 : 0.25,
      normalize(projectile.damage, 600),
      normalize(projectile.splashRadius, 15),
      normalize(projectile.x, width),
      normalize(projectile.y, 20),
      normalize(projectile.vx, 80),
      normalize(projectile.lifeMs, 6000),
      normalize(projectile.vy, 80),
      normalize(targetY, 20),
      normalize(remainingPierces, 5),
      0,
    ];
  });

  pushTokenLimited(ownEffects, perGroupBudget, (effect) => [
    0.60,
    encodeEffectType(effect.type),
    0,
    0,
    normalize(effect.x, width),
    normalize(effect.y, 20),
    normalize(effect.lifeMs, 2000),
    0,
    0,
    0,
    0,
    0,
  ]);

  pushTokenLimited(opponentEffects, perGroupBudget, (effect) => [
    0.72,
    encodeEffectType(effect.type),
    0,
    0,
    normalize(effect.x, width),
    normalize(effect.y, 20),
    normalize(effect.lifeMs, 2000),
    0,
    0,
    0,
    0,
    0,
  ]);

  return tokens;
}

function buildStaticStateVector(state: GameStateSnapshot, actionMask: MLLegalActionMask): number[] {
  const width = Math.max(1, state.battlefieldWidth);
  const opponentBaseX = Number.isFinite(state.playerBaseX) ? state.playerBaseX : 0;
  const ownBaseX = Number.isFinite(state.enemyBaseX) ? state.enemyBaseX : width;
  let playerUnitCount = 0;
  let playerTotalUnitHealth = 0;
  let playerTotalUnitDamage = 0;
  let playerTotalUnitRange = 0;
  let playerTotalUnitPosition = 0;
  let playerTotalUnitCooldown = 0;
  let playerTotalSkillCooldown = 0;
  for (const unit of state.playerUnits) {
    playerUnitCount += 1;
    playerTotalUnitHealth += unit.health;
    playerTotalUnitDamage += unit.damage;
    playerTotalUnitRange += unit.range;
    playerTotalUnitPosition += unit.position;
    playerTotalUnitCooldown += unit.attackCooldownRemaining ?? 0;
    playerTotalSkillCooldown += unit.skillCooldownRemaining ?? 0;
  }

  let enemyUnitCount = 0;
  let enemyTotalUnitHealth = 0;
  let enemyTotalUnitDamage = 0;
  let enemyTotalUnitRange = 0;
  let enemyTotalUnitPosition = 0;
  let enemyTotalUnitCooldown = 0;
  let enemyTotalSkillCooldown = 0;
  for (const unit of state.enemyUnits) {
    enemyUnitCount += 1;
    enemyTotalUnitHealth += unit.health;
    enemyTotalUnitDamage += unit.damage;
    enemyTotalUnitRange += unit.range;
    enemyTotalUnitPosition += unit.position;
    enemyTotalUnitCooldown += unit.attackCooldownRemaining ?? 0;
    enemyTotalSkillCooldown += unit.skillCooldownRemaining ?? 0;
  }

  const projectileState = state.projectiles ?? [];
  let ownProjectileCount = 0;
  let ownProjectileDamage = 0;
  let ownProjectileNearEnemyBase = 0;
  let ownProjectileSplash = 0;
  let ownProjectileFalling = 0;
  let ownProjectileDrone = 0;
  let ownProjectileLifeTotal = 0;
  let opponentProjectileCount = 0;
  let opponentProjectileDamage = 0;
  let opponentProjectileNearOwnBase = 0;
  let opponentProjectileSplash = 0;
  let opponentProjectileFalling = 0;
  let opponentProjectileDrone = 0;
  let opponentProjectileLifeTotal = 0;
  for (const projectile of projectileState) {
    if (projectile.owner === 'SELF') {
      ownProjectileCount += 1;
      ownProjectileDamage += projectile.damage;
      ownProjectileLifeTotal += projectile.lifeMs;
      if (Math.abs(projectile.x - opponentBaseX) < 15) ownProjectileNearEnemyBase += 1;
      if (projectile.splashRadius > 0) ownProjectileSplash += 1;
      if (projectile.isFalling) ownProjectileFalling += 1;
      if (projectile.hasDroneGuidance) ownProjectileDrone += 1;
    } else if (projectile.owner === 'OPPONENT') {
      opponentProjectileCount += 1;
      opponentProjectileDamage += projectile.damage;
      opponentProjectileLifeTotal += projectile.lifeMs;
      if (Math.abs(projectile.x - ownBaseX) < 15) opponentProjectileNearOwnBase += 1;
      if (projectile.splashRadius > 0) opponentProjectileSplash += 1;
      if (projectile.isFalling) opponentProjectileFalling += 1;
      if (projectile.hasDroneGuidance) opponentProjectileDrone += 1;
    }
  }
  const ownProjectileLife = meanFromTotal(ownProjectileLifeTotal, ownProjectileCount);
  const opponentProjectileLife = meanFromTotal(opponentProjectileLifeTotal, opponentProjectileCount);

  const abilityEffects = state.activeAbilityEffects ?? [];
  let ownAbilityEffectsCount = 0;
  let opponentAbilityEffectsCount = 0;
  let ownAbilityCast = 0;
  let opponentAbilityCast = 0;
  let ownAbilityImpact = 0;
  let opponentAbilityImpact = 0;
  let ownFlamethrowerEffects = 0;
  let opponentFlamethrowerEffects = 0;
  for (const effect of abilityEffects) {
    const isOwn = effect.owner === 'SELF';
    if (isOwn) ownAbilityEffectsCount += 1;
    else if (effect.owner === 'OPPONENT') opponentAbilityEffectsCount += 1;
    else continue;
    if (effect.type === 'ability_cast') {
      if (isOwn) ownAbilityCast += 1;
      else opponentAbilityCast += 1;
    } else if (effect.type === 'ability_impact') {
      if (isOwn) ownAbilityImpact += 1;
      else opponentAbilityImpact += 1;
    } else if (effect.type === 'flamethrower') {
      if (isOwn) ownFlamethrowerEffects += 1;
      else opponentFlamethrowerEffects += 1;
    }
  }

  const unitDiag = state.unitCatalogDiagnostics ?? [];
  const turretDiag = state.turretCatalogDiagnostics ?? [];
  const summary = state.actionConstraintSummary;

  let diagLegalUnits = 0;
  let diagUnitBlockedByAge = 0;
  let diagUnitBlockedByGold = 0;
  let diagUnitBlockedByMana = 0;
  let diagUnitBlockedByQueue = 0;
  let diagUnitBlockedByCap = 0;
  let unitGoldShortfallTotal = 0;
  let unitManaShortfallTotal = 0;
  let maxUnitPower = 0;
  let affordableUnitPowerTotal = 0;
  let affordableUnitCount = 0;
  for (const item of unitDiag) {
    unitGoldShortfallTotal += item.goldShortfall;
    unitManaShortfallTotal += item.manaShortfall;
    if (item.scorePower > maxUnitPower) maxUnitPower = item.scorePower;
    if (item.legalNow) {
      diagLegalUnits += 1;
      affordableUnitPowerTotal += item.scorePower;
      affordableUnitCount += 1;
    }
    if (item.ageLocked) diagUnitBlockedByAge += 1;
    if (!item.ageLocked && item.goldShortfall > 0) diagUnitBlockedByGold += 1;
    if (!item.ageLocked && item.manaShortfall > 0) diagUnitBlockedByMana += 1;
    if (!item.ageLocked && item.queueBlocked) diagUnitBlockedByQueue += 1;
    if (!item.ageLocked && item.capBlocked) diagUnitBlockedByCap += 1;
  }
  const avgUnitGoldShortfall = meanFromTotal(unitGoldShortfallTotal, unitDiag.length);
  const avgUnitManaShortfall = meanFromTotal(unitManaShortfallTotal, unitDiag.length);
  const avgAffordableUnitPower = meanFromTotal(affordableUnitPowerTotal, affordableUnitCount);

  let diagLegalTurrets = 0;
  let diagTurretBlockedByAge = 0;
  let diagTurretBlockedByGold = 0;
  let diagTurretBlockedByMana = 0;
  let diagTurretBlockedBySlot = 0;
  let diagTurretBlockedByQueue = 0;
  let turretGoldShortfallTotal = 0;
  let turretManaShortfallTotal = 0;
  let maxTurretPower = 0;
  let affordableTurretPowerTotal = 0;
  let affordableTurretCount = 0;
  for (const item of turretDiag) {
    turretGoldShortfallTotal += item.goldShortfall;
    turretManaShortfallTotal += item.manaShortfall;
    if (item.scorePower > maxTurretPower) maxTurretPower = item.scorePower;
    if (item.legalNow) {
      diagLegalTurrets += 1;
      affordableTurretPowerTotal += item.scorePower;
      affordableTurretCount += 1;
    }
    if (item.ageLocked) diagTurretBlockedByAge += 1;
    if (!item.ageLocked && item.goldShortfall > 0) diagTurretBlockedByGold += 1;
    if (!item.ageLocked && item.manaShortfall > 0) diagTurretBlockedByMana += 1;
    if (!item.ageLocked && item.slotBlocked) diagTurretBlockedBySlot += 1;
    if (!item.ageLocked && item.queueBlocked) diagTurretBlockedByQueue += 1;
  }
  const avgTurretGoldShortfall = meanFromTotal(turretGoldShortfallTotal, turretDiag.length);
  const avgTurretManaShortfall = meanFromTotal(turretManaShortfallTotal, turretDiag.length);
  const avgAffordableTurretPower = meanFromTotal(affordableTurretPowerTotal, affordableTurretCount);

  const legalUnits = summary?.legalUnits ?? diagLegalUnits;
  const legalTurrets = summary?.legalTurrets ?? diagLegalTurrets;
  const unitBlockedByAge = summary?.unitBlockedByAge ?? diagUnitBlockedByAge;
  const unitBlockedByGold = summary?.unitBlockedByGold ?? diagUnitBlockedByGold;
  const unitBlockedByMana = summary?.unitBlockedByMana ?? diagUnitBlockedByMana;
  const unitBlockedByQueue = summary?.unitBlockedByQueue ?? diagUnitBlockedByQueue;
  const unitBlockedByCap = summary?.unitBlockedByCap ?? diagUnitBlockedByCap;
  const turretBlockedByAge = summary?.turretBlockedByAge ?? diagTurretBlockedByAge;
  const turretBlockedByGold = summary?.turretBlockedByGold ?? diagTurretBlockedByGold;
  const turretBlockedByMana = summary?.turretBlockedByMana ?? diagTurretBlockedByMana;
  const turretBlockedBySlot = summary?.turretBlockedBySlot ?? diagTurretBlockedBySlot;
  const turretBlockedByQueue = summary?.turretBlockedByQueue ?? diagTurretBlockedByQueue;

  const enemyMeanUnitHealth = meanFromTotal(enemyTotalUnitHealth, enemyUnitCount);
  const playerMeanUnitHealth = meanFromTotal(playerTotalUnitHealth, playerUnitCount);
  const enemyMeanUnitDamage = meanFromTotal(enemyTotalUnitDamage, enemyUnitCount);
  const playerMeanUnitDamage = meanFromTotal(playerTotalUnitDamage, playerUnitCount);
  const enemyMeanUnitRange = meanFromTotal(enemyTotalUnitRange, enemyUnitCount);
  const playerMeanUnitRange = meanFromTotal(playerTotalUnitRange, playerUnitCount);
  const enemyMeanUnitPosition = meanFromTotal(enemyTotalUnitPosition, enemyUnitCount);
  const playerMeanUnitPosition = meanFromTotal(playerTotalUnitPosition, playerUnitCount);
  const enemyMeanUnitCooldown = meanFromTotal(enemyTotalUnitCooldown, enemyUnitCount);
  const playerMeanUnitCooldown = meanFromTotal(playerTotalUnitCooldown, playerUnitCount);
  const enemyMeanSkillCooldown = meanFromTotal(enemyTotalSkillCooldown, enemyUnitCount);
  const playerMeanSkillCooldown = meanFromTotal(playerTotalSkillCooldown, playerUnitCount);

  const legalActionTypes = countLegal(actionMask.actionTypeMask);
  const legalBuySlots = countLegal(actionMask.buySlotMask);
  const legalSellSlots = countLegal(actionMask.sellSlotMask);
  const queueRemaining = summary?.queueRemaining ?? Math.max(0, 10 - state.enemyQueueSize);
  const emptyUnlockedTurretSlots =
    summary?.emptyUnlockedTurretSlots ??
    Math.max(0, state.enemyTurretSlotsUnlocked - state.enemyTurretInstalledCount);

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
    normalize(state.enemyAgeCost, 30000),
    normalize(state.playerAgeCost, 30000),
    normalize(state.enemyAgeManaCost, 3000),
    normalize(state.playerAgeManaCost, 3000),
    normalize(state.enemyAgeRequirementsMet ? 1 : 0, 1),
    normalize(state.playerAgeRequirementsMet ? 1 : 0, 1),
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
    normalize(state.enemyTurretLevel, 6),
    normalize(state.playerTurretLevel, 6),
    normalize(state.enemyUnitCount, 40),
    normalize(state.playerUnitCount, 40),
    normalize(state.enemyUnitCount - state.playerUnitCount, 40),
    normalize(state.enemyUnitCap, 100),
    normalize(state.playerUnitCap, 100),
    normalize(state.enemyUnitCapReached ? 1 : 0, 1),
    normalize(state.playerUnitCapReached ? 1 : 0, 1),
    normalize(playerTotalUnitHealth, 20000),
    normalize(enemyTotalUnitHealth, 20000),
    normalize(enemyTotalUnitHealth - playerTotalUnitHealth, 20000),
    normalize(playerTotalUnitDamage, 4000),
    normalize(enemyTotalUnitDamage, 4000),
    normalize(enemyTotalUnitDamage - playerTotalUnitDamage, 4000),
    normalize(enemyMeanUnitHealth, 2500),
    normalize(playerMeanUnitHealth, 2500),
    normalize(enemyMeanUnitDamage, 300),
    normalize(playerMeanUnitDamage, 300),
    normalize(enemyMeanUnitRange, 40),
    normalize(playerMeanUnitRange, 40),
    normalize(state.enemyQueueSize, 10),
    normalize(state.playerQueueSize, 10),
    normalize(state.enemyTurretQueueCount, 6),
    normalize(state.playerTurretQueueCount, 6),
    normalize(state.playerUnitsNearEnemyBase, 20),
    normalize(state.enemyUnitsNearPlayerBase, 20),
    normalize(state.battlefieldWidth, 400),
    normalize(state.lastEnemyBaseAttackTime, 600),
    normalize(enemyMeanUnitPosition, Math.max(1, state.battlefieldWidth)),
    normalize(playerMeanUnitPosition, Math.max(1, state.battlefieldWidth)),
    normalize(enemyMeanUnitCooldown, 3),
    normalize(playerMeanUnitCooldown, 3),
    normalize(enemyMeanSkillCooldown, 8),
    normalize(playerMeanSkillCooldown, 8),
    normalize(ownProjectileCount, 80),
    normalize(opponentProjectileCount, 80),
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
    normalize(ownAbilityEffectsCount, 80),
    normalize(opponentAbilityEffectsCount, 80),
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
    normalize(unitBlockedByCap, Math.max(1, ML_UNIT_IDS.length)),
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
    normalize(queueRemaining, 10),
    normalize(emptyUnlockedTurretSlots, 4),
    normalize(state.enemyAgeRequirementProgress, 1),
    normalize(state.playerAgeRequirementProgress, 1),
    normalize(state.enemyAgePrevAgeUnitRequirementProgress, 1),
    normalize(state.playerAgePrevAgeUnitRequirementProgress, 1),
    normalize(state.enemyAgeTotalUnitRequirementProgress, 1),
    normalize(state.playerAgeTotalUnitRequirementProgress, 1),
  ];
}

export function encodeObservation(
  state: GameStateSnapshot,
  historyTokens: MLHistoryToken[],
  actionMask: MLLegalActionMask,
  config: ObservationEncoderConfig = {}
): EncodedMLObservation {
  const sequenceLength = config.sequenceLength ?? 240;
  // Preserve history when possible, but prioritize full tactical/raw state coverage.
  const preferredMinHistoryTokens = Math.max(
    0,
    Math.min(
      sequenceLength,
      config.minHistoryTokens ?? Math.min(24, Math.floor(sequenceLength * 0.2))
    )
  );
  const mandatoryStateTokens = estimateMandatoryStateTokenCount(state);
  const stateTokenBudget = Math.max(
    0,
    Math.min(sequenceLength, Math.max(sequenceLength - preferredMinHistoryTokens, mandatoryStateTokens))
  );
  const stateTokens = encodeCurrentStateTokens(state, stateTokenBudget);
  const historyBudget = Math.max(0, sequenceLength - stateTokens.length);
  const encodedTokens = historyTokens.slice(-historyBudget).map(encodeHistoryToken);
  const zeroToken = new Array<number>(TOKEN_FEATURE_SIZE).fill(0);
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
