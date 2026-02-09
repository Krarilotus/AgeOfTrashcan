import { Entity, GameState } from '../GameEngine';
import { UNIT_DEFS } from '../config/units';
import {
  getSlotMountYOffsetUnits,
  getTurretEngineDef,
  type TurretEngineDef,
} from '../config/turrets';
import { TURRET_VISUALS, pixelsToUnits } from '../config/renderConfig';
import { CombatUtils } from './CombatUtils';

interface OilGroundPatch {
  owner: 'PLAYER' | 'ENEMY';
  targetOwner: 'PLAYER' | 'ENEMY';
  direction: 1 | -1;
  baseX: number;
  centerX: number;
  radius: number;
  forwardReachUnits: number;
  backReachUnits: number;
  laneHalfHeight: number;
  remainingSeconds: number;
  tickIntervalSeconds: number;
  tickCountdownSeconds: number;
  tickDamage: number;
}

export class TurretSystem {
  private oilPatches: OilGroundPatch[] = [];
  private siphonTargetsBySlot: Map<string, number> = new Map();

  private getForwardDirection(owner: 'PLAYER' | 'ENEMY'): 1 | -1 {
    return owner === 'PLAYER' ? 1 : -1;
  }

  private getProjectileMuzzleOrigin(
    owner: 'PLAYER' | 'ENEMY',
    mount: { x: number; y: number },
    target: Entity,
    engine: TurretEngineDef
  ): { x: number; y: number } {
    const direction = this.getForwardDirection(owner);
    const projectile = engine.projectile;
    const dxRaw = target.transform.x - mount.x;
    const dyRaw = target.transform.laneY - mount.y;
    const distance = Math.max(0.001, Math.sqrt(dxRaw * dxRaw + dyRaw * dyRaw));
    const ux = dxRaw / distance;
    const uy = dyRaw / distance;
    const speed = projectile?.speed ?? 32;
    const radiusPx = projectile?.radiusPx ?? 4;
    const forwardOffset = Math.max(0.55, Math.min(1.45, 0.6 + speed * 0.005 + radiusPx * 0.03));
    const verticalLift = Math.abs(projectile?.curvature ?? 0) > 0.001 ? 0.16 : 0.08;
    return {
      x: mount.x + ux * forwardOffset + direction * 0.1,
      y: mount.y + uy * (forwardOffset * 0.25) + verticalLift,
    };
  }

  public update(state: GameState, deltaSeconds: number): void {
    this.updateOilPatches(state, deltaSeconds);

    const updateTurretsForOwner = (owner: 'PLAYER' | 'ENEMY') => {
      const base = owner === 'PLAYER' ? state.playerBase : state.enemyBase;
      const enemyOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
      const econ = owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
      const age = owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age;

      for (let slotIndex = 0; slotIndex < base.turretSlotsUnlocked; slotIndex++) {
        const slotKey = `${owner}:${slotIndex}`;
        const slot = base.turretSlots[slotIndex];
        if (!slot) {
          this.siphonTargetsBySlot.delete(slotKey);
          continue;
        }
        slot.cooldownRemaining = Math.max(0, slot.cooldownRemaining - deltaSeconds);
        if (!slot.turretId) {
          this.siphonTargetsBySlot.delete(slotKey);
          continue;
        }

        const engine = getTurretEngineDef(slot.turretId);
        if (!engine) {
          this.siphonTargetsBySlot.delete(slotKey);
          continue;
        }
        if (engine.attackType !== 'mana_siphon') {
          this.siphonTargetsBySlot.delete(slotKey);
        }
        if (engine.attackType === 'mana_shield') {
          slot.cooldownRemaining = 0;
          continue;
        }
        if (slot.cooldownRemaining > 0) continue;
        const castManaCost = Math.max(0, engine.castManaCost ?? 0);
        if (castManaCost > 0 && econ.mana < castManaCost) continue;
        const consumeCastMana = () => {
          if (castManaCost <= 0) return;
          econ.mana = Math.max(0, econ.mana - castManaCost);
        };

        const mount = TurretSystem.getTurretPosition(base.x, age, slotIndex);

        if (engine.attackType === 'projectile' && engine.projectile) {
          const target = this.selectTarget(state, base.x, enemyOwner, engine);
          if (!target) continue;
          this.fireProjectile(state, owner, mount, target, engine);
          slot.cooldownRemaining = engine.fireIntervalSec;
          consumeCastMana();
          continue;
        }

        if (engine.attackType === 'chain_lightning' && engine.chainLightning) {
          this.castChainLightning(state, owner, base.x, mount, engine);
          slot.cooldownRemaining = engine.chainLightning.cooldownSeconds;
          consumeCastMana();
          continue;
        }

        if (engine.attackType === 'artillery_barrage' && engine.artillery) {
          this.castArtilleryBarrage(state, owner, base.x, mount, engine);
          slot.cooldownRemaining = engine.artillery.cooldownSeconds;
          consumeCastMana();
          continue;
        }

        if (engine.attackType === 'oil_pour' && engine.oil) {
          const casted = this.castOilPour(state, owner, base.x, engine);
          if (casted) {
            slot.cooldownRemaining = engine.oil.cooldownSeconds;
            consumeCastMana();
          }
          continue;
        }

        if (engine.attackType === 'drone_swarm' && engine.drones) {
          const target = this.selectTarget(state, base.x, enemyOwner, engine);
          if (!target) continue;
          this.launchDroneSwarm(state, owner, mount, target, engine);
          slot.cooldownRemaining = engine.drones.cooldownSeconds;
          consumeCastMana();
          continue;
        }

        if (engine.attackType === 'flamethrower' && engine.flamethrower) {
          const casted = this.castFlamethrowerBurst(state, owner, mount, engine);
          if (casted) {
            slot.cooldownRemaining = engine.flamethrower.cooldownSeconds;
            consumeCastMana();
          }
          continue;
        }

        if (engine.attackType === 'laser_pulse' && engine.laserPulse) {
          const casted = this.castLaserPulse(state, owner, mount, engine);
          if (casted) {
            slot.cooldownRemaining = engine.laserPulse.cooldownSeconds;
            consumeCastMana();
          }
          continue;
        }

        if (engine.attackType === 'mana_siphon' && engine.manaSiphon) {
          const casted = this.castManaSiphon(state, owner, slotIndex, base.x, mount, engine);
          if (casted) {
            slot.cooldownRemaining = Math.max(
              0.05,
              Math.min(engine.fireIntervalSec, 1 / Math.max(1, engine.manaSiphon.ticksPerSecond))
            );
            consumeCastMana();
          }
        }
      }
    };

    updateTurretsForOwner('PLAYER');
    updateTurretsForOwner('ENEMY');
  }

