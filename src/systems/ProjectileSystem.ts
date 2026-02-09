import { Entity, GameState, Projectile } from '../GameEngine';
import { UNIT_DEFS } from '../config/units';
import { CombatUtils } from './CombatUtils';

export class ProjectileSystem {
  public update(state: GameState, deltaSeconds: number): void {
    const projToRemove: number[] = [];

    for (const p of state.projectiles) {
      if (p.delayMs && p.delayMs > 0) {
        p.delayMs -= deltaSeconds * 1000;
        continue;
      }

      if (p.droneState) {
        this.updateDroneGuidance(state, p, deltaSeconds);
      }

      if (p.curvature && p.curvature !== 0) {
        p.vy += p.curvature * deltaSeconds;
      }

      p.x += p.vx * deltaSeconds;
      p.y += p.vy * deltaSeconds;
      p.lifeMs -= deltaSeconds * 1000;

      let hitResolved = false;

      // Base collisions
      if (p.owner === 'PLAYER' && p.x >= state.battlefield.width - 1) {
        if (p.splitOnImpact) {
          this.spawnSplitProjectiles(state, p, state.battlefield.width - 1, 0);
        }
        const baseHit = CombatUtils.applyDamageToBase(state, 'ENEMY', p.damage);
        state.stats.damageDealt.player += baseHit.actualDamage;
        projToRemove.push(p.id);
        hitResolved = true;
      } else if (p.owner === 'ENEMY' && p.x <= 1) {
        if (p.splitOnImpact) {
          this.spawnSplitProjectiles(state, p, 1, 0);
        }
        const baseHit = CombatUtils.applyDamageToBase(state, 'PLAYER', p.damage);
        state.stats.damageDealt.enemy += baseHit.actualDamage;
        projToRemove.push(p.id);
        hitResolved = true;
      }

      if (hitResolved) {
        continue;
      }

      const targetOwner = p.owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
      const candidates: Entity[] = [];

      for (const ent of state.entities.values()) {
        if (ent.owner !== targetOwner) continue;

        if (p.isFalling) {
          const groundY = p.targetY ?? ent.transform.laneY;
          if (Math.abs(p.y - groundY) > 2.0) continue;
          if (Math.abs(ent.transform.x - p.x) > 1.2) continue;
        } else {
          if (Math.abs(ent.transform.x - p.x) > 0.8) continue;
          if (Math.abs(ent.transform.laneY - p.y) > 1.5) continue;
        }

        candidates.push(ent);
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => Math.abs(a.transform.x - p.x) - Math.abs(b.transform.x - p.x));
        const primary = candidates[0];
        this.applyProjectileDamage(state, p, primary);
        const impactX = primary.transform.x;
        const impactY = primary.transform.laneY;

        if (p.splashRadius && p.splashRadius > 0) {
          const splashDamageMultiplier = p.droneState ? 1.0 : 0.65;
          for (const ent of state.entities.values()) {
            if (ent.owner !== targetOwner || ent.entityId === primary.entityId) continue;
            const dist = Math.abs(ent.transform.x - primary.transform.x);
            if (dist <= p.splashRadius) {
              this.applyProjectileDamage(state, p, ent, splashDamageMultiplier);
            }
          }
        }

        if (p.droneState && p.splashRadius && p.splashRadius > 0) {
          this.spawnDroneImpactVfx(state, p, impactX, impactY);
        }

        if (p.splitOnImpact) {
          this.spawnSplitProjectiles(state, p, primary.transform.x, primary.transform.laneY);
        }

        if (p.isFalling) {
          projToRemove.push(p.id);
          continue;
        }

        if ((p.remainingPierces ?? 0) > 0) {
          p.remainingPierces = (p.remainingPierces ?? 0) - 1;
          const direction = p.owner === 'PLAYER' ? 1 : -1;
          p.x += direction * 1.1;
        } else {
          projToRemove.push(p.id);
        }
      }

      if (p.lifeMs <= 0) {
        projToRemove.push(p.id);
      }
    }

