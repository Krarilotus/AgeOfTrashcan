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
import { ensureManaSpendStats, recordManaSpent } from './systems/resourceAccounting';

import { UNIT_DEFS, type UnitDef, getUnitsForAge } from './config/units';
import {
  BASE_CONFIG,
  getAgeUpgradeCost,
  getAgeUpgradeManaCost,
  getAgeUpgradeRequirementRule,
  DIFFICULTY_CONFIG,
  getEnemyPurchaseDiscountMultiplier,
  type EnemyPurchaseCategory,
  type GameDifficulty,
  getManaCost,
  getGoldIncome,
  getManaGeneration,
  PROGRESSION_CONFIG,
  QUEUE_CONFIG,
  UNIT_CAP_CONFIG,
} from './config/gameBalance';
import { RENDER_CONFIG } from './config/renderConfig';
import {
  MAX_TURRET_SLOTS,
  TURRET_ENGINES,
  calculateTurretDefenseStats,
  estimateEngineDps,
  getTurretEngineDef,
  getTurretEnginesForAge,
  getTurretSellRefundMultiplier,
  getTurretSlotUnlockBuildMs,
  getTurretSlotUnlockCost,
  type MountedTurretSlotState,
} from './config/turrets';
import { AIController, AIControllerFactory } from './ai/AIController';
import { BalancedAI, MLSelfPlayBehavior, SmartPlannerAI } from './ai/behaviors';
import type { GameStateSnapshot, AIDecision, IAIBehavior, RecruitUnitParams } from './ai/AIBehavior';

const FIXED_TIMESTEP = 1000 / 60; // ~16.67ms for 60 FPS
const baseHalfSize = 30; // Original half size
const MAX_ACTIVE_UNITS_PER_SIDE = UNIT_CAP_CONFIG.maxActiveUnitsPerSide;
type Owner = 'PLAYER' | 'ENEMY';

// Re-export UNIT_DEFS for backward compatibility
export { UNIT_DEFS };

// OLD UNIT_DEFS REMOVED - All units now imported from config/units.ts

export interface GameConfig {
  difficulty: GameDifficulty;
  mode?: 'PLAY' | 'WATCH';
  startingGold: number;
  startingMana: number;
  goldIncomeBase: number;
  manaIncomeBase: number;
  laneLength: number;
  basePositions: {
    player: number;
    enemy: number;
  };
  sideControl?: Partial<Record<Owner, SideControlConfig>>;
}

export interface SideControlConfig {
  control: 'HUMAN' | 'AI';
  difficulty?: GameDifficulty;
  mlCheckpointId?: string;
  mlStrictInference?: boolean;
}

export interface SideActionSnapshot {
  tick: number;
  gameTime: number;
  owner: Owner;
  action: string;
  phase: 'DECISION' | 'EXECUTED';
  success?: boolean;
  details?: string;
  parameters?: Record<string, any>;
  gold: number;
  mana: number;
  age: number;
  baseHealth: number;
  opponentBaseHealth: number;
  ownUnitCount: number;
  opponentUnitCount: number;
}

export interface SideTelemetry {
  owner: Owner;
  control: 'HUMAN' | 'AI';
  difficulty?: GameDifficulty;
  ageUpTimes: number[];
  unitBuildCounts: Record<string, number>;
  manaUpgradeCount: number;
  totalManaSpent: number;
  manaSpentUnits: number;
  manaSpentAbilities: number;
  turretSlotUpgradeCount: number;
  turretEngineBuys: Record<string, number>;
  turretEngineSells: Record<string, number>;
  actionTimeline: SideActionSnapshot[];
}

export interface MatchTelemetry {
  bySide: Record<Owner, SideTelemetry>;
  baseHealthTimeline: Array<{
    tick: number;
    gameTime: number;
    playerBaseHealth: number;
    enemyBaseHealth: number;
    playerGold: number;
    enemyGold: number;
    playerMana: number;
    enemyMana: number;
  }>;
}

// DIFFICULTY_MODIFIERS removed - using DIFFICULTY_CONFIG from config/gameBalance.ts
// AIState removed - using AIController from ai/AIController.ts

export interface GameCallbacks {
  onStateUpdate?: (state: GameState) => void;
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
  curvature?: number; // Vertical acceleration applied each tick
  damage: number;
  lifeMs: number;
  radiusPx?: number;
  color?: string;
  glowColor?: string;
  trailAlpha?: number;
  manaLeech?: number; // Amount of mana to restore to owner on hit
  delayMs?: number; // Time before projectile becomes active/visible
  isFalling?: boolean; // If true, collisions only happen near ground (y approx 0)
  targetY?: number; // Y position to target for falling projectiles
  splashRadius?: number; // Optional AOE splash radius for projectile impact
  remainingPierces?: number; // Projectile can pass through additional targets
  splitOnImpact?: {
    childCount: number;
    childDamage: number;
    childSpeed: number;
    childLifeMs: number;
    spreadRadius: number;
  };
  targetEntityId?: number;
  droneState?: {
    phase: 'cruise' | 'dive';
    sourceX: number;
    maxRange: number;
    cruiseY: number;
    overflyX: number;
    cruiseSpeed: number;
    diveSpeed: number;
    retargetOnKill: boolean;
  };
}

export type BuildQueueItemKind = 'unit' | 'turret_slot' | 'turret_engine';

export interface BuildQueueItem {
  kind: BuildQueueItemKind;
  remainingMs: number;
  unitId?: string;
  turretId?: string;
  slotIndex?: number;
  refundGold?: number;
  label?: string;
}

export interface BaseState {
  health: number;
  maxHealth: number;
  x: number;
  turretSlotsUnlocked: number;
  turretSlots: MountedTurretSlotState[];
  turretLevel: number; // Legacy compatibility/debug field derived from engine strength
  lastAttackTime: number; // Game time when base was last attacked
}

