# AI System Architecture - Interface for Symbolic & ML Agents

## Overview

The AI system is designed with a **clean, pluggable interface** that supports both **symbolic (rule-based)** AI and **machine learning** (e.g., PPO reinforcement learning) agents. All AI implementations share the same interface and have access to the complete game state.

## Core Interface: `IAIBehavior`

All AI agents (symbolic or ML) implement this interface:

```typescript
interface IAIBehavior {
  /**
   * Main decision function - called every AI tick (~200ms)
   * @param state - Complete observable game state snapshot
   * @param personality - AI personality parameters (optional for ML)
   * @returns AIDecision - Action to execute
   */
  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision;
  
  /**
   * Get behavior name
   */
  getName(): string;
  
  /**
   * Reset internal state (called on new game)
   */
  reset(): void;
  
  /**
   * Get internal parameters (for debugging/logging)
   */
  getParameters(): Record<string, any>;
}
```

## Game State Snapshot

The `GameStateSnapshot` provides **complete observability** of the game:

### Economy (8 fields)
- `playerGold`, `enemyGold` - Current gold reserves
- `playerMana`, `enemyMana` - Current mana reserves
- `playerGoldIncome`, `enemyGoldIncome` - Gold/second
- `playerManaIncome`, `enemyManaIncome` - Mana/second

### Progression (6 fields)
- `playerAge`, `enemyAge` - Current age (1-6)
- `playerAgeCost`, `enemyAgeCost` - Gold cost to age up
- `playerManaLevel`, `enemyManaLevel` - Mana generation level

### Bases & Defenses (6 fields)
- `playerBaseHealth`, `playerBaseMaxHealth` - Player base HP
- `enemyBaseHealth`, `enemyBaseMaxHealth` - Enemy base HP
- `playerTurretLevel`, `enemyTurretLevel` - Turret levels (0-10)

### Units (6 fields)
- `playerUnitCount`, `enemyUnitCount` - Total unit counts
- `playerUnits[]`, `enemyUnits[]` - Detailed unit arrays with:
  - `unitId` - Unit type identifier
  - `health`, `maxHealth` - HP values
  - `position` - X coordinate on battlefield
  - `damage`, `range` - Combat stats

### Queues (2 fields)
- `playerQueueSize`, `enemyQueueSize` - Units in training queue

### Battlefield (3 fields)
- `battlefieldWidth` - Total battlefield size
- `playerBaseX`, `enemyBaseX` - Base positions

### Tactical Analysis (2 fields)
- `playerUnitsNearEnemyBase` - Units within 15 units of enemy base
- `enemyUnitsNearPlayerBase` - Units within 15 units of player base