    if (projToRemove.length > 0) {
      const removeSet = new Set(projToRemove);
      state.projectiles = state.projectiles.filter((proj) => !removeSet.has(proj.id));
    }
  }

  private updateDroneGuidance(state: GameState, projectile: Projectile, deltaSeconds: number): void {
    const drone = projectile.droneState;
    if (!drone) return;

    const direction = projectile.owner === 'PLAYER' ? 1 : -1;
    const targetOwner = projectile.owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';

    if (drone.phase === 'cruise') {
      projectile.vx = direction * Math.max(8, drone.cruiseSpeed);
      const yError = drone.cruiseY - projectile.y;
      projectile.vy = Math.max(-10, Math.min(10, yError * 3.5));

      const crossedOverfly = direction === 1 ? projectile.x >= drone.overflyX : projectile.x <= drone.overflyX;
      if (crossedOverfly) {
        const target = this.findHealthiestDroneTarget(state, targetOwner, drone.sourceX, drone.maxRange);
        if (target) {
          drone.phase = 'dive';
          projectile.targetEntityId = target.entityId;
        }
      }
      return;
    }

    let target =
      typeof projectile.targetEntityId === 'number'
        ? state.entities.get(projectile.targetEntityId)
        : undefined;

    if (!target || target.owner !== targetOwner || target.health.current <= 0) {
      if (drone.retargetOnKill) {
        target = this.findHealthiestDroneTarget(state, targetOwner, drone.sourceX, drone.maxRange) ?? undefined;
        projectile.targetEntityId = target?.entityId;
      } else {
        target = undefined;
      }
    }

    const diveSpeed = Math.max(12, drone.diveSpeed);
    if (target) {
      const dx = target.transform.x - projectile.x;
      const dy = target.transform.laneY - projectile.y;
      const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      projectile.vx = (dx / dist) * diveSpeed;
      projectile.vy = (dy / dist) * diveSpeed;
    } else {
      projectile.vx = direction * diveSpeed * 0.4;
      projectile.vy = -Math.max(8, diveSpeed * 0.75);
    }
  }

  private findHealthiestDroneTarget(
    state: GameState,
    targetOwner: 'PLAYER' | 'ENEMY',
    sourceX: number,
    maxRange: number
  ): Entity | null {
    let best: Entity | null = null;
    let bestScore = -Infinity;

    for (const ent of state.entities.values()) {
      if (ent.owner !== targetOwner) continue;
      if (ent.health.current <= 0) continue;
      if (Math.abs(ent.transform.x - sourceX) > maxRange) continue;
      const score = ent.health.current + ent.health.max * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = ent;
      }
    }

    return best;
  }

  private spawnDroneImpactVfx(state: GameState, projectile: Projectile, x: number, laneY: number): void {
    state.vfx.push({
      id: state.nextVfxId++,
      type: 'ability_impact',
      x,
      y: laneY,
      age: projectile.owner === 'PLAYER' ? state.progression.player.age : state.progression.enemy.age,
      lifeMs: 700,
      data: {
        radius: projectile.splashRadius ?? 5,
        damage: projectile.damage,
        turretAbility: 'kamikaze_drone',
      },
    });
  }

  private applyProjectileDamage(
    state: GameState,
    projectile: Projectile,
    target: Entity,
    damageMultiplier = 1
  ): void {
    const protectionMultiplier = CombatUtils.getTowerProtectionMultiplier(target, state);
    let actualDamage = projectile.damage * protectionMultiplier * damageMultiplier;

    const unitDef = UNIT_DEFS[target.unitId];
    if (unitDef?.teleporter) {
      actualDamage *= (1 - unitDef.teleporter.damageReduction);
    }

    if (unitDef?.manaShield) {
      const ownerEcon = target.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
      const shieldableDamage = Math.floor(actualDamage * 0.9);
      const manaNeeded = Math.ceil(shieldableDamage / 2);
      const manaUsed = Math.min(manaNeeded, ownerEcon.mana);
      ownerEcon.mana -= manaUsed;
      actualDamage = Math.max(1, actualDamage - (manaUsed * 2));
    }

    target.health.current -= actualDamage;

    if (projectile.manaLeech) {
      const ownerEcon = projectile.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
      ownerEcon.mana += actualDamage * projectile.manaLeech;
    }

    if (projectile.owner === 'PLAYER') {
      state.stats.damageDealt.player += actualDamage;
    } else {
      state.stats.damageDealt.enemy += actualDamage;
    }
  }

  private spawnSplitProjectiles(
    state: GameState,
    projectile: Projectile,
    impactX: number,
    impactY: number
  ): void {
    const split = projectile.splitOnImpact;
    if (!split) return;

    const forward = projectile.owner === 'PLAYER' ? 1 : -1;
    const baseLaunchAngleRad = (36 * Math.PI) / 180;
    const fanHalfAngleRad = Math.min(0.62, Math.max(0.28, split.spreadRadius * 0.09));

    for (let i = 0; i < split.childCount; i++) {
      const t = split.childCount === 1 ? 0 : i / (split.childCount - 1);
      const centered = t * 2 - 1;
      const angleOffset = centered * fanHalfAngleRad + Math.sin((i + 1) * 2.17) * 0.06;
      const launchAngle = baseLaunchAngleRad + angleOffset;
      const speedScale = Math.max(0.72, 1 - Math.abs(centered) * 0.14 + (i % 2 === 0 ? 0.08 : -0.05));
      const childSpeed = split.childSpeed * speedScale;
      const vx = forward * Math.cos(launchAngle) * childSpeed;
      const vy = Math.sin(launchAngle) * childSpeed;
      const childCurvature = -26 - Math.abs(centered) * 18 + ((i % 3) - 1) * 3;
      const spawnOffsetX = forward * (0.5 + Math.abs(centered) * 0.25);
      const spawnOffsetY = 0.28 + Math.abs(centered) * 0.1;

        state.projectiles.push({
          id: state.nextEntityId++,
          owner: projectile.owner,
          x: impactX + spawnOffsetX,
          y: impactY + spawnOffsetY,
          vx,
          vy,
          curvature: childCurvature,
          damage: split.childDamage,
          lifeMs: split.childLifeMs,
          delayMs: 20,
          radiusPx: Math.max(2, (projectile.radiusPx ?? 4) * 0.8),
          color: projectile.color,
          glowColor: projectile.glowColor,
          trailAlpha: projectile.trailAlpha,
        });
      }
  }
}