export interface GameState {
  tick: number;
  nextEntityId: number;
  nextVfxId: number;
  entities: Map<number, Entity>;
  playerBase: BaseState;
  enemyBase: BaseState;
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
      ageProgress: {
        costGold: number;
        costMana: number;
        canUpgrade: boolean;
        requirementProgress: number;
        requirementText: string;
        requirements: {
          targetAge: number;
          prevAgeUnitsRequired: number;
          prevAgeUnitsBuilt: number;
          prevAgeUnitsProgress: number;
          totalUnitsRequired: number;
          totalUnitsBuilt: number;
          totalUnitsProgress: number;
          met: boolean;
          missing: string[];
        };
      };
      manaGenerationLevel: number; // 0 = no mana generation
    };
    enemy: {
      age: number;
      ageProgress: {
        costGold: number;
        costMana: number;
        canUpgrade: boolean;
        requirementProgress: number;
        requirementText: string;
        requirements: {
          targetAge: number;
          prevAgeUnitsRequired: number;
          prevAgeUnitsBuilt: number;
          prevAgeUnitsProgress: number;
          totalUnitsRequired: number;
          totalUnitsBuilt: number;
          totalUnitsProgress: number;
          met: boolean;
          missing: string[];
        };
      };
      manaGenerationLevel: number;
    };
  };
  battlefield: {
    width: number; // Total width (playerHalfWidth + enemyHalfWidth)
    playerHalfWidth: number; // Player's territory (left half)
    enemyHalfWidth: number; // Enemy's territory (right half)
  };
  playerQueue: BuildQueueItem[];
  enemyQueue: BuildQueueItem[];
  projectiles: Projectile[];
  stats: {
    damageDealt: { player: number; enemy: number };
    manaSpent: { player: number; enemy: number };
    manaSpentUnits: { player: number; enemy: number };
    manaSpentAbilities: { player: number; enemy: number };
  };
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
  private static readonly UNIT_CATALOG_ENTRIES = Object.entries(UNIT_DEFS) as Array<[string, UnitDef]>;
  private static readonly TURRET_CATALOG_ENTRIES = Object.entries(TURRET_ENGINES);
  private state: GameState;
  private unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement> = new Map();
  private coreLoop: CoreLoop | null = null;
  private prng: PRNG;
  private lastUpdateTime = 0;
  private aiAccumulatorsMs: Record<Owner, number> = { PLAYER: 0, ENEMY: 0 };
  private sideControl: Record<Owner, SideControlConfig>;
  private aiDecisionEnabled: Record<Owner, boolean> = { PLAYER: true, ENEMY: true };
  private aiControllers: Partial<Record<Owner, AIController>> = {};
  private telemetry: MatchTelemetry;
  private lastTelemetrySampleTimeSec = 0;
  private isRunning = false;
  private isPaused = false;
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
  
  // Track one-time bonuses for Cyber Assassin
  private enemyCyberAssassin6kBonusUsed = false;
  private enemyCyberAssassin12kBonusUsed = false;

  public getAIController(owner: Owner = 'ENEMY'): AIController | null {
    return this.aiControllers[owner] ?? null;
  }

  public getAIControllersDebug(): Partial<Record<Owner, ReturnType<AIController['getDebugInfo']>>> {
    const debug: Partial<Record<Owner, ReturnType<AIController['getDebugInfo']>>> = {};
    for (const owner of ['PLAYER', 'ENEMY'] as const) {
      const controller = this.aiControllers[owner];
      if (controller) {
        debug[owner] = controller.getDebugInfo();
      }
    }
    return debug;
  }

  public getTelemetrySnapshot(): MatchTelemetry {
    const snapshot = createSnapshot(this.telemetry) as MatchTelemetry;
    snapshot.bySide.PLAYER.totalManaSpent = this.state.stats.manaSpent.player;
    snapshot.bySide.ENEMY.totalManaSpent = this.state.stats.manaSpent.enemy;
    snapshot.bySide.PLAYER.manaSpentUnits = this.state.stats.manaSpentUnits.player;
    snapshot.bySide.ENEMY.manaSpentUnits = this.state.stats.manaSpentUnits.enemy;
    snapshot.bySide.PLAYER.manaSpentAbilities = this.state.stats.manaSpentAbilities.player;
    snapshot.bySide.ENEMY.manaSpentAbilities = this.state.stats.manaSpentAbilities.enemy;
    return snapshot;
  }

  public getSideControlSnapshot(): Record<Owner, SideControlConfig> {
    return createSnapshot(this.sideControl) as Record<Owner, SideControlConfig>;
  }

  constructor(
    private config: GameConfig,
    private seed: number,
    private callbacks: GameCallbacks
  ) {
    this.sideControl = this.buildSideControl(config);
    this.telemetry = this.createInitialTelemetry();
    this.state = this.createInitialState();
    this.syncBasePositions();
    this.refreshAgeUpgradeProgress('PLAYER');
    this.refreshAgeUpgradeProgress('ENEMY');
    this.prng = new PRNG(seed);
    
    // Initialize Systems
    this.projectileSystem = new ProjectileSystem();
    this.entitySystem = new EntitySystem();
    this.turretSystem = new TurretSystem();
    this.vfxSystem = new VfxSystem();
    this.economySystem = new EconomySystem();
    this.skillSystem = new SkillSystem();
    this.initializeAIControllers();
  }

  private createBehaviorForDifficulty(
    difficulty: GameDifficulty,
    sideConfig?: SideControlConfig
  ): IAIBehavior {
    if (difficulty === 'SMART_ML') {
      const behavior = new MLSelfPlayBehavior();
      behavior.setParameters({
        selectedCheckpointId: sideConfig?.mlCheckpointId ?? null,
        requireCheckpointInference: Boolean(sideConfig?.mlStrictInference),
      });
      return behavior;
    }
    if (difficulty === 'SMART') {
      return new SmartPlannerAI();
    }
    return new BalancedAI();
  }

  private createAIController(difficulty: GameDifficulty, sideConfig?: SideControlConfig): AIController {
    return AIControllerFactory.createRuleBased(
      difficulty,
      'BALANCED',
      this.createBehaviorForDifficulty(difficulty, sideConfig)
    );
  }

  private buildSideControl(config: GameConfig): Record<Owner, SideControlConfig> {
    const defaultControl: Record<Owner, SideControlConfig> = {
      PLAYER: { control: 'HUMAN' },
      ENEMY: { control: 'AI', difficulty: config.difficulty },
    };
    const mergedPlayer = {
      ...defaultControl.PLAYER,
      ...(config.sideControl?.PLAYER ?? {}),
    };
    const mergedEnemy = {
      ...defaultControl.ENEMY,
      ...(config.sideControl?.ENEMY ?? {}),
    };
    if (mergedPlayer.control === 'AI' && !mergedPlayer.difficulty) {
      mergedPlayer.difficulty = config.difficulty;
    }
    if (mergedEnemy.control === 'AI' && !mergedEnemy.difficulty) {
      mergedEnemy.difficulty = config.difficulty;
    }
    return {
      PLAYER: mergedPlayer,
      ENEMY: mergedEnemy,
    };
  }

  private createInitialTelemetry(): MatchTelemetry {
    return {
      bySide: {
        PLAYER: {
          owner: 'PLAYER',
          control: this.sideControl.PLAYER.control,
          difficulty: this.sideControl.PLAYER.difficulty,
          ageUpTimes: [],
          unitBuildCounts: {},
          manaUpgradeCount: 0,
          totalManaSpent: 0,
          manaSpentUnits: 0,
          manaSpentAbilities: 0,
          turretSlotUpgradeCount: 0,
          turretEngineBuys: {},
          turretEngineSells: {},
          actionTimeline: [],
        },
        ENEMY: {
          owner: 'ENEMY',
          control: this.sideControl.ENEMY.control,
          difficulty: this.sideControl.ENEMY.difficulty,
          ageUpTimes: [],
          unitBuildCounts: {},
          manaUpgradeCount: 0,
          totalManaSpent: 0,
          manaSpentUnits: 0,
          manaSpentAbilities: 0,
          turretSlotUpgradeCount: 0,
          turretEngineBuys: {},
          turretEngineSells: {},
          actionTimeline: [],
        },
      },
      baseHealthTimeline: [],
    };
  }

  private hydrateTelemetry(rawTelemetry: any): MatchTelemetry {
    const fallback = this.createInitialTelemetry();
    if (!rawTelemetry || !rawTelemetry.bySide) return fallback;

    const normalizeSide = (owner: Owner): SideTelemetry => {
      const raw = rawTelemetry.bySide?.[owner] ?? {};
      return {
        owner,
        control: this.sideControl[owner].control,
        difficulty: this.sideControl[owner].difficulty,
        ageUpTimes: Array.isArray(raw.ageUpTimes) ? raw.ageUpTimes.map((v: any) => Number(v) || 0) : [],
        unitBuildCounts: typeof raw.unitBuildCounts === 'object' && raw.unitBuildCounts ? raw.unitBuildCounts : {},
        manaUpgradeCount: Number(raw.manaUpgradeCount) || 0,
        totalManaSpent: Number(raw.totalManaSpent) || 0,
        manaSpentUnits: Number(raw.manaSpentUnits) || 0,
        manaSpentAbilities: Number(raw.manaSpentAbilities) || 0,
        turretSlotUpgradeCount: Number(raw.turretSlotUpgradeCount) || 0,
        turretEngineBuys: typeof raw.turretEngineBuys === 'object' && raw.turretEngineBuys ? raw.turretEngineBuys : {},
        turretEngineSells: typeof raw.turretEngineSells === 'object' && raw.turretEngineSells ? raw.turretEngineSells : {},
        actionTimeline: Array.isArray(raw.actionTimeline) ? raw.actionTimeline : [],
      };
    };

    return {
      bySide: {
        PLAYER: normalizeSide('PLAYER'),
        ENEMY: normalizeSide('ENEMY'),
      },
      baseHealthTimeline: Array.isArray(rawTelemetry.baseHealthTimeline)
        ? rawTelemetry.baseHealthTimeline
        : [],
    };
  }

  private initializeAIControllers(): void {
    this.aiControllers = {};
    this.aiAccumulatorsMs = { PLAYER: 0, ENEMY: 0 };
    for (const owner of ['PLAYER', 'ENEMY'] as const) {
      const side = this.sideControl[owner];
      this.aiDecisionEnabled[owner] = side.control === 'AI';
      if (side.control === 'AI') {
        const difficulty = side.difficulty ?? this.config.difficulty;
        this.aiControllers[owner] = this.createAIController(difficulty, side);
      }
    }
  }

  private getControlMode(owner: Owner): 'HUMAN' | 'AI' {
    return this.sideControl[owner].control;
  }

  public setAIDecisionEnabled(owner: Owner, enabled: boolean): void {
    if (this.getControlMode(owner) !== 'AI') return;
    this.aiDecisionEnabled[owner] = enabled;
  }

  private isAISide(owner: Owner): boolean {
    return this.getControlMode(owner) === 'AI' && this.aiDecisionEnabled[owner];
  }

  private getDifficultyForOwner(owner: Owner): GameDifficulty | null {
    if (this.getControlMode(owner) !== 'AI') return null;
    return this.sideControl[owner].difficulty ?? this.config.difficulty;
  }

  private getDifficultyOrDefault(owner: Owner, fallback: GameDifficulty = 'MEDIUM'): GameDifficulty {
    return this.getDifficultyForOwner(owner) ?? fallback;
  }

  private getOpponentOwner(owner: Owner): Owner {
    return owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
  }

  private getBaseHealthForDifficulty(difficulty: GameDifficulty | null): number {
    if (!difficulty) return BASE_CONFIG.baseHealth;
    if (difficulty === 'EASY') return 300;
    if (difficulty === 'MEDIUM') return 400;
    if (difficulty === 'SMART' || difficulty === 'SMART_ML') return 500;
    if (difficulty === 'HARD') return 700;
    if (difficulty === 'CHEATER') return 1000;
    return BASE_CONFIG.baseHealth;
  }

  private getInitialGoldIncome(owner: Owner): number {
    const difficulty = this.getDifficultyForOwner(owner);
    if (!difficulty) return this.config.goldIncomeBase;
    return this.config.goldIncomeBase * DIFFICULTY_CONFIG[difficulty].goldMultiplier;
  }

  private recordActionSnapshot(
    owner: Owner,
    action: string,
    phase: 'DECISION' | 'EXECUTED',
    success: boolean,
    parameters?: Record<string, any>,
    details?: string
  ): void {
    const econ = this.getEconomyForOwner(owner);
    const prog = this.getProgressionForOwner(owner);
    const base = this.getBaseForOwner(owner);
    const opponent = this.getOpponentOwner(owner);
    const opponentBase = this.getBaseForOwner(opponent);
    let ownUnitCount = 0;
    let opponentUnitCount = 0;
    for (const entity of this.state.entities.values()) {
      if (entity.owner === owner) ownUnitCount += 1;
      else if (entity.owner === opponent) opponentUnitCount += 1;
    }
    const timeline = this.telemetry.bySide[owner].actionTimeline;
    timeline.push({
      tick: this.state.tick,
      gameTime: (this.state.tick * FIXED_TIMESTEP) / 1000,
      owner,
      action,
      phase,
      success,
      details,
      parameters,
      gold: econ.gold,
      mana: econ.mana,
      age: prog.age,
      baseHealth: base.health,
      opponentBaseHealth: opponentBase.health,
      ownUnitCount,
      opponentUnitCount,
    });
    if (timeline.length > 2500) {
      timeline.shift();
    }
  }

  private recordBaseHealthTimelineIfNeeded(): void {
    const gameTime = (this.state.tick * FIXED_TIMESTEP) / 1000;
    if (gameTime - this.lastTelemetrySampleTimeSec < 2) return;
    this.lastTelemetrySampleTimeSec = gameTime;
    this.telemetry.baseHealthTimeline.push({
      tick: this.state.tick,
      gameTime,
      playerBaseHealth: this.state.playerBase.health,
      enemyBaseHealth: this.state.enemyBase.health,
      playerGold: this.state.economy.player.gold,
      enemyGold: this.state.economy.enemy.gold,
      playerMana: this.state.economy.player.mana,
      enemyMana: this.state.economy.enemy.mana,
    });
    if (this.telemetry.baseHealthTimeline.length > 3600) {
      this.telemetry.baseHealthTimeline.shift();
    }
  }

  private createDefaultTurretSlots(): MountedTurretSlotState[] {
    const slots: MountedTurretSlotState[] = [];
    for (let i = 0; i < MAX_TURRET_SLOTS; i++) {
      slots.push({
        slotIndex: i,
        turretId: null,
        cooldownRemaining: 0,
      });
    }
    return slots;
  }

  private createBaseState(health: number, x: number): BaseState {
    const base: BaseState = {
      health,
      maxHealth: health,
      x,
      turretSlotsUnlocked: 1,
      turretSlots: this.createDefaultTurretSlots(),
      turretLevel: 0,
      lastAttackTime: 0,
    };
    return this.recomputeBaseTurretLevel(base);
  }

  private ensureBaseTurretState(base: BaseState | undefined): BaseState {
    if (!base) {
      return this.createBaseState(BASE_CONFIG.baseHealth, 0);
    }

    if (!Array.isArray(base.turretSlots)) {
      base.turretSlots = this.createDefaultTurretSlots();
    }
    if (typeof base.turretSlotsUnlocked !== 'number') {
      base.turretSlotsUnlocked = 1;
    }
    while (base.turretSlots.length < MAX_TURRET_SLOTS) {
      base.turretSlots.push({
        slotIndex: base.turretSlots.length,
        turretId: null,
        cooldownRemaining: 0,
      });
    }
    base.turretSlots = base.turretSlots.slice(0, MAX_TURRET_SLOTS).map((slot, idx) => ({
      slotIndex: idx,
      turretId: slot?.turretId ?? null,
      cooldownRemaining: Math.max(0, slot?.cooldownRemaining ?? 0),
    }));
    base.turretSlotsUnlocked = Math.min(MAX_TURRET_SLOTS, Math.max(1, base.turretSlotsUnlocked));
    return this.recomputeBaseTurretLevel(base);
  }

  private recomputeBaseTurretLevel(base: BaseState): BaseState {
    const stats = calculateTurretDefenseStats(base);
    base.turretLevel = stats.legacyLevelEstimate;
    return base;
  }

  private syncBasePositions(): void {
    // Always ensure bases exist with proper structure before syncing
    if (!this.state.playerBase) {
      this.state.playerBase = this.createBaseState(BASE_CONFIG.baseHealth, 0);
    }
    
    if (!this.state.enemyBase) {
      this.state.enemyBase = this.createBaseState(BASE_CONFIG.baseHealth, this.state.battlefield.width);
    }

    this.state.playerBase = this.ensureBaseTurretState(this.state.playerBase);
    this.state.enemyBase = this.ensureBaseTurretState(this.state.enemyBase);
    
    // Keep bases anchored to the battlefield edges (width can change with age upgrades)
    this.state.playerBase.x = 0;
    this.state.enemyBase.x = this.state.battlefield.width;
    
  }

  private createInitialState(): GameState {
    const playerBase = this.createBaseState(this.getBaseHealthForDifficulty(this.getDifficultyForOwner('PLAYER')), 0);
    const enemyBaseHealth = this.getBaseHealthForDifficulty(this.getDifficultyForOwner('ENEMY'));
    const enemyBase = this.createBaseState(enemyBaseHealth, 50);
    return {
      tick: 0,
      nextEntityId: 1000,
      nextVfxId: 1,
      entities: new Map(),
      playerBase,
      enemyBase,
      economy: {
        player: {
          gold: this.config.startingGold,
          mana: this.config.startingMana,
          goldIncomePerSec: this.getInitialGoldIncome('PLAYER'),
          manaIncomePerSec: 0, // Start with 0 mana generation - must upgrade
        },
        enemy: {
          gold: this.config.startingGold,
          mana: this.config.startingMana,
          goldIncomePerSec: this.getInitialGoldIncome('ENEMY'),
          manaIncomePerSec: 0, // AI also starts with 0
        },
      },
      progression: {
        player: {
          age: 1,
          ageProgress: {
            costGold: getAgeUpgradeCost(1),
            costMana: getAgeUpgradeManaCost(1),
            canUpgrade: false,
            requirementProgress: 0,
            requirementText: 'Requirement pending',
            requirements: {
              targetAge: 2,
              prevAgeUnitsRequired: 5,
              prevAgeUnitsBuilt: 0,
              prevAgeUnitsProgress: 0,
              totalUnitsRequired: 0,
              totalUnitsBuilt: 0,
              totalUnitsProgress: 1,
              met: false,
              missing: [],
            },
          },
          manaGenerationLevel: 0, // No mana generation initially
        },
        enemy: {
          age: 1,
          ageProgress: {
            costGold: getAgeUpgradeCost(1),
            costMana: getAgeUpgradeManaCost(1),
            canUpgrade: false,
            requirementProgress: 0,
            requirementText: 'Requirement pending',
            requirements: {
              targetAge: 2,
              prevAgeUnitsRequired: 5,
              prevAgeUnitsBuilt: 0,
              prevAgeUnitsProgress: 0,
              totalUnitsRequired: 0,
              totalUnitsBuilt: 0,
              totalUnitsProgress: 1,
              met: false,
              missing: [],
            },
          },
          manaGenerationLevel: 0,
        },
      },
      battlefield: {
        width: 2 * baseHalfSize, // Total battlefield width (calculated as playerHalfWidth + enemyHalfWidth)
        playerHalfWidth: baseHalfSize, // Player's territory (left half)
        enemyHalfWidth: baseHalfSize, // Enemy's territory (right half)
      },
      playerQueue: [],
      enemyQueue: [],
      projectiles: [],
      stats: {
        damageDealt: { player: 0, enemy: 0 },
        manaSpent: { player: 0, enemy: 0 },
        manaSpentUnits: { player: 0, enemy: 0 },
        manaSpentAbilities: { player: 0, enemy: 0 },
      },
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

    this.syncCanvasSizeToBattlefield();
    console.log("Canvas size set to", canvas.width, "x", canvas.height);

    // Load SVG sprites (await so they are ready before gameplay)
    await this.loadUnitSprites();

    return;
  }

  

  private async loadUnitSprites(): Promise<void> {
    const basePath = '/units/';
    
    // AUTO-DISCOVERY: define sprites based on UNIT_DEFS keys
    // This enforces convention: sprite filename = unitId + ".svg"
    // No more manual mapping needed!
    const unitIds = Object.keys(UNIT_DEFS);
    return this.loadSpecificSprites(unitIds);
  }

  // Load a specific list of sprites
  private async loadSpecificSprites(unitIds: string[]): Promise<void> {
      if (typeof Image === 'undefined') {
        // Headless runtime (Node bridge): no DOM image loading available.
        return;
      }
      const basePath = '/units/';
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
    this.isPaused = false;
    // Use CoreLoop for fixed 60Hz deterministic stepping
    this.coreLoop = new CoreLoop(60, (dtMs) => {
      this.update(dtMs);
    });
    this.coreLoop.start();
    console.log('Game started (core loop 60Hz)');
  }

  startHeadless(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.isPaused = false;
    if (this.coreLoop) {
      this.coreLoop.stop();
      this.coreLoop = null;
    }
  }

  stopHeadless(): void {
    this.stop();
  }

  stepHeadless(frames: number = 1): void {
    if (!this.isRunning) {
      this.startHeadless();
    }
    const boundedFrames = Math.max(1, Math.floor(frames));
    for (let i = 0; i < boundedFrames; i++) {
      if (!this.isRunning) break;
      this.update(FIXED_TIMESTEP);
    }
  }

  pause(): void {
    if (!this.isRunning) return;
    this.isPaused = true;
  }

  resume(): void {
    if (!this.isRunning) return;
    this.isPaused = false;
  }

  togglePause(): boolean {
    if (!this.isRunning) return this.isPaused;
    this.isPaused = !this.isPaused;
    return this.isPaused;
  }

  getIsPaused(): boolean {
    return this.isPaused;
  }

  update(deltaTime: number): void {
    if (!this.isRunning) return;
    if (this.isPaused) return;

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

    // Keep age-up readiness (costs + requirements) current for UI and AI.
    this.refreshAgeUpgradeProgress('PLAYER');
    this.refreshAgeUpgradeProgress('ENEMY');

    // Update entities
    this.updateEntities(deltaSeconds);

    // Throttle AI per configured side: run at ~2Hz (every 500ms)
    this.updateAISides(deltaTime);

    // Check for turret damage
    this.updateTurrets(deltaSeconds);

    // Update VFX (decay lifetime)
    this.vfxSystem.update(this.state, deltaSeconds);

    // Render the canvas
    this.render();

    // Telemetry snapshots for long-horizon evaluation
    this.recordBaseHealthTimelineIfNeeded();

    // Skip expensive full-state snapshots when no state callback is configured (headless training bridge).
    if (this.callbacks.onStateUpdate) {
      this.callbacks.onStateUpdate(this.getState());
    }

    this.state.tick++;
  }

  private updateEconomy(deltaSeconds: number): void {
    EconomySystem.update(this.state, deltaSeconds);
  }

  private updateTrainingQueues(): void {
    const updateQueueForOwner = (owner: 'PLAYER' | 'ENEMY') => {
      const queue = owner === 'PLAYER' ? this.state.playerQueue : this.state.enemyQueue;
      if (queue.length === 0) return;

      const item = queue[0];
      item.remainingMs -= FIXED_TIMESTEP;
      if (item.remainingMs > 0) return;

      if (item.kind === 'unit' && this.hasReachedActiveUnitCap(owner)) {
        // Keep the completed unit build queued until a battlefield slot opens.
        item.remainingMs = 100;
        return;
      }

      const finished = queue.shift();
      if (!finished) return;

      if (finished.kind === 'unit' && finished.unitId) {
        this.spawnTestUnit(owner, finished.unitId);
        return;
      }

      if (finished.kind === 'turret_slot') {
        this.completeTurretSlotUnlock(owner);
        return;
      }

      if (finished.kind === 'turret_engine' && typeof finished.slotIndex === 'number' && finished.turretId) {
        this.completeTurretEngineBuild(owner, finished.slotIndex, finished.turretId);
      }
    };

    updateQueueForOwner('PLAYER');
    updateQueueForOwner('ENEMY');
  }

  private getSpawnXForOwner(owner: 'PLAYER' | 'ENEMY'): number {
    return owner === 'PLAYER' ? 0.1 : (this.state.battlefield.width - 0.1);
  }

  private spawnTestUnit(owner: 'PLAYER' | 'ENEMY', unitId?: string): void {
    if (this.hasReachedActiveUnitCap(owner)) {
      return;
    }
    const entityId = this.state.nextEntityId++;
    const isPlayer = owner === 'PLAYER';

    // Spawn Offset
    const baseX = this.getSpawnXForOwner(owner);
    
    const actualUnitId = unitId || (isPlayer ? this.state.playerQueue[0]?.unitId : this.state.enemyQueue[0]?.unitId) || 'stone_clubman';
    const unitDef = UNIT_DEFS[actualUnitId] || UNIT_DEFS.stone_clubman;

    const entity: Entity = {
      entityId,
      owner,
      unitId: actualUnitId,
      transform: { x: baseX, laneY: 0, facing: isPlayer ? 'RIGHT' : 'LEFT' },
      kinematics: { vx: isPlayer ? unitDef.speed : -unitDef.speed, vy: 0 },
      health: { current: unitDef.health, max: unitDef.health },
      attack: { 
          damage: unitDef.damage, 
          range: unitDef.range ?? 1, 
          speed: unitDef.attackSpeed ?? 1.0, 
          cooldownRemaining: 0 
      },
      skillCooldownRemaining: 0,
      animationState: 'IDLE',
    };

    // SPECIAL RULE: Cyber Assassin 10x HP Bonus at 6k and 12k mana (once each)
    if (!isPlayer && actualUnitId === 'cyber_assassin') {
        const currentMana = this.state.economy.enemy.mana;
        let appliedBonus = false;

        // Check 12k threshold first (higher priority)
        if (currentMana >= 12000 && !this.enemyCyberAssassin12kBonusUsed) {
            this.enemyCyberAssassin12kBonusUsed = true;
            appliedBonus = true;
            console.log("Cyber Assassin triggered 12k Mana Bonus (10x HP)!");
        } 
        // Check 6k threshold
        else if (currentMana >= 6000 && !this.enemyCyberAssassin6kBonusUsed) {
            this.enemyCyberAssassin6kBonusUsed = true;
            appliedBonus = true;
            console.log("Cyber Assassin triggered 6k Mana Bonus (10x HP)!");
        }

        if (appliedBonus) {
            entity.health.max *= 10;
            entity.health.current = entity.health.max;
            // Visual flair for super unit? Maybe scale it up slightly
             // Accessing scaling would require RenderSystem changes, but we can assume normal size
        }
    }

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

  public getAISnapshot(owner: Owner = 'ENEMY'): GameStateSnapshot {
    return this.extractGameStateForAI(owner);
  }

  public applyAIDecision(decision: AIDecision, owner: Owner = 'ENEMY'): boolean {
    return this.executeAIDecision(decision, owner);
  }


  // Extract complete game state for AI decision-making in owner-relative perspective.
  // Contract remains: "enemy*" is self, "player*" is opponent.
  private extractGameStateForAI(owner: Owner): GameStateSnapshot {
    const opponent = this.getOpponentOwner(owner);
    const mirror = owner === 'PLAYER';
    const width = this.state.battlefield.width;

    const ownBase = this.getBaseForOwner(owner);
    const opponentBase = this.getBaseForOwner(opponent);
    const ownEcon = this.getEconomyForOwner(owner);
    const opponentEcon = this.getEconomyForOwner(opponent);
    const ownProg = this.getProgressionForOwner(owner);
    const opponentProg = this.getProgressionForOwner(opponent);

    const ownUnitsRaw: Entity[] = [];
    const opponentUnitsRaw: Entity[] = [];
    for (const entity of this.state.entities.values()) {
      if (entity.owner === owner) ownUnitsRaw.push(entity);
      else if (entity.owner === opponent) opponentUnitsRaw.push(entity);
    }
    const mirrorX = (x: number) => (mirror ? width - x : x);
    const mirrorVx = (vx: number) => (mirror ? -vx : vx);
    const mapUnit = (entity: Entity) => ({
      unitId: entity.unitId,
      health: entity.health.current,
      maxHealth: entity.health.max,
      position: mirrorX(entity.transform.x),
      laneY: entity.transform.laneY,
      damage: entity.attack.damage,
      range: entity.attack.range,
      speed: Math.abs(entity.kinematics.vx),
      attackCooldownRemaining: entity.attack.cooldownRemaining,
      skillCooldownRemaining: entity.skillCooldownRemaining ?? 0,
    });

    const queue = this.getQueueForOwner(owner);
    const queueBlocked = queue.length >= QUEUE_CONFIG.maxQueueSize;
    const sideDifficulty = this.getDifficultyForOwner(owner);
    const discountedCost = (baseCost: number, category: EnemyPurchaseCategory): number => {
      if (!sideDifficulty) return baseCost;
      return Math.floor(baseCost * getEnemyPurchaseDiscountMultiplier(sideDifficulty, category));
    };

    let emptyUnlockedTurretSlots = 0;
    for (const slot of ownBase.turretSlots) {
      if (slot.slotIndex < ownBase.turretSlotsUnlocked && !slot.turretId) {
        emptyUnlockedTurretSlots += 1;
      }
    }

    let legalUnits = 0;
    let unitBlockedByAge = 0;
    let unitBlockedByGold = 0;
    let unitBlockedByMana = 0;
    let unitBlockedByQueue = 0;
    let unitBlockedByCap = 0;
    const ownUnitCapReached = ownUnitsRaw.length >= MAX_ACTIVE_UNITS_PER_SIDE;
    const unitCatalogDiagnostics = GameEngine.UNIT_CATALOG_ENTRIES.map(([unitId, def]) => {
      const ageRequired = def.age ?? 1;
      const goldCost = discountedCost(def.cost, 'unit');
      const manaCost = def.manaCost ?? 0;
      const ageLocked = ageRequired > ownProg.age;
      const goldShortfall = Math.max(0, goldCost - ownEcon.gold);
      const manaShortfall = Math.max(0, manaCost - ownEcon.mana);
      const capBlocked = ownUnitCapReached;
      const legalNow = !ageLocked && !queueBlocked && !capBlocked && goldShortfall <= 0 && manaShortfall <= 0;
      if (legalNow) {
        legalUnits += 1;
      } else if (ageLocked) {
        unitBlockedByAge += 1;
      } else if (queueBlocked) {
        unitBlockedByQueue += 1;
      } else if (capBlocked) {
        unitBlockedByCap += 1;
      } else {
        if (goldShortfall > 0) unitBlockedByGold += 1;
        if (manaShortfall > 0) unitBlockedByMana += 1;
      }
      const scorePower = def.damage * 6 + def.health * 0.6 + (def.range ?? 1) * 5 + def.speed * 2;
      return {
        unitId,
        ageRequired,
        goldCost,
        manaCost,
        legalNow,
        ageLocked,
        queueBlocked,
        goldShortfall,
        manaShortfall,
        capBlocked,
        scorePower,
      };
    });

    let legalTurrets = 0;
    let turretBlockedByAge = 0;
    let turretBlockedByGold = 0;
    let turretBlockedByMana = 0;
    let turretBlockedBySlot = 0;
    let turretBlockedByQueue = 0;
    const turretCatalogDiagnostics = GameEngine.TURRET_CATALOG_ENTRIES.map(([turretId, def]) => {
      const ageRequired = def.age;
      const goldCost = discountedCost(def.cost, 'turret_engine');
      const manaCost = def.manaCost ?? 0;
      const ageLocked = ageRequired > ownProg.age;
      const goldShortfall = Math.max(0, goldCost - ownEcon.gold);
      const manaShortfall = Math.max(0, manaCost - ownEcon.mana);
      const slotBlocked = emptyUnlockedTurretSlots <= 0;
      const legalNow = !ageLocked && !queueBlocked && !slotBlocked && goldShortfall <= 0 && manaShortfall <= 0;
      if (legalNow) {
        legalTurrets += 1;
      } else if (ageLocked) {
        turretBlockedByAge += 1;
      } else if (queueBlocked) {
        turretBlockedByQueue += 1;
      } else if (slotBlocked) {
        turretBlockedBySlot += 1;
      } else {
        if (goldShortfall > 0) turretBlockedByGold += 1;
        if (manaShortfall > 0) turretBlockedByMana += 1;
      }
      return {
        turretId,
        ageRequired,
        goldCost,
        manaCost,
        legalNow,
        ageLocked,
        queueBlocked,
        slotBlocked,
        goldShortfall,
        manaShortfall,
        scorePower: estimateEngineDps(def),
      };
    });

    const actionConstraintSummary = {
      queueRemaining: Math.max(0, QUEUE_CONFIG.maxQueueSize - queue.length),
      emptyUnlockedTurretSlots,
      legalUnits,
      legalTurrets,
      unitBlockedByAge,
      unitBlockedByGold,
      unitBlockedByMana,
      unitBlockedByQueue,
      unitBlockedByCap,
      turretBlockedByAge,
      turretBlockedByGold,
      turretBlockedByMana,
      turretBlockedBySlot,
      turretBlockedByQueue,
    };

    const projectiles = this.state.projectiles.map((projectile) => ({
      owner: projectile.owner === owner ? ('SELF' as const) : ('OPPONENT' as const),
      x: mirrorX(projectile.x),
      y: projectile.y,
      vx: mirrorVx(projectile.vx),
      vy: projectile.vy,
      damage: projectile.damage,
      lifeMs: projectile.lifeMs,
      splashRadius: projectile.splashRadius ?? 0,
      isFalling: Boolean(projectile.isFalling),
      hasDroneGuidance: Boolean(projectile.droneState),
    }));

    const activeAbilityEffects: Array<{
      owner: 'SELF' | 'OPPONENT';
      type: 'ability_cast' | 'ability_impact' | 'flamethrower';
      x: number;
      y: number;
      lifeMs: number;
    }> = [];
    for (const vfx of this.state.vfx) {
      if (vfx.type !== 'ability_cast' && vfx.type !== 'ability_impact' && vfx.type !== 'flamethrower') continue;
      const sourceOnRight = vfx.x > width * 0.5;
      const ownerRole = sourceOnRight ? (mirror ? 'OPPONENT' : 'SELF') : (mirror ? 'SELF' : 'OPPONENT');
      activeAbilityEffects.push({
        owner: ownerRole,
        type: vfx.type,
        x: mirrorX(vfx.x),
        y: vfx.y,
        lifeMs: vfx.lifeMs,
      });
    }

    const ownTurretStats = calculateTurretDefenseStats(ownBase);
    const opponentTurretStats = calculateTurretDefenseStats(opponentBase);
    const ownTurretSummary = ownBase.turretSlots.map((slot) => ({
      slotIndex: slot.slotIndex,
      turretId: slot.turretId,
      cooldownRemaining: slot.cooldownRemaining,
    }));
    const opponentTurretSummary = opponentBase.turretSlots.map((slot) => ({
      slotIndex: slot.slotIndex,
      turretId: slot.turretId,
      cooldownRemaining: slot.cooldownRemaining,
    }));

    const gameTimeSec = (this.state.tick * FIXED_TIMESTEP) / 1000;
    const ownBasePos = mirrorX(ownBase.x);
    const opponentBasePos = mirrorX(opponentBase.x);
    const ownUnits = ownUnitsRaw.map(mapUnit);
    const opponentUnits = opponentUnitsRaw.map(mapUnit);
    let enemyUnitsNearPlayerBase = 0;
    for (const unit of ownUnits) {
      if (Math.abs(unit.position - opponentBasePos) < 15) enemyUnitsNearPlayerBase += 1;
    }
    let playerUnitsNearEnemyBase = 0;
    for (const unit of opponentUnits) {
      if (Math.abs(unit.position - ownBasePos) < 15) playerUnitsNearEnemyBase += 1;
    }
    const opponentQueue = this.getQueueForOwner(opponent);
    const ownQueue = this.getQueueForOwner(owner);
    let playerTurretQueueCount = 0;
    for (const q of opponentQueue) {
      if (q.kind !== 'unit') playerTurretQueueCount += 1;
    }
    let enemyTurretQueueCount = 0;
    for (const q of ownQueue) {
      if (q.kind !== 'unit') enemyTurretQueueCount += 1;
    }
    const ownAgeUpTimes = this.telemetry.bySide[owner].ageUpTimes;
    const opponentAgeUpTimes = this.telemetry.bySide[opponent].ageUpTimes;
    const ownLastAgeUpTime = ownAgeUpTimes.length > 0 ? ownAgeUpTimes[ownAgeUpTimes.length - 1] : 0;
    const opponentLastAgeUpTime =
      opponentAgeUpTimes.length > 0 ? opponentAgeUpTimes[opponentAgeUpTimes.length - 1] : 0;
    const ownAgeRequirements = ownProg.ageProgress.requirements;
    const opponentAgeRequirements = opponentProg.ageProgress.requirements;

    return {
      tick: this.state.tick,
      gameTime: gameTimeSec,
      playerGold: opponentEcon.gold,
      enemyGold: ownEcon.gold,
      playerMana: opponentEcon.mana,
      enemyMana: ownEcon.mana,
      playerGoldIncome: opponentEcon.goldIncomePerSec,
      enemyGoldIncome: ownEcon.goldIncomePerSec,
      playerManaIncome: opponentEcon.manaIncomePerSec,
      enemyManaIncome: ownEcon.manaIncomePerSec,
      playerTotalManaSpent: this.state.stats.manaSpent.player,
      enemyTotalManaSpent: this.state.stats.manaSpent.enemy,
      playerAge: opponentProg.age,
      enemyAge: ownProg.age,
      playerAgeCost: opponentProg.ageProgress.costGold,
      enemyAgeCost: ownProg.ageProgress.costGold,
      playerAgeManaCost: opponentProg.ageProgress.costMana,
      enemyAgeManaCost: ownProg.ageProgress.costMana,
      playerAgeRequirementsMet: opponentProg.ageProgress.requirements.met,
      enemyAgeRequirementsMet: ownProg.ageProgress.requirements.met,
      playerAgeRequirementProgress: opponentProg.ageProgress.requirementProgress,
      enemyAgeRequirementProgress: ownProg.ageProgress.requirementProgress,
      playerAgePrevAgeUnitRequirementProgress: opponentAgeRequirements.prevAgeUnitsProgress,
      enemyAgePrevAgeUnitRequirementProgress: ownAgeRequirements.prevAgeUnitsProgress,
      playerAgeTotalUnitRequirementProgress: opponentAgeRequirements.totalUnitsProgress,
      enemyAgeTotalUnitRequirementProgress: ownAgeRequirements.totalUnitsProgress,
      playerManaLevel: opponentProg.manaGenerationLevel,
      enemyManaLevel: ownProg.manaGenerationLevel,
      playerBaseHealth: opponentBase.health,
      playerBaseMaxHealth: opponentBase.maxHealth,
      enemyBaseHealth: ownBase.health,
      enemyBaseMaxHealth: ownBase.maxHealth,
      playerTurretLevel: opponentTurretStats.legacyLevelEstimate,
      enemyTurretLevel: ownTurretStats.legacyLevelEstimate,
      playerTurretDps: opponentTurretStats.totalDps,
      enemyTurretDps: ownTurretStats.totalDps,
      playerTurretMaxRange: opponentTurretStats.maxRange,
      enemyTurretMaxRange: ownTurretStats.maxRange,
      playerTurretAvgRange: opponentTurretStats.avgRange,
      enemyTurretAvgRange: ownTurretStats.avgRange,
      playerTurretProtectionMultiplier: opponentTurretStats.strongestProtectionMultiplier,
      enemyTurretProtectionMultiplier: ownTurretStats.strongestProtectionMultiplier,
      playerTurretSlotsUnlocked: opponentBase.turretSlotsUnlocked,
      enemyTurretSlotsUnlocked: ownBase.turretSlotsUnlocked,
      playerTurretInstalledCount: opponentTurretStats.installedCount,
      enemyTurretInstalledCount: ownTurretStats.installedCount,
      playerTurretSlots: opponentTurretSummary,
      enemyTurretSlots: ownTurretSummary,
      playerUnitCount: opponentUnits.length,
      enemyUnitCount: ownUnits.length,
      playerUnitCap: MAX_ACTIVE_UNITS_PER_SIDE,
      enemyUnitCap: MAX_ACTIVE_UNITS_PER_SIDE,
      playerUnitCapReached: opponentUnits.length >= MAX_ACTIVE_UNITS_PER_SIDE,
      enemyUnitCapReached: ownUnits.length >= MAX_ACTIVE_UNITS_PER_SIDE,
      playerUnits: opponentUnits,
      enemyUnits: ownUnits,
      projectiles,
      activeAbilityEffects,
      unitCatalogDiagnostics,
      turretCatalogDiagnostics,
      actionConstraintSummary,
      playerQueueSize: opponentQueue.length,
      enemyQueueSize: ownQueue.length,
      playerTurretQueueCount,
      enemyTurretQueueCount,
      battlefieldWidth: width,
      playerBaseX: opponentBasePos,
      enemyBaseX: ownBasePos,
      difficulty: this.getDifficultyOrDefault(owner, this.config.difficulty),
      playerUnitsNearEnemyBase,
      enemyUnitsNearPlayerBase,
      lastEnemyBaseAttackTime: ownBase.lastAttackTime,
      playerTimeSinceLastAgeUp: Math.max(0, gameTimeSec - opponentLastAgeUpTime),
      enemyTimeSinceLastAgeUp: Math.max(0, gameTimeSec - ownLastAgeUpTime),
    };
  }

  // Execute AI decision from AIController
  private executeAIDecision(decision: AIDecision, owner: Owner = 'ENEMY'): boolean {
    const params = (decision.parameters ?? {}) as Record<string, any>;
    this.recordActionSnapshot(owner, decision.action, 'DECISION', true, params, decision.reasoning);
    let success = false;

    switch (decision.action) {
      case 'RECRUIT_UNIT':
        // Extract unit type from parameters
        const unitType = (decision.parameters as any)?.unitType;
        if (unitType) {
          const unit = UNIT_DEFS[unitType];
          if (!unit) return false;
          success = this.queueUnit(owner, unitType);
        }
        break;
        
      case 'AGE_UP':
        success = this.upgradeAge(owner);
        break;
        
      case 'UPGRADE_MANA':
        success = this.upgradeManaGeneration(owner);
        break;
        
      case 'UPGRADE_TURRET_SLOTS':
        success = this.queueTurretSlotUpgrade(owner);
        break;

      case 'BUY_TURRET_ENGINE': {
        const slotIndex = (decision.parameters as any)?.slotIndex;
        const turretId = (decision.parameters as any)?.turretId;
        if (typeof slotIndex === 'number' && typeof turretId === 'string') {
          success = this.queueTurretEngine(owner, slotIndex, turretId);
        }
        break;
      }

      case 'SELL_TURRET_ENGINE': {
        const slotIndex = (decision.parameters as any)?.slotIndex;
        if (typeof slotIndex === 'number') {
          success = this.sellTurretEngine(owner, slotIndex);
        }
        break;
      }
        
      case 'EXECUTE_ATTACK_GROUP':
        // Attack group execution - recruit all units in the group (legacy support)
        if ((decision as any).attackGroup) {
          let anyQueued = false;
          for (const composition of (decision as any).attackGroup.composition) {
            for (let i = 0; i < composition.count; i++) {
              const unit = UNIT_DEFS[composition.unitId];
              if (!unit) continue;
              anyQueued = this.queueUnit(owner, composition.unitId) || anyQueued;
            }
          }
          success = anyQueued;
        }
        break;
        
      case 'WAIT':
        // Intentionally no fallback spending here; behavior logic owns reserve-aware decisions.
        success = true;
        break;

      case 'REPAIR_BASE':
        success = this.healBase(owner);
        break;
    }
    this.recordActionSnapshot(owner, decision.action, 'EXECUTED', success, params, decision.reasoning);
    return success;
  }

  private updateAISides(deltaTime: number): void {
    for (const owner of ['PLAYER', 'ENEMY'] as const) {
      if (!this.isAISide(owner)) continue;
      this.aiAccumulatorsMs[owner] += deltaTime;
      while (this.aiAccumulatorsMs[owner] >= 500) {
        this.aiAccumulatorsMs[owner] -= 500;
        this.updateAIForOwner(owner);
      }
    }
  }

  private updateAIForOwner(owner: Owner): void {
    const controller = this.aiControllers[owner];
    if (!controller) return;

    const gameState = this.extractGameStateForAI(owner);
    const decision = controller.makeDecision(gameState, gameState.gameTime);
    this.executeAIDecision(decision, owner);
  }


  private updateTurrets(deltaSeconds: number): void {
      this.turretSystem.update(this.state, deltaSeconds);
  }


  private render(): void {
    if (this.renderSystem) {
      this.syncCanvasSizeToBattlefield();
      this.renderSystem.render(this.state);
    }
  }

  private syncCanvasSizeToBattlefield(): void {
    if (!this.canvas) return;

    const baselineWidthUnits = RENDER_CONFIG.BATTLEFIELD.BASE_WIDTH_UNITS;
    const baselineCanvasWidthPx = RENDER_CONFIG.BATTLEFIELD.BASE_CANVAS_WIDTH_PX;
    const baselineCanvasHeightPx = RENDER_CONFIG.BATTLEFIELD.BASE_CANVAS_HEIGHT_PX;
    const battlefieldWidthUnits = Math.max(1, this.state.battlefield.width);
    const targetWidth = Math.max(
      baselineCanvasWidthPx,
      Math.round((battlefieldWidthUnits / baselineWidthUnits) * baselineCanvasWidthPx)
    );

    if (this.canvas.width !== targetWidth) {
      this.canvas.width = targetWidth;
    }
    if (this.canvas.height !== baselineCanvasHeightPx) {
      this.canvas.height = baselineCanvasHeightPx;
    }
  }

  private completeTurretSlotUnlock(owner: 'PLAYER' | 'ENEMY'): void {
    const base = owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
    if (base.turretSlotsUnlocked >= MAX_TURRET_SLOTS) return;
    base.turretSlotsUnlocked += 1;
    this.recomputeBaseTurretLevel(base);
    console.log(`${owner} unlocked turret slot ${base.turretSlotsUnlocked}/${MAX_TURRET_SLOTS}`);
  }

  private completeTurretEngineBuild(owner: 'PLAYER' | 'ENEMY', slotIndex: number, turretId: string): void {
    const base = owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
    if (slotIndex < 0 || slotIndex >= base.turretSlotsUnlocked) return;
    const slot = base.turretSlots[slotIndex];
    if (!slot) return;
    slot.turretId = turretId;
    slot.cooldownRemaining = 0;
    this.recomputeBaseTurretLevel(base);
    console.log(`${owner} mounted turret engine ${turretId} on slot ${slotIndex + 1}`);
  }

  private getBaseForOwner(owner: 'PLAYER' | 'ENEMY'): BaseState {
    return owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
  }

  private getQueueForOwner(owner: 'PLAYER' | 'ENEMY'): BuildQueueItem[] {
    return owner === 'PLAYER' ? this.state.playerQueue : this.state.enemyQueue;
  }

  private countActiveUnits(owner: 'PLAYER' | 'ENEMY'): number {
    let count = 0;
    for (const entity of this.state.entities.values()) {
      if (entity.owner === owner) count += 1;
    }
    return count;
  }

  private hasReachedActiveUnitCap(owner: 'PLAYER' | 'ENEMY'): boolean {
    return this.countActiveUnits(owner) >= MAX_ACTIVE_UNITS_PER_SIDE;
  }

  private getEconomyForOwner(owner: 'PLAYER' | 'ENEMY') {
    return owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
  }

  private getProgressionForOwner(owner: 'PLAYER' | 'ENEMY') {
    return owner === 'PLAYER' ? this.state.progression.player : this.state.progression.enemy;
  }

  private getBuiltUnitStats(owner: 'PLAYER' | 'ENEMY'): { totalUnitsBuilt: number; builtByAge: Record<number, number> } {
    const counts = this.telemetry.bySide[owner].unitBuildCounts ?? {};
    const builtByAge: Record<number, number> = {};
    let totalUnitsBuilt = 0;
    for (const [unitId, rawCount] of Object.entries(counts)) {
      const count = Math.max(0, Number(rawCount) || 0);
      if (count <= 0) continue;
      const unitAge = Math.max(1, UNIT_DEFS[unitId]?.age ?? 1);
      builtByAge[unitAge] = (builtByAge[unitAge] ?? 0) + count;
      totalUnitsBuilt += count;
    }
    return { totalUnitsBuilt, builtByAge };
  }

  private refreshAgeUpgradeProgress(owner: 'PLAYER' | 'ENEMY'): void {
    const prog = this.getProgressionForOwner(owner);
    const econ = this.getEconomyForOwner(owner);
    const maxAge = PROGRESSION_CONFIG.maxAge;

    if (prog.age >= maxAge) {
      prog.ageProgress = {
        costGold: 0,
        costMana: 0,
        canUpgrade: false,
        requirementProgress: 1,
        requirementText: 'Max age reached',
        requirements: {
          targetAge: maxAge,
          prevAgeUnitsRequired: 0,
          prevAgeUnitsBuilt: 0,
          prevAgeUnitsProgress: 1,
          totalUnitsRequired: 0,
          totalUnitsBuilt: 0,
          totalUnitsProgress: 1,
          met: true,
          missing: [],
        },
      };
      return;
    }

    const targetAge = prog.age + 1;
    const rule = getAgeUpgradeRequirementRule(prog.age);
    const costGold = getAgeUpgradeCost(prog.age);
    const costMana = getAgeUpgradeManaCost(prog.age);
    const { totalUnitsBuilt, builtByAge } = this.getBuiltUnitStats(owner);
    const prevAgeUnitsBuilt = builtByAge[prog.age] ?? 0;
    const prevAgeUnitsRequired = Math.max(0, rule.prevAgeUnitsRequired ?? 0);
    const totalUnitsRequired = Math.max(0, rule.totalUnitsRequired ?? 0);
    const prevAgeUnitsProgress =
      prevAgeUnitsRequired > 0 ? Math.min(1, prevAgeUnitsBuilt / prevAgeUnitsRequired) : 1;
    const totalUnitsProgress =
      totalUnitsRequired > 0 ? Math.min(1, totalUnitsBuilt / totalUnitsRequired) : 1;

    const missing: string[] = [];
    if (prevAgeUnitsRequired > 0 && prevAgeUnitsBuilt < prevAgeUnitsRequired) {
      missing.push(`Build ${prevAgeUnitsRequired} age-${prog.age} units (${prevAgeUnitsBuilt}/${prevAgeUnitsRequired})`);
    }
    if (totalUnitsRequired > 0 && totalUnitsBuilt < totalUnitsRequired) {
      missing.push(`Build ${totalUnitsRequired} total units (${totalUnitsBuilt}/${totalUnitsRequired})`);
    }
    if (costGold > 0 && econ.gold < costGold) {
      missing.push(`Need ${Math.ceil(costGold - econ.gold)} more gold`);
    }
    if (costMana > 0 && econ.mana < costMana) {
      missing.push(`Need ${Math.ceil(costMana - econ.mana)} more mana`);
    }

    const requirementProgress = Math.min(prevAgeUnitsProgress, totalUnitsProgress);
    const requirementsMet = missing.length === 0;

    prog.ageProgress = {
      costGold,
      costMana,
      canUpgrade: requirementsMet,
      requirementProgress,
      requirementText: requirementsMet ? `Ready for age ${targetAge}` : missing[0] ?? 'Requirement pending',
      requirements: {
        targetAge,
        prevAgeUnitsRequired,
        prevAgeUnitsBuilt,
        prevAgeUnitsProgress,
        totalUnitsRequired,
        totalUnitsBuilt,
        totalUnitsProgress,
        met: requirementsMet,
        missing,
      },
    };
  }

  private getDiscountedGoldCostForOwner(
    owner: 'PLAYER' | 'ENEMY',
    baseCost: number,
    category: EnemyPurchaseCategory = 'unit'
  ): number {
    const difficulty = this.getDifficultyForOwner(owner);
    if (!difficulty) return baseCost;
    const multiplier = getEnemyPurchaseDiscountMultiplier(difficulty, category);
    return Math.floor(baseCost * multiplier);
  }

  queueTurretSlotUpgrade(owner: 'PLAYER' | 'ENEMY' = 'PLAYER'): boolean {
    const base = this.getBaseForOwner(owner);
    const econ = this.getEconomyForOwner(owner);
    const queue = this.getQueueForOwner(owner);
    if (queue.length >= QUEUE_CONFIG.maxQueueSize) return false;
    if (base.turretSlotsUnlocked >= MAX_TURRET_SLOTS) return false;
    if (queue.some((item) => item.kind === 'turret_slot')) return false;

    const cost = this.getDiscountedGoldCostForOwner(
      owner,
      getTurretSlotUnlockCost(base.turretSlotsUnlocked),
      'turret_upgrade'
    );
    if (econ.gold < cost) return false;
    econ.gold -= cost;

    queue.push({
      kind: 'turret_slot',
      remainingMs: getTurretSlotUnlockBuildMs(base.turretSlotsUnlocked),
      refundGold: cost,
      label: `Unlock Slot ${base.turretSlotsUnlocked + 1}`,
    });
    this.telemetry.bySide[owner].turretSlotUpgradeCount += 1;
    this.recordActionSnapshot(owner, 'UPGRADE_TURRET_SLOTS', 'EXECUTED', true, { cost });
    return true;
  }

  queueTurretEngine(
    owner: 'PLAYER' | 'ENEMY',
    slotIndex: number,
    turretId: string,
    skipQueueLimit = false
  ): boolean {
    const base = this.getBaseForOwner(owner);
    const econ = this.getEconomyForOwner(owner);
    const prog = this.getProgressionForOwner(owner);
    const queue = this.getQueueForOwner(owner);

    if (!skipQueueLimit && queue.length >= QUEUE_CONFIG.maxQueueSize) return false;
    if (slotIndex < 0 || slotIndex >= base.turretSlotsUnlocked) return false;

    const slot = base.turretSlots[slotIndex];
    if (!slot) return false;
    if (slot.turretId) return false;
    if (queue.some((item) => item.kind === 'turret_engine' && item.slotIndex === slotIndex)) return false;

    const engine = getTurretEngineDef(turretId);
    if (!engine) return false;
    if (engine.age > prog.age) return false;

    let finalCost = this.getDiscountedGoldCostForOwner(owner, engine.cost, 'turret_engine');
    const finalManaCost = engine.manaCost ?? 0;

    if (econ.gold < finalCost) return false;
    if (econ.mana < finalManaCost) return false;
    econ.gold -= finalCost;
    econ.mana -= finalManaCost;
    recordManaSpent(this.state, owner, finalManaCost, 'ability');

    queue.push({
      kind: 'turret_engine',
      turretId,
      slotIndex,
      remainingMs: engine.buildMs,
      refundGold: finalCost,
      label: `${engine.name} -> S${slotIndex + 1}`,
    });
    this.telemetry.bySide[owner].turretEngineBuys[turretId] =
      (this.telemetry.bySide[owner].turretEngineBuys[turretId] ?? 0) + 1;
    this.recordActionSnapshot(owner, 'BUY_TURRET_ENGINE', 'EXECUTED', true, { turretId, slotIndex, cost: finalCost });

    return true;
  }

  sellTurretEngine(owner: 'PLAYER' | 'ENEMY', slotIndex: number): boolean {
    const base = this.getBaseForOwner(owner);
    const econ = this.getEconomyForOwner(owner);
    if (slotIndex < 0 || slotIndex >= base.turretSlotsUnlocked) return false;
    const slot = base.turretSlots[slotIndex];
    if (!slot?.turretId) return false;

    const engine = getTurretEngineDef(slot.turretId);
    if (!engine) return false;

    const difficulty = this.getDifficultyOrDefault(owner, this.config.difficulty);
    const refund = Math.floor(
      engine.cost *
        getTurretSellRefundMultiplier(owner === 'PLAYER' && !this.isAISide(owner), difficulty)
    );
    econ.gold += refund;
    slot.turretId = null;
    slot.cooldownRemaining = 0;
    this.recomputeBaseTurretLevel(base);
    this.telemetry.bySide[owner].turretEngineSells[engine.id] =
      (this.telemetry.bySide[owner].turretEngineSells[engine.id] ?? 0) + 1;
    this.recordActionSnapshot(owner, 'SELL_TURRET_ENGINE', 'EXECUTED', true, { slotIndex, turretId: engine.id, refund });
    return true;
  }

  private autoManageEnemyTurrets(): boolean {
    const base = this.state.enemyBase;
    const econ = this.state.economy.enemy;
    const enemyAge = this.state.progression.enemy.age;
    const gameTime = (this.state.tick * FIXED_TIMESTEP) / 1000;
    let playerUnitCount = 0;
    let enemyUnitCount = 0;
    let playerNearEnemyBase = 0;
    let playerHealthTotal = 0;
    let playerHeavyUnits = 0;
    for (const unit of this.state.entities.values()) {
      if (unit.owner === 'PLAYER') {
        playerUnitCount += 1;
        playerHealthTotal += unit.health.current;
        if (Math.abs(unit.transform.x - this.state.enemyBase.x) < 15) playerNearEnemyBase += 1;
        if (unit.health.current >= 320) playerHeavyUnits += 1;
      } else if (unit.owner === 'ENEMY') {
        enemyUnitCount += 1;
      }
    }
    const severeOutnumbered = playerUnitCount >= Math.max(7, enemyUnitCount * 6) || playerNearEnemyBase >= 4;
    const avgPlayerHp = playerUnitCount > 0 ? playerHealthTotal / playerUnitCount : 0;
    const swarmPressure = playerUnitCount >= Math.max(6, enemyUnitCount + 4) || (playerUnitCount >= 4 && avgPlayerHp <= 180);
    const heavyPressure = avgPlayerHp >= 260 || playerHeavyUnits >= 2;

    const desiredSlotsByAge = enemyAge >= 6
      ? ((gameTime >= 140 && this.state.economy.enemy.mana >= 5000) ? 4 : 3)
      : enemyAge >= 5 ? 3 : enemyAge >= 3 ? 2 : 1;

    const isMultiTargetEngine = (engine: NonNullable<ReturnType<typeof getTurretEngineDef>>) => {
      if (engine.attackType === 'chain_lightning' || engine.attackType === 'artillery_barrage' || engine.attackType === 'oil_pour') {
        return true;
      }
      if (engine.attackType !== 'projectile' || !engine.projectile) return false;
      return (engine.projectile.splashRadius ?? 0) > 0 || !!engine.projectile.splitOnImpact || (engine.projectile.pierceCount ?? 0) >= 2;
    };

    const getSingleTargetPressure = (engine: NonNullable<ReturnType<typeof getTurretEngineDef>>) => {
      if (engine.attackType === 'projectile' && engine.projectile) {
        const direct = engine.projectile.damage / Math.max(0.1, engine.fireIntervalSec);
        const pierceBonus = 1 + Math.min(0.6, (engine.projectile.pierceCount ?? 0) * 0.2);
        const antiSplashPenalty = isMultiTargetEngine(engine) ? 0.88 : 1.0;
        return direct * pierceBonus * antiSplashPenalty;
      }
      if (engine.attackType === 'laser_pulse' && engine.laserPulse) return engine.laserPulse.damage / Math.max(0.1, engine.laserPulse.cooldownSeconds);
      if (engine.attackType === 'mana_siphon' && engine.manaSiphon) return engine.manaSiphon.tickDamage * engine.manaSiphon.ticksPerSecond;
      return 0;
    };

    const scoreEngine = (engine: NonNullable<ReturnType<typeof getTurretEngineDef>>): number => {
      let score =
        estimateEngineDps(engine) * 2.2 +
        (1 - engine.protectionMultiplier) * 2000 +
        engine.range * 15 +
        engine.age * 50;
      if (swarmPressure) {
        score *= isMultiTargetEngine(engine) ? 1.35 : 0.86;
      }
      if (heavyPressure) {
        score += getSingleTargetPressure(engine) * 1.25;
        if (!isMultiTargetEngine(engine)) score *= 1.14;
      }
      if (severeOutnumbered && enemyAge >= 4 && engine.age < Math.max(2, enemyAge - 2)) {
        score *= 0.76;
      }
      return score;
    };

    const getDiscountedCost = (cost: number) => this.getDiscountedGoldCostForOwner('ENEMY', cost, 'turret_engine');
    const canAfford = (engine: NonNullable<ReturnType<typeof getTurretEngineDef>>, goldOverride?: number) =>
      getDiscountedCost(engine.cost) <= (goldOverride ?? econ.gold) &&
      (engine.manaCost ?? 0) <= econ.mana;
    const availableEngines = Object.values(getTurretEnginesForAge(enemyAge))
      .sort((a, b) => scoreEngine(b) - scoreEngine(a));

    if (availableEngines.length === 0) return false;

    for (let i = 0; i < base.turretSlotsUnlocked; i++) {
      if (!base.turretSlots[i]?.turretId) {
        const preferred = severeOutnumbered && enemyAge >= 4
          ? availableEngines.filter((e) => e.age >= Math.max(2, enemyAge - 2))
          : availableEngines;
        const candidatePool = preferred.length > 0 ? preferred : availableEngines;
        const affordable = candidatePool.filter((e) => canAfford(e));
        const pick =
          (swarmPressure ? affordable.find((e) => isMultiTargetEngine(e)) : null) ??
          (heavyPressure ? [...affordable].sort((a, b) => getSingleTargetPressure(b) - getSingleTargetPressure(a))[0] : null) ??
          affordable[0];
        if (pick) {
          return this.queueTurretEngine('ENEMY', i, pick.id);
        }
      }
    }

    if (base.turretSlotsUnlocked < desiredSlotsByAge) {
      return this.queueTurretSlotUpgrade('ENEMY');
    }

    const canReplace = enemyAge >= 4 && (
      severeOutnumbered ||
      playerUnitCount > enemyUnitCount + 3 ||
      this.state.enemyBase.health < this.state.enemyBase.maxHealth * 0.7
    );
    if (canReplace) {
      if (this.state.enemyQueue.length >= QUEUE_CONFIG.maxQueueSize) {
        return false;
      }
      let weakestSlot = -1;
      let weakestScore = Infinity;
      let weakestDef: NonNullable<ReturnType<typeof getTurretEngineDef>> | null = null;
      for (let i = 0; i < base.turretSlotsUnlocked; i++) {
        const turretId = base.turretSlots[i]?.turretId;
        if (!turretId) continue;
        const def = getTurretEngineDef(turretId);
        if (!def) continue;
        const score = scoreEngine(def);
        if (score < weakestScore) {
          weakestScore = score;
          weakestSlot = i;
          weakestDef = def;
        }
      }

      if (weakestSlot >= 0 && weakestDef) {
        const refundMultiplier = getTurretSellRefundMultiplier(
          false,
          this.getDifficultyOrDefault('ENEMY', this.config.difficulty)
        );
        const budgetAfterSell = econ.gold + Math.floor(weakestDef.cost * refundMultiplier);
        const improvementThreshold = severeOutnumbered ? 1.06 : 1.16;
        const betterOption = availableEngines.find(
          (def) =>
            def.id !== weakestDef!.id &&
            canAfford(def, budgetAfterSell) &&
            scoreEngine(def) > weakestScore * improvementThreshold
        );
        if (!betterOption) return false;
        const sold = this.sellTurretEngine('ENEMY', weakestSlot);
        if (sold) {
          return this.queueTurretEngine('ENEMY', weakestSlot, betterOption.id);
        }
      }
    }

    return false;
  }



  spawnUnit(unitId: string): void {
    // Player queues units through unified queue API
    this.queueUnit('PLAYER', unitId);
  }

  // Unified queueing logic for player and enemy so costs, training times, and queue rules match
  queueUnit(owner: 'PLAYER' | 'ENEMY', unitId: string, emergency: boolean = false): boolean {
    const unitDef = UNIT_DEFS[unitId] || UNIT_DEFS.stone_clubman;
    const econ = this.getEconomyForOwner(owner);
    const queue = this.getQueueForOwner(owner);
    const maxQueue = QUEUE_CONFIG.maxQueueSize;
    if (this.hasReachedActiveUnitCap(owner)) return false;
    if (queue.length >= maxQueue) return false;
    // enforce age availability
    const ownerAge = this.getProgressionForOwner(owner).age;
    if ((unitDef.age ?? 1) > ownerAge) return false; // cannot queue unit beyond current age
    
    // Apply Difficulty Discount for AI
    let finalCost = this.getDiscountedGoldCostForOwner(owner, unitDef.cost);

    if (econ.gold < finalCost) return false;
    
    // WARCHEST ENFORCEMENT: Enemy AI cannot spend below warchest reserve
    // Warchest is now handled by the modular AI system (AIController + BalancedAI)
    // The AI passes spendableGold (total - warchest) to recruitment decisions
    
    // if unit requires mana to train, check and deduct
    if ((unitDef.manaCost ?? 0) > 0) {
      if (econ.mana < (unitDef.manaCost ?? 0)) return false;
      econ.mana -= (unitDef.manaCost ?? 0);
      recordManaSpent(this.state, owner, unitDef.manaCost ?? 0, 'unit');
    }
    econ.gold -= finalCost;
    
    // Apply age-based build time reduction (10% per age, minimum 40%)
    const buildTimeMultiplier = Math.max(0.4, 1 - (ownerAge - 1) * 0.1);
    const adjustedTrainingMs = (unitDef.trainingMs ?? 2000) * buildTimeMultiplier;
    
    queue.push({ kind: 'unit', unitId, remainingMs: adjustedTrainingMs, refundGold: finalCost, label: unitId });
    this.telemetry.bySide[owner].unitBuildCounts[unitId] =
      (this.telemetry.bySide[owner].unitBuildCounts[unitId] ?? 0) + 1;
    this.recordActionSnapshot(owner, 'RECRUIT_UNIT', 'EXECUTED', true, { unitType: unitId, cost: finalCost });
    console.log(`${owner} queued ${unitId} (cost ${finalCost}g, training ${Math.round(adjustedTrainingMs)}ms). Queue now ${queue.length}`);
    return true;
  }

  upgradeAge(owner: 'PLAYER' | 'ENEMY' = 'PLAYER'): boolean {
    const prog = owner === 'PLAYER' ? this.state.progression.player : this.state.progression.enemy;
    const econ = owner === 'PLAYER' ? this.state.economy.player : this.state.economy.enemy;
    const base = owner === 'PLAYER' ? this.state.playerBase : this.state.enemyBase;
    if (prog.age >= PROGRESSION_CONFIG.maxAge) return false;
    this.refreshAgeUpgradeProgress(owner);
    const costGold = prog.ageProgress.costGold;
    const costMana = prog.ageProgress.costMana;
    if (!prog.ageProgress.canUpgrade) return false;
    if (econ.gold < costGold) return false;
    if (econ.mana < costMana) return false;
    prog.age += 1;
    econ.gold -= costGold;
    econ.mana -= costMana;
    recordManaSpent(this.state, owner, costMana, 'ability');
    
    // Update income using centralized config
    let newIncome = getGoldIncome(prog.age);

    // Apply difficulty multiplier for AI-controlled side consistently
    const sideDifficulty = this.getDifficultyForOwner(owner);
    if (sideDifficulty) {
      newIncome *= DIFFICULTY_CONFIG[sideDifficulty].goldMultiplier;
    }

    econ.goldIncomePerSec = newIncome;
    
    // Mana income NO LONGER auto-increases with age - must upgrade separately
    
    // Update next age readiness/costs after progression change.
    this.refreshAgeUpgradeProgress(owner);
    
    // Expand battlefield from the middle - both halves grow to maintain symmetry
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
    const healthIncrease = base.maxHealth * (PROGRESSION_CONFIG.ageBaseHealthMultiplier - 1);
    base.maxHealth *= PROGRESSION_CONFIG.ageBaseHealthMultiplier;
    base.health += healthIncrease;
    if (base.health > base.maxHealth) base.health = base.maxHealth;
    
    console.log(
      `${owner} Age upgraded to ${prog.age}, player half: ${this.state.battlefield.playerHalfWidth.toFixed(1)}, enemy half: ${this.state.battlefield.enemyHalfWidth.toFixed(1)}, total width: ${this.state.battlefield.width.toFixed(1)}, base health: ${Math.floor(base.health)}/${base.maxHealth}, next cost: ${prog.ageProgress.costGold}g/${prog.ageProgress.costMana}m`
    );
    this.telemetry.bySide[owner].ageUpTimes.push((this.state.tick * FIXED_TIMESTEP) / 1000);
    this.recordActionSnapshot(owner, 'AGE_UP', 'EXECUTED', true, { newAge: prog.age });
    
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
    recordManaSpent(this.state, owner, manaCost, 'ability');
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
    this.recordActionSnapshot(owner, 'REPAIR_BASE', 'EXECUTED', true, { healAmount, manaCost });
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
    this.telemetry.bySide[owner].manaUpgradeCount += 1;
    this.recordActionSnapshot(owner, 'UPGRADE_MANA', 'EXECUTED', true, { level: prog.manaGenerationLevel, cost });
    return true;
  }

  cancelQueueItem(index: number): void {
    if (index >= 0 && index < this.state.playerQueue.length) {
      const queuedItem = this.state.playerQueue[index];
      const refund = queuedItem.refundGold ?? 0;
      this.state.economy.player.gold += refund;
      // Remove from queue
      this.state.playerQueue.splice(index, 1);
      console.log(`Cancelled queued ${queuedItem.kind}, refunded ${refund}g`);
    }
  }

  getState(): GameState {
    // Return a snapshot copy and include derived UI-friendly values like turret upgrade cost
    const snapshot = createSnapshot(this.state) as GameState & { playerBase?: any; enemyBase?: any };
    if (snapshot.playerBase) {
      snapshot.playerBase.nextTurretSlotCost = getTurretSlotUnlockCost(snapshot.playerBase.turretSlotsUnlocked);
      snapshot.playerBase.maxTurretSlots = MAX_TURRET_SLOTS;
      snapshot.playerBase.turretDefenseStats = calculateTurretDefenseStats(snapshot.playerBase);
    }
    if (snapshot.enemyBase) {
      snapshot.enemyBase.nextTurretSlotCost = getTurretSlotUnlockCost(snapshot.enemyBase.turretSlotsUnlocked);
      snapshot.enemyBase.maxTurretSlots = MAX_TURRET_SLOTS;
      snapshot.enemyBase.turretDefenseStats = calculateTurretDefenseStats(snapshot.enemyBase);
    }
    (snapshot as any).turretCatalog = TURRET_ENGINES;
    // also include available units for UI convenience
    (snapshot as any).unitCatalog = UNIT_DEFS;
    // telemetry
    (snapshot as any).stats = this.state.stats;
    (snapshot as any).telemetry = this.getTelemetrySnapshot();
    (snapshot as any).sideControl = this.getSideControlSnapshot();
    // Debug: Expose AI State (legacy + per-side)
    const enemyAI = this.aiControllers.ENEMY;
    if (enemyAI) {
      (snapshot as any).aiState = enemyAI.getState();
    }
    (snapshot as any).aiBySide = this.getAIControllersDebug();
    
    return snapshot;
  }

  // ============================================================================
  // SAVE/LOAD SYSTEM - Single source of truth for game persistence
  // ============================================================================
  
  private static readonly SAVE_KEY = 'ageOfWar_saveGame';

  private static getStorage(): Storage | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  }

  public exportSerializableState(): Record<string, unknown> {
    const entitiesArray = Array.from(this.state.entities.values());
    return {
      version: 3,
      state: {
        ...this.state,
        entities: entitiesArray,
      },
      telemetry: this.getTelemetrySnapshot(),
      runtime: {
        aiAccumulatorsMs: this.aiAccumulatorsMs,
        aiAccumulatorMs: this.aiAccumulatorsMs.ENEMY,
        lastUpdateTime: this.lastUpdateTime,
        enemyCyberAssassin6kBonusUsed: this.enemyCyberAssassin6kBonusUsed,
        enemyCyberAssassin12kBonusUsed: this.enemyCyberAssassin12kBonusUsed,
      },
      aiState: this.aiControllers.ENEMY?.getState() ?? null,
      aiStateByOwner: {
        PLAYER: this.aiControllers.PLAYER?.getState() ?? null,
        ENEMY: this.aiControllers.ENEMY?.getState() ?? null,
      },
      seed: this.seed,
      config: this.config,
      timestamp: Date.now(),
    };
  }

  public importSerializableState(saveData: unknown): boolean {
    try {
      if (!saveData || typeof saveData !== 'object') return false;
      const parsed = saveData as Record<string, any>;
      if (!parsed.state || typeof parsed.state !== 'object') return false;

      if (parsed.config) this.config = parsed.config;
      if (typeof parsed.seed === 'number' && Number.isFinite(parsed.seed)) {
        this.seed = parsed.seed;
      }

      const loadedState = parsed.state as Record<string, any>;

      const entityMap = new Map<number, Entity>();
      if (Array.isArray(loadedState.entities)) {
        for (const entity of loadedState.entities) {
          if (entity?.entityId !== undefined) {
            entityMap.set(entity.entityId, entity as Entity);
          } else if (entity?.id !== undefined) {
            entityMap.set(entity.id, entity as Entity);
          }
        }
      }
      loadedState.entities = entityMap;

      if (!loadedState.playerBase || !loadedState.enemyBase) {
        return false;
      }

      this.state = loadedState as unknown as GameState;
      if (!this.state.stats || typeof this.state.stats !== 'object') {
        this.state.stats = {
          damageDealt: { player: 0, enemy: 0 },
          manaSpent: { player: 0, enemy: 0 },
          manaSpentUnits: { player: 0, enemy: 0 },
          manaSpentAbilities: { player: 0, enemy: 0 },
        };
      }
      this.state.stats.damageDealt = {
        player: Number(this.state.stats.damageDealt?.player) || 0,
        enemy: Number(this.state.stats.damageDealt?.enemy) || 0,
      };
      ensureManaSpendStats(this.state);
      this.state.playerBase = this.ensureBaseTurretState(this.state.playerBase as BaseState);
      this.state.enemyBase = this.ensureBaseTurretState(this.state.enemyBase as BaseState);
      this.state.playerQueue = (this.state.playerQueue ?? []).map((item: any) => {
        if (item && item.kind) return item as BuildQueueItem;
        return {
          kind: 'unit',
          unitId: item?.unitId,
          remainingMs: item?.remainingMs ?? 0,
          refundGold: UNIT_DEFS[item?.unitId || 'stone_clubman']?.cost ?? 0,
          label: item?.unitId,
        } as BuildQueueItem;
      });
      this.state.enemyQueue = (this.state.enemyQueue ?? []).map((item: any) => {
        if (item && item.kind) return item as BuildQueueItem;
        return {
          kind: 'unit',
          unitId: item?.unitId,
          remainingMs: item?.remainingMs ?? 0,
          refundGold: UNIT_DEFS[item?.unitId || 'stone_clubman']?.cost ?? 0,
          label: item?.unitId,
        } as BuildQueueItem;
      });
      this.aiAccumulatorsMs = parsed.runtime?.aiAccumulatorsMs ?? {
        PLAYER: 0,
        ENEMY: parsed.runtime?.aiAccumulatorMs ?? 0,
      };
      this.lastUpdateTime = parsed.runtime?.lastUpdateTime ?? 0;
      this.enemyCyberAssassin6kBonusUsed = parsed.runtime?.enemyCyberAssassin6kBonusUsed ?? false;
      this.enemyCyberAssassin12kBonusUsed = parsed.runtime?.enemyCyberAssassin12kBonusUsed ?? false;

      this.prng = new PRNG(this.seed);
      this.sideControl = this.buildSideControl(this.config);
      this.telemetry = this.hydrateTelemetry(parsed.telemetry);
      this.lastTelemetrySampleTimeSec =
        this.telemetry.baseHealthTimeline.length > 0
          ? this.telemetry.baseHealthTimeline[this.telemetry.baseHealthTimeline.length - 1].gameTime ?? 0
          : 0;
      this.refreshAgeUpgradeProgress('PLAYER');
      this.refreshAgeUpgradeProgress('ENEMY');
      this.initializeAIControllers();

      const aiStateByOwner = parsed.aiStateByOwner ?? {};
      if (this.aiControllers.PLAYER && aiStateByOwner.PLAYER) {
        this.aiControllers.PLAYER.restoreState(aiStateByOwner.PLAYER);
      }
      if (this.aiControllers.ENEMY) {
        const enemyState = aiStateByOwner.ENEMY ?? parsed.aiState;
        if (enemyState) {
          this.aiControllers.ENEMY.restoreState(enemyState);
        }
      }

      this.syncBasePositions();
      this.ensureUnitSpritesLoaded();
      return true;
    } catch (error) {
      console.error('[ERROR] Failed to import game state:', error);
      return false;
    }
  }
  
  /**
   * Save complete game state to localStorage
   * Converts Map to array for JSON serialization
   */
  saveGameState(): void {
    try {
      const storage = GameEngine.getStorage();
      if (!storage) return;
      const saveData = this.exportSerializableState();
      storage.setItem(GameEngine.SAVE_KEY, JSON.stringify(saveData));
      console.log('[SAVE] Game saved successfully:', {
        entities: Array.isArray((saveData.state as any)?.entities) ? (saveData.state as any).entities.length : 0,
        playerGold: this.state.economy.player.gold,
        playerAge: this.state.progression.player.age,
        battlefieldWidth: this.state.battlefield.width,
      });
    } catch (error) {
      console.error('[ERROR] Failed to save game:', error);
      throw error;
    }
  }

  /**
   * Load complete game state from localStorage
   * Converts array back to Map and validates data integrity
   */
  loadGameState(): boolean {
    try {
      const storage = GameEngine.getStorage();
      if (!storage) return false;
      const saved = storage.getItem(GameEngine.SAVE_KEY);
      if (!saved) {
        console.log('No saved game found');
        return false;
      }

      const saveData = JSON.parse(saved);
      const ok = this.importSerializableState(saveData);
      if (!ok) {
        console.error('[ERROR] Failed to load game: invalid save payload');
        return false;
      }

      console.log('[LOAD] Game loaded successfully:', {
        entities: this.state.entities.size,
        playerGold: this.state.economy.player.gold,
        playerAge: this.state.progression.player.age,
        playerBaseX: this.state.playerBase.x,
        enemyBaseX: this.state.enemyBase.x,
        battlefieldWidth: this.state.battlefield.width,
      });
      
      return true;
    } catch (error) {
      console.error('[ERROR] Failed to load game:', error);
      return false;
    }
  }
  
  /**
   * Check if a saved game exists
   */
  static hasSavedGame(): boolean {
    const storage = GameEngine.getStorage();
    if (!storage) return false;
    return !!storage.getItem(GameEngine.SAVE_KEY);
  }
  
  /**
   * Delete saved game
   */
  static deleteSavedGame(): void {
    const storage = GameEngine.getStorage();
    if (!storage) return;
    storage.removeItem(GameEngine.SAVE_KEY);
    console.log('[SAVE] Saved game deleted');
  }
}

