import { Entity, GameState } from '../GameEngine';
import { UNIT_DEFS, type UnitDef } from '../config/units';
import { getGoldToManaConversionRate } from '../config/gameBalance';
import { SkillSystem } from './SkillSystem';
import { CombatUtils } from './CombatUtils';

const FIXED_TIMESTEP = 1000 / 60;

export class EntitySystem {
  
  public update(state: GameState, deltaSeconds: number, projectileSystem: any): void {
    const toRemove: number[] = [];
    const damageStats = state.stats.damageDealt;

    // Use a secondary list to avoid iterator invalidation issues if concurrent mods happen (JS is single threaded but logic might vary)
    // Actually direct map iteration is safe for values update, deletion is safe too usually.

    for (const [id, entity] of state.entities) {
      const unitDef = UNIT_DEFS[entity.unitId];
      
      // Handle teleporter units (void_reaper) - special behavior
      if (unitDef?.teleporter && entity.teleporterState) {
        EntitySystem.updateTeleporter(entity, unitDef, state, deltaSeconds);
        continue; // Skip normal movement/attack
      }
      
      // Step 1: collision and movement blocks
      let blocked = false;
      let target: Entity | null = null;
      
      // LOGICAL WIDTH / COLLISION SIZE
      // Use configured width multiplier, applied to the calculated base width
      // This defines how much space a unit occupies in the line
      const scale = unitDef.visualScale ?? 1.0;
      
      const isRanged = (entity.attack.range ?? 1) > 1.5;
      const baseLegacyWidth = isRanged ? 1.2 : 2.4;
      // 'width' in config is now treated as a multiplier (default 1.0)
      const widthMult = unitDef.width ?? 1.0;

      const minSpacing = baseLegacyWidth * scale * widthMult;

      for (const [otherId, other] of state.entities) {
        if (id === otherId) continue;
        
        // GHOST LOGIC: If either unit has width roughly 0, they do not collide
        const otherDef = UNIT_DEFS[other.unitId];
        if ((unitDef?.width ?? 1) < 0.1 || (otherDef?.width ?? 1) < 0.1) continue;

        const dx = other.transform.x - entity.transform.x;
        const distance = Math.abs(dx);
        // Facing check: only blocked by things in front
        // STRICT directionality check. If units are perfectly overlapped, they do NOT block each other.
        const isInFront = (entity.kinematics.vx > 0 ? dx > 0 : dx < 0);

        // Collision with allies
        if (entity.owner === other.owner) {
          // Prevention of stacking: Ranged units keep distance, melee can close in.
          // Restore minSpacing (1.2 for Ranged, 2.4 for Melee) to prevent visual clipping
          // Keep deadlock protection (dist > 0.2) for overlapping spawns
          if (isInFront && distance < minSpacing && distance > 0.2) {
            blocked = true;
          }
        } else {
          // Opponent: select as target if within attack range
          if (!target && distance <= (entity.attack.range ?? 1) + 2.5) { 
             // Logic used +0.5 before, allowing slight tolerance. 
             // Original: distance <= (entity.attack.range ?? 1) + 0.5
             // "2.5" seems permissive? Let's stick to original logic: +0.5
             if (distance <= (entity.attack.range ?? 1) + 0.5) {
                 target = other;
             }
          }

          // Block movement for physical collisions
          const enemyBlockDist = (entity.attack.range ?? 1) > 1.5 ? 0.3 : 1.0;
          if (isInFront && distance < enemyBlockDist) {
            blocked = true;
          }
        }
      }

      // Collision with base - only for ATTACKING enemy base
      // Friendly base should NOT block movement (units walk out from it)
      
      if (entity.owner === 'PLAYER') {
        const distanceToEnemyBase = state.battlefield.width - entity.transform.x;
        const baseBlockDist = isRanged ? 1.5 : 3.5;
        // Block only if hitting ENEMY base
        if (distanceToEnemyBase <= baseBlockDist) blocked = true;
      } else if (entity.owner === 'ENEMY') {
        const distanceToPlayerBase = entity.transform.x;
        const baseBlockDist = isRanged ? 1.5 : 3.5;
        // Block only if hitting PLAYER base
        if (distanceToPlayerBase <= baseBlockDist) blocked = true;
      }

      // Step 2: Move if not blocked
      if (!blocked) {
        entity.transform.x += entity.kinematics.vx * deltaSeconds;
      }

      // Step 3: Attack Logic
      if (target) {
        EntitySystem.performUnitAttack(entity, target, unitDef, state, deltaSeconds);
      }

      // Step 4: Skill Execution
      SkillSystem.executeSkill(
        entity, 
        state, 
        deltaSeconds,
        {
          getTowerProtectionMultiplier: (t) => CombatUtils.getTowerProtectionMultiplier(t, state),
          addVfx: (vfx) => {
            // How to get nextVfxId? We can increment a static counter or use random
            // Ideally state logic should provide ID gen. 
            // For now, use Date.now() + random or just assume a large number
             vfx.id = Date.now() + Math.random() * 1000;
             state.vfx.push(vfx);
          }
        }
      );

      // Step 5: Base Attack
      EntitySystem.checkBaseAttack(entity, unitDef, state, deltaSeconds);

      // Step 6: Out of bounds check
      if (entity.transform.x < -5 || entity.transform.x > state.battlefield.width + 5) {
        toRemove.push(id);
      }
    }

    // Process removals (Deaths handled by separate check or here?)
    // Original code checked for dead entities in toRemove loop AND during iteration.
    // We need to clean up dead entities.
    // Let's add a pass for dead entities.
    for (const [id, entity] of state.entities) {
        if (entity.health.current <= 0) {
            if (!toRemove.includes(id)) toRemove.push(id);
        }
    }

    // Remove entities logic
    toRemove.forEach((id) => {
      const deadEntity = state.entities.get(id);
      if (deadEntity && deadEntity.health.current <= 0) {
          EntitySystem.handleDeathReward(deadEntity, state);
      }
      state.entities.delete(id);
    });
  }

