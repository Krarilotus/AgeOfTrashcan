/**
 * Turret Configuration and Logic
 * 
 * Central place for turret progression, stats, and formulas.
 * Extracting this makes it easier to balance defenses without touching core game logic.
 */

export const TURRET_CONSTANTS = {
  BASE_DAMAGE: 4,
  BASE_RANGE: 10,
  FIRE_INTERVAL: 0.4, // Seconds between shots
  PROJECTILE_SPEED: 60,
  
  // Cost scaling
  BASE_COST: 100,
  COST_EXPONENT: 1.5, // How fast costs rise
};

/**
 * Turret Upgrade Costs by Target Level
 * Maps target level -> gold cost
 */
export const TURRET_UPGRADE_COSTS: Record<number, number> = {
  1: 100,
  2: 200,
  3: 300,
  4: 400,
  5: 600,  // Jump
  6: 800,
  7: 1000,
  8: 1200,
  9: 1500, // Jump
  10: 1900 // Jump
};

export const getTurretUpgradeCost = (currentLevel: number): number => {
  const targetLevel = currentLevel + 1;
  return TURRET_UPGRADE_COSTS[targetLevel] || 0; // 0 if maxed
};

/**
 * Calculate turret damage based on level
 * Formula: (BASE + (level * (5 + level))) * INTERVAL
 */
export const calculateTurretDamage = (level: number): number => {
  if (level <= 0) return 0;
  
  const baseDps = TURRET_CONSTANTS.BASE_DAMAGE;
  const levelBonus = level * (5 + level);
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
    // Mid levels: +2 range per level
    bonus = 12 + (level - 3) * 2;
  } else {
    // Late levels: +1 range per level (Diminishing)
    bonus = 18 + (level - 6) * 1;
  }
  
  return base + bonus;
};

/**
 * Calculate cost to upgrade TO this level
 */
export const getTurretCost = (targetLevel: number): number => {
  if (targetLevel <= 1) return TURRET_CONSTANTS.BASE_COST;
  return Math.floor(TURRET_CONSTANTS.BASE_COST * Math.pow(targetLevel, TURRET_CONSTANTS.COST_EXPONENT));
};
