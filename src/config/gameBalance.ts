/**
 * Game Balance Configuration
 * All costs, income rates, XP rates, and game mechanics in one place
 * Tune these values to balance the game without touching core logic
 */

/**
 * Base Health and Damage Configuration
 */
export const BASE_CONFIG = {
  // Base health for both player and enemy
  baseHealth: 300,
  
  // Base starting gold
  startingGold: 150,
  
  // Base starting mana
  startingMana: 0,
  
  // Base mana generation per second
  baseManaPerSecond: 0,
};

/**
 * Income and Resource Generation
 */
export const INCOME_CONFIG = {
  // Base gold income per second
  baseGoldPerSecond: 8,
  
  // Gold income additive increase per age. Logic: age 1->2 (+3), age 2->3 (+4)
  // Formula approx: base + sum(i=2 to age) of (i+1)
  // We can just define the increase map or a function
  
  // Mana generation cost and benefits
  manaUpgrade: {
    baseCost: 50,
    costMultiplier: 2, // Each level costs 2x previous
    manaPerSecondPerLevel: 1, // Each level adds 1 mana/s (GameEngine says +1)
  },
};

export const PROGRESSION_CONFIG = {
  maxAge: 6,
  ageBaseHealthMultiplier: 2,
} as const;

export const TURRET_BALANCE_CONFIG = {
  // Slot 1 is free by design; entries map to current unlocked slot count.
  // Example: unlocking slot 2 when currently at 1 unlocked costs 500.
  slotUnlockCosts: [0, 300, 1000, 5000] as const,
  slotUnlockBuildMs: [0, 1600, 2200, 3000] as const,
} as const;

export const MANA_CONVERSION_CONFIG = {
  unlockLevel: 6,
  percentPerLevel: 0.02,
} as const;

/**
 * Age Progression Costs
 * Defines the gold cost required to upgrade TO a specific age.
 * age 1 is starting age. cost[2] is cost to go 1->2 (which is index 2 in 1-based logic, or we map explicitly).
 * Let's map explicitly: Target Age -> Cost
 */
export const AGE_UPGRADE_COSTS: Record<number, number> = {
  2: 500,   // Age 1 -> 2
  3: 1000,  // Age 2 -> 3
  4: 1500,  // Age 3 -> 4
  5: 2500,  // Age 4 -> 5
  6: 4000,  // Age 5 -> 6
  7: 10000,  // Age 6 -> 7 (or max) - using 7 as theoretical max or display
};

export const getAgeUpgradeCost = (currentAge: number): number => {
  const targetAge = currentAge + 1;
  return AGE_UPGRADE_COSTS[targetAge] || 999999;
};

/**
 * Combat and Damage Configuration
 */
export const COMBAT_CONFIG = {
  // Projectile speed for ranged units
  projectileSpeed: 30,
  
  // Projectile lifetime in milliseconds
  projectileLifeMs: 2000,
  
  // Turret projectile speed (faster than regular)
  turretProjectileSpeed: 60,
  
  // Collision detection distances
  collision: {
    // Distance for projectile-entity collision
    projectileEntityRange: 0.8,
    
    // Ally spacing for ranged units
    allySpacingRanged: 1.2,
    
    // Ally spacing for melee units
    allySpacingMelee: 2.4,
    
    // Enemy blocking distance for ranged units
    enemyBlockRanged: 0.3, // Physical collision only
    
    // Enemy blocking distance for melee units
    enemyBlockMelee: 1.0,
    
    // Base blocking distance for ranged units
    baseBlockRanged: 2.0,
    
    // Base blocking distance for melee units
    baseBlockMelee: 1.0,
  },
  
  // Mana shield configuration (for units with manaShield property)
  manaShield: {
    damageAbsorption: 0.9, // 90% of damage absorbed by mana
    manaPerDamage: 0.5, // 1 mana absorbs 2 damage
    minimumDamage: 1, // Always take at least 1 damage
  },
  
  // Skill cooldown reduction per mana level (for future upgrades)
  skillCooldownReductionPerLevel: 0.05, // 5% per level
};

