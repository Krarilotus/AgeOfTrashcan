/**
 * AI Configuration and Parameters
 * Define AI behavior patterns, decision thresholds, and learning parameters
 */

/**
 * AI personality defines high-level strategic preferences
 */
export interface AIPersonality {
  name: string;
  
  // Unit composition preferences (0.0 to 1.0)
  meleePreference: number; // Prefer melee-heavy units
  rangedPreference: number; // Prefer ranged units
  fastPreference: number; // Prefer fast/mobile units
  tankPreference: number; // Prefer high-HP units
  manaUnitPreference: number; // Prefer mana-costing special units
  
  // Economic preferences
  savingsRate: number; // How much to save vs spend (0.0 = spend all, 1.0 = save all)
  ageUpPriority: number; // How quickly to age up (0.0 = never, 1.0 = ASAP)
  manaUpgradePriority: number; // Priority for mana upgrades (0.0 = never, 1.0 = always)
  
  // Tactical preferences
  aggression: number; // How aggressively to push (0.0 = defensive, 1.0 = all-out)
  stackSizePreference: number; // Prefer large coordinated pushes vs constant pressure
  turretPreference: number; // How much to invest in turrets
  
  // Adaptive behavior
  adaptiveness: number; // How much to adapt to player strategy (0.0 = rigid, 1.0 = highly adaptive)
  learningRate: number; // For ML: how quickly to update strategy (0.0 = no learning, 1.0 = fast learning)
}

/**
 * Predefined AI personalities
 */
export const AI_PERSONALITIES: Record<string, AIPersonality> = {
  RUSHER: {
    name: 'Rusher',
    meleePreference: 0.8,
    rangedPreference: 0.2,
    fastPreference: 0.9,
    tankPreference: 0.1,
    manaUnitPreference: 0.0,
    savingsRate: 0.1,
    ageUpPriority: 0.3,
    manaUpgradePriority: 0.0,
    aggression: 1.0,
    stackSizePreference: 0.4,
    turretPreference: 0.1,
    adaptiveness: 0.3,
    learningRate: 0.1,
  },
  
  BALANCED: {
    name: 'Balanced',
    meleePreference: 0.5,
    rangedPreference: 0.5,
    fastPreference: 0.5,
    tankPreference: 0.5,
    manaUnitPreference: 0.5,
    savingsRate: 0.4,
    ageUpPriority: 0.6,
    manaUpgradePriority: 0.5,
    aggression: 0.5,
    stackSizePreference: 0.6,
    turretPreference: 0.4,
    adaptiveness: 0.6,
    learningRate: 0.3,
  },
  
  TURTLE: {
    name: 'Turtle',
    meleePreference: 0.3,
    rangedPreference: 0.7,
    fastPreference: 0.2,
    tankPreference: 0.9,
    manaUnitPreference: 0.3,
    savingsRate: 0.7,
    ageUpPriority: 0.9,
    manaUpgradePriority: 0.8,
    aggression: 0.2,
    stackSizePreference: 0.3,
    turretPreference: 0.9,
    adaptiveness: 0.4,
    learningRate: 0.2,
  },
  
  TECH_RUSH: {
    name: 'Tech Rusher',
    meleePreference: 0.2,
    rangedPreference: 0.6,
    fastPreference: 0.4,
    tankPreference: 0.3,
    manaUnitPreference: 0.9,
    savingsRate: 0.8,
    ageUpPriority: 1.0,
    manaUpgradePriority: 1.0,
    aggression: 0.3,
    stackSizePreference: 0.8,
    turretPreference: 0.2,
    adaptiveness: 0.5,
    learningRate: 0.4,
  },
  
  ADAPTIVE: {
    name: 'Adaptive',
    meleePreference: 0.5,
    rangedPreference: 0.5,
    fastPreference: 0.5,
    tankPreference: 0.5,
    manaUnitPreference: 0.5,
    savingsRate: 0.5,
    ageUpPriority: 0.5,
    manaUpgradePriority: 0.5,
    aggression: 0.5,
    stackSizePreference: 0.5,
    turretPreference: 0.5,
    adaptiveness: 1.0,
    learningRate: 0.8,
  },
};

/**
 * AI decision thresholds and tuning parameters
 */
