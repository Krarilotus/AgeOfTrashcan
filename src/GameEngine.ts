import { CoreLoop } from './core/CoreLoop';
import { PRNG } from './core/PRNG';
import { createSnapshot } from './core/World';

// Import modular configuration
// Import SkillSystem
import { SkillSystem } from './systems/SkillSystem';
import { RenderSystem } from './systems/RenderSystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { EntitySystem } from './systems/EntitySystem';
import { TurretSystem } from './systems/TurretSystem';
import { VfxSystem } from './systems/VfxSystem';
import { CombatUtils } from './systems/CombatUtils';
import { EconomySystem } from './systems/EconomySystem';

import { UNIT_DEFS, type UnitDef, getUnitsForAge } from './config/units';
import {
  BASE_CONFIG,
  getAgeUpgradeCost,
  DIFFICULTY_CONFIG,
  getManaCost,
  getGoldIncome,
  getManaGeneration,
} from './config/gameBalance';
import { 
  getTurretUpgradeCost,
} from './config/turretConfig';
import { AIController, AIControllerFactory } from './ai/AIController';
import { BalancedAI } from './ai/behaviors';
import type { GameStateSnapshot, AIDecision, RecruitUnitParams } from './ai/AIBehavior';

const FIXED_TIMESTEP = 1000 / 60; // ~16.67ms for 60 FPS

// Re-export UNIT_DEFS for backward compatibility
export { UNIT_DEFS };

// OLD UNIT_DEFS REMOVED - All units now imported from config/units.ts

export interface GameConfig {
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'CHEATER';
  startingGold: number;
  startingMana: number;
  goldIncomeBase: number;
  manaIncomeBase: number;
  laneLength: number;
  basePositions: {
    player: number;
    enemy: number;
  };
}

// DIFFICULTY_MODIFIERS removed - using DIFFICULTY_CONFIG from config/gameBalance.ts
// AIState removed - using AIController from ai/AIController.ts

export interface GameCallbacks {
  onStateUpdate: (state: GameState) => void;
  onGameOver: (winner: string) => void;
  onAgeUpgrade?: () => void;
}

export interface Entity {
  entityId: number;
  owner: 'PLAYER' | 'ENEMY';
  unitId: string;
  transform: { x: number; laneY: number; facing: 'LEFT' | 'RIGHT' };
  kinematics: { vx: number; vy: number };
  health: { current: number; max: number };
  attack: { damage: number; range: number; speed: number; cooldownRemaining: number };
  skillCooldownRemaining?: number;
  animationState: string;
  burstState?: { shotsRemaining: number; burstCooldown: number }; // For burst fire units
  teleporterState?: { 
    attackCooldown: number; // Cooldown for next attack
    currentTarget?: number; // Entity ID of current target
  };
}

export interface Projectile {
  id: number;
  owner: 'PLAYER' | 'ENEMY';
  x: number;
  y: number; // Vertical position in battlefield units (0 = center)
  vx: number;
  vy: number; // Vertical velocity (for arcing shots)
  damage: number;
  lifeMs: number;
  manaLeech?: number; // Amount of mana to restore to owner on hit
}

export interface GameState {
  tick: number;
  nextEntityId: number;
  nextVfxId: number;
  entities: Map<number, Entity>;
  playerBase: {
    health: number;
    maxHealth: number;
    x: number;
    turretLevel: number;
    turretAbilityCooldown?: number; // Cooldown for special turret abilities (level 5+)
    lastAttackTime: number; // Game time when base was last attacked
  };
  enemyBase: {
    health: number;
    maxHealth: number;
    x: number;
    turretLevel: number;
    turretAbilityCooldown?: number;
    lastAttackTime: number; // Game time when base was last attacked
  };
  economy: {
    player: {
      gold: number;
      mana: number;
      goldIncomePerSec: number;
      manaIncomePerSec: number;
    };
    enemy: {
      gold: number;
      mana: number;
      goldIncomePerSec: number;
      manaIncomePerSec: number;
    };
  };
  progression: {
    player: {
      age: number;
      ageProgress: { costGold: number; canUpgrade: boolean };
      manaGenerationLevel: number; // 0 = no mana generation
    };
    enemy: {
      age: number;
      ageProgress: { costGold: number; canUpgrade: boolean };
      manaGenerationLevel: number;
    };
  };
  battlefield: {
    width: number; // Total width (playerHalfWidth + enemyHalfWidth)
    playerHalfWidth: number; // Player's territory (left half)
    enemyHalfWidth: number; // Enemy's territory (right half)
  };
  playerQueue: Array<{ unitId: string; remainingMs: number }>;
  enemyQueue: Array<{ unitId: string; remainingMs: number }>;
  projectiles: Projectile[];
  stats: { damageDealt: { player: number; enemy: number } };
  vfx: Array<{
    id: number;
    type: 'ability_cast' | 'ability_impact' | 'kill_reward' | 'flamethrower';
    x: number;
    y: number;
    age: number;
    lifeMs: number;
    data?: any;
  }>;
}