  private updateOilPatches(state: GameState, deltaSeconds: number): void {
    if (this.oilPatches.length === 0) return;

    const nextPatches: OilGroundPatch[] = [];
    for (const patch of this.oilPatches) {
      patch.remainingSeconds -= deltaSeconds;
      patch.tickCountdownSeconds -= deltaSeconds;

      while (patch.tickCountdownSeconds <= 0 && patch.remainingSeconds > 0) {
        patch.tickCountdownSeconds += patch.tickIntervalSeconds;
        let tickTotalDamage = 0;

        for (const entity of state.entities.values()) {
          if (!this.isEntityInsideOilZone(
            entity,
            patch.targetOwner,
            patch.baseX,
            patch.centerX,
            patch.direction,
            patch.radius,
            patch.laneHalfHeight,
            patch.forwardReachUnits,
            patch.backReachUnits
          )) continue;
          entity.health.current -= patch.tickDamage;
          tickTotalDamage += patch.tickDamage;
        }

        if (tickTotalDamage > 0) {
          if (patch.owner === 'PLAYER') {
            state.stats.damageDealt.player += tickTotalDamage;
          } else {
            state.stats.damageDealt.enemy += tickTotalDamage;
          }
        }
      }

      if (patch.remainingSeconds > 0) {
        nextPatches.push(patch);
      }
    }

    this.oilPatches = nextPatches;
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

    const muzzle = this.getProjectileMuzzleOrigin(owner, mount, target, engine);
    const dx = target.transform.x - muzzle.x;
    const dy = target.transform.laneY - muzzle.y;
    const distanceToTarget = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
    const speed = Math.max(1, projectile.speed);
    const curvature = projectile.curvature ?? 0;

    let vx = (dx / distanceToTarget) * speed;
    let vy = (dy / distanceToTarget) * speed;

    // Ballistic launch for curved projectiles so velocity/trajectory is visibly distinct.
    if (Math.abs(curvature) > 0.001) {
      const flightTime = Math.max(0.2, Math.abs(dx) / Math.max(speed * 0.9, 0.1));
      vx = dx / flightTime;
      vy = (dy - 0.5 * curvature * flightTime * flightTime) / flightTime;
    }

    state.projectiles.push({
      id: state.nextEntityId++,
      owner,
      x: muzzle.x,
      y: muzzle.y,
      vx,
      vy,
      curvature,
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
        x: muzzle.x,
        y: -muzzle.y,
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

  private castOilPour(state: GameState, owner: 'PLAYER' | 'ENEMY', baseX: number, engine: TurretEngineDef): boolean {
    const config = engine.oil;
    if (!config) return false;

    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const direction: 1 | -1 = owner === 'PLAYER' ? 1 : -1;
    const centerX = baseX + direction * (config.pourOffsetUnits ?? 5.5);
    const forwardReachUnits = Math.max(0.4, config.forwardReachUnits ?? config.radius);
    const backReachUnits = Math.max(0.2, config.backReachUnits ?? Math.max(0.6, config.radius * 0.6));
    const laneHalfHeight = Math.max(1.3, config.radius * 0.75);
    const hasTargetsInPourZone = Array.from(state.entities.values()).some(
      (entity) => this.isEntityInsideOilZone(
        entity,
        targetOwner,
        baseX,
        centerX,
        direction,
        config.radius,
        laneHalfHeight,
        forwardReachUnits,
        backReachUnits
      )
    );
    if (!hasTargetsInPourZone) return false;

    const initialImpactDamage = Math.max(0, config.initialDamage ?? (config.damage * 0.55));
    const duration = Math.max(0.2, config.groundDurationSeconds ?? 2);
    const ticksPerSecond = Math.max(1, config.ticksPerSecond ?? 3);
    const tickInterval = 1 / ticksPerSecond;
    const tickDamage = Math.max(0, config.dotDamagePerTick ?? (config.damage * Math.max(0.05, config.dotTickMultiplier ?? 0.25)));

    let initialTotalDamage = 0;
    for (const entity of state.entities.values()) {
      if (!this.isEntityInsideOilZone(
        entity,
        targetOwner,
        baseX,
        centerX,
        direction,
        config.radius,
        laneHalfHeight,
        forwardReachUnits,
        backReachUnits
      )) continue;
      entity.health.current -= initialImpactDamage;
      initialTotalDamage += initialImpactDamage;
    }

    if (initialTotalDamage > 0) {
      if (owner === 'PLAYER') {
        state.stats.damageDealt.player += initialTotalDamage;
      } else {
        state.stats.damageDealt.enemy += initialTotalDamage;
      }
    }

    this.oilPatches.push({
      owner,
      targetOwner,
      direction,
      baseX,
      centerX,
      radius: config.radius,
      forwardReachUnits,
      backReachUnits,
      laneHalfHeight,
      remainingSeconds: duration,
      tickIntervalSeconds: tickInterval,
      tickCountdownSeconds: tickInterval,
      tickDamage,
    });

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_cast',
      x: centerX,
      y: 0,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: duration * 1000,
      data: {
        turretAbility: 'oil_pour',
        radius: config.radius,
        durationMs: duration * 1000,
        direction,
        forwardReachUnits,
        backReachUnits,
      },
    });
    return true;
  }

  private isEntityInsideOilZone(
    entity: Entity,
    targetOwner: 'PLAYER' | 'ENEMY',
    baseX: number,
    centerX: number,
    direction: 1 | -1,
    radius: number,
    laneHalfHeight: number,
    forwardReachUnits: number,
    backReachUnits: number
  ): boolean {
    if (entity.owner !== targetOwner) return false;
    if (entity.health.current <= 0) return false;
    if (Math.abs(entity.transform.laneY) > laneHalfHeight) return false;

    // Require enemies to be in front of the base and near the pour zone, not behind it.
    const frontFromBase = (entity.transform.x - baseX) * direction;
    if (frontFromBase < 0) return false;

    const alongPourAxis = (entity.transform.x - centerX) * direction;
    if (alongPourAxis > forwardReachUnits) return false;
    if (alongPourAxis < -backReachUnits) return false;

    return true;
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
    // One drone per cycle; cadence is controlled by cooldownSeconds (requested 4.8s).
    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const direction = owner === 'PLAYER' ? 1 : -1;
    const inRangeTargets = Array.from(state.entities.values()).filter(
      (entity) => entity.owner === targetOwner && entity.health.current > 0 && Math.abs(entity.transform.x - mount.x) <= engine.range
    );
    const farthestX = inRangeTargets.length > 0
      ? direction === 1
        ? Math.max(...inRangeTargets.map((entity) => entity.transform.x))
        : Math.min(...inRangeTargets.map((entity) => entity.transform.x))
      : target.transform.x;
    const overflyPadding = Math.max(1.2, config.overflyPadding ?? 2.4);
    const overflyX = farthestX + direction * overflyPadding;
    const cruiseY = Math.max(6, config.cruiseHeight ?? 8.5);
    const cruiseSpeed = Math.max(10, config.droneSpeed);
    const diveSpeed = Math.max(16, cruiseSpeed * (config.diveSpeedMultiplier ?? 1.9));
    const launchVy = Math.max(-4, Math.min(14, (cruiseY - mount.y) * 4));

    state.projectiles.push({
      id: state.nextEntityId++,
      owner,
      x: mount.x,
      y: mount.y,
      vx: direction * cruiseSpeed,
      vy: launchVy,
      damage: config.droneDamage,
      lifeMs: 6500,
      splashRadius: Math.max(1.5, config.explosionRadius ?? 5),
      radiusPx: 7,
      color: '#93c5fd',
      glowColor: 'rgba(147,197,253,0.9)',
      trailAlpha: 0.22,
      targetEntityId: target.entityId,
      droneState: {
        phase: 'cruise',
        sourceX: mount.x,
        maxRange: Math.max(2, engine.range),
        cruiseY,
        overflyX,
        cruiseSpeed,
        diveSpeed,
        retargetOnKill: config.retargetOnKill ?? true,
      },
    });
  }

  private getManaSiphonTarget(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    slotIndex: number,
    baseX: number,
    targetOwner: 'PLAYER' | 'ENEMY',
    engine: TurretEngineDef
  ): Entity | null {
    const slotKey = `${owner}:${slotIndex}`;
    const lockedId = this.siphonTargetsBySlot.get(slotKey);
    if (typeof lockedId === 'number') {
      const locked = state.entities.get(lockedId);
      if (
        locked &&
        locked.owner === targetOwner &&
        locked.health.current > 0 &&
        Math.abs(locked.transform.x - baseX) <= engine.range
      ) {
        return locked;
      }
      this.siphonTargetsBySlot.delete(slotKey);
    }

    let best: Entity | null = null;
    let bestScore = -Infinity;
    for (const entity of state.entities.values()) {
      if (entity.owner !== targetOwner || entity.health.current <= 0) continue;
      const dist = Math.abs(entity.transform.x - baseX);
      if (dist > engine.range) continue;
      const score = entity.health.current + entity.health.max * 0.2 + entity.attack.damage * Math.max(0.2, entity.attack.speed) * 8;
      if (score > bestScore) {
        bestScore = score;
        best = entity;
      }
    }

    if (best) {
      this.siphonTargetsBySlot.set(slotKey, best.entityId);
    }

    return best;
  }

  private castManaSiphon(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    slotIndex: number,
    baseX: number,
    mount: { x: number; y: number },
    engine: TurretEngineDef
  ): boolean {
    const config = engine.manaSiphon;
    if (!config) return false;

    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const target = this.getManaSiphonTarget(state, owner, slotIndex, baseX, targetOwner, engine);
    if (!target) return false;

    const protectionMultiplier = CombatUtils.getTowerProtectionMultiplier(target, state);
    const tickDamage = Math.max(0, config.tickDamage);
    const actualDamage = tickDamage * protectionMultiplier;
    if (actualDamage <= 0) return false;

    target.health.current -= actualDamage;
    const ownerEcon = owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
    ownerEcon.mana += actualDamage * Math.max(0, config.manaLeechFraction);

    if (owner === 'PLAYER') state.stats.damageDealt.player += actualDamage;
    else state.stats.damageDealt.enemy += actualDamage;

    if (target.health.current <= 0) {
      this.siphonTargetsBySlot.delete(`${owner}:${slotIndex}`);
    }

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_cast',
      x: mount.x,
      y: -mount.y,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: 220,
      data: {
        turretAbility: 'mana_siphon',
        startX: mount.x,
        startY: -mount.y,
        endX: target.transform.x,
        endY: target.transform.laneY,
        durationMs: 220,
        laneThickness: config.laneThickness ?? 2.2,
        waveAmplitude: config.waveAmplitude ?? 7,
      },
    });

