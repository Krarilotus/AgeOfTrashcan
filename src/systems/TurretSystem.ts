import { GameState, Entity, Projectile } from '../GameEngine';
import {
  TURRET_ABILITY_CONFIG,
  TURRET_CONSTANTS,
  calculateTurretDamage,
  calculateTurretRange,
} from '../config/turretConfig';
import { TURRET_VISUALS, pixelsToUnits, unitsToPixels } from '../config/renderConfig';

export class TurretSystem {
  private turretAccumPlayerMs = 0;
  private turretAccumEnemyMs = 0;

  public update(state: GameState, deltaSeconds: number, projectileSystem: any): void {
    
    // Update cooldowns
    if (state.playerBase.turretAbilityCooldown && state.playerBase.turretAbilityCooldown > 0) {
      state.playerBase.turretAbilityCooldown -= deltaSeconds;
    }
    if (state.enemyBase.turretAbilityCooldown && state.enemyBase.turretAbilityCooldown > 0) {
      state.enemyBase.turretAbilityCooldown -= deltaSeconds;
    }

    const { FIRE_INTERVAL, PROJECTILE_SPEED, BASE_HITBOX_RADIUS } = { ...TURRET_CONSTANTS, BASE_HITBOX_RADIUS: 3 };
    
    const getEffectiveTurretRange = (level: number): number => {
      const nominalRange = calculateTurretRange(level);
      const maxRange = state.battlefield.width / 2;
      return Math.min(nominalRange, maxRange);
    };

    const updateTurretForSide = (
      isPlayer: boolean,
      accumulator: number,
      projIdOffset: number
    ): number => {
      const base = isPlayer ? state.playerBase : state.enemyBase;
      const owner = isPlayer ? 'PLAYER' : 'ENEMY';
      const targetOwner = isPlayer ? 'ENEMY' : 'PLAYER';
      const age = isPlayer ? state.progression.player.age : state.progression.enemy.age;
      const turretLevel = base.turretLevel;
      const turretRange = getEffectiveTurretRange(turretLevel);
      const piercingRange = turretRange * TURRET_ABILITY_CONFIG.PIERCING_SHOT.rangeMultiplier;
      
      const targets: Entity[] = [];
      for (const entity of state.entities.values()) {
        if (entity.owner === targetOwner) {
          const dist = Math.abs(entity.transform.x - base.x);
          if (dist <= turretRange || dist <= BASE_HITBOX_RADIUS) {
            targets.push(entity);
          }
        }
      }
      targets.sort((a, b) => Math.abs(a.transform.x - base.x) - Math.abs(b.transform.x - base.x));

      let piercingTarget: Entity | null = null;
      if (turretLevel >= TURRET_ABILITY_CONFIG.PIERCING_SHOT.requiredLevel) {
        for (const entity of state.entities.values()) {
          if (entity.owner !== targetOwner) continue;
          const dist = Math.abs(entity.transform.x - base.x);
          if (dist <= piercingRange) {
            if (!piercingTarget || dist < Math.abs(piercingTarget.transform.x - base.x)) {
              piercingTarget = entity;
            }
          }
        }
      }
      
      if (targets.length > 0 || piercingTarget) {
        accumulator += deltaSeconds;
        if (accumulator >= FIRE_INTERVAL) {
          accumulator -= FIRE_INTERVAL;
          
          const damagePerShot = calculateTurretDamage(turretLevel);
          const canUseAbility = (base.turretAbilityCooldown ?? 0) <= 0;
          // Single source-of-truth muzzle position for this shot tick.
          const muzzlePos = TurretSystem.getTurretPosition(base.x, age, turretLevel);
          
          if (
            turretLevel >= TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.requiredLevel &&
            canUseAbility &&
            targets.length >= TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.minTargets
          ) {
            base.turretAbilityCooldown = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.cooldownSeconds;
            const barrageDamage =
              damagePerShot * TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.damageMultiplier;

            // Spawn 100 falling projectiles
            const barrageCount = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.projectileCount;
            const barrageDuration = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.durationMs;
            const abilityRange = getEffectiveTurretRange(turretLevel);
            
            // Determine covered area (X range)
            const minX = isPlayer ? base.x : base.x - abilityRange;
            const maxX = isPlayer ? base.x + abilityRange : base.x;
            
            for (let i = 0; i < barrageCount; i++) {
                const delay = Math.random() * barrageDuration;
                const targetX = minX + Math.random() * (maxX - minX);
                const targetY = (Math.random() - 0.5) * TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.spreadLaneY;
                
                // Falling from SKY (Positive Y is Up in Projectile Render Logic)
                const startY = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.startY;
                const speed = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.fallSpeed;
                const distY = Math.abs(startY - targetY); // Distance to fall
                const travelTime = (distY / Math.abs(speed)) * 1000;
                
                state.projectiles.push({ 
                  id: (state.nextEntityId++) + projIdOffset + i, 
                  owner: owner as 'PLAYER' | 'ENEMY', 
                  x: targetX, 
                  y: startY, 
                  vx: 0, 
                  vy: speed,
                  damage: barrageDamage, 
                  lifeMs: travelTime + TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.extraLifeMs,
                  delayMs: delay,
                  isFalling: true,
                  targetY: targetY
                });
            }
            
            // Cast Effect at Turret (Just visual)
            state.vfx.push({
              id: state.nextVfxId++,
              type: 'ability_cast',
              x: muzzlePos.x,
              // RenderSystem treats VFX y as lane offset (+down), while turret/projectile
              // muzzle y is world-up. Flip sign so cast source matches projectile source.
              y: -muzzlePos.y,
              age,
              lifeMs: TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.vfxLifeMs,
              data: { turretAbility: 'artillery_barrage', targets: targets.length },
            });
            
          } else if (
            turretLevel >= TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.requiredLevel &&
            canUseAbility &&
            targets.length >= TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.minTargets
          ) {
            base.turretAbilityCooldown = TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.cooldownSeconds;
            const maxChainTargets = TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.maxTargets;
            const chainPositions: {x: number, y: number}[] = [];

            for (let i = 0; i < Math.min(maxChainTargets, targets.length); i++) {
              const chainDamage =
                damagePerShot *
                (
                  TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.initialDamageMultiplier -
                  i * TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.bounceFalloff
                );
              targets[i].health.current -= chainDamage;
              chainPositions.push({ x: targets[i].transform.x, y: targets[i].transform.laneY });
            }
             state.vfx.push({
              id: state.nextVfxId++,
              type: 'ability_cast',
              x: muzzlePos.x, 
              y: -muzzlePos.y,
              age,
              lifeMs: TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.vfxLifeMs,
              data: { turretAbility: 'chain_lightning', targetPositions: chainPositions },
            });
          } else if (
            turretLevel >= TURRET_ABILITY_CONFIG.PIERCING_SHOT.requiredLevel &&
            canUseAbility &&
            !!piercingTarget
          ) {
            base.turretAbilityCooldown = TURRET_ABILITY_CONFIG.PIERCING_SHOT.cooldownSeconds;
            const pierceDamage = damagePerShot * TURRET_ABILITY_CONFIG.PIERCING_SHOT.damageMultiplier;
            piercingTarget.health.current -= pierceDamage;

            const targetPositions = [
              { x: piercingTarget.transform.x, y: piercingTarget.transform.laneY },
            ];

             state.vfx.push({
              id: state.nextVfxId++,
              type: 'ability_cast',
              x: muzzlePos.x,
              y: -muzzlePos.y,
              age,
              lifeMs: TURRET_ABILITY_CONFIG.PIERCING_SHOT.vfxLifeMs,
              data: {
                turretAbility: 'piercing_shot',
                targets: 1,
                targetPositions,
                durationMs: TURRET_ABILITY_CONFIG.PIERCING_SHOT.vfxLifeMs,
              },
            });
          } else {
            if (targets.length === 0) return accumulator;
            const target = targets[0];
            const projX = muzzlePos.x;
            const projY = muzzlePos.y;
            
            const dx = target.transform.x - projX;
            const dy = target.transform.laneY - projY;
            const distanceToTarget = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);
            
            const projVx = Math.cos(angle) * PROJECTILE_SPEED;
            const projVy = Math.sin(angle) * PROJECTILE_SPEED;
            const lifeMs = (distanceToTarget / PROJECTILE_SPEED) * 1000 * 1.2;
            const projId = (state.nextEntityId++) + projIdOffset;
            
            state.projectiles.push({ 
              id: projId, 
              owner: owner as 'PLAYER' | 'ENEMY', 
              x: projX, 
              y: projY, 
              vx: projVx, 
              vy: projVy,
              damage: damagePerShot, 
              lifeMs 
            });
          }
        }
      } else {
        accumulator = 0;
      }
      return accumulator;
    };

    this.turretAccumPlayerMs = updateTurretForSide(true, this.turretAccumPlayerMs, 200000);
    this.turretAccumEnemyMs = updateTurretForSide(false, this.turretAccumEnemyMs, 300000);
  }

  // Helper methods
  public static getTurretPosition(baseX: number, age: number, turretLevel: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const platformY = pixelsToUnits(dims.height) + TURRET_VISUALS.PLATFORM_OFFSET_UNITS;
    
    // Inline static calls
    const baseSize = TURRET_VISUALS.BASE_SIZE + turretLevel * TURRET_VISUALS.SIZE_PER_LEVEL;
    let ratio = 0.4;
    if (turretLevel >= 7) ratio = 0.6;
    else if (turretLevel >= 4) ratio = 0.5;
    
    const cannonOffsetPx = baseSize * ratio;
    const cannonTipY = platformY + pixelsToUnits(cannonOffsetPx);
    return { x: baseX, y: cannonTipY };
  }
}
