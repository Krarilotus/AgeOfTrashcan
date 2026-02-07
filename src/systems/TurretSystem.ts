import { Entity, GameState } from '../GameEngine';
import { UNIT_DEFS } from '../config/units';
import {
  getSlotMountYOffsetUnits,
  getTurretEngineDef,
  type TurretEngineDef,
} from '../config/turrets';
import { TURRET_VISUALS, pixelsToUnits } from '../config/renderConfig';

export class TurretSystem {
  public update(state: GameState, deltaSeconds: number): void {
    const updateTurretsForOwner = (owner: 'PLAYER' | 'ENEMY') => {
      const base = owner === 'PLAYER' ? state.playerBase : state.enemyBase;
      const enemyOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
      const age = owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age;

      for (let slotIndex = 0; slotIndex < base.turretSlotsUnlocked; slotIndex++) {
        const slot = base.turretSlots[slotIndex];
        if (!slot) continue;
        slot.cooldownRemaining = Math.max(0, slot.cooldownRemaining - deltaSeconds);
        if (!slot.turretId) continue;

        const engine = getTurretEngineDef(slot.turretId);
        if (!engine) continue;
        if (slot.cooldownRemaining > 0) continue;

        const target = this.selectTarget(state, base.x, enemyOwner, engine);
        if (!target) continue;

        const mount = TurretSystem.getTurretPosition(base.x, age, slotIndex);

        if (engine.attackType === 'projectile' && engine.projectile) {
          this.fireProjectile(state, owner, mount, target, engine);
          slot.cooldownRemaining = engine.fireIntervalSec;
          continue;
        }

        if (engine.attackType === 'chain_lightning' && engine.chainLightning) {
          this.castChainLightning(state, owner, base.x, mount, engine);
          slot.cooldownRemaining = engine.chainLightning.cooldownSeconds;
          continue;
        }

        if (engine.attackType === 'artillery_barrage' && engine.artillery) {
          this.castArtilleryBarrage(state, owner, base.x, mount, engine);
          slot.cooldownRemaining = engine.artillery.cooldownSeconds;
          continue;
        }

        if (engine.attackType === 'oil_pour' && engine.oil) {
          this.castOilPour(state, owner, base.x, engine);
          slot.cooldownRemaining = engine.oil.cooldownSeconds;
          continue;
        }

        if (engine.attackType === 'drone_swarm' && engine.drones) {
          this.launchDroneSwarm(state, owner, mount, target, engine);
          slot.cooldownRemaining = engine.drones.cooldownSeconds;
        }
      }
    };

    updateTurretsForOwner('PLAYER');
    updateTurretsForOwner('ENEMY');
  }

  private selectTarget(
    state: GameState,
    baseX: number,
    targetOwner: 'PLAYER' | 'ENEMY',
    engine: TurretEngineDef
  ): Entity | null {
    let best: Entity | null = null;
    let bestScore = -Infinity;

    for (const entity of state.entities.values()) {
      if (entity.owner !== targetOwner) continue;
      const dist = Math.abs(entity.transform.x - baseX);
      if (dist > engine.range) continue;

      const healthPct = entity.health.max > 0 ? entity.health.current / entity.health.max : 0;
      const dps = entity.attack.damage * Math.max(entity.attack.speed, 0.2);
      const unitDef = UNIT_DEFS[entity.unitId];
      const skill = unitDef?.skill;
      const skillDps = skill
        ? ((skill.damage ?? skill.power ?? 0) * Math.max(skill.radius ?? skill.power ?? 1, 1)) / Math.max(skill.cooldownMs / 1000, 0.1)
        : 0;

      let score = 0;
      if (engine.targeting === 'nearest') score = -dist;
      else if (engine.targeting === 'healthiest') score = entity.health.current + healthPct * 1000;
      else if (engine.targeting === 'lowest_health') score = -entity.health.current;
      else if (engine.targeting === 'highest_dps') score = dps * 10 - dist;
      else if (engine.targeting === 'strongest_ability_dps') score = skillDps * 10 + dps * 3 - dist;

      if (score > bestScore) {
        bestScore = score;
        best = entity;
      }
    }

    return best;
  }

  private fireProjectile(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    mount: { x: number; y: number },
    target: Entity,
    engine: TurretEngineDef
  ): void {
    const projectile = engine.projectile;
    if (!projectile) return;

    const dx = target.transform.x - mount.x;
    const dy = target.transform.laneY - mount.y;
    const distanceToTarget = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
    const speed = Math.max(1, projectile.speed);

    state.projectiles.push({
      id: state.nextEntityId++,
      owner,
      x: mount.x,
      y: mount.y,
      vx: (dx / distanceToTarget) * speed,
      vy: (dy / distanceToTarget) * speed,
      curvature: projectile.curvature ?? 0,
      damage: projectile.damage,
      lifeMs: projectile.lifeMs ?? (distanceToTarget / speed) * 1200,
      remainingPierces: projectile.pierceCount ?? 0,
      splitOnImpact: projectile.splitOnImpact,
      splashRadius: projectile.splashRadius,
      radiusPx: projectile.radiusPx,
      color: projectile.color,
      glowColor: projectile.glowColor,
      trailAlpha: projectile.trailAlpha,
    });

    if ((projectile.pierceCount ?? 0) > 0) {
      state.vfx.push({
        id: state.nextVfxId++,
        type: 'ability_cast',
        x: mount.x,
        y: -mount.y,
        age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
        lifeMs: 220,
        data: {
          turretAbility: 'piercing_shot',
          durationMs: 220,
          targetPositions: [{ x: target.transform.x, y: target.transform.laneY }],
        },
      });
    }
  }