    return true;
  }

  private castFlamethrowerBurst(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    mount: { x: number; y: number },
    engine: TurretEngineDef
  ): boolean {
    const config = engine.flamethrower;
    if (!config) return false;

    const direction: 1 | -1 = owner === 'PLAYER' ? 1 : -1;
    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const range = engine.range;
    const width = Math.max(1, config.width ?? 2.6);
    const primaryTarget = this.selectTarget(state, mount.x, targetOwner, engine);
    if (!primaryTarget) return false;
    const primaryForward = (primaryTarget.transform.x - mount.x) * direction;
    if (primaryForward < -0.4 || primaryForward > range) return false;
    const aimLaneY = primaryTarget.transform.laneY;

    let totalDamage = 0;
    let hitCount = 0;
    let hasEnemyInCone = false;

    for (const entity of state.entities.values()) {
      if (entity.owner !== targetOwner || entity.health.current <= 0) continue;
      const dx = (entity.transform.x - mount.x) * direction;
      if (dx < -0.4 || dx > range) continue;
      if (Math.abs(entity.transform.laneY - aimLaneY) > width) continue;
      hasEnemyInCone = true;
      const protectionMultiplier = CombatUtils.getTowerProtectionMultiplier(entity, state);
      const damage = config.damage * protectionMultiplier;
      entity.health.current -= damage;
      totalDamage += damage;
      hitCount++;
    }

    // Do not cast or consume mana when no enemy units are in actual flamethrower coverage.
    if (!hasEnemyInCone) return false;

    const enemyBase = owner === 'PLAYER' ? state.enemyBase : state.playerBase;
    const baseForward = (enemyBase.x - mount.x) * direction;
    if (baseForward >= 0 && baseForward <= range) {
      const baseDamage = config.damage * 0.65;
      const baseHit = CombatUtils.applyDamageToBase(state, targetOwner, baseDamage);
      if (baseHit.actualDamage > 0) {
        totalDamage += baseHit.actualDamage;
        hitCount++;
      }
    }

    if (totalDamage > 0) {
      if (owner === 'PLAYER') state.stats.damageDealt.player += totalDamage;
      else state.stats.damageDealt.enemy += totalDamage;
    }

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'flamethrower',
      x: mount.x + direction * 0.75,
      y: -mount.y,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: Math.max(360, config.cooldownSeconds * 550),
      data: {
        range,
        direction,
        unitId: 'turret_flamethrower',
        sourceType: 'turret',
        targetLaneY: aimLaneY,
      },
    });

    return hitCount > 0;
  }

  private castLaserPulse(
    state: GameState,
    owner: 'PLAYER' | 'ENEMY',
    mount: { x: number; y: number },
    engine: TurretEngineDef
  ): boolean {
    const config = engine.laserPulse;
    if (!config) return false;

    const direction: 1 | -1 = owner === 'PLAYER' ? 1 : -1;
    const targetOwner = owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const range = engine.range;
    const laneThickness = Math.max(1.2, config.laneThickness ?? 2.4);
    const beamWidth = Math.max(0.8, config.beamWidth ?? 1.8);
    const pulseDurationMs = Math.max(260, config.pulseDurationMs ?? 500);
    let totalDamage = 0;
    let hitCount = 0;
    let farthestHitX = mount.x + direction * range;

    for (const entity of state.entities.values()) {
      if (entity.owner !== targetOwner || entity.health.current <= 0) continue;
      const dx = (entity.transform.x - mount.x) * direction;
      if (dx < 0 || dx > range) continue;
      if (Math.abs(entity.transform.laneY) > laneThickness) continue;
      const protectionMultiplier = CombatUtils.getTowerProtectionMultiplier(entity, state);
      const damage = config.damage * protectionMultiplier;
      entity.health.current -= damage;
      totalDamage += damage;
      hitCount++;
      farthestHitX = direction === 1 ? Math.max(farthestHitX, entity.transform.x) : Math.min(farthestHitX, entity.transform.x);
    }

    const enemyBase = owner === 'PLAYER' ? state.enemyBase : state.playerBase;
    const baseForward = (enemyBase.x - mount.x) * direction;
    if (baseForward >= 0 && baseForward <= range) {
      const baseDamage = config.damage * 0.55;
      const baseHit = CombatUtils.applyDamageToBase(state, targetOwner, baseDamage);
      if (baseHit.actualDamage > 0) {
        totalDamage += baseHit.actualDamage;
        hitCount++;
      }
      farthestHitX = enemyBase.x;
    }

    if (totalDamage > 0) {
      if (owner === 'PLAYER') state.stats.damageDealt.player += totalDamage;
      else state.stats.damageDealt.enemy += totalDamage;
    }

    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_cast',
      x: mount.x + direction * 0.75,
      y: -mount.y,
      age: owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: pulseDurationMs,
      data: {
        turretAbility: 'laser_pulse',
        startX: mount.x + direction * 0.75,
        startY: -mount.y,
        endX: farthestHitX,
        endY: 0,
        beamWidth,
        durationMs: pulseDurationMs,
      },
    });

    return hitCount > 0;
  }

  public static getTurretPosition(baseX: number, age: number, slotIndex: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const platformY = pixelsToUnits(dims.height) + TURRET_VISUALS.PLATFORM_OFFSET_UNITS;
    const slotYOffset = getSlotMountYOffsetUnits(slotIndex);
    return { x: baseX, y: platformY + slotYOffset };
  }
}
