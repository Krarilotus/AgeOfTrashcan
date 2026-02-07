export type TurretTargetingMode =
  | 'nearest'
  | 'healthiest'
  | 'lowest_health'
  | 'highest_dps'
  | 'strongest_ability_dps';

export type TurretAttackType =
  | 'projectile'
  | 'chain_lightning'
  | 'artillery_barrage'
  | 'oil_pour'
  | 'drone_swarm';

export interface TurretSplitProjectileConfig {
  childCount: number;
  childDamage: number;
  childSpeed: number;
  childLifeMs: number;
  spreadRadius: number;
}

export interface TurretProjectileConfig {
  speed: number;
  damage: number;
  lifeMs?: number;
  curvature?: number;
  radiusPx?: number;
  color?: string;
  glowColor?: string;
  trailAlpha?: number;
  splashRadius?: number;
  pierceCount?: number;
  splitOnImpact?: TurretSplitProjectileConfig;
}

export interface TurretChainLightningConfig {
  maxTargets: number;
  initialDamage: number;
  falloffMultiplier: number;
  cooldownSeconds: number;
}

export interface TurretArtilleryConfig {
  barrageCount: number;
  spreadRange: number;
  spreadLaneY: number;
  startY: number;
  fallSpeed: number;
  shellDamage: number;
  shellRadius: number;
  cooldownSeconds: number;
}

export interface TurretOilConfig {
  radius: number;
  damage: number;
  cooldownSeconds: number;
}

export interface TurretDroneConfig {
  droneCount: number;
  droneDamage: number;
  droneSpeed: number;
  cooldownSeconds: number;
}

export interface TurretEngineDef {
  id: string;
  name: string;
  age: number;
  cost: number;
  buildMs: number;
  range: number;
  protectionMultiplier: number;
  targeting: TurretTargetingMode;
  attackType: TurretAttackType;
  fireIntervalSec: number;
  projectile?: TurretProjectileConfig;
  chainLightning?: TurretChainLightningConfig;
  artillery?: TurretArtilleryConfig;
  oil?: TurretOilConfig;
  drones?: TurretDroneConfig;
  spritePath: string;
  description: string;
}

export interface MountedTurretSlotState {
  slotIndex: number;
  turretId: string | null;
  cooldownRemaining: number;
}

export interface TurretBaseLike {
  turretSlotsUnlocked: number;
  turretSlots: MountedTurretSlotState[];
}

export interface TurretDefenseStats {
  installedCount: number;
  totalDps: number;
  maxRange: number;
  avgRange: number;
  strongestProtectionMultiplier: number;
  legacyLevelEstimate: number;
}

export const MAX_TURRET_SLOTS = 4;
export const TURRET_SLOT_UNLOCK_COSTS: number[] = [0, 500, 1000, 5000];
export const TURRET_SLOT_UNLOCK_BUILD_MS: number[] = [0, 1600, 2200, 3000];
export const TURRET_SLOT_MOUNT_Y_OFFSETS_UNITS: number[] = [0.6, 1.3, 2.0, 2.8];

export function getTurretSlotUnlockCost(currentUnlocked: number): number {
  if (currentUnlocked >= MAX_TURRET_SLOTS) return 0;
  return TURRET_SLOT_UNLOCK_COSTS[currentUnlocked] ?? 0;
}

export function getTurretSlotUnlockBuildMs(currentUnlocked: number): number {
  if (currentUnlocked >= MAX_TURRET_SLOTS) return 0;
  return TURRET_SLOT_UNLOCK_BUILD_MS[currentUnlocked] ?? 2000;
}

export function getSlotMountYOffsetUnits(slotIndex: number): number {
  return TURRET_SLOT_MOUNT_Y_OFFSETS_UNITS[slotIndex] ?? TURRET_SLOT_MOUNT_Y_OFFSETS_UNITS[TURRET_SLOT_MOUNT_Y_OFFSETS_UNITS.length - 1];
}

export function getTurretSellRefundMultiplier(isPlayer: boolean, difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER'): number {
  if (isPlayer) return 0.5;
  if (difficulty === 'EASY') return 0.5;
  if (difficulty === 'MEDIUM') return 0.6;
  if (difficulty === 'HARD') return 0.8;
  return 1.0;
}

