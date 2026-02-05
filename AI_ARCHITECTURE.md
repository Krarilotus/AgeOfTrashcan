# Age of War - Modular AI Architecture

## Overview

The game has been refactored into a modular, configuration-driven architecture that separates:
- **Configuration** (units, game balance, AI parameters)
- **AI Logic** (pluggable behavior strategies)
- **Core Game Engine** (game loop, physics, rendering)

This enables:
- ✅ Easy balance tuning without touching code
- ✅ Multiple AI personalities and strategies
- ✅ Machine learning integration (future)
- ✅ Adaptive AI that learns during gameplay
- ✅ Coordinated attack groups
- ✅ Clear separation of concerns

---

## Directory Structure

```
src/
├── config/
│   ├── units.ts          # All unit definitions and stats
│   ├── gameBalance.ts    # Costs, income, XP, combat parameters
│   └── aiConfig.ts       # AI personalities, tuning, ML config
│
├── ai/
│   ├── AIBehavior.ts     # Interfaces and utility functions
│   ├── AIController.ts   # Main AI orchestrator
│   └── behaviors/
│       ├── BalancedAI.ts   # Well-rounded adaptive strategy
│       ├── AggressiveAI.ts # Constant pressure strategy
│       ├── DefensiveAI.ts  # Turtle and tech rush strategy
│       └── index.ts        # Export all behaviors
│
└── GameEngine.ts         # Core game loop and logic
```

---

## Configuration System

### 1. Units Configuration (`config/units.ts`)

**Purpose**: Define all unit stats, costs, abilities in one place.

```typescript
import { UNIT_DEFS, getUnitsForAge, filterUnits } from './config/units';

// Get all units for current age
const age3Units = getUnitsForAge(3);

// Filter units by criteria
const affordableRangedUnits = filterUnits({
  age: 3,
  maxCost: 200,
  isRanged: true,
  requiresMana: false
});
```

**Key Features**:
- Age-based unit organization
- Skill/ability definitions
- Helper functions for filtering
- Easy to add new units
- Centralized balance tuning

### 2. Game Balance Configuration (`config/gameBalance.ts`)

**Purpose**: All game mechanics and balance parameters.

```typescript
import {
  BASE_CONFIG,
  INCOME_CONFIG,
  XP_CONFIG,
  COMBAT_CONFIG,
  TURRET_CONFIG,
  DIFFICULTY_CONFIG,
  getAgeCost,
  getXpRequired,
  getManaCost,
  getGoldIncome,
  getManaGeneration
} from './config/gameBalance';

// Get age cost
const age3Cost = getAgeCost(3); // Returns 800

// Get difficulty multipliers
const hardMultipliers = DIFFICULTY_CONFIG.HARD;
```

**Configuration Sections**:
- `BASE_CONFIG`: Starting resources, base health
- `INCOME_CONFIG`: Gold/mana generation rates
- `XP_CONFIG`: Experience and aging system
- `COMBAT_CONFIG`: Damage, projectiles, collision
- `TURRET_CONFIG`: Turret stats and scaling
- `DIFFICULTY_CONFIG`: AI difficulty multipliers
- `QUEUE_CONFIG`: Training queue limits
- `GAME_LOOP_CONFIG`: Tick rates and intervals

### 3. AI Configuration (`config/aiConfig.ts`)

**Purpose**: AI personalities, behaviors, and machine learning settings.

```typescript
import {
  AI_PERSONALITIES,
  AI_TUNING,
  ATTACK_GROUPS,
  DEFAULT_ML_CONFIG
} from './config/aiConfig';

// Use a predefined personality
const rusherPersonality = AI_PERSONALITIES.RUSHER;

// Access AI tuning parameters
const threatThresholds = AI_TUNING.threatThresholds;
const goldReserve = AI_TUNING.goldThresholds.minimumReserve;

// Get attack group templates
const earlyRush = ATTACK_GROUPS.EARLY_RUSH;
```

**Key Components**:
- **AI Personalities**: Predefined strategic preferences
  - `RUSHER`: Fast, aggressive, cheap units
  - `BALANCED`: Adaptive, well-rounded
  - `TURTLE`: Defensive, tech-focused
  - `TECH_RUSH`: Economy → powerful late-game units
  - `ADAPTIVE`: Learns and adapts to player