  private castChainLightning(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    baseX: number,
    mount: { x: number; y: number },
    engine: TurretEngineDef
  ): void {
    const config = engine.chainLightning;
    if (!config) return;

    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const targets = Array.from(state.entities.values())
      .filter((entity) => entity.owner === targetOwner && Math.abs(entity.transform.x - baseX) <= engine.range)
      .sort((a, b) => Math.abs(a.transform.x - baseX) - Math.abs(b.transform.x - baseX))
      .slice(0, config.maxTargets);

    if (targets.length === 0) return;

    const positions: Array<{ x: number; y: number }> = [];
    let damage = config.initialDamage;

    for (const target of targets) {
      target.health.current -= damage;
      positions.push({ x: target.transform.x, y: target.transform.laneY });
      damage *= config.falloffMultiplier;
    }

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_cast',
      x: mount.x,
      y: -mount.y,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: 550,
      data: { turretAbility: 'chain_lightning', targetPositions: positions },
    });
  }

  private castArtilleryBarrage(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    baseX: number,
    mount: { x: number; y: number },
    engine: TurretEngineDef
  ): void {
    const config = engine.artillery;
    if (!config) return;

    const direction = owner === 'PLAYER' ? 1 : -1;

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_cast',
      x: mount.x,
      y: -mount.y,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: 520,
      data: { turretAbility: 'artillery_barrage' },
    });

    for (let i = 0; i < config.barrageCount; i++) {
      const randomForward = Math.random() * config.spreadRange;
      const targetX = baseX + direction * randomForward;
      const targetY = (Math.random() - 0.5) * config.spreadLaneY;
      const distanceY = Math.abs(config.startY - targetY);
      const shellLife = (distanceY / Math.max(Math.abs(config.fallSpeed), 1)) * 1000 + 350;

      state.projectiles.push({
        id: state.nextEntityId++,
        owner,
        x: targetX,
        y: config.startY,
        vx: 0,
        vy: config.fallSpeed,
        damage: config.shellDamage,
        lifeMs: shellLife,
        isFalling: true,
        targetY,
        splashRadius: config.shellRadius,
        delayMs: Math.random() * 800,
        radiusPx: 3,
        color: '#fb7185',
        glowColor: 'rgba(251,113,133,0.9)',
        trailAlpha: 0.35,
      });
    }
  }

  private castOilPour(state: GameState, owner: 'PLAYER' | 'ENEMY', baseX: number, engine: TurretEngineDef): void {
    const config = engine.oil;
    if (!config) return;

    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const direction = owner === 'PLAYER' ? 1 : -1;
    const centerX = baseX + direction * 2.5;

    for (const entity of state.entities.values()) {
      if (entity.owner !== targetOwner) continue;
      const dist = Math.abs(entity.transform.x - centerX);
      if (dist > config.radius) continue;
      entity.health.current -= config.damage;
    }

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_cast',
      x: centerX,
      y: 0,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: 900,
      data: { turretAbility: 'oil_pour', radius: config.radius },
    });
  }

  private launchDroneSwarm(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    mount: { x: number; y: number },
    target: Entity,
    engine: TurretEngineDef
  ): void {
    const config = engine.drones;
    if (!config) return;

    for (let i = 0; i < config.droneCount; i++) {
      const jitterY = (Math.random() - 0.5) * 1.4;
      const dx = target.transform.x - mount.x;
      const dy = target.transform.laneY + jitterY - mount.y;
      const distance = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      const speed = Math.max(8, config.droneSpeed);

      state.projectiles.push({
        id: state.nextEntityId++,
        owner,
        x: mount.x,
        y: mount.y,
        vx: (dx / distance) * speed,
        vy: (dy / distance) * speed,
        damage: config.droneDamage,
        lifeMs: 1800,
        radiusPx: 5,
        color: '#93c5fd',
        glowColor: 'rgba(147,197,253,0.85)',
        trailAlpha: 0.25,
      });
    }
  }

  public static getTurretPosition(baseX: number, age: number, slotIndex: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const platformY = pixelsToUnits(dims.height) + TURRET_VISUALS.PLATFORM_OFFSET_UNITS;
    const slotYOffset = getSlotMountYOffsetUnits(slotIndex);
    return { x: baseX, y: platformY + slotYOffset };
  }
}
