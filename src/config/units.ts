/**
 * Unit Configuration Module
 * All unit definitions, stats, and abilities
 * Easily tunable for balance adjustments
 */

export interface UnitSkill {
  type: 'direct' | 'aoe' | 'flamethrower' | 'heal';
  manaCost: number;
  cooldownMs: number;
  power: number; // For 'direct': Damage amount. For 'aoe': Radius in game units. For 'flamethrower': Dmg/tick
  damage?: number; // For 'aoe': Damage amount.
  range?: number; // for direct skills
}

export interface BurstFire {
  shots: number;
  burstCooldown: number;
}

export interface TeleporterAbility {
  damageReduction: number; // 0.0 to 1.0, percentage of damage reduced
  healPerSecond: number; // Passive self-healing
  manaPerAttack: number; // Mana cost per attack
  attackCooldown: number; // Cooldown between attacks in ms
  canAttackBase: boolean; // Whether it can attack the enemy base
}

export interface UnitDef {
  cost: number;
  health: number;
  damage: number;
  speed: number;
  range?: number;
  trainingMs?: number;
  age?: number;
  skill?: UnitSkill;
  manaCost?: number; // Mana cost to queue/train this unit
  manaShield?: boolean; // If true, 90% of damage absorbed by mana (1 mana = 2 dmg), min 1 dmg
  burstFire?: BurstFire;
  teleporter?: TeleporterAbility;
  manaLeech?: number; // Percentage of damage dealt that returns as mana (e.g., 0.01 = 1%)
  visualScale?: number; // Optional scaling factor for rendering (default 1.0)
  width?: number; // Width Multiplier for collision (default: 1.0)
}

/**
 * Master unit definitions organized by age
 * Easy to tune individual unit stats or add new units
 */