// NOTE: Turret stats are now defined in GameEngine.ts as constants:
// - TURRET_FIRE_INTERVAL = 0.4s
// - TURRET_BASE_DAMAGE = 4
// - BASE_TURRET_RANGE = 10
// - Progressive damage: level * (5 + level) per interval
// This avoids duplication and keeps game logic centralized.

/**
 * AI Difficulty Multipliers
 */
export const DIFFICULTY_CONFIG = {
  EASY: {
    goldMultiplier: 1.0,
    xpMultiplier: 1.0,
    stackSizeMultiplier: 2.0,
    stackSizeMultiplierMax: 2.5, 
  },
  MEDIUM: {
    goldMultiplier: 1.2,
    stackSizeMultiplier: 2.5,
    stackSizeMultiplierMax: 3.0,
  },
  HARD: {
    goldMultiplier: 1.5,
    stackSizeMultiplier: 3.0,
    stackSizeMultiplierMax: 3.5,
  },
  CHEATER: {
    goldMultiplier: 2.0,
    stackSizeMultiplier: 3.5,
    stackSizeMultiplierMax: 4.0,
  },
};

/**
 * Training Queue Configuration
 */
export const QUEUE_CONFIG = {
  // Maximum units that can be queued
  maxQueueSize: 5,
  
  // Time penalty for each unit in queue (makes later units train slower)
  queueTimePenaltyMs: 100,
};

/**
 * Game Loop Configuration
 */
export const GAME_LOOP_CONFIG = {
  // Fixed timestep for physics (60 FPS)
  fixedTimestepMs: 1000 / 60,
  
  // AI decision interval
  aiDecisionIntervalMs: 500,
  
  // Income tick interval
  incomeTickIntervalMs: 1000,
  
  // XP tick interval
  xpTickIntervalMs: 100,
};

/**
 * Helper function to calculate mana upgrade cost
 * ACTUAL GAME LOGIC: (level + 1) * 150
 * Level 0->1: 150g, Level 1->2: 300g, Level 2->3: 450g, etc.
 */
export function getManaCost(currentLevel: number): number {
  return (currentLevel + 1) * 150;
}

/**
 * Helper function to calculate current gold income based on Age
 * Logic: Base + cumulative upgrades.
 * Age 2 Upgrade: +3 (Total 11)
 * Age 3 Upgrade: +4 (Total 15)
 * Age 4 Upgrade: +5 (Total 20)
 * Age 5 Upgrade: +6 (Total 26)
 * Age 6 Upgrade: +7 (Total 33)
 * Age 7 Upgrade: +7 (Total 40)
 */
export function getGoldIncome(age: number): number {
  let income = INCOME_CONFIG.baseGoldPerSecond;
  if (age <= 1) return income;
  
  // Calculate cumulative increase
  for (let current = 2; current <= age; current++) {
    // Logic from GameEngine: Math.min(prog.age + 1, 7) where prog.age is the NEW age.
    // So for age 2, increase is 3. For age 6, increase is 7. For age 7, increase is 7.
    const increase = Math.min(current + 1, 7);
    income += increase;
  }
  return income;
}

/**
 * Helper function to calculate current mana generation
 */
export function getManaGeneration(manaLevel: number): number {
  return BASE_CONFIG.baseManaPerSecond + 
         (manaLevel * INCOME_CONFIG.manaUpgrade.manaPerSecondPerLevel);
}

export function getGoldToManaConversionRate(manaLevel: number): number {
  if (manaLevel < MANA_CONVERSION_CONFIG.unlockLevel) return 0;
  const unlockedLevels = manaLevel - MANA_CONVERSION_CONFIG.unlockLevel + 1;
  return unlockedLevels * MANA_CONVERSION_CONFIG.percentPerLevel;
}