export const TURRET_ENGINES: Record<string, TurretEngineDef> = {
  chicken_eggomat: {
    id: 'chicken_eggomat',
    name: 'Chicken Eggomat',
    age: 1,
    cost: 200,
    buildMs: 1200,
    range: 11,
    protectionMultiplier: 0.97,
    targeting: 'nearest',
    attackType: 'projectile',
    fireIntervalSec: 0.4,
    projectile: {
      speed: 64,
      damage: 5,
      lifeMs: 1600,
      radiusPx: 4,
      color: '#fde68a',
      glowColor: 'rgba(253,230,138,0.8)',
      trailAlpha: 0.3,
    },
    spritePath: '/turret_engines/chicken_eggomat.svg',
    description: 'Rapid egg launcher with low damage and quick travel speed.',
  },
  flame_catapult: {
    id: 'flame_catapult',
    name: 'Flame Catapult',
    age: 1,
    cost: 500,
    buildMs: 2600,
    range: 12,
    protectionMultiplier: 0.99,
    targeting: 'healthiest',
    attackType: 'projectile',
    fireIntervalSec: 2.8,
    projectile: {
      speed: 32,
      damage: 30,
      lifeMs: 2600,
      curvature: -14,
      radiusPx: 7,
      color: '#fb923c',
      glowColor: 'rgba(251,146,60,0.9)',
      trailAlpha: 0.45,
      splitOnImpact: {
        childCount: 6,
        childDamage: 5,
        childSpeed: 24,
        childLifeMs: 900,
        spreadRadius: 3,
      },
    },
    spritePath: '/turret_engines/flame_catapult.svg',
    description: 'Heavy flaming payload that bursts into six burning shards on impact.',
  },

  sunspike_ballista: {
    id: 'sunspike_ballista',
    name: 'Sunspike Ballista',
    age: 2,
    cost: 420,
    buildMs: 1800,
    range: 16,
    protectionMultiplier: 0.99,
    targeting: 'highest_dps',
    attackType: 'projectile',
    fireIntervalSec: 1.4,
    projectile: {
      speed: 58,
      damage: 18,
      lifeMs: 1800,
      pierceCount: 1,
      radiusPx: 4,
      color: '#f8fafc',
      glowColor: 'rgba(248,250,252,0.9)',
      trailAlpha: 0.35,
    },
    spritePath: '/turret_engines/sunspike_ballista.svg',
    description: 'Long bronze bolt that can pierce one extra target.',
  },
  shrapnel_urn_launcher: {
    id: 'shrapnel_urn_launcher',
    name: 'Shrapnel Urn Launcher',
    age: 2,
    cost: 650,
    buildMs: 2500,
    range: 13,
    protectionMultiplier: 0.95,
    targeting: 'healthiest',
    attackType: 'projectile',
    fireIntervalSec: 2.1,
    projectile: {
      speed: 28,
      damage: 22,
      lifeMs: 2200,
      curvature: -10,
      radiusPx: 6,
      color: '#f59e0b',
      glowColor: 'rgba(245,158,11,0.85)',
      trailAlpha: 0.4,
      splashRadius: 1.6,
      splitOnImpact: {
        childCount: 5,
        childDamage: 7,
        childSpeed: 20,
        childLifeMs: 950,
        spreadRadius: 2.4,
      },
    },
    spritePath: '/turret_engines/shrapnel_urn_launcher.svg',
    description: 'Splintering urn that showers clustered enemies with shrapnel.',
  },

  boiling_pot: {
    id: 'boiling_pot',
    name: 'Boiling Pot',
    age: 3,
    cost: 900,
    buildMs: 2300,
    range: 6,
    protectionMultiplier: 0.75,
    targeting: 'nearest',
    attackType: 'oil_pour',
    fireIntervalSec: 5.5,
    oil: { radius: 3, damage: 45, cooldownSeconds: 5.5 },
    spritePath: '/turret_engines/boiling_pot.svg',
    description: 'Pours burning oil onto enemies close to the base, huge defensive aura.',
  },
  repeater_crossbow: {
    id: 'repeater_crossbow',
    name: 'Repeater Crossbow',
    age: 3,
    cost: 700,
    buildMs: 1700,
    range: 14,
    protectionMultiplier: 0.93,
    targeting: 'lowest_health',
    attackType: 'projectile',
    fireIntervalSec: 0.75,
    projectile: { speed: 54, damage: 14, lifeMs: 1700, radiusPx: 4, color: '#e2e8f0', glowColor: 'rgba(226,232,240,0.85)', trailAlpha: 0.3 },
    spritePath: '/turret_engines/repeater_crossbow.svg',
    description: 'Rapid precision bolts for finishing low-health enemies.',
  },
  thunder_javelin: {
    id: 'thunder_javelin',
    name: 'Thunder Javelin',
    age: 3,
    cost: 1050,
    buildMs: 2600,
    range: 15,
    protectionMultiplier: 0.96,
    targeting: 'strongest_ability_dps',
    attackType: 'projectile',
    fireIntervalSec: 1.8,
    projectile: { speed: 48, damage: 34, lifeMs: 2000, radiusPx: 6, color: '#facc15', glowColor: 'rgba(250,204,21,0.85)', trailAlpha: 0.35 },
    spritePath: '/turret_engines/thunder_javelin.svg',
    description: 'Prioritizes high-ability-threat enemies with heavy javelins.',
  },

  piercing_sniper: {
    id: 'piercing_sniper',
    name: 'Piercing Sniper',
    age: 4,
    cost: 1200,
    buildMs: 2400,
    range: 20,
    protectionMultiplier: 0.99,
    targeting: 'highest_dps',
    attackType: 'projectile',
    fireIntervalSec: 2.4,
    projectile: {
      speed: 90,
      damage: 78,
      lifeMs: 2000,
      pierceCount: 3,
      radiusPx: 5,
      color: '#e5e7eb',
      glowColor: 'rgba(229,231,235,0.95)',
      trailAlpha: 0.45,
    },
    spritePath: '/turret_engines/piercing_sniper.svg',
    description: 'High caliber shot that can pierce through multiple enemies.',
  },
  shock_mortar: {
    id: 'shock_mortar',
    name: 'Shock Mortar',
    age: 4,
    cost: 1350,
    buildMs: 2700,
    range: 17,
    protectionMultiplier: 0.94,
    targeting: 'healthiest',
    attackType: 'projectile',
    fireIntervalSec: 2.2,
    projectile: { speed: 36, damage: 44, lifeMs: 2200, curvature: -8, splashRadius: 2.4, radiusPx: 8, color: '#fb7185', glowColor: 'rgba(251,113,133,0.9)', trailAlpha: 0.45 },
    spritePath: '/turret_engines/shock_mortar.svg',
    description: 'Mid-range mortar with broad splash damage.',
  },
  suppressor_nest: {
    id: 'suppressor_nest',
    name: 'Suppressor Nest',
    age: 4,
    cost: 900,
    buildMs: 1800,
    range: 12,
    protectionMultiplier: 0.88,
    targeting: 'nearest',
    attackType: 'projectile',
    fireIntervalSec: 0.35,
    projectile: { speed: 70, damage: 9, lifeMs: 1300, radiusPx: 4, color: '#fca5a5', glowColor: 'rgba(252,165,165,0.8)', trailAlpha: 0.25 },
    spritePath: '/turret_engines/suppressor_nest.svg',
    description: 'Sustained suppressive fire and strong protection radius.',
  },

  kamikaze_drone_hub: {
    id: 'kamikaze_drone_hub',
    name: 'Kamikaze Drone Hub',
    age: 5,
    cost: 2800,
    buildMs: 4200,
    range: 22,
    protectionMultiplier: 0.98,
    targeting: 'strongest_ability_dps',
    attackType: 'drone_swarm',
    fireIntervalSec: 7,
    drones: {
      droneCount: 4,
      droneDamage: 65,
      droneSpeed: 52,
      cooldownSeconds: 7,
    },
    spritePath: '/turret_engines/kamikaze_drone_hub.svg',
    description: 'Launches expensive self-destructing drones at priority threats.',
  },
  lightning_rod: {
    id: 'lightning_rod',
    name: 'Chain Lightning Rod',
    age: 5,
    cost: 1700,
    buildMs: 2600,
    range: 16,
    protectionMultiplier: 0.9,
    targeting: 'highest_dps',
    attackType: 'chain_lightning',
    fireIntervalSec: 5,
    chainLightning: {
      maxTargets: 4,
      initialDamage: 60,
      falloffMultiplier: 0.72,
      cooldownSeconds: 5,
    },
    spritePath: '/turret_engines/lightning_rod.svg',
    description: 'Jumps electricity across multiple enemy targets.',
  },
  artillery_barrage_platform: {
    id: 'artillery_barrage_platform',
    name: 'Artillery Barrage',
    age: 5,
    cost: 2400,
    buildMs: 3500,
    range: 20,
    protectionMultiplier: 0.97,
    targeting: 'nearest',
    attackType: 'artillery_barrage',
    fireIntervalSec: 12,
    artillery: {
      barrageCount: 14,
      spreadRange: 14,
      spreadLaneY: 5,
      startY: 23,
      fallSpeed: -14,
      shellDamage: 28,
      shellRadius: 2.2,
      cooldownSeconds: 12,
    },
    spritePath: '/turret_engines/artillery_barrage_platform.svg',
    description: 'Area-denial barrage over a wide lane sector.',
  },
  flak_array: {
    id: 'flak_array',
    name: 'Flak Array',
    age: 5,
    cost: 1300,
    buildMs: 2200,
    range: 14,
    protectionMultiplier: 0.86,
    targeting: 'lowest_health',
    attackType: 'projectile',
    fireIntervalSec: 0.65,
    projectile: { speed: 62, damage: 16, lifeMs: 1400, splashRadius: 1.1, radiusPx: 4, color: '#fda4af', glowColor: 'rgba(253,164,175,0.85)', trailAlpha: 0.3 },
    spritePath: '/turret_engines/flak_array.svg',
    description: 'Anti-swarm platform with high short-range protection.',
  },

  plasma_lance: {
    id: 'plasma_lance',
    name: 'Plasma Lance',
    age: 6,
    cost: 2200,
    buildMs: 2800,
    range: 24,
    protectionMultiplier: 0.98,
    targeting: 'healthiest',
    attackType: 'projectile',
    fireIntervalSec: 1.8,
    projectile: { speed: 88, damage: 95, lifeMs: 1700, pierceCount: 1, radiusPx: 6, color: '#22d3ee', glowColor: 'rgba(34,211,238,0.95)', trailAlpha: 0.45 },
    spritePath: '/turret_engines/plasma_lance.svg',
    description: 'Long-range plasma bolt with heavy single-target pressure.',
  },
  quantum_laser: {
    id: 'quantum_laser',
    name: 'Quantum Laser',
    age: 6,
    cost: 2600,
    buildMs: 3000,
    range: 26,
    protectionMultiplier: 0.99,
    targeting: 'highest_dps',
    attackType: 'projectile',
    fireIntervalSec: 1.2,
    projectile: { speed: 120, damage: 62, lifeMs: 1400, pierceCount: 2, radiusPx: 5, color: '#67e8f9', glowColor: 'rgba(103,232,249,0.95)', trailAlpha: 0.4 },
    spritePath: '/turret_engines/quantum_laser.svg',
    description: 'Near-instant beam pulses with partial piercing.',
  },
  tesla_obelisk_mk2: {
    id: 'tesla_obelisk_mk2',
    name: 'Tesla Obelisk Mk II',
    age: 6,
    cost: 3000,
    buildMs: 3600,
    range: 20,
    protectionMultiplier: 0.88,
    targeting: 'strongest_ability_dps',
    attackType: 'chain_lightning',
    fireIntervalSec: 4,
    chainLightning: {
      maxTargets: 6,
      initialDamage: 85,
      falloffMultiplier: 0.78,
      cooldownSeconds: 4,
    },
    spritePath: '/turret_engines/tesla_obelisk_mk2.svg',
    description: 'Upgraded chain lightning with broader jumps.',
  },
  orbital_barrage_mk2: {
    id: 'orbital_barrage_mk2',
    name: 'Orbital Barrage Mk II',
    age: 6,
    cost: 3600,
    buildMs: 4200,
    range: 24,
    protectionMultiplier: 0.97,
    targeting: 'healthiest',
    attackType: 'artillery_barrage',
    fireIntervalSec: 10,
    artillery: {
      barrageCount: 22,
      spreadRange: 18,
      spreadLaneY: 6,
      startY: 26,
      fallSpeed: -18,
      shellDamage: 34,
      shellRadius: 2.8,
      cooldownSeconds: 10,
    },
    spritePath: '/turret_engines/orbital_barrage_mk2.svg',
    description: 'Future artillery saturation with higher density and damage.',
  },
};