  private static updateTeleporter(entity: Entity, unitDef: any, state: GameState, deltaSeconds: number) {
      const ownerEcon = entity.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
      
      // Passive self-healing
      const healAmount = unitDef.teleporter.healPerSecond * deltaSeconds;
      entity.health.current = Math.min(entity.health.max, entity.health.current + healAmount);
      
      // Update attack cooldown
      entity.teleporterState!.attackCooldown -= deltaSeconds;
      
      // Find strongest enemy unit
      let strongestEnemy: Entity | null = null;
      let highestHealth = 0;
      for (const other of state.entities.values()) {
        if (other.owner !== entity.owner && other.health.current > highestHealth) {
          highestHealth = other.health.current;
          strongestEnemy = other;
        }
      }
      
      // Attack
      if (strongestEnemy && entity.teleporterState!.attackCooldown <= 0 && ownerEcon.mana >= unitDef.teleporter.manaPerAttack) {
         entity.transform.x = strongestEnemy.transform.x;
         entity.transform.facing = entity.owner === 'PLAYER' ? 'RIGHT' : 'LEFT';
         
         ownerEcon.mana -= unitDef.teleporter.manaPerAttack;
         
         const aoeRadius = unitDef.skill?.radius ?? unitDef.skill?.power ?? 1;
         
         // Damage loop
         const toKill: number[] = [];
         for (const other of state.entities.values()) {
             if (other.owner !== entity.owner) {
                 const dist = Math.abs(other.transform.x - entity.transform.x);
                 if (dist <= aoeRadius) {
                     const protection = CombatUtils.getTowerProtectionMultiplier(other, state);
                     // Allow skill damage override or base attack damage
                     const baseDmg = unitDef.skill?.damage ?? entity.attack.damage;
                     const dmg = baseDmg * protection;
                     other.health.current -= dmg;
                     
                     if (entity.owner === 'PLAYER') state.stats.damageDealt.player += dmg;
                     else state.stats.damageDealt.enemy += dmg;
                 }
             }
         }
         
         entity.teleporterState!.attackCooldown = unitDef.teleporter.attackCooldown / 1000;
         entity.animationState = 'ATTACK';
      }
  }

  private static getProjectileSpeed(unitDef: UnitDef, isBurstShot: boolean): number {
    if (unitDef.projectile?.speed && unitDef.projectile.speed > 0) {
      return unitDef.projectile.speed;
    }
    return isBurstShot ? 40 : 30;
  }

  private static getProjectileLifeMs(unitDef: UnitDef, projectileSpeed: number): number {
    const unitRange = unitDef.range ?? 1;
    return ((unitRange * 1.5) / Math.max(0.1, projectileSpeed)) * 1000;
  }