- **AI Tuning**: Decision thresholds and parameters
  - Threat assessment levels
  - Gold/mana thresholds
  - Recruitment parameters
  - Warchest accumulation
  - Turret placement logic
  - Aging decisions
  - Mana upgrade targets

- **Attack Groups**: Coordinated unit compositions
  - Unit role percentages (frontline/ranged/support)
  - Minimum units required
  - Target gold budget
  - Preferred age

- **ML Config**: Neural network settings (for future integration)

---

## AI System

### Architecture

```
┌─────────────────┐
│  GameEngine     │
│  (Game Loop)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AIController   │◄──── Difficulty, Personality
│  (Orchestrator) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  IAIBehavior    │◄──── BalancedAI / AggressiveAI / DefensiveAI
│  (Strategy)     │
└─────────────────┘
```

### AIController

**Main orchestrator** that:
- Manages AI state and strategic assessment
- Delegates decisions to behavior strategy
- Tracks warchest and attack groups
- Provides reward signals for learning
- Handles personality/behavior switching

```typescript
import { AIController, AIControllerFactory } from './ai/AIController';
import { BalancedAI } from './ai/behaviors';

// Create a balanced AI on HARD difficulty
const aiController = AIControllerFactory.createRuleBased(
  'HARD',
  'BALANCED',
  new BalancedAI()
);

// Make decisions
const gameState = extractGameState(); // From GameEngine
const decision = aiController.makeDecision(gameState, currentTime);

// Execute decision
executeAIDecision(decision);

// Provide rewards for learning
aiController.provideReward(10); // Positive reward
```

### AI Behaviors

Each behavior implements the `IAIBehavior` interface:

```typescript
interface IAIBehavior {
  getName(): string;
  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision;
  update?(state: GameStateSnapshot, reward?: number): void;
  reset?(): void;
  getParameters?(): Record<string, any>;
  setParameters?(params: Record<string, any>): void;
}
```

**AIDecision** actions:
- `WAIT`: Do nothing
- `RECRUIT_UNIT`: Recruit a specific unit
- `AGE_UP`: Advance to next age
- `UPGRADE_MANA`: Upgrade mana generation
- `BUILD_TURRET`: Build/upgrade turret
- `ACTIVATE_SKILL`: Use a unit skill
- `EXECUTE_ATTACK_GROUP`: Execute coordinated attack

#### 1. BalancedAI

**Strategy**: Adaptive, well-rounded approach.

**Priorities**:
1. Desperate defense if base health < 30%
2. Age up when resources available
3. Mana upgrades to target levels
4. Build turrets for defense
5. Recruit units (attack groups or singles)

**Key Features**:
- Adjusts preferences based on threat level
- Uses attack groups for coordinated pushes
- Balances economy and military
- Adapts composition to situation

#### 2. AggressiveAI

**Strategy**: Relentless offensive pressure.

**Priorities**:
1. Emergency defense only if critical (base < 20%)
2. Age up only with excess gold (>800g)
3. Mana upgrades only with excess gold (>500g)
4. PRIMARY FOCUS: Recruit units constantly

**Key Features**:
- Spends 90% of gold on units
- Prefers fast, aggressive units
- Low priority on turrets/economy
- Never stops attacking

#### 3. DefensiveAI

**Strategy**: Turtle, build economy, then tech push.

**Priorities**:
1. Age up ASAP (tech advantage)
2. Mana upgrades (strong economy)
3. Build turrets (max 3)
4. Recruit only when threatened
5. Build extra budget on top of Warchest for bigger pushes

**Key Features**:
- saves gold for pushes
- Builds warchest for aging up over time based on income
- Executes massive coordinated push
- Prefers tanks and mana units
- Dynamic Turret investment based on enemy threat level

### GameStateSnapshot

AI behaviors receive a comprehensive game state:

```typescript
interface GameStateSnapshot {
  // Own resources
  gold, mana, age, manaLevel, xp, baseHealth, unitCount, queueSize, turretCount
  
  // Own units (array with type, health, position, isRanged)
  units: Array<{type, health, position, isRanged}>
  
  // Enemy state
  enemyGold, enemyMana, enemyAge, enemyBaseHealth, enemyUnitCount, enemyTurretCount
  enemyUnits: Array<{...}>
  
  // Battlefield
  battlefieldWidth, averageEnemyPosition, averageOwnPosition
  
  // Time tracking
  gameTimeMs, timeSinceLastAging, timeSinceLastRecruitment, timeSinceLastTurret
  
  // Difficulty
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER'
}
```