export class GameEngine {
  private state: GameState;
  private unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement> = new Map();
  private coreLoop: CoreLoop | null = null;
  private prng: PRNG;
  private lastUpdateTime = 0;
  private aiAccumulatorMs = 0;
  private isRunning = false;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private renderSystem: RenderSystem | null = null;
  private projectileSystem: ProjectileSystem;
  private entitySystem: EntitySystem;
  private turretSystem: TurretSystem;
  private vfxSystem: VfxSystem;
  private economySystem: EconomySystem;
  private skillSystem: SkillSystem;
  private combatUtils: CombatUtils = new CombatUtils();
  private aiController: AIController; // NEW: Modular AI system

  public getAIController(): AIController {
    return this.aiController;
  }

  constructor(
    private config: GameConfig,
    private seed: number,
    private callbacks: GameCallbacks
  ) {
    this.state = this.createInitialState();
    this.syncBasePositions();
    this.prng = new PRNG(seed);
    
    // Initialize Systems
    this.projectileSystem = new ProjectileSystem();
    this.entitySystem = new EntitySystem();
    this.turretSystem = new TurretSystem();
    this.vfxSystem = new VfxSystem();
    this.economySystem = new EconomySystem();
    this.skillSystem = new SkillSystem();

    // Initialize AI controller with Balanced behavior
    this.aiController = AIControllerFactory.createRuleBased(
      config.difficulty,
      'BALANCED',
      new BalancedAI()
    );
  }

  private syncBasePositions(): void {
    // Always ensure bases exist with proper structure before syncing
    if (!this.state.playerBase) {
      this.state.playerBase = {
        x: 0,
        health: BASE_CONFIG.baseHealth,
        maxHealth: BASE_CONFIG.baseHealth,
        turretLevel: 0,
        turretAbilityCooldown: 0,
        lastAttackTime: 0,
      };
    }
    
    if (!this.state.enemyBase) {
      this.state.enemyBase = {
        x: this.state.battlefield.width,
        health: BASE_CONFIG.baseHealth,
        maxHealth: BASE_CONFIG.baseHealth,
        turretLevel: 0,
        turretAbilityCooldown: 0,
        lastAttackTime: 0,
      };
    }
    
    // Keep bases anchored to the battlefield edges (width can change with age upgrades)
    this.state.playerBase.x = 0;
    this.state.enemyBase.x = this.state.battlefield.width;
    
    console.log('Base positions synced:', {
      player: this.state.playerBase.x,
      enemy: this.state.enemyBase.x,
      battlefieldWidth: this.state.battlefield.width
    });
  }

  private createInitialState(): GameState {
    return {
      tick: 0,
      nextEntityId: 1000,
      nextVfxId: 1,
      entities: new Map(),
      playerBase: {
        health: BASE_CONFIG.baseHealth,
        maxHealth: BASE_CONFIG.baseHealth,
        x: 0, // Player base always at left edge
        turretLevel: 0,
        turretAbilityCooldown: 0,
        lastAttackTime: 0,
      },
      enemyBase: {
        health: this.config.difficulty === 'EASY' ? 300 :
                this.config.difficulty === 'MEDIUM' ? 500 :
                this.config.difficulty === 'HARD' ? 700 :
                this.config.difficulty === 'CHEATER' ? 1000 : 500,
        maxHealth: this.config.difficulty === 'EASY' ? 300 :
                   this.config.difficulty === 'MEDIUM' ? 500 :
                   this.config.difficulty === 'HARD' ? 700 :
                   this.config.difficulty === 'CHEATER' ? 1000 : 500,
        x: 50, // Enemy base starts at right edge (will be updated dynamically)
        turretLevel: 0,
        turretAbilityCooldown: 0,
        lastAttackTime: 0,
      },
      economy: {
        player: {
          gold: this.config.startingGold,
          mana: this.config.startingMana,
          goldIncomePerSec: this.config.goldIncomeBase,
          manaIncomePerSec: 0, // Start with 0 mana generation - must upgrade
        },
        enemy: {
          gold: this.config.startingGold,
          mana: this.config.startingMana,
          goldIncomePerSec: this.config.goldIncomeBase * DIFFICULTY_CONFIG[this.config.difficulty].goldMultiplier,
          manaIncomePerSec: 0, // AI also starts with 0
        },
      },
      progression: {
        player: {
          age: 1,
          ageProgress: { costGold: getAgeUpgradeCost(1), canUpgrade: false },
          manaGenerationLevel: 0, // No mana generation initially
        },
        enemy: {
          age: 1,
          ageProgress: { costGold: getAgeUpgradeCost(1), canUpgrade: false },
          manaGenerationLevel: 0,
        },
      },
      battlefield: {
        width: 50, // Total battlefield width (calculated as playerHalfWidth + enemyHalfWidth)
        playerHalfWidth: 25, // Player's territory (left half)
        enemyHalfWidth: 25, // Enemy's territory (right half)
      },
      playerQueue: [],
      enemyQueue: [],
      projectiles: [],
      stats: { damageDealt: { player: 0, enemy: 0 } },
      vfx: [],
    };
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    console.log("GameEngine.init() called with canvas:", canvas);
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    this.ctx = ctx;
    console.log("Canvas context obtained:", !!this.ctx);
    
    // Initialize RenderSystem
    this.renderSystem = new RenderSystem(ctx, canvas, this.unitSprites);

    // Set fixed canvas size - battlefield expansion handled via coordinate mapping
    canvas.width = 1200;
    canvas.height = 450;
    console.log("Canvas size set to", canvas.width, "x", canvas.height);

    // Load SVG sprites (await so they are ready before gameplay)
    await this.loadUnitSprites();

    return;
  }

  

