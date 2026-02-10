import type { GameStateSnapshot } from '../AIBehavior';
import { getEnemyPurchaseDiscountMultiplier, getManaCost, PROGRESSION_CONFIG, QUEUE_CONFIG } from '../../config/gameBalance';
import { getTurretEnginesForAge, getTurretSlotUnlockCost, MAX_TURRET_SLOTS } from '../../config/turrets';
import { UNIT_DEFS } from '../../config/units';
import { ML_ACTION_TYPES, ML_SLOT_INDICES, ML_TURRET_IDS, ML_UNIT_IDS, getActionTypeIndex } from './actionCatalog';

export interface MLLegalActionMask {
  actionTypeMask: number[];
  unitMask: number[];
  turretMask: number[];
  buySlotMask: number[];
  sellSlotMask: number[];
}

export function countLegal(mask: number[]): number {
  return mask.reduce((total, item) => total + (item > 0 ? 1 : 0), 0);
}

function discountedEnemyCost(
  difficulty: GameStateSnapshot['difficulty'],
  baseCost: number,
  category: Parameters<typeof getEnemyPurchaseDiscountMultiplier>[1]
): number {
  return Math.floor(baseCost * getEnemyPurchaseDiscountMultiplier(difficulty, category));
}

export function buildLegalActionMask(state: GameStateSnapshot): MLLegalActionMask {
  const canQueueMore = state.enemyQueueSize < QUEUE_CONFIG.maxQueueSize;
  const hasAnyEmptyUnlockedSlot = ML_SLOT_INDICES.some(
    (slotIndex) =>
      slotIndex < state.enemyTurretSlotsUnlocked &&
      (state.enemyTurretSlots[slotIndex]?.turretId ?? null) === null
  );
  const buySlotMask = ML_SLOT_INDICES.map((slotIndex) =>
    slotIndex < state.enemyTurretSlotsUnlocked &&
    (state.enemyTurretSlots[slotIndex]?.turretId ?? null) === null
      ? 1
      : 0
  );
  const sellSlotMask = ML_SLOT_INDICES.map((slotIndex) =>
    slotIndex < state.enemyTurretSlotsUnlocked &&
    (state.enemyTurretSlots[slotIndex]?.turretId ?? null) !== null
      ? 1
      : 0
  );

  const unitMask = ML_UNIT_IDS.map((unitId) => {
    const unit = UNIT_DEFS[unitId];
    if (!unit) return 0;
    if (!canQueueMore) return 0;
    if ((unit.age ?? 1) > state.enemyAge) return 0;
    const goldCost = discountedEnemyCost(state.difficulty, unit.cost, 'unit');
    const manaCost = unit.manaCost ?? 0;
    if (state.enemyGold < goldCost) return 0;
    if (state.enemyMana < manaCost) return 0;
    return 1;
  });

  const ageUpLegal =
    state.enemyAge < PROGRESSION_CONFIG.maxAge && state.enemyGold >= state.enemyAgeCost;

  const manaUpgradeCost = getManaCost(state.enemyManaLevel);
  const manaUpgradeLegal = state.enemyGold >= manaUpgradeCost;

  const slotUpgradeCost = discountedEnemyCost(
    state.difficulty,
    getTurretSlotUnlockCost(state.enemyTurretSlotsUnlocked),
    'turret_upgrade'
  );
  const slotUpgradeLegal =
    canQueueMore &&
    state.enemyTurretSlotsUnlocked < MAX_TURRET_SLOTS &&
    state.enemyGold >= slotUpgradeCost;

  const affordableTurretsByAge = getTurretEnginesForAge(state.enemyAge);
  const turretMask = ML_TURRET_IDS.map((turretId) => {
    if (!canQueueMore || !hasAnyEmptyUnlockedSlot) return 0;
    const turret = affordableTurretsByAge[turretId];
    if (!turret) return 0;
    const goldCost = discountedEnemyCost(state.difficulty, turret.cost, 'turret_engine');
    const manaCost = turret.manaCost ?? 0;
    if (state.enemyGold < goldCost) return 0;
    if (state.enemyMana < manaCost) return 0;
    return 1;
  });

  const canRepairBase =
    state.enemyAge >= 4 && state.enemyMana >= 500 && state.enemyBaseHealth < state.enemyBaseMaxHealth;

  const actionTypeMask = new Array<number>(ML_ACTION_TYPES.length).fill(0);
  actionTypeMask[getActionTypeIndex('WAIT')] = 1;
  actionTypeMask[getActionTypeIndex('RECRUIT_UNIT')] = countLegal(unitMask) > 0 ? 1 : 0;
  actionTypeMask[getActionTypeIndex('AGE_UP')] = ageUpLegal ? 1 : 0;
  actionTypeMask[getActionTypeIndex('UPGRADE_MANA')] = manaUpgradeLegal ? 1 : 0;
  actionTypeMask[getActionTypeIndex('UPGRADE_TURRET_SLOTS')] = slotUpgradeLegal ? 1 : 0;
  actionTypeMask[getActionTypeIndex('BUY_TURRET_ENGINE')] =
    countLegal(turretMask) > 0 && countLegal(buySlotMask) > 0 ? 1 : 0;
  actionTypeMask[getActionTypeIndex('SELL_TURRET_ENGINE')] = countLegal(sellSlotMask) > 0 ? 1 : 0;
  actionTypeMask[getActionTypeIndex('REPAIR_BASE')] = canRepairBase ? 1 : 0;

  return {
    actionTypeMask,
    unitMask,
    turretMask,
    buySlotMask,
    sellSlotMask,
  };
}