### Utility Functions

`AIBehaviorUtils` provides helper functions:

```typescript
// Assess threat level
const threat = AIBehaviorUtils.assessThreat(state);
// Returns: MINIMAL | LOW | MODERATE | HIGH | CRITICAL

// Get strategic state
const strategy = AIBehaviorUtils.getStrategicState(state, threat);
// Returns: EARLY_GAME | MID_GAME | LATE_GAME | ECONOMY | MILITARY | PUSHING | DEFENDING | DESPERATE

// Calculate available budget
const budget = AIBehaviorUtils.calculateAvailableBudget(gold, savingsRate, minimumReserve);

// Score a unit for recruitment
const score = AIBehaviorUtils.scoreUnit(unitDef, unitType, personality, state);

// Find best unit to recruit
const bestUnit = AIBehaviorUtils.findBestUnit(availableUnits, maxCost, personality, state);

// Check if should age up
const shouldAge = AIBehaviorUtils.shouldAgeUp(state, personality, ageCost, threat);

// Check if should upgrade mana
const shouldMana = AIBehaviorUtils.shouldUpgradeMana(state, personality, manaCost, targetLevel, threat);
```

---

## Integration with GameEngine

### Step 1: Import Configuration Modules

```typescript
import { UNIT_DEFS } from './config/units';
import {
  BASE_CONFIG,
  INCOME_CONFIG,
  XP_CONFIG,
  COMBAT_CONFIG,
  TURRET_CONFIG,
  DIFFICULTY_CONFIG,
  getAgeCost,
  getManaCost,
  getGoldIncome,
  getManaGeneration
} from './config/gameBalance';
```

### Step 2: Initialize AIController

```typescript
import { AIController, AIControllerFactory } from './ai/AIController';
import { BalancedAI, AggressiveAI, DefensiveAI } from './ai/behaviors';

class GameEngine {
  private aiController: AIController;
  
  constructor(config: GameConfig, seed: number, callbacks: GameCallbacks) {
    // ... existing initialization ...
    
    // Create AI based on difficulty and desired behavior
    this.aiController = AIControllerFactory.createRuleBased(
      config.difficulty,
      'BALANCED', // or 'RUSHER', 'TURTLE', 'ADAPTIVE'
      new BalancedAI() // or new AggressiveAI(), new DefensiveAI()
    );
  }
}
```

### Step 3: Replace AI Logic with Controller Calls