### Meta (3 fields)
- `tick` - Game tick counter
- `gameTime` - Elapsed game time in seconds
- `difficulty` - Difficulty level ('EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'CHEATER')

**Total: 36 observable state fields** - Everything needed for decision-making!

## Action Space: `AIDecision`

AI agents return decisions with this structure:

```typescript
interface AIDecision {
  action: 'RECRUIT_UNIT' | 'AGE_UP' | 'UPGRADE_MANA' | 'UPGRADE_TURRET_SLOTS' | 'BUY_TURRET_ENGINE' | 'SELL_TURRET_ENGINE' | 'WAIT';
  reasoning?: string;  // Optional for debugging
  parameters?: any;    // Action-specific parameters
}
```

### Action Types:

1. **RECRUIT_UNIT** - Train a unit
   ```typescript
   {
     action: 'RECRUIT_UNIT',
     parameters: {
       unitType: 'clubman' | 'bowman' | 'knight' | ...,  // 30+ unit types
       priority: 'low' | 'normal' | 'high' | 'emergency'
     }
   }
   ```

2. **AGE_UP** - Advance to next age
   ```typescript
   { action: 'AGE_UP', reasoning: 'Tech advantage' }
   ```

3. **UPGRADE_MANA** - Increase mana generation
   ```typescript
   { action: 'UPGRADE_MANA', reasoning: 'Economy boost' }
   ```

4. **UPGRADE_TURRET_SLOTS** - Unlock next mounted turret slot
   ```typescript
   { action: 'UPGRADE_TURRET_SLOTS', reasoning: 'Unlock slot 3 for more defense coverage' }
   ```
5. **BUY_TURRET_ENGINE** - Buy and queue an engine for a specific slot
   ```typescript
   { action: 'BUY_TURRET_ENGINE', parameters: { slotIndex: 1, turretId: 'lightning_rod' } }
   ```
6. **SELL_TURRET_ENGINE** - Sell a mounted engine in a specific slot
   ```typescript
   { action: 'SELL_TURRET_ENGINE', parameters: { slotIndex: 0 } }
   ```

5. **WAIT** - Do nothing this tick
   ```typescript
   { action: 'WAIT', reasoning: 'Saving resources' }
   ```

## Current Implementations

### 1. **BalancedAI** (Default - Sophisticated Symbolic)
- **Features:**
  - Warchest system for strategic resource allocation
  - Difficulty-based stack multipliers (Easy: 2x, Hard: 3x, Cheater: 4x)
  - Emergency spending when base < 25% health
  - Threat-based turret upgrading
  - Dynamic age-gap adjusted warchest
  - Smart unit composition planning

- **Preserved from original monolithic AI:**
  - Warchest formula: `timeSinceLastAgeUp * goldIncome * difficultyMultiplier * timeMultiplier * ageMultiplier`
  - Threat calculation: `playerAge + (playerUnits / 10)`
  - Emergency detection: base health < 25%

### 2. **AggressiveAI** (Relentless Pressure)
- High aggression, low savings rate
- Spends 90% of gold immediately
- Prioritizes fast units (speed > tanks)
- Only ages up with excess gold
- Minimal turret investment

### 3. **DefensiveAI** (Turtle & Tech)
- High savings rate, builds warchest
- Prioritizes age-ups and mana upgrades
- Heavy turret investment
- Waits for overwhelming tech advantage
- Big push with warchest when ready

## AI Controller Architecture

```
AIController (Orchestrator)
    |
    â”œâ”€â”€ IAIBehavior (Pluggable Strategy)
    |      â”œâ”€â”€ BalancedAI (symbolic)
    |      â”œâ”€â”€ AggressiveAI (symbolic)
    |      â”œâ”€â”€ DefensiveAI (symbolic)
    |      â””â”€â”€ PPO_AI (ML - future)
    |
    â””â”€â”€ GameStateSnapshot (observation)
            â†“
        AIDecision (action)
            â†“
        GameEngine.executeAIDecision()
```

## Integrating Machine Learning (PPO)

To add an ML-based agent, implement `IAIBehavior`:

```typescript
export class PPO_AI implements IAIBehavior {
  private model: tf.LayersModel;  // TensorFlow model
  private memory: Experience[] = [];
  
  constructor(modelPath?: string) {
    // Load pre-trained model or initialize random
    this.model = modelPath 
      ? await tf.loadLayersModel(modelPath)
      : this.createNetwork();
  }
  
  decide(state: GameStateSnapshot, personality: AIPersonality): AIDecision {
    // Convert state to tensor
    const stateTensor = this.stateToTensor(state);
    
    // Forward pass through network
    const [actionProbs, value] = this.model.predict(stateTensor);
    
    // Sample action from policy
    const action = this.sampleAction(actionProbs);
    
    // Store experience for training
    this.memory.push({ state, action, value });
    
    return this.actionToDecision(action, state);
  }
  
  private stateToTensor(state: GameStateSnapshot): tf.Tensor {
    // Normalize 36-field state vector
    return tf.tensor([
      state.enemyGold / 10000,           // 0-1 range
      state.enemyMana / 1000,
      state.enemyAge / 6,
      state.enemyBaseHealth / state.enemyBaseMaxHealth,
      state.playerUnitCount / 20,
      state.enemyUnitCount / 20,
      // ... all 36 fields normalized
    ]);
  }
  
  private actionToDecision(actionIdx: number, state: GameStateSnapshot): AIDecision {
    // Map discrete action index to game action
    // E.g., actions 0-29: recruit units, 30: age up, 31: mana, 32: turret, 33: wait
    if (actionIdx < 30) {
      const units = getUnitsForAge(state.enemyAge);
      const unitType = Object.keys(units)[actionIdx];
      return { action: 'RECRUIT_UNIT', parameters: { unitType } };
    }
    // ... handle other actions
  }
  
  train(rewards: number[]) {
    // PPO training loop
    // Calculate advantages, policy loss, value loss
    // Update model weights
  }
  
  getName() { return 'PPO_AI'; }
  reset() { this.memory = []; }
  getParameters() { return { modelLayers: this.model.layers.length }; }
}
```

### ML Training Setup:

```typescript
// In AIController or dedicated training script
const mlAI = new PPO_AI();
const aiController = new AIController({
  difficulty: 'HARD',
  personality: AI_PERSONALITIES.BALANCED,
  behavior: mlAI  // Use ML agent
});

// Training loop
for (let episode = 0; episode < 10000; episode++) {
  gameEngine.reset();
  
  while (!gameEngine.isGameOver()) {
    gameEngine.update(FIXED_TIMESTEP);
  }
  
  // Calculate rewards (e.g., +1 for win, -1 for loss, +0.01 per damage dealt)
  const rewards = calculateRewards(gameEngine.getHistory());
  mlAI.train(rewards);
  
  if (episode % 100 === 0) {
    console.log(`Episode ${episode}: Win rate ${mlAI.getWinRate()}`);
    mlAI.saveModel(`models/ppo_ai_ep${episode}.h5`);
  }
}
```

## Switching AI Behaviors at Runtime

```typescript
// Easy: swap behavior in AIController
const controller = new AIController({
  difficulty: 'HARD',
  personality: AI_PERSONALITIES.BALANCED,
  behavior: new BalancedAI()  // Start with symbolic
});

// Later: switch to ML
controller.setBehavior(new PPO_AI('models/trained_ppo.h5'));

// Or use factory
const controller = AIControllerFactory.createRuleBased('HARD', 'BALANCED', new AggressiveAI());
const mlController = AIControllerFactory.createMLBased('HARD', new PPO_AI());
```

## State Extraction Pipeline

```
GameEngine.state (full internal state)
    â†“
extractGameStateForAI() 
    â†“
GameStateSnapshot (36 observable fields)
    â†“
IAIBehavior.decide()
    â†“
AIDecision
    â†“
GameEngine.executeAIDecision()
    â†“
Game state updated
```

## Key Design Principles

1. **Complete Observability:** AI sees everything it needs - no hidden information
2. **Clean Separation:** AI logic isolated from game engine
3. **Stateless Interface:** `decide()` is pure function (internal state allowed in implementation)
4. **Action Validation:** Game engine validates actions (AI doesn't need to check gold/mana)
5. **Pluggable:** Swap AI behaviors without changing game code
6. **ML-Ready:** State/action spaces designed for RL (discrete actions, continuous state)

## Performance Characteristics

- **Decision Frequency:** ~5 Hz (every 200ms)
- **State Vector Size:** 36 fields + variable-length unit arrays
- **Action Space:** 5 action types Ã— unit varieties = ~35 discrete actions
- **Game Length:** 100-500 ticks (20-100 seconds)
- **Episodes for Training:** Estimated 5,000-10,000 for convergence

## Future Enhancements for ML

1. **Reward Shaping:**
   - Base damage dealt: +0.1 per 100 damage
   - Base damage received: -0.1 per 100 damage
   - Age advancement: +1 per age
   - Unit kills: +0.05 per kill
   - Win: +10, Loss: -10

2. **Curriculum Learning:**
   - Stage 1: vs Easy AI (learn basics)
   - Stage 2: vs Medium AI (learn economy)
   - Stage 3: vs Hard AI (learn strategy)
   - Stage 4: vs Cheater AI (master play)
   - Stage 5: Self-play

3. **Network Architecture:**
   - Input: 36-field state vector + 2Ã—20 unit arrays (flattened)
   - Hidden: 3 layers Ã— 256 units (ReLU)
   - Output: Policy head (35 actions, softmax) + Value head (1 scalar)

4. **Hyperparameters:**
   - Learning rate: 3e-4
   - Batch size: 64
   - PPO epsilon: 0.2
   - Discount gamma: 0.99
   - GAE lambda: 0.95

## Testing the Interface

```typescript
// Test that your ML agent works
describe('PPO_AI Integration', () => {
  it('should make valid decisions', () => {
    const ai = new PPO_AI();
    const state = mockGameState();
    const decision = ai.decide(state, AI_PERSONALITIES.BALANCED);
    
    expect(decision.action).toBeDefined();
    expect(['RECRUIT_UNIT', 'AGE_UP', 'UPGRADE_MANA', 'UPGRADE_TURRET_SLOTS', 'BUY_TURRET_ENGINE', 'SELL_TURRET_ENGINE', 'WAIT'])
      .toContain(decision.action);
  });
  
  it('should learn from experience', async () => {
    const ai = new PPO_AI();
    const initialWinRate = await evaluateAI(ai, 100);
    
    // Train for 1000 episodes
    await trainAI(ai, 1000);
    
    const finalWinRate = await evaluateAI(ai, 100);
    expect(finalWinRate).toBeGreaterThan(initialWinRate);
  });
});
```

## Summary

The AI system provides:
- âœ… **Clean interface** for both symbolic and ML agents
- âœ… **Complete game state** observable in 36 fields
- âœ… **Discrete action space** with 5 action types
- âœ… **Pluggable architecture** - swap AI behaviors easily
- âœ… **Three working symbolic AIs** - BalancedAI, AggressiveAI, DefensiveAI
- âœ… **ML-ready design** - perfect for PPO, A3C, or other RL algorithms
- âœ… **Preserved sophisticated logic** - warchest, difficulty scaling, emergency behavior

You can now plug in a PPO agent by implementing `IAIBehavior` and training it against the existing symbolic AIs!