export const AI_TUNING = {
  // State transition thresholds
  threatThresholds: {
    minimal: 0.3, // Enemy has <30% of our units
    low: 0.7, // Enemy has <70% of our units
    moderate: 1.2, // Enemy has >120% of our units
    high: 2.0, // Enemy has >200% of our units
    critical: 3.0, // Enemy has >300% of our units
  },
  
  // Unit recruitment parameters
  recruitment: {
    minStackSize: 2, // Minimum units in a coordinated push (increased from 2)
    maxStackSize: 20, // Maximum units in a single push
    stackBudgetMultiplier: 1.0, // Use 100% of available gold for stacks
    
    // Difficulty-based stack size multipliers
    // Lowered these values to make AI more active (was 2.5, 3.5, 4.5, 5.5)
    // Since we now have strict Warchest logic, we don't need to force huge savings here too.
    difficultyStackMultipliers: {
      EASY: 1.5,    // Wait for 1.5x average unit cost
      MEDIUM: 2.0,  // Wait for 2.0x average unit cost
      HARD: 2.5,    // Wait for 2.5x average unit cost
      SMART: 2.2,   // Planner AI keeps pressure while still staging coordinated waves
      SMART_ML: 2.2, // ML policy parity with SMART baseline pacing
      CHEATER: 1.0, // Cheater just spams (1.0x)
    },
    
    // Recruitment frequency (ms between recruitment attempts)
    decisionIntervalMs: 500,
  },
  
  // Warchest accumulation (saving for big age ups!)
  // Now uses a "Tax" system: AI reserves a % of its income for aging
  warchest: {
    enabled: true,
    baseTaxRate: 0.35, // Invest 35% of income into future tech (Age Up)
    difficultyTaxMultipliers: {
      EASY: 0.6,    // Weak economy management
      MEDIUM: 1.0,  // Standard
      HARD: 1.25,   // Efficient saving
      SMART: 1.0,   // Same macro reserve behavior as medium economy profile
      SMART_ML: 1.0, // Same reserve behavior as SMART
      CHEATER: 1.5, // Rapid tech up
    },
  },
  
  // Turret placement
  turret: {
    maxTurrets: 4,
    placementInterval: 15000, // 15 seconds between turret builds
    minGoldMultiplier: 1.5, // Need 2x turret cost before building
  },
  
  // Age advancement
  aging: {
    requireGoldPercent: 1.0, // Need 100% of gold cost (no XP system in game)
    delayAfterAgingMs: 3000, // Wait 3s after aging before major actions
  },
  
  // Mana upgrades
  manaUpgrades: {
    // Progressive mana level targets by age
    // Age 1: 0, Age 2: 1, Age 3: 3, Age 4: 5, Age 5: 8, Age 6: 40 (Maxed)
    targetLevelsByAge: [0, 0, 1, 3, 5, 8, 40], 
    priorityWhenBelowTarget: 0.8, // High priority when behind target
    priorityWhenAtTarget: 0.1, // Low priority when at target
  },
};

/**
 * Machine Learning Configuration
 * For future neural network integration
 */
export interface MLConfig {
  enabled: boolean;
  
  // Neural network architecture
  inputSize: number; // Number of game state features
  hiddenLayers: number[];
  outputSize: number; // Number of possible actions
  
  // Training parameters
  learningRate: number;
  discountFactor: number; // For reward calculation
  explorationRate: number; // Epsilon for epsilon-greedy
  explorationDecay: number;
  minExplorationRate: number;
  
  // Experience replay
  replayBufferSize: number;
  batchSize: number;
  
  // Reward shaping
  rewards: {
    killUnit: number;
    loseUnit: number;
    damageBase: number;
    takeDamage: number;
    ageUp: number;
    winGame: number;
    loseGame: number;
  };
}

export const DEFAULT_ML_CONFIG: MLConfig = {
  enabled: false, // Disabled by default
  
  inputSize: 50, // Game state features (unit counts, gold, mana, etc.)
  hiddenLayers: [128, 64, 32],
  outputSize: 10, // Actions: recruit unit types, age up, build turret, etc.
  
  learningRate: 0.001,
  discountFactor: 0.95,
  explorationRate: 1.0,
  explorationDecay: 0.995,
  minExplorationRate: 0.05,
  
  replayBufferSize: 10000,
  batchSize: 32,
  
  rewards: {
    killUnit: 10,
    loseUnit: -10,
    damageBase: 1,
    takeDamage: -1,
    ageUp: 50,
    winGame: 1000,
    loseGame: -1000,
  },
};

/**
 * Attack group configuration
 * Defines coordinated unit groups for strategic pushes
 */
export interface AttackGroup {
  name: string;
  composition: {
    frontline: number; // Percentage of melee/tank units (0.0 to 1.0)
    ranged: number; // Percentage of ranged units
    support: number; // Percentage of support/special units
  };
  minUnits: number; // Minimum units before executing
  targetGoldCost: number; // Target total cost for the group
  preferredAge: number; // Preferred age to execute this strategy
}

export const ATTACK_GROUPS: Record<string, AttackGroup> = {
  EARLY_RUSH: {
    name: 'Early Rush',
    composition: { frontline: 0.6, ranged: 0.4, support: 0.0 },
    minUnits: 4, // Wait for proper composition
    targetGoldCost: 0, // Will be calculated from actual unit costs
    preferredAge: 1,
  },
  
  BALANCED_PUSH: {
    name: 'Balanced Push',
    composition: { frontline: 0.4, ranged: 0.4, support: 0.2 },
    minUnits: 4,
    targetGoldCost: 0, // Calculated dynamically
    preferredAge: 3,
  },
  
  RANGED_SIEGE: {
    name: 'Ranged Siege',
    composition: { frontline: 0.2, ranged: 0.6, support: 0.2 },
    minUnits: 4,
    targetGoldCost: 0, // Calculated dynamically
    preferredAge: 4,
  },
  
  TANK_WAVE: {
    name: 'Tank Wave',
    composition: { frontline: 0.7, ranged: 0.2, support: 0.1 },
    minUnits: 4,
    targetGoldCost: 0, // Calculated dynamically
    preferredAge: 5,
  },
  
  ENDGAME_ASSAULT: {
    name: 'Endgame Assault',
    composition: { frontline: 0.3, ranged: 0.4, support: 0.3 },
    minUnits: 5,
    targetGoldCost: 0, // Calculated dynamically
    preferredAge: 6,
  },
};