  private static spawnUnitProjectile(
    state: GameState,
    entity: Entity,
    targetX: number,
    damage: number,
    unitDef: UnitDef,
    isBurstShot: boolean
  ): void {
    const dir = targetX > entity.transform.x ? 1 : -1;
    const speed = EntitySystem.getProjectileSpeed(unitDef, isBurstShot);
    const lifeMs = EntitySystem.getProjectileLifeMs(unitDef, speed);
    const projectileStyle = unitDef.projectile;

    state.projectiles.push({
      id: state.nextEntityId++ + 100000,
      owner: entity.owner,
      x: entity.transform.x + dir * 0.2,
      y: entity.transform.laneY,
      vx: dir * speed,
      vy: 0,
      curvature: projectileStyle?.curvature ?? 0,
      damage,
      lifeMs,
      manaLeech: unitDef.manaLeech,
      radiusPx: projectileStyle?.radiusPx,
      color: projectileStyle?.color,
      glowColor: projectileStyle?.glowColor,
      trailAlpha: projectileStyle?.trailAlpha,
    });
  }

  private static performUnitAttack(entity: Entity, target: Entity, unitDef: UnitDef, state: GameState, deltaSeconds: number) {
     entity.animationState = 'ATTACK';
     const isRanged = (entity.attack.range ?? 1) > 1.5;
     
     if (isRanged && unitDef.burstFire) {
         // Burst logic (simplified mapping from provided GameEngine code)
         if (!entity.burstState) entity.burstState = { shotsRemaining: 0, burstCooldown: 0 };
         
         if (entity.burstState.shotsRemaining > 0) {
             entity.attack.cooldownRemaining -= deltaSeconds;
             if (entity.attack.cooldownRemaining <= 0) {
                 EntitySystem.spawnUnitProjectile(
                   state,
                   entity,
                   target.transform.x,
                   entity.attack.damage,
                   unitDef,
                   true
                 );
                 
                 entity.burstState.shotsRemaining--;
                 entity.attack.cooldownRemaining = 0.05;
                 
                 if (entity.burstState.shotsRemaining === 0) {
                     entity.burstState.burstCooldown = unitDef.burstFire.burstCooldown / 1000;
                 }
             }
         } else if (entity.burstState.burstCooldown > 0) {
             entity.burstState.burstCooldown -= deltaSeconds;
             if (entity.burstState.burstCooldown <= 0) {
                 entity.burstState.shotsRemaining = unitDef.burstFire.shots;
                 entity.attack.cooldownRemaining = 0;
             }
         } else {
             entity.burstState.shotsRemaining = unitDef.burstFire.shots;
             entity.attack.cooldownRemaining = 0;
         }
     } else if (isRanged) {
        entity.attack.cooldownRemaining -= deltaSeconds;
        if (entity.attack.cooldownRemaining <= 0) {
            EntitySystem.spawnUnitProjectile(
              state,
              entity,
              target.transform.x,
              entity.attack.damage,
              unitDef,
              false
            );
            entity.attack.cooldownRemaining = 1 / Math.max(0.1, entity.attack.speed);
        }
     } else {
         // Melee (Tick-based)
         entity.attack.cooldownRemaining -= deltaSeconds;
         if (entity.attack.cooldownRemaining <= 0) {
             const baseDmg = entity.attack.damage; // Full damage per hit
             const protection = CombatUtils.getTowerProtectionMultiplier(target, state);
             let dmg = baseDmg * protection;
             
             const targetDef = UNIT_DEFS[target.unitId];
             if (targetDef?.teleporter) {
                dmg *= (1 - targetDef.teleporter.damageReduction);
             }
             
             // Fix: Apply Mana Shield to melee damage as well
             if (targetDef?.manaShield) {
                 const ownerEcon = target.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
                 const shieldableDamage = Math.floor(dmg * 0.9);
                 // 1 Mana absorbs 2 Damage
                 const manaNeeded = Math.ceil(shieldableDamage / 2);
                 const manaUsed = Math.min(manaNeeded, ownerEcon.mana);
                 const damageAbsorbed = manaUsed * 2;
                 
                 if (manaUsed > 0) {
                    ownerEcon.mana -= manaUsed;
                    dmg = Math.max(1, dmg - damageAbsorbed); // Min 1 dmg always penetrates
                 }
             }
             
             target.health.current -= dmg;
             
             if (unitDef?.manaLeech) {
                 const mana = dmg * unitDef.manaLeech;
                 const ownerEcon = entity.owner === 'PLAYER' ? state.economy.player : state.economy.enemy;
                 ownerEcon.mana = ownerEcon.mana + mana; // Leech mana on hit
             }
             
             if (entity.owner === 'PLAYER') state.stats.damageDealt.player += dmg;
             else state.stats.damageDealt.enemy += dmg;

             // Reset Cooldown
             entity.attack.cooldownRemaining = 1.0 / Math.max(0.1, entity.attack.speed);
         }
     }
  }