export const UNIT_DEFS: Record<string, UnitDef> = {
  // ===== AGE 1: Stone Age =====
  stone_clubman: {
    cost: 15,
    health: 45,
    damage: 6,
    speed: 4.5,
    range: 1,
    trainingMs: 1000,
    age: 1,
  },
  stone_slinger: {
    cost: 25,
    health: 18,
    damage: 8,
    speed: 5.0,
    range: 6,
    trainingMs: 1250,
    age: 1,
  },
  stone_dino: {
    cost: 100,
    health: 120,
    damage: 12,
    speed: 2.5,
    range: 1,
    trainingMs: 2500,
    age: 1,
  },

  // ===== AGE 2: Bronze Age =====
  bronze_spearman: {
    cost: 20,
    health: 65,
    damage: 10,
    speed: 5.5,
    range: 1,
    trainingMs: 1100,
    age: 2,
  },
  bronze_archer: {
    cost: 30,
    health: 22,
    damage: 10,
    speed: 5.8,
    range: 8,
    trainingMs: 1500,
    age: 2,
    skill: { type: 'direct', manaCost: 3, cooldownMs: 5000, power: 25, range: 10 },
  },
  bronze_catapult: {
    cost: 150,
    health: 120,
    damage: 30,
    speed: 2.8,
    range: 10,
    trainingMs: 4000,
    age: 2,
    visualScale: 1.3,   
    width: 1.3,
    skill: { type: 'aoe', manaCost: 15, cooldownMs: 15000, power: 4, damage: 25, range: 6 },
  },

  // ===== AGE 3: Iron Age =====
  iron_knight: {
    cost: 70,
    health: 230,
    damage: 24,
    speed: 4.8,
    range: 1,
    trainingMs: 2750,
    age: 3,
    visualScale: 1.2,
  },
  iron_mage: {
    cost: 45,
    manaCost: 30,
    health: 50,
    damage: 5,
    speed: 6.2,
    range: 7,
    trainingMs: 1500,
    age: 3,
    skill: { type: 'aoe', manaCost: 10, cooldownMs: 10000, power: 6, damage: 30, range: 6 },
  },
  iron_crossbow: {
    cost: 55,
    health: 50,
    damage: 18,
    speed: 6.5,
    range: 9,
    trainingMs: 1750,
    age: 3,
    skill: { type: 'direct', manaCost: 4, cooldownMs: 7000, power: 30, range: 10 },
  },
  war_elephant: {
    cost: 200,
    health: 450,
    damage: 40,
    speed: 3.2,
    range: 1,
    trainingMs: 3500,
    age: 3,
    visualScale: 1.3,   
    width: 1.3,
  },
  battle_monk: {
    cost: 65,
    manaCost: 16,
    health: 120,
    damage: 12,
    speed: 5.2,
    range: 1,
    trainingMs: 2250,
    age: 3,
    skill: { type: 'direct', manaCost: 5, cooldownMs: 8000, power: 100, range: 3 },
  },

  // ===== AGE 4: Steel Age =====
  steel_tank: {
    cost: 200,
    health: 550,
    damage: 48,
    speed: 4.5,
    range: 1,
    trainingMs: 5000,
    age: 4,
    visualScale: 1.5, // Large unit
    width: 10,
  },
  artillery: {
    cost: 160,
    health: 180,
    damage: 40,
    speed: 5.0,
    range: 15,
    trainingMs: 4500,
    age: 4,
    visualScale: 1.3,
    width: 1.5,
    skill: { type: 'aoe', manaCost: 18, cooldownMs: 15000, power: 5, damage: 80, range: 6 },
  },
  medic: {
    cost: 100,
    manaCost: 40,
    health: 80,
    damage: 2,
    speed: 6.5,
    range: 10,
    trainingMs: 3000,
    age: 4,
    skill: { type: 'heal', manaCost: 7, cooldownMs: 1000, power: 30, range: 10 },
  },
  heavy_cavalry: {
    cost: 160,
    health: 450,
    damage: 55,
    speed: 7.5,
    range: 1,
    trainingMs: 2800,
    age: 4,
    visualScale: 1.3,
  },
  siege_engineer: {
    cost: 120,
    manaCost: 50,
    health: 150,
    damage: 35,
    speed: 4.2,
    range: 14,
    trainingMs: 4500,
    age: 4,
    skill: { type: 'aoe', manaCost: 30, cooldownMs: 25000, power: 15, damage: 45, range: 14 },
  },

  // ===== AGE 5: Industrial Age =====
  gunner: {
    cost: 160,
    health: 300,
    damage: 9,
    speed: 6.8,
    range: 9,
    trainingMs: 3500,
    age: 5,
    burstFire: { shots: 5, burstCooldown: 1000 },
  },
  pyro_maniac: {
    cost: 80,
    manaCost: 30,
    health: 140,
    damage: 18,
    speed: 7.0,
    range: 3,
    trainingMs: 2500,
    age: 5,
    skill: { type: 'aoe', manaCost: 12, cooldownMs: 12000, power: 20, damage: 25, range: 10},
  },
  energy_shield: {
    cost: 180,
    manaCost: 60,
    health: 1200,
    damage: 8,
    speed: 3.8,
    range: 1,
    trainingMs: 4000,
    age: 5,
    visualScale: 1.2,
    width: 1.5,
    skill: { type: 'aoe', manaCost: 24, cooldownMs: 18000, power: 3, damage: 10, range: 8 },
  },
  flamethrower: {
    cost: 140,
    manaCost: 40,
    health: 260, 
    damage: 10,
    speed: 6.5,
    range: 8,
    trainingMs: 3500,
    age: 5,
    skill: { type: 'flamethrower', manaCost: 1, cooldownMs: 200, power: 8, range: 8 }, 
  },
  steam_mech: {
    cost: 280,
    manaCost: 70,
    health: 800,
    damage: 70,
    speed: 4.5,
    range: 1,
    trainingMs: 5500,
    age: 5,
    skill: { type: 'direct', manaCost: 18, cooldownMs: 12000, power: 160, range: 2 },
  },
  sniper: {
    cost: 130,
    health: 170,
    damage: 45,
    speed: 6.8,
    range: 16,
    trainingMs: 3250,
    age: 5,
    width: 1.3,
  },
  mana_vampire: {
    cost: 200,
    manaCost: 45,
    health: 320,
    damage: 42,
    speed: 6.5,
    range: 7,
    trainingMs: 4000,
    age: 5,
    manaLeech: 0.05,
    skill: { type: 'direct', manaCost: 2, cooldownMs: 8000, power: 140, range: 12 },
    visualScale: 0.5,
    width: 2,
  },

  // ===== AGE 6: Future Age =====
  robot_soldier: {
    cost: 180,
    health: 850,
    damage: 50,
    speed: 7.5,
    range: 1,
    trainingMs: 5000,
    age: 6,
    skill: { type: 'direct', manaCost: 20, cooldownMs: 10000, power: 70, range: 10 },
  },
  laser_trooper: {
    cost: 120,
    health: 360,
    damage: 70,
    speed: 8.0,
    range: 12,
    trainingMs: 4000,
    age: 6,
    skill: { type: 'direct', manaCost: 4, cooldownMs: 5000, power: 150, range: 15 },
  },
  mech_walker: {
    cost: 350,
    manaCost: 50,
    health: 2400,
    damage: 170,
    speed: 4.8,
    range: 1,
    trainingMs: 8000,
    age: 6,
    visualScale: 1.4,
    width: 1.4,
    skill: { type: 'direct', manaCost: 15, cooldownMs: 10000, power: 300, range: 3 },
  },
  plasma_striker: {
    cost: 240,
    manaCost: 60,
    health: 600,
    damage: 100,
    speed: 8.2,
    range: 10,
    trainingMs: 4500,
    age: 6,
    skill: { type: 'direct', manaCost: 15, cooldownMs: 7000, power: 200, range: 16 },
  },
  nanoswarm: {
    cost: 400,
    manaCost: 80,
    health: 1300,
    damage: 10,
    speed: 8.8,
    range: 20,
    trainingMs: 5500,
    age: 6,
    manaLeech: 0.05,
    skill: { type: 'aoe', manaCost: 5, cooldownMs: 2000, power: 40, damage: 20, range: 20 },
  },
  titan_mech: {
    cost: 650,
    manaCost: 80,
    health: 4000,
    damage: 200,
    speed: 4.2,
    range: 1,
    trainingMs: 11000,
    age: 6,
    visualScale: 1.8,
    width: 1.8,
    skill: { type: 'aoe', manaCost: 70, cooldownMs: 13000, power: 50, damage: 150, range: 14 },
  },
  cyber_assassin: {
    cost: 320,
    manaCost: 40,
    health: 560,
    damage: 60,
    speed: 9.2,
    range: 1,
    trainingMs: 7000,
    age: 6,
    skill: { type: 'direct', manaCost: 15, cooldownMs: 7000, power: 200, range: 4 },
    manaShield: true,
  },
  burst_gunner: {
    cost: 220,
    health: 560,
    damage: 5,
    speed: 6.2,
    range: 11,
    trainingMs: 5000,
    age: 6,
    burstFire: { shots: 30, burstCooldown: 1500 },
  },
  dark_cultist: {
    cost: 240,
    manaCost: 60,
    health: 640,
    damage: 15,
    speed: 7.0,
    range: 15,
    trainingMs: 5500,
    age: 6,
    visualScale: 0.6,
    width: 1.5,
    skill: { type: 'flamethrower', manaCost: 1, cooldownMs: 60, power: 8, range: 15 }, 
  },
  void_reaper: {
    cost: 10000,
    manaCost: 1000,
    health: 999,
    damage: 999,
    speed: 0,
    range: 1,
    trainingMs: 40000,
    age: 6,
    teleporter: {
      damageReduction: 0.8,
      healPerSecond: 50,
      manaPerAttack: 10,
      attackCooldown: 1500,
      canAttackBase: false,
    },
    // Added skill definition for AOE radius control
    skill: { type: 'aoe', manaCost: 50, cooldownMs: 3000, power: 4, damage: 999, range: 1 },
    manaShield: true, 
  },
};