```typescript
private updateEnemyAI(): void {
  // Extract game state for AI
  const gameState = this.extractGameStateForAI();
  
  // Get AI decision
  const decision = this.aiController.makeDecision(gameState, Date.now());
  
  // Execute decision
  this.executeAIDecision(decision);
  
  // Provide reward signals (for learning)
  this.provideAIRewards();
}

private extractGameStateForAI(): GameStateSnapshot {
  const playerUnits = Array.from(this.state.entities.values())
    .filter(e => e.owner === 'PLAYER')
    .map(e => ({
      type: e.unitId,
      health: e.health.current,
      position: e.transform.x,
      isRanged: (UNIT_DEFS[e.unitId]?.range ?? 1) > 1.5
    }));
  
  const enemyUnits = Array.from(this.state.entities.values())
    .filter(e => e.owner === 'ENEMY')
    .map(e => ({
      type: e.unitId,
      health: e.health.current,
      position: e.transform.x,
      isRanged: (UNIT_DEFS[e.unitId]?.range ?? 1) > 1.5
    }));
  
  return {
    // Own state
    gold: this.state.economy.enemy.gold,
    mana: this.state.economy.enemy.mana,
    age: this.state.progression.enemy.age,
    manaLevel: this.state.progression.enemy.manaGenerationLevel,
    xp: 0, // Calculate from progression
    xpRequired: 0, // Calculate from age
    baseHealth: this.state.enemyBase.health,
    maxBaseHealth: this.state.enemyBase.maxHealth,
    unitCount: enemyUnits.length,
    units: enemyUnits,
    queueSize: this.state.enemyQueue.length,
    turretCount: this.state.enemyBase.turretLevel,
    
    // Enemy (player) state
    enemyGold: this.state.economy.player.gold,
    enemyMana: this.state.economy.player.mana,
    enemyAge: this.state.progression.player.age,
    enemyBaseHealth: this.state.playerBase.health,
    enemyMaxBaseHealth: this.state.playerBase.maxHealth,
    enemyUnitCount: playerUnits.length,
    enemyUnits: playerUnits,
    enemyTurretCount: this.state.playerBase.turretLevel,
    
    // Battlefield
    battlefieldWidth: this.state.battlefield.width,
    averageEnemyPosition: playerUnits.length > 0 
      ? playerUnits.reduce((sum, u) => sum + u.position, 0) / playerUnits.length 
      : 0,
    averageOwnPosition: enemyUnits.length > 0
      ? enemyUnits.reduce((sum, u) => sum + u.position, 0) / enemyUnits.length
      : this.state.battlefield.width,
    
    // Time
    gameTimeMs: this.state.tick * (FIXED_TIMESTEP),
    timeSinceLastAging: 0,
    timeSinceLastRecruitment: 0,
    timeSinceLastTurret: 0,
    
    // Difficulty
    difficulty: this.config.difficulty
  };
}

private executeAIDecision(decision: AIDecision): void {
  switch (decision.action) {
    case 'RECRUIT_UNIT':
      const params = decision.parameters as RecruitUnitParams;
      this.queueUnit('ENEMY', params.unitType);
      break;
      
    case 'AGE_UP':
      this.upgradeAge('ENEMY');
      break;
      
    case 'UPGRADE_MANA':
      this.upgradeManaGeneration('ENEMY');
      break;
      
    case 'BUILD_TURRET':
      this.upgradeTurret('ENEMY');
      break;
      
    case 'WAIT':
      // Do nothing
      break;
  }
}
```

---

## Machine Learning Integration (Future)

The architecture is designed to support neural network AI:

### 1. Create ML Behavior

```typescript
class MLBehavior implements IAIBehavior {
  private neuralNetwork: NeuralNetwork;
  private replayBuffer: ExperienceBuffer;
  
  constructor(mlConfig: MLConfig) {
    this.neuralNetwork = new NeuralNetwork(mlConfig);
    this.replayBuffer = new ExperienceBuffer(mlConfig.replayBufferSize);
  }
  
  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision {
    // Extract features from game state
    const features = this.extractFeatures(state);
    
    // Neural network forward pass
    const actionProbabilities = this.neuralNetwork.forward(features);
    
    // Epsilon-greedy exploration
    const action = this.selectAction(actionProbabilities);
    
    return {
      action: action.type,
      parameters: action.params,
      confidence: action.probability
    };
  }
  
  update(state: GameStateSnapshot, reward: number): void {
    // Store experience
    this.replayBuffer.add(this.lastState, this.lastAction, reward, state);
    
    // Train network
    if (this.replayBuffer.size() >= this.mlConfig.batchSize) {
      const batch = this.replayBuffer.sample(this.mlConfig.batchSize);
      this.neuralNetwork.train(batch);
    }
  }
}
```

### 2. Use ML AI

```typescript
import { DEFAULT_ML_CONFIG } from './config/aiConfig';

const mlBehavior = new MLBehavior(DEFAULT_ML_CONFIG);
const aiController = AIControllerFactory.createAdaptive(
  'HARD',
  mlBehavior
);
```

---

## Balance Tuning Guide

### Tuning Unit Stats

**File**: `src/config/units.ts`

```typescript
// Increase robot soldier damage
robot_soldier: {
  cost: 300,
  health: 800,
  damage: 80, // Was 65
  speed: 7.5,
  // ...
}
```

### Tuning Game Mechanics

**File**: `src/config/gameBalance.ts`

```typescript
// Increase gold income
export const INCOME_CONFIG = {
  baseGoldPerSecond: 4, // Was 3
  // ...
};

// Adjust collision distances
export const COMBAT_CONFIG = {
  collision: {
    enemyBlockRanged: 0.5, // Was 0.3
    // ...
  }
};
```

### Tuning AI Behavior

**File**: `src/config/aiConfig.ts`

