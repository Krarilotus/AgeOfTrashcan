/**
 * Turret Configuration and Logic
 * 
 * Central place for turret progression, stats, and formulas.
 * Extracting this makes it easier to balance defenses without touching core game logic.
 */

export const TURRET_CONSTANTS = {
  BASE_DAMAGE: 0,
  BASE_RANGE: 10,
  FIRE_INTERVAL: 0.4, // Seconds between shots
  PROJECTILE_SPEED: 60,
};

export const TURRET_ABILITY_CONFIG = {
  PIERCING_SHOT: {
    requiredLevel: 5,
    minTargets: 1,
    cooldownSeconds: 3.0,
    rangeMultiplier: 1.5,
    damageMultiplier: 1.5,
    vfxLifeMs: 220,
  },
  CHAIN_LIGHTNING: {
    requiredLevel: 7,
    minTargets: 2,
    cooldownSeconds: 5.0,
    maxTargets: 3,
    initialDamageMultiplier: 2.0,
    bounceFalloff: 0.4,
    vfxLifeMs: 600,
  },
  ARTILLERY_BARRAGE: {
    requiredLevel: 9,
    minTargets: 3,
    cooldownSeconds: 18.0,
    projectileCount: 100,
    durationMs: 3000,
    spreadLaneY: 4,
    startY: 25,
    fallSpeed: -15,
    damageMultiplier: 1.0,
    extraLifeMs: 500,
    vfxLifeMs: 3000,
  },
} as const;

/**
 * Turret Upgrade Costs by Target Level
 * Maps target level -> gold cost
 */
export const TURRET_UPGRADE_COSTS: Record<number, number> = {
  1: 100,
  2: 200,
  3: 300,
  4: 400,
  5: 600,  // pierce
  6: 800,
  7: 1100, // Chain Lightning
  8: 1400,
  9: 1800, // Artillery Barrage
  10: 2500
};

export const getTurretUpgradeCost = (currentLevel: number): number => {
  const targetLevel = currentLevel + 1;
  return TURRET_UPGRADE_COSTS[targetLevel] || 0; // 0 if maxed
};

/**
 * Calculate turret damage based on level
 * Formula: (BASE + (level * (6 + level))) * INTERVAL
 */
export const calculateTurretDamage = (level: number): number => {
  if (level <= 0) return 0;
  
  const baseDps = TURRET_CONSTANTS.BASE_DAMAGE;
  const levelBonus = level * (6 + level);
  const damagePerShot = (baseDps + levelBonus) * TURRET_CONSTANTS.FIRE_INTERVAL;
  
  return damagePerShot;
};

/**
 * Calculate turret DPS (Damage Per Second)
 */
export const calculateTurretDPS = (level: number): number => {
  if (level <= 0) return 0;
  return calculateTurretDamage(level) / TURRET_CONSTANTS.FIRE_INTERVAL;
};

/**
 * Calculate turret range based on level
 * Diminishing returns formula to prevent map-wide sniping too early
 */
export const calculateTurretRange = (level: number): number => {
  if (level <= 0) return 0;
  
  const base = TURRET_CONSTANTS.BASE_RANGE;
  let bonus = 0;
  
  if (level <= 3) {
    // Early levels: +4 range per level (Big jumps)
    bonus = level * 4;
  } else if (level <= 6) {
    // Mid levels: +3 range per level
    bonus = 12 + (level - 3) * 3;
  } else if (level <= 9) {
    // Late levels: +2 range per level (Diminishing)
    bonus = 21 + (level - 6) * 2;
  } else {
    // Max level: +1 range per level (Very diminishing)
    bonus = 27 + (level - 9) * 1;
  }
  
  return base + bonus;
};

/**
 * Cumulative diminishing tower protection.
 * Level 1: 10%, Level 2: 19%, ... Level 10: 55%
 */
export const calculateTurretProtectionReductionPercent = (level: number): number => {
  if (level <= 0) return 0;
  const effectiveLevel = Math.min(Math.max(0, level), 10);
  return (11 * effectiveLevel) - (effectiveLevel * (effectiveLevel + 1)) / 2;
};

