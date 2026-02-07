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
        state.enemyBase.health = Math.max(0, state.enemyBase.health - p.damage);
        state.enemyBase.lastAttackTime = state.tick * (1000 / 60) / 1000;
        state.stats.damageDealt.player += p.damage;
        projToRemove.push(p.id);
        hitResolved = true;
      } else if (p.owner === 'ENEMY' && p.x <= 1) {
        if (p.splitOnImpact) {
          this.spawnSplitProjectiles(state, p, 1, 0);
        }
        state.playerBase.health = Math.max(0, state.playerBase.health - p.damage);
        state.playerBase.lastAttackTime = state.tick * (1000 / 60) / 1000;
        state.stats.damageDealt.enemy += p.damage;
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

        if (p.splashRadius && p.splashRadius > 0) {
          for (const ent of state.entities.values()) {
            if (ent.owner !== targetOwner || ent.entityId === primary.entityId) continue;
            const dist = Math.abs(ent.transform.x - primary.transform.x);
            if (dist <= p.splashRadius) {
              this.applyProjectileDamage(state, p, ent, 0.65);
            }
          }
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

    for (let i = 0; i < split.childCount; i++) {
      const angle = (Math.PI * 2 * i) / split.childCount;
      const targetX = impactX + Math.cos(angle) * split.spreadRadius;
      const targetY = impactY + Math.sin(angle) * split.spreadRadius;
      const dx = targetX - impactX;
      const dy = targetY - impactY;
      const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      const nx = dx / dist;
      const ny = dy / dist;

        state.projectiles.push({
          id: state.nextEntityId++,
          owner: projectile.owner,
          x: impactX + nx * 0.9,
          y: impactY + ny * 0.9,
          vx: (dx / dist) * split.childSpeed,
          vy: (dy / dist) * split.childSpeed,
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