/**
 * Get all units available for a specific age
 */
export function getUnitsForAge(age: number): Record<string, UnitDef> {
  const result: Record<string, UnitDef> = {};
  for (const [key, def] of Object.entries(UNIT_DEFS)) {
    if (def.age === age) {
      result[key] = def;
    }
  }
  return result;
}

/**
 * Get unit keys filtered by criteria
 */
export function filterUnits(criteria: {
  age?: number;
  maxCost?: number;
  minCost?: number;
  isRanged?: boolean;
  requiresMana?: boolean;
}): string[] {
  return Object.entries(UNIT_DEFS)
    .filter(([_, def]) => {
      if (criteria.age !== undefined && def.age !== criteria.age) return false;
      if (criteria.maxCost !== undefined && def.cost > criteria.maxCost) return false;
      if (criteria.minCost !== undefined && def.cost < criteria.minCost) return false;
      if (criteria.isRanged !== undefined) {
        const isRanged = (def.range ?? 1) > 1.5;
        if (isRanged !== criteria.isRanged) return false;
      }
      if (criteria.requiresMana !== undefined) {
        const requiresMana = (def.manaCost ?? 0) > 0;
        if (requiresMana !== criteria.requiresMana) return false;
      }
      return true;
    })
    .map(([key]) => key);
}