  private async loadUnitSprites(): Promise<void> {
    const basePath = '/assets/units/';
    
    // AUTO-DISCOVERY: define sprites based on UNIT_DEFS keys
    // This enforces convention: sprite filename = unitId + ".svg"
    // No more manual mapping needed!
    const unitIds = Object.keys(UNIT_DEFS);
    return this.loadSpecificSprites(unitIds);
  }

  // Load a specific list of sprites
  private async loadSpecificSprites(unitIds: string[]): Promise<void> {
      const basePath = '/assets/units/';
      const entries = unitIds.map((unitId) => {
      // Skip if already loaded (unless error)
      if (this.unitSprites.has(unitId)) return Promise.resolve();

      return new Promise<void>((resolve) => {
        const fileName = `${unitId}.svg`;
        const img = new Image();
        
        const onLoad = () => {
          this.unitSprites.set(unitId, img);
          resolve();
        };

        img.onload = onLoad;
        img.onerror = () => {
          console.warn(`Failed to load sprite for ${unitId}: ${basePath + fileName}`);
          resolve();
        };
        img.src = basePath + fileName;

        // Force check for cached images (fix for reload bug)
        if (img.complete && img.naturalHeight !== 0) {
          onLoad();
        }
      });
    });

    await Promise.all(entries);
  }