export function getTurretEngineDef(turretId: string): TurretEngineDef | null {
  return TURRET_ENGINES[turretId] ?? null;
}

export function getTurretEnginesForAge(age: number): Record<string, TurretEngineDef> {
  const result: Record<string, TurretEngineDef> = {};
  for (const [id, def] of Object.entries(TURRET_ENGINES)) {
    if (def.age <= age) {
      result[id] = def;
    }
  }
  return result;
}

export function estimateEngineDps(engine: TurretEngineDef): number {
  if (engine.attackType === 'projectile') {
    const projectile = engine.projectile;
    if (!projectile) return 0;
    const splitDps = projectile.splitOnImpact
      ? (projectile.splitOnImpact.childCount * projectile.splitOnImpact.childDamage) / Math.max(engine.fireIntervalSec, 0.1) * 0.6
      : 0;
    return projectile.damage / Math.max(engine.fireIntervalSec, 0.1) + splitDps;
  }

  if (engine.attackType === 'chain_lightning' && engine.chainLightning) {
    let total = 0;
    let hitDamage = engine.chainLightning.initialDamage;
    for (let i = 0; i < engine.chainLightning.maxTargets; i++) {
      total += hitDamage;
      hitDamage *= engine.chainLightning.falloffMultiplier;
    }
    return total / Math.max(engine.chainLightning.cooldownSeconds, 0.1);
  }

  if (engine.attackType === 'artillery_barrage' && engine.artillery) {
    const volleyDamage = engine.artillery.barrageCount * engine.artillery.shellDamage * 0.45;
    return volleyDamage / Math.max(engine.artillery.cooldownSeconds, 0.1);
  }

  if (engine.attackType === 'oil_pour' && engine.oil) {
    return engine.oil.damage / Math.max(engine.oil.cooldownSeconds, 0.1);
  }

  if (engine.attackType === 'drone_swarm' && engine.drones) {
    return (engine.drones.droneCount * engine.drones.droneDamage) / Math.max(engine.drones.cooldownSeconds, 0.1);
  }

  return 0;
}