```typescript
// Make AI more aggressive
export const AI_TUNING = {
  threatThresholds: {
    high: 1.5, // Was 2.0 - AI reacts to threats sooner
    // ...
  },
  
  recruitment: {
    minStackSize: 3, // Was 2 - bigger coordinated pushes
    stackBudgetMultiplier: 0.8, // Was 0.7 - spend more per push
    // ...
  }
};
```

### Creating Custom AI Personality

```typescript
export const AI_PERSONALITIES = {
  // ... existing personalities ...
  
  CUSTOM_AGGRESSIVE: {
    name: 'Custom Aggressive',
    meleePreference: 0.9,
    rangedPreference: 0.1,
    fastPreference: 1.0,
    tankPreference: 0.2,
    manaUnitPreference: 0.0,
    savingsRate: 0.0, // Spend everything
    ageUpPriority: 0.1, // Low priority
    manaUpgradePriority: 0.0, // No mana upgrades
    aggression: 1.0,
    stackSizePreference: 0.3, // Constant stream vs big pushes
    turretPreference: 0.0, // No turrets
    adaptiveness: 0.2,
    learningRate: 0.1,
  }
};
```

---

## Testing

### Test Different AI Behaviors

```typescript
// In GameEngine or test file
const behaviors = [
  new BalancedAI(),
  new AggressiveAI(),
  new DefensiveAI()
];

for (const behavior of behaviors) {
  const ai = AIControllerFactory.createRuleBased('MEDIUM', 'BALANCED', behavior);
  // Run game and observe behavior
}
```

### Test Different Difficulties

```typescript
const difficulties = ['EASY', 'MEDIUM', 'HARD', 'CHEATER'] as const;

for (const difficulty of difficulties) {
  const ai = AIControllerFactory.createRuleBased(difficulty, 'BALANCED', new BalancedAI());
  // Run game and measure performance
}
```

### Debug AI Decisions

```typescript
const decision = aiController.makeDecision(gameState, currentTime);
console.log(`AI Decision: ${decision.action}`);
console.log(`Reasoning: ${decision.reasoning}`);
console.log(`Confidence: ${decision.confidence}`);
console.log(`Parameters:`, decision.parameters);
```

---

## Migration Checklist

- [x] Create `config/units.ts` with all unit definitions
- [x] Create `config/gameBalance.ts` with game mechanics
- [x] Create `config/aiConfig.ts` with AI personalities and tuning
- [x] Create `ai/AIBehavior.ts` with interfaces and utilities
- [x] Create `ai/AIController.ts` as main orchestrator
- [x] Create `ai/behaviors/BalancedAI.ts`
- [x] Create `ai/behaviors/AggressiveAI.ts`
- [x] Create `ai/behaviors/DefensiveAI.ts`
- [ ] Update `GameEngine.ts` to import configuration modules
- [ ] Replace AI logic in `GameEngine.ts` with `AIController` calls
- [ ] Remove old `UNIT_DEFS` from `GameEngine.ts`
- [ ] Remove old difficulty modifiers from `GameEngine.ts`
- [ ] Test AI recruitment and behavior
- [ ] Verify game balance is unchanged
- [ ] Test save/load compatibility

---

## Benefits

### Before Refactor
- ❌ All logic in 2700+ line GameEngine file
- ❌ Hard to tune balance (scattered constants)
- ❌ Single monolithic AI behavior
- ❌ Difficult to add new strategies
- ❌ No ML integration path
- ❌ Hard to test and debug

### After Refactor
- ✅ Clear separation of concerns
- ✅ Configuration-driven balance tuning
- ✅ Pluggable AI behaviors
- ✅ Easy to add new strategies
- ✅ ML-ready architecture
- ✅ Unit testable components
- ✅ Coordinated attack groups
- ✅ Adaptive AI personalities
- ✅ Comprehensive debugging info

---

## Next Steps

1. **Complete Integration**: Update GameEngine to use new modules
2. **Test**: Verify AI recruitment and behavior
3. **Balance**: Tune parameters using config files
4. **Extend**: Add new AI behaviors (e.g., EconomyRushAI, CounterAI)
5. **ML**: Implement neural network behavior
6. **UI**: Add AI personality selector in game menu
7. **Analytics**: Track AI performance metrics

---

## Support

For questions or issues with the modular architecture:
1. Check this README
2. Review code comments in config/AI files
3. Use `getParameters()` for debugging AI state
4. Enable console logging for AI decisions