  private static checkBaseAttack(entity: Entity, unitDef: UnitDef, state: GameState, deltaSeconds: number) {
      if (unitDef.teleporter && unitDef.teleporter.canAttackBase === false) return;

      const isRangedUnit = (entity.attack.range ?? 1) > 1.5;
      const attackRange = entity.attack.range ?? 1;
      
      let canAttackBase = false;
      let targetBase = null;
      let dir = 1;
      
      if (entity.owner === 'PLAYER') {
          const dist = state.battlefield.width - entity.transform.x;
          canAttackBase = isRangedUnit ? dist <= attackRange : dist <= 4;
          targetBase = state.enemyBase;
          dir = 1;
      } else {
          const dist = entity.transform.x;
          // Enemy Logic: Fixed to match Player logic and Movement logic (prevent air swings)
          // Range increased from 2 to 4 to cover stopping distance (3.5)
          canAttackBase = isRangedUnit ? dist <= attackRange : dist <= 4;
          targetBase = state.playerBase;
          dir = -1;
      }
      
      if (canAttackBase && targetBase) {
          if (isRangedUnit) {
              entity.attack.cooldownRemaining -= deltaSeconds;
              if (entity.attack.cooldownRemaining <= 0) {
                const targetX = entity.owner === 'PLAYER' ? state.battlefield.width : 0;
                EntitySystem.spawnUnitProjectile(
                  state,
                  entity,
                  targetX,
                  entity.attack.damage,
                  unitDef,
                  false
                );
                entity.attack.cooldownRemaining = 1 / Math.max(0.1, entity.attack.speed);
              }
          } else {
              // Melee Attack on Base (Tick-Based)
              entity.attack.cooldownRemaining -= deltaSeconds;
              if (entity.attack.cooldownRemaining <= 0) {
                  const dmg = entity.attack.damage; // Full damage
                  const targetOwner = entity.owner === 'PLAYER' ? 'ENEMY' : 'PLAYER';
                  const baseHit = CombatUtils.applyDamageToBase(state, targetOwner, dmg);
                  
                  if (entity.owner === 'PLAYER') state.stats.damageDealt.player += baseHit.actualDamage;
                  else state.stats.damageDealt.enemy += baseHit.actualDamage;
                  
                  // Reset Cooldown
                  entity.attack.cooldownRemaining = 1.0 / Math.max(0.1, entity.attack.speed);
              }
          }
          entity.animationState = 'ATTACK';
      }
  }

  private static handleDeathReward(deadEntity: Entity, state: GameState) {
      const unitDef = UNIT_DEFS[deadEntity.unitId];
      if (!unitDef) return;
      
      const bounty = Math.floor(unitDef.cost * 0.5);
      
      if (deadEntity.owner === 'ENEMY') {
          // Player Killed Enemy
          state.economy.player.gold += bounty;
          const playerConversionRate = getGoldToManaConversionRate(state.progression.player.manaGenerationLevel);
          if (playerConversionRate > 0) {
              state.economy.player.mana += Math.floor(bounty * playerConversionRate);
          }
          state.vfx.push({
              id: Date.now() + Math.random()*1000,
              type: 'kill_reward',
              x: deadEntity.transform.x, y: deadEntity.transform.laneY,
              age: state.progression.player.age, lifeMs: 800,
              data: { bounty }
          });
      } else {
          // Enemy Killed Player
          state.economy.enemy.gold += bounty;
          const enemyConversionRate = getGoldToManaConversionRate(state.progression.enemy.manaGenerationLevel);
          if (enemyConversionRate > 0) {
              state.economy.enemy.mana += Math.floor(bounty * enemyConversionRate);
          }
      }
  }
}