export function calculateTurretDefenseStats(base: TurretBaseLike): TurretDefenseStats {
  let totalDps = 0;
  let installedCount = 0;
  let maxRange = 0;
  let totalRange = 0;
  let strongestProtectionMultiplier = 1;

  for (const slot of base.turretSlots) {
    if (!slot.turretId) continue;
    const engine = getTurretEngineDef(slot.turretId);
    if (!engine) continue;

    installedCount += 1;
    totalDps += estimateEngineDps(engine);
    maxRange = Math.max(maxRange, engine.range);
    totalRange += engine.range;
    strongestProtectionMultiplier = Math.min(strongestProtectionMultiplier, engine.protectionMultiplier);
  }

  const avgRange = installedCount > 0 ? totalRange / installedCount : 0;
  const legacyLevelEstimate = Math.min(10, Math.max(0, Math.round(installedCount * 1.5 + totalDps / 35 + avgRange / 6)));

  return {
    installedCount,
    totalDps,
    maxRange,
    avgRange,
    strongestProtectionMultiplier,
    legacyLevelEstimate,
  };
}

export function getProtectionMultiplierAtDistance(base: TurretBaseLike, distanceFromBase: number): number {
  let multiplier = 1;
  for (const slot of base.turretSlots) {
    if (!slot.turretId) continue;
    const engine = getTurretEngineDef(slot.turretId);
    if (!engine) continue;
    if (distanceFromBase <= engine.range) {
      multiplier *= engine.protectionMultiplier;
    }
  }
  return multiplier;
}
