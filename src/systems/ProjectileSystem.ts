import { GameState, Projectile, Entity } from '../GameEngine';
import { UNIT_DEFS } from '../config/units';
import { CombatUtils } from './CombatUtils';

const FIXED_TIMESTEP = 1000 / 60; // Need to verify if I can import this or define it. GameEngine defines it.

export class ProjectileSystem {
  
  public update(state: GameState, deltaSeconds: number): void {
    const callbacks = {
      getTowerProtectionMultiplier: (target: Entity) => CombatUtils.getTowerProtectionMultiplier(target, state),
      damageStats: state.stats.damageDealt
    };
    const projToRemove: number[] = [];
    const toRemoveEntities: number[] = []; // Entities killed by projectiles

    for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i];
        
        // Move
        p.x += p.vx * deltaSeconds;
        p.y += p.vy * deltaSeconds;
        p.lifeMs -= deltaSeconds * 1000;
        
        let hitBase = false;
        
        // Base Collision
        if (p.owner === 'PLAYER' && p.x >= state.battlefield.width - 1) {
            state.enemyBase.health -= p.damage;
            state.enemyBase.lastAttackTime = state.tick * (1000/60) / 1000;
            if (state.enemyBase.health < 0) state.enemyBase.health = 0;
            callbacks.damageStats.player += p.damage; // Use callback to update stats
            projToRemove.push(p.id);
            hitBase = true;
        } else if (p.owner === 'ENEMY' && p.x <= 1) {
            state.playerBase.health -= p.damage;
            state.playerBase.lastAttackTime = state.tick * (1000/60) / 1000;
            if (state.playerBase.health < 0) state.playerBase.health = 0;
            callbacks.damageStats.enemy += p.damage;
            projToRemove.push(p.id);
            hitBase = true;
        }
        
        if (!hitBase) {
            // Entity Collision
            for (const [eid, ent] of state.entities) {
                if (ent.owner === p.owner) continue;
                const dist = Math.abs(ent.transform.x - p.x);
                if (dist < 0.8) {
                    // Collision Logic
                    const protectionMultiplier = callbacks.getTowerProtectionMultiplier(ent);
                    let actualDamage = p.damage * protectionMultiplier;
                    
                    const unitDef = UNIT_DEFS[ent.unitId];
                    if (unitDef?.teleporter) {
                        actualDamage *= (1 - unitDef.teleporter.damageReduction);
                    }
                    
                    // MANA SHIELD
                    if (unitDef?.manaShield) {
                        const ownerEcon = ent.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
                        const shieldableDamage = Math.floor(actualDamage * 0.9);
                        const manaNeeded = Math.ceil(shieldableDamage / 2);
                        const manaUsed = Math.min(manaNeeded, ownerEcon.mana);
                        const damageAbsorbed = manaUsed * 2;
                        ownerEcon.mana -= manaUsed;
                        actualDamage = Math.max(1, actualDamage - damageAbsorbed);
                    }
                    
                    ent.health.current -= actualDamage;

                    // Mana Leech (Fixed: Now reads from projectile property instead of expensive/buggy loop)
                    if (p.manaLeech) {
                        const ownerEcon = p.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
                        const manaRestored = actualDamage * p.manaLeech;
                        ownerEcon.mana += manaRestored;
                    }

                    if (p.owner === 'PLAYER') state.stats.damageDealt.player += actualDamage;

                    if (p.owner === 'PLAYER') callbacks.damageStats.player += actualDamage;
                    else callbacks.damageStats.enemy += actualDamage;

                    projToRemove.push(p.id);
                    // Dead entity handling is done in EntitySystem or main loop cleaning
                    // But we can mark here if we want return.
                    break;
                }
            }
        }
        
        if (p.lifeMs <= 0) projToRemove.push(p.id);
    }
    
    // Remove projectiles
    if (projToRemove.length > 0) {
        state.projectiles = state.projectiles.filter((p) => !projToRemove.includes(p.id));
    }
  }
}