  // Helper to ensure all units in state have sprites loaded
  // Called after Load Game
  private ensureUnitSpritesLoaded() {
      const neededIds = new Set<string>();
      if (this.state.entities) {
          for (const entity of this.state.entities.values()) {
              if (!this.unitSprites.has(entity.unitId)) {
                  neededIds.add(entity.unitId);
              }
          }
      }
      if (neededIds.size > 0) {
          console.log("Restoring sprites for saved units:", Array.from(neededIds));
          this.loadSpecificSprites(Array.from(neededIds));
      }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // Use CoreLoop for fixed 60Hz deterministic stepping
    this.coreLoop = new CoreLoop(60, (dtMs) => {
      this.update(dtMs);
    });
    this.coreLoop.start();
    console.log('Game started (core loop 60Hz)');
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.coreLoop) {
      this.coreLoop.stop();
      this.coreLoop = null;
    }
  }

  update(deltaTime: number): void {
    if (!this.isRunning) return;

    // CHECK GAME OVER FIRST - before any AI decisions or spawning
    if (this.state.enemyBase.health <= 0) {
      this.state.enemyBase.health = 0;
      GameEngine.deleteSavedGame();
      try {
        this.callbacks.onGameOver('PLAYER');
      } catch (e) {}
      this.stop();
      return;
    }
    if (this.state.playerBase.health <= 0) {
      this.state.playerBase.health = 0;
      GameEngine.deleteSavedGame();
      try {
        this.callbacks.onGameOver('ENEMY');
      } catch (e) {}
      this.stop();
      return;
    }

    // Battlefield width can change with age upgrades; keep base positions in sync.
    this.syncBasePositions();

    // Convert deltaTime to seconds for economy
    const deltaSeconds = Math.min(deltaTime / 1000, 0.1); // Cap at 100ms

    // Update economy
    this.updateEconomy(deltaSeconds);

    // Update training queues and spawn units
    this.updateTrainingQueues();

    // Update entities
    this.updateEntities(deltaSeconds);

    // Throttle enemy AI: run at ~2Hz (every 500ms)
    this.aiAccumulatorMs += deltaTime;
    if (this.aiAccumulatorMs >= 500) {
      this.aiAccumulatorMs -= 500;
      this.updateEnemyAI();
    }

    // Check for turret damage
    this.updateTurrets(deltaSeconds);

    // Update VFX (decay lifetime)
    this.vfxSystem.update(this.state, deltaSeconds);

    // Render the canvas
    this.render();

    // Call state update callback
    this.callbacks.onStateUpdate(this.getState());

    this.state.tick++;
  }

  private updateEconomy(deltaSeconds: number): void {
    EconomySystem.update(this.state, deltaSeconds);
  }

  private updateTrainingQueues(): void {
    // Update player queue - units already have reduced training time from queueUnit()
    if (this.state.playerQueue.length > 0) {
      const unit = this.state.playerQueue[0];
      unit.remainingMs -= FIXED_TIMESTEP;
      if (unit.remainingMs <= 0) {
        const finished = this.state.playerQueue.shift();
        if (finished) this.spawnTestUnit('PLAYER', finished.unitId);
      }
    }

    // Update enemy queue
    if (this.state.enemyQueue.length > 0) {
      const unit = this.state.enemyQueue[0];
      unit.remainingMs -= FIXED_TIMESTEP;
      if (unit.remainingMs <= 0) {
        const finished = this.state.enemyQueue.shift();
        if (finished) this.spawnTestUnit('ENEMY', finished.unitId);
      }
    }
  }

  private spawnTestUnit(owner: 'PLAYER' | 'ENEMY', unitId?: string): void {
    const entityId = this.state.nextEntityId++;
    const isPlayer = owner === 'PLAYER';

    // Spawn Offset
    const baseX = isPlayer ? 0.1 : (this.state.battlefield.width - 0.1);
    
    const actualUnitId = unitId || (isPlayer ? this.state.playerQueue[0]?.unitId : this.state.enemyQueue[0]?.unitId) || 'stone_clubman';
    const unitDef = UNIT_DEFS[actualUnitId] || UNIT_DEFS.stone_clubman;

    const entity: Entity = {
      entityId,
      owner,
      unitId: actualUnitId,
      transform: { x: baseX, laneY: 0, facing: isPlayer ? 'RIGHT' : 'LEFT' },
      kinematics: { vx: isPlayer ? unitDef.speed : -unitDef.speed, vy: 0 },
      health: { current: unitDef.health, max: unitDef.health },
      attack: { damage: unitDef.damage, range: unitDef.range ?? 1, speed: 1, cooldownRemaining: 0 },
      skillCooldownRemaining: 0,
      animationState: 'IDLE',
    };

    // Initialize burst fire state if unit has burst fire capability
    if (unitDef.burstFire) {
      entity.burstState = {
        shotsRemaining: 0,
        burstCooldown: 0,
      };
    }

    // Initialize teleporter state if unit is a teleporter
    if (unitDef.teleporter) {
      entity.teleporterState = {
        attackCooldown: 0,
        currentTarget: undefined,
      };
    }

    this.state.entities.set(entityId, entity);

    console.log(`Unit spawned for ${owner} (${actualUnitId}) at x=${baseX}`);
  }

  private updateEntities(deltaSeconds: number): void {
    this.projectileSystem.update(this.state, deltaSeconds);
    this.entitySystem.update(this.state, deltaSeconds, this.projectileSystem);
  }



  // Extract complete game state for AI decision-making
  private extractGameStateForAI(): GameStateSnapshot {
    const playerUnits = Array.from(this.state.entities.values()).filter(e => e.owner === 'PLAYER');
    const enemyUnits = Array.from(this.state.entities.values()).filter(e => e.owner === 'ENEMY');
    
    return {
      tick: this.state.tick,
      gameTime: (this.state.tick * FIXED_TIMESTEP) / 1000,
      
      // Economy
      playerGold: this.state.economy.player.gold,
      enemyGold: this.state.economy.enemy.gold,
      playerMana: this.state.economy.player.mana,
      enemyMana: this.state.economy.enemy.mana,
      playerGoldIncome: this.state.economy.player.goldIncomePerSec,
      enemyGoldIncome: this.state.economy.enemy.goldIncomePerSec,
      playerManaIncome: this.state.economy.player.manaIncomePerSec,
      enemyManaIncome: this.state.economy.enemy.manaIncomePerSec,
      
      // Progression
      playerAge: this.state.progression.player.age,
      enemyAge: this.state.progression.enemy.age,
      playerAgeCost: this.state.progression.player.ageProgress.costGold,
      enemyAgeCost: this.state.progression.enemy.ageProgress.costGold,
      playerManaLevel: this.state.progression.player.manaGenerationLevel,
      enemyManaLevel: this.state.progression.enemy.manaGenerationLevel,
      
      // Bases
      playerBaseHealth: this.state.playerBase.health,
      playerBaseMaxHealth: this.state.playerBase.maxHealth,
      enemyBaseHealth: this.state.enemyBase.health,
      enemyBaseMaxHealth: this.state.enemyBase.maxHealth,
      playerTurretLevel: this.state.playerBase.turretLevel,
      enemyTurretLevel: this.state.enemyBase.turretLevel,
      
      // Units
      playerUnitCount: playerUnits.length,
      enemyUnitCount: enemyUnits.length,
      playerUnits: playerUnits.map(e => ({
        unitId: e.unitId,
        health: e.health.current,
        maxHealth: e.health.max,
        position: e.transform.x,
        damage: e.attack.damage,
        range: e.attack.range
      })),
      enemyUnits: enemyUnits.map(e => ({
        unitId: e.unitId,
        health: e.health.current,
        maxHealth: e.health.max,
        position: e.transform.x,
        damage: e.attack.damage,
        range: e.attack.range
      })),
      
      // Queues
      playerQueueSize: this.state.playerQueue.length,
      enemyQueueSize: this.state.enemyQueue.length,
      
      // Battlefield
      battlefieldWidth: this.state.battlefield.width,
      playerBaseX: this.state.playerBase.x,
      enemyBaseX: this.state.enemyBase.x,
      
      // Game config
      difficulty: this.config.difficulty,
      
      // Additional analysis
      playerUnitsNearEnemyBase: playerUnits.filter(e => 
        Math.abs(e.transform.x - this.state.enemyBase.x) < 15
      ).length,
      enemyUnitsNearPlayerBase: enemyUnits.filter(e => 
        Math.abs(e.transform.x - this.state.playerBase.x) < 15
      ).length,
      lastEnemyBaseAttackTime: this.state.enemyBase.lastAttackTime
    };
  }

  // Execute AI decision from AIController
  private executeAIDecision(decision: AIDecision): void {
    switch (decision.action) {
      case 'RECRUIT_UNIT':
        // Extract unit type from parameters
        const unitType = (decision.parameters as any)?.unitType;
        if (unitType) {
          const unit = UNIT_DEFS[unitType];
          if (!unit) return;
          
          const goldCost = unit.cost || 0;
          const manaCost = unit.manaCost || 0;
          
          if (this.state.economy.enemy.gold >= goldCost && 
              this.state.economy.enemy.mana >= manaCost) {
            this.queueUnit('ENEMY', unitType);
          }
        }
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
        
      case 'EXECUTE_ATTACK_GROUP':
        // Attack group execution - recruit all units in the group (legacy support)
        if ((decision as any).attackGroup) {
          for (const composition of (decision as any).attackGroup.composition) {
            for (let i = 0; i < composition.count; i++) {
              const unit = UNIT_DEFS[composition.unitId];
              if (!unit) continue;
              
              const goldCost = unit.cost || 0;
              const manaCost = unit.manaCost || 0;
              
              if (this.state.economy.enemy.gold >= goldCost && 
                  this.state.economy.enemy.mana >= manaCost) {
                this.queueUnit('ENEMY', composition.unitId);
              }
            }
          }
        }
        break;
        
      case 'WAIT':
        // Do nothing - AI is waiting for resources or opportunity
        break;
    }
  }

  private updateEnemyAI(): void {
    // NEW MODULAR AI SYSTEM
    // Extract current game state
    const gameState = this.extractGameStateForAI();
    
    // Get AI decision from controller
    const decision = this.aiController.makeDecision(gameState, gameState.gameTime);
    
    // Execute the decision
    this.executeAIDecision(decision);
  }


  private updateTurrets(deltaSeconds: number): void {
      this.turretSystem.update(this.state, deltaSeconds, this.projectileSystem);
  }


  private render(): void {
    if (this.renderSystem) {
      this.renderSystem.render(this.state);
    }
  }




  spawnUnit(unitId: string): void {
    // Player queues units through unified queue API
    this.queueUnit('PLAYER', unitId);
  }

  // Unified queueing logic for player and enemy so costs, training times, and queue rules match
  queueUnit(owner: 'PLAYER' | 'ENEMY', unitId: string, emergency: boolean = false): boolean {
    const unitDef = UNIT_DEFS[unitId] || UNIT_DEFS.stone_clubman;
    const econ = owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
    const queue = owner === 'PLAYER' ? this.state.playerQueue : this.state.enemyQueue;
    const maxQueue = 5;
    if (queue.length >= maxQueue) return false;
    // enforce age availability
    const ownerAge = owner === 'PLAYER' ? this.state.progression.player.age : this.state.progression.enemy.age;
    if ((unitDef.age ?? 1) > ownerAge) return false; // cannot queue unit beyond current age
    
    // Apply Difficulty Discount for AI
    let finalCost = unitDef.cost;
    if (owner === 'ENEMY') {
         if (this.config.difficulty === 'MEDIUM') finalCost *= 0.8;
         else if (this.config.difficulty === 'HARD') finalCost *= 0.65;
         else if (this.config.difficulty === 'CHEATER') finalCost *= 0.5;
         finalCost = Math.floor(finalCost);
    }

    if (econ.gold < finalCost) return false;
    
    // WARCHEST ENFORCEMENT: Enemy AI cannot spend below warchest reserve
    // Warchest is now handled by the modular AI system (AIController + BalancedAI)
    // The AI passes spendableGold (total - warchest) to recruitment decisions
    
    // if unit requires mana to train, check and deduct
    if ((unitDef.manaCost ?? 0) > 0) {
      if (econ.mana < (unitDef.manaCost ?? 0)) return false;
      econ.mana -= (unitDef.manaCost ?? 0);
    }
    econ.gold -= finalCost;
    
    // Apply age-based build time reduction (10% per age, minimum 40%)
    const buildTimeMultiplier = Math.max(0.4, 1 - (ownerAge - 1) * 0.1);
    const adjustedTrainingMs = (unitDef.trainingMs ?? 2000) * buildTimeMultiplier;
    
    queue.push({ unitId, remainingMs: adjustedTrainingMs });
    console.log(`${owner} queued ${unitId} (cost ${finalCost}g, training ${Math.round(adjustedTrainingMs)}ms). Queue now ${queue.length}`);
    return true;
  }

  upgradeAge(owner: 'PLAYER' | 'ENEMY' = 'PLAYER'): boolean {
    const prog = owner === 'PLAYER' ? this.state.progression.player : this.state.progression.enemy;
    const econ = owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
    const base = owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
    if (prog.age >= 6) return false;
    const cost = prog.ageProgress.costGold;
    if (econ.gold < cost) return false;
    prog.age += 1;
    econ.gold -= cost;
    
    // Update income using centralized config
    let newIncome = getGoldIncome(prog.age);

    // Apply difficulty multiplier for AI consistently
    if (owner === 'ENEMY') {
         newIncome *= DIFFICULTY_CONFIG[this.config.difficulty].goldMultiplier;
    }

    econ.goldIncomePerSec = newIncome;
    
    // Mana income NO LONGER auto-increases with age - must upgrade separately
    
    // Update next age cost
    prog.ageProgress.costGold = getAgeUpgradeCost(prog.age);
    
    // Expand battlefield from the middle - both halves grow to maintain symmetry
    const baseHalfSize = 25; // Original half size
    const expansionFactor = 1 + prog.age * 0.2;
    
    // Both halves expand equally when any player ages up to maintain center point
    const maxAge = Math.max(this.state.progression.player.age, this.state.progression.enemy.age);
    const maxExpansionFactor = 1 + maxAge * 0.2;
    
    this.state.battlefield.playerHalfWidth = baseHalfSize * maxExpansionFactor;
    this.state.battlefield.enemyHalfWidth = baseHalfSize * maxExpansionFactor;
    
    // Update total width
    this.state.battlefield.width = this.state.battlefield.playerHalfWidth + this.state.battlefield.enemyHalfWidth;

    // Re-anchor bases after battlefield expansion
    this.syncBasePositions();
    
    // Double base max health and restore by that amount
    const healthIncrease = base.maxHealth;
    base.maxHealth *= 2;
    base.health += healthIncrease;
    if (base.health > base.maxHealth) base.health = base.maxHealth;
    
    console.log(`${owner} Age upgraded to ${prog.age}, player half: ${this.state.battlefield.playerHalfWidth.toFixed(1)}, enemy half: ${this.state.battlefield.enemyHalfWidth.toFixed(1)}, total width: ${this.state.battlefield.width.toFixed(1)}, base health: ${Math.floor(base.health)}/${base.maxHealth}, next cost: ${prog.ageProgress.costGold}g`);
    
    // Reset warchest timer for AI when they upgrade
    // Warchest tracking removed - now handled by AIController + BalancedAI
    
    if (owner === 'PLAYER' && this.callbacks.onAgeUpgrade) this.callbacks.onAgeUpgrade();
    return true;
  }

  healBase(owner: 'PLAYER' | 'ENEMY' = 'PLAYER'): boolean {
    const prog = owner === 'PLAYER' ? this.state.progression.player : this.state.progression.enemy;
    const econ = owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
    const base = owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
    
    // Only available in age 4+
    if (prog.age < 4) return false;
    
    const manaCost = 500;
    const healAmount = 200;
    
    if (econ.mana < manaCost) {
      console.log(`${owner} heal failed: Insufficient mana (${econ.mana}/${manaCost})`);
      return false;
    }

    if (base.health >= base.maxHealth) return false; // Already at full health
    
    econ.mana -= manaCost;
    base.health += healAmount;
    if (base.health > base.maxHealth) base.health = base.maxHealth;
    
    // Spawn VFX at base location (use existing VFX format)
    const vfxX = owner === 'PLAYER' ? this.state.playerBase.x : this.state.enemyBase.x;
    VfxSystem.spawn(
      this.state,
      'ability_cast',
      vfxX,
      0,
      800,
      prog.age,
      { healing: true, amount: healAmount }
    );
    
    console.log(`${owner} base healed for ${healAmount} HP (${Math.floor(base.health)}/${base.maxHealth})`);
    return true;
  }

  upgradeManaGeneration(owner: 'PLAYER' | 'ENEMY' = 'PLAYER'): boolean {
    const prog = owner === 'PLAYER' ? this.state.progression.player : this.state.progression.enemy;
    const econ = owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
    const level = prog.manaGenerationLevel;
    const cost = getManaCost(level);
    
    if (econ.gold < cost) return false;
    
    econ.gold -= cost;
    prog.manaGenerationLevel += 1;
    econ.manaIncomePerSec = getManaGeneration(prog.manaGenerationLevel);
    
    console.log(`${owner} Mana Generation upgraded to level ${prog.manaGenerationLevel}, +${econ.manaIncomePerSec} mana/sec`);
    return true;
  }

  upgradeTurret(owner: 'PLAYER' | 'ENEMY' = 'PLAYER'): void {
    const econ = owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
    const baseObj = owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
    
    // Cap at level 10
    if (baseObj.turretLevel >= 10) {
      console.log(`${owner} turret already at max level (10)`);
      return;
    }
    
    const cost = getTurretUpgradeCost(baseObj.turretLevel);
    
    if (econ.gold >= cost) {
      econ.gold -= cost;
      baseObj.turretLevel += 1;
      console.log(`${owner} turret upgraded to level ${baseObj.turretLevel}, cost was ${cost}g`);
    }
  }

  cancelQueueItem(index: number): void {
    if (index >= 0 && index < this.state.playerQueue.length) {
      const queuedUnit = this.state.playerQueue[index];
      const unitDef = UNIT_DEFS[queuedUnit.unitId] || UNIT_DEFS.stone_clubman;
      // Refund the cost
      this.state.economy.player.gold += unitDef.cost;
      // Remove from queue
      this.state.playerQueue.splice(index, 1);
      console.log(`Cancelled queued ${queuedUnit.unitId}, refunded ${unitDef.cost}g`);
    }
  }

  getState(): GameState {
    // Return a snapshot copy and include derived UI-friendly values like turret upgrade cost
    const snapshot = createSnapshot(this.state) as GameState & { playerBase?: any };
    if (snapshot.playerBase) {
      snapshot.playerBase.turretUpgradeCost = getTurretUpgradeCost(snapshot.playerBase.turretLevel);
    }
    // also include available units for UI convenience
    (snapshot as any).unitCatalog = UNIT_DEFS;
    // telemetry
    (snapshot as any).stats = this.state.stats;
    // meta info about upgrades (UI-friendly) - progressive damage: +6, +8, +10, etc.
    (snapshot as any).meta = { 
      turretProgressiveDamage: true, // Flag to indicate progressive scaling
      turretBaseDamagePerShot: 1.6, // 4 * 0.4 fireInterval
      turretFireInterval: 0.4,
      ageGoldIncomePerUpgrade: 'progressive', // +2g/s age 1→2, +3g/s age 2→3, etc.
      ageBaseHealthMultiplier: 2 // Base HP doubles per age
    };
    
    // Debug: Expose AI State
    if (this.aiController) {
        (snapshot as any).aiState = this.aiController.getState();
    }
    
    return snapshot;
  }

  // ============================================================================
  // SAVE/LOAD SYSTEM - Single source of truth for game persistence
  // ============================================================================
  
  private static readonly SAVE_KEY = 'ageOfWar_saveGame';
  
  /**
   * Save complete game state to localStorage
   * Converts Map to array for JSON serialization
   */
  saveGameState(): void {
    try {
      // Convert Map to array for JSON serialization
      const entitiesArray = Array.from(this.state.entities.values());
      
      const saveData = {
        version: 1, // For future migration support
        state: {
          ...this.state,
          entities: entitiesArray, // Serialize as array
        },
        aiState: this.aiController.getState(), // Persist AI state (warchest, learning)
        seed: this.seed,
        config: this.config,
        timestamp: Date.now(),
      };
      
      localStorage.setItem(GameEngine.SAVE_KEY, JSON.stringify(saveData));
      console.log('✅ Game saved successfully:', {
        entities: entitiesArray.length,
        playerGold: this.state.economy.player.gold,
        playerAge: this.state.progression.player.age,
        battlefieldWidth: this.state.battlefield.width,
      });
    } catch (error) {
      console.error('❌ Failed to save game:', error);
      throw error;
    }
  }

  /**
   * Load complete game state from localStorage
   * Converts array back to Map and validates data integrity
   */
  loadGameState(): boolean {
    try {
      const saved = localStorage.getItem(GameEngine.SAVE_KEY);
      if (!saved) {
        console.log('No saved game found');
        return false;
      }

      const saveData = JSON.parse(saved);
      
      // Validate save data version (future-proofing)
      if (!saveData.version) {
        console.warn('⚠️ Legacy save format detected');
      }
      
      // Restore config first - critical for proper initialization
      this.config = saveData.config;
      this.seed = saveData.seed;
      
      // Restore state
      const loadedState = saveData.state;
      
      // Rebuild entity Map from array
      const entityMap = new Map<number, Entity>();
      if (Array.isArray(loadedState.entities)) {
        for (const entity of loadedState.entities) {
          // Fix: Use correct property name (entityId, not id)
          if (entity.entityId !== undefined) {
            entityMap.set(entity.entityId, entity);
          } else {
             // Fallback for legacy saves or confused typings
             // @ts-ignore
             if (entity.id) entityMap.set(entity.id, entity);
          }
        }
      }
      loadedState.entities = entityMap;
      
      // Ensure bases exist with valid positions
      if (!loadedState.playerBase) {
        console.error('❌ Invalid save: missing playerBase');
        return false;
      }
      if (!loadedState.enemyBase) {
        console.error('❌ Invalid save: missing enemyBase');
        return false;
      }
      
      // Restore complete state
      this.state = loadedState;
      
      // Reinitialize PRNG with restored seed
      this.prng = new PRNG(this.seed);
      
      // Reinitialize AI controller
      this.aiController = AIControllerFactory.createRuleBased(
        this.config.difficulty,
        'BALANCED',
        new BalancedAI()
      );
      
      // Restore AI state if available
      if (saveData.aiState) {
        this.aiController.restoreState(saveData.aiState);
        // Correctly restore lastAgeUpTime to avoid massive warchest spikes on reload
        // Since we don't save lastAgeUpTime in AIState explicitly yet, we can approximate 
        // using lastAgingTime or assume 0 if start of game.
        // BETTER: Use lastAgingTime from AIState which is saved.
        const behavior = (this.aiController as any).config.behavior;
        if (behavior instanceof BalancedAI && saveData.aiState.lastAgingTime) {
             behavior.setLastAgeUpTime(saveData.aiState.lastAgingTime); 
        }
      }
      
      // Ensure base positions are synced to battlefield dimensions
      this.syncBasePositions();

      // Robustness: Ensure sprites are loaded for all restored units
      // This fixes the "invisible units" bug if save contains units not in initial sprite list
      this.ensureUnitSpritesLoaded();

      console.log('✅ Game loaded successfully:', {
        entities: this.state.entities.size,
        playerGold: this.state.economy.player.gold,
        playerAge: this.state.progression.player.age,
        playerBaseX: this.state.playerBase.x,
        enemyBaseX: this.state.enemyBase.x,
        battlefieldWidth: this.state.battlefield.width,
      });
      
      return true;
    } catch (error) {
      console.error('❌ Failed to load game:', error);
      return false;
    }
  }
  
  /**
   * Check if a saved game exists
   */
  static hasSavedGame(): boolean {
    return !!localStorage.getItem(GameEngine.SAVE_KEY);
  }
  
  /**
   * Delete saved game
   */
  static deleteSavedGame(): void {
    localStorage.removeItem(GameEngine.SAVE_KEY);
    console.log('🗑️ Saved game deleted');
  }
}
