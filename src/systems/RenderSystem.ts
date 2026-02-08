import { GameState, Entity, Projectile } from '../GameEngine';
import { MANA_POOL_VISUALS, TURRET_VISUALS, pixelsToUnits, unitsToPixels } from '../config/renderConfig';
import { UNIT_DEFS } from '../config/units';
import {
  MAX_TURRET_SLOTS,
  getSlotMountYOffsetUnits,
  getTurretEngineDef,
} from '../config/turrets';

export class RenderSystem {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement>;
  private manaPoolSprites: Map<number, HTMLImageElement> = new Map();
  private missingManaPoolWarnings: Set<number> = new Set();
  private turretEngineSprites: Map<string, HTMLImageElement> = new Map();
  private baseSlotExtensionSprites: Map<number, HTMLImageElement> = new Map();

  constructor(
    ctx: CanvasRenderingContext2D, 
    canvas: HTMLCanvasElement, 
    unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement>
  ) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.unitSprites = unitSprites;
    this.loadManaPoolSprites();
    this.loadTurretEngineSprites();
    this.loadBaseSlotExtensionSprites();
  }

  private loadTurretEngineSprites(): void {
    const turretIds = [
      'chicken_eggomat', 'flame_catapult', 'sunspike_ballista', 'shrapnel_urn_launcher',
      'boiling_pot', 'repeater_crossbow', 'thunder_javelin', 'piercing_sniper',
      'shock_mortar', 'suppressor_nest', 'kamikaze_drone_hub', 'lightning_rod',
      'artillery_barrage_platform', 'flak_array', 'plasma_lance', 'quantum_laser',
      'tesla_obelisk_mk2', 'orbital_barrage_mk2',
    ];

    for (const turretId of turretIds) {
      const img = new Image();
      img.onload = () => {
        this.turretEngineSprites.set(turretId, img);
      };
      img.src = `/turret_engines/${turretId}.svg`;
    }
  }

  private loadBaseSlotExtensionSprites(): void {
    for (let slots = 1; slots <= MAX_TURRET_SLOTS; slots++) {
      const img = new Image();
      img.onload = () => {
        this.baseSlotExtensionSprites.set(slots, img);
      };
      img.src = `/base_slots/slots_${slots}.svg`;
    }
  }

  private loadManaPoolSprites(): void {
    for (let tier = 1; tier <= 6; tier++) {
      const img = new Image();
      const src = `${import.meta.env.BASE_URL}manapool/mana_pool_age_${tier}.svg`;
      img.onload = () => {
        this.manaPoolSprites.set(tier, img);
      };
      img.onerror = () => {
        console.warn(`Mana pool sprite failed to load for tier ${tier}: ${src}`);
      };
      img.src = src;
    }
  }

  public render(state: GameState): void {
    if (!this.ctx || !this.canvas) return;

    // Clear canvas
    this.ctx.fillStyle = '#1e293b';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw lane
    this.ctx.strokeStyle = '#475569';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([10, 10]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.canvas.height / 2);
    this.ctx.lineTo(this.canvas.width, this.canvas.height / 2);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw bases
    this.drawBase(
      state.playerBase,
      true,
      state.progression.player.age,
      state.progression.player.manaGenerationLevel,
      state.battlefield.width,
      state.vfx
    );
    this.drawBase(
      state.enemyBase,
      false,
      state.progression.enemy.age,
      state.progression.enemy.manaGenerationLevel,
      state.battlefield.width,
      state.vfx
    );

    // Draw units
    for (const entity of state.entities.values()) {
      this.drawUnit(entity, state.battlefield.width);
    }

    // Draw projectiles
    this.drawProjectiles(state.projectiles, state.battlefield.width);

    // Draw VFX
    this.drawVFX(state, state.battlefield.width);

    // Draw UI info
    this.drawHUD(state);
  }

  private getTurretScreenPosition(baseX: number, baseY: number, age: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const turretY = baseY - dims.height - 5; 
    return { x: baseX, y: turretY };
  }

  private getTurretScreenPositionForSlot(baseX: number, baseY: number, age: number, slotIndex: number): { x: number; y: number } {
    const top = this.getTurretScreenPosition(baseX, baseY, age);
    const slotYOffset = unitsToPixels(getSlotMountYOffsetUnits(slotIndex));
    return { x: top.x, y: top.y - slotYOffset };
  }

  private drawBase(
    base: any,
    isPlayer: boolean,
    age: number,
    manaLevel: number,
    battlefieldWidth: number,
    vfx: GameState['vfx']
  ): void {
    const x = (base.x / battlefieldWidth) * this.canvas.width;
    const y = this.canvas.height / 2;
    
    const turretSlotsUnlocked = Math.max(1, Math.min(MAX_TURRET_SLOTS, base.turretSlotsUnlocked ?? 1));
    const color1 = isPlayer ? '#3b82f6' : '#ef4444';
    const color2 = isPlayer ? '#1e40af' : '#991b1b';
    const color3 = isPlayer ? '#60a5fa' : '#f87171';

    // Draw cellar/well first so base geometry sits naturally above it.
    this.drawManaPool(x, y, age, manaLevel, isPlayer);

    // Age-progressive procedural designs
    if (age === 1) { // Stone Age
      const tentWidth = 35;
      const tentHeight = 30;
      this.ctx.fillStyle = '#8b7355';
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - tentHeight);
      this.ctx.lineTo(x - tentWidth/2, y);
      this.ctx.lineTo(x + tentWidth/2, y);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.strokeStyle = '#654321';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
      this.ctx.fillStyle = '#3d2817';
      this.ctx.fillRect(x - 8, y - 15, 16, 15);
    } else if (age === 2) { // Tool Age
      const tentWidth = 38;
      const tentHeight = 32;
      this.ctx.fillStyle = '#a0826d';
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - tentHeight);
      this.ctx.lineTo(x - tentWidth/2, y);
      this.ctx.lineTo(x + tentWidth/2, y);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.strokeStyle = '#654321';
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(x - tentWidth/3, y);
      this.ctx.lineTo(x, y - tentHeight);
      this.ctx.moveTo(x + tentWidth/3, y);
      this.ctx.lineTo(x, y - tentHeight);
      this.ctx.stroke();
    } else if (age === 3) { // Bronze Age
      const hutWidth = 35;
      const hutHeight = 35;
      this.ctx.fillStyle = color2;
      this.ctx.fillRect(x - hutWidth/2, y - hutHeight + 10, hutWidth, hutHeight - 10);
      this.ctx.fillStyle = '#8b4513';
      this.ctx.beginPath();
      this.ctx.moveTo(x, y - hutHeight);
      this.ctx.lineTo(x - hutWidth/2 - 5, y - hutHeight + 15);
      this.ctx.lineTo(x + hutWidth/2 + 5, y - hutHeight + 15);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = '#fcd34d';
      this.ctx.fillRect(x - 6, y - 20, 12, 10);
    } else if (age === 4) { // Iron Age
      const towerWidth = 36;
      const towerHeight = 40;
      this.ctx.fillStyle = '#71717a';
      this.ctx.fillRect(x - towerWidth/2, y - towerHeight, towerWidth, towerHeight);
      this.ctx.strokeStyle = '#52525b';
      this.ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        this.ctx.strokeRect(x - towerWidth/2, y - towerHeight + i * 13, towerWidth, 13);
      }
      this.ctx.fillStyle = '#52525b';
      for (let i = 0; i < 3; i++) {
        this.ctx.fillRect(x - towerWidth/2 + i * 12, y - towerHeight - 5, 8, 5);
      }
    } else if (age === 5) { // Castle Age
      const keepWidth = 40;
      const keepHeight = 42;
      const gradient = this.ctx.createLinearGradient(x, y - keepHeight, x, y);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(x - keepWidth/2, y - keepHeight, keepWidth, keepHeight);
      this.ctx.fillStyle = color3;
      this.ctx.beginPath();
      this.ctx.moveTo(x - keepWidth/2 + 5, y - keepHeight - 5);
      this.ctx.lineTo(x - keepWidth/2 + 15, y - keepHeight - 8);
      this.ctx.lineTo(x - keepWidth/2 + 5, y - keepHeight - 11);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = '#000';
      for (let i = 0; i < 2; i++) {
        this.ctx.fillRect(x - 12, y - keepHeight + 15 + i * 15, 3, 10);
        this.ctx.fillRect(x + 9, y - keepHeight + 15 + i * 15, 3, 10);
      }
    } else if (age === 6) { // Renaissance
      const citadelWidth = 42;
      const citadelHeight = 45;
      this.ctx.fillStyle = color2;
      this.ctx.fillRect(x - citadelWidth/2, y - citadelHeight, citadelWidth, citadelHeight);
      this.ctx.fillStyle = color1;
      this.ctx.fillRect(x - citadelWidth/2 - 4, y - citadelHeight, 8, 20);
      this.ctx.fillRect(x + citadelWidth/2 - 4, y - citadelHeight, 8, 20);
      this.ctx.fillStyle = '#fbbf24';
      for (let i = 0; i < 2; i++) {
        this.ctx.fillRect(x - 15, y - citadelHeight + 15 + i * 15, 10, 10);
        this.ctx.fillRect(x + 5, y - citadelHeight + 15 + i * 15, 10, 10);
      }
    } else { // Modern Age (7)
      const bunkerWidth = 45;
      const bunkerHeight = 48;
      const metalGradient = this.ctx.createLinearGradient(x - bunkerWidth/2, y - bunkerHeight, x + bunkerWidth/2, y);
      metalGradient.addColorStop(0, '#6b7280');
      metalGradient.addColorStop(0.5, '#9ca3af');
      metalGradient.addColorStop(1, '#4b5563');
      this.ctx.fillStyle = metalGradient;
      this.ctx.fillRect(x - bunkerWidth/2, y - bunkerHeight, bunkerWidth, bunkerHeight);
      this.ctx.fillStyle = isPlayer ? '#3b82f6' : '#ef4444';
      this.ctx.fillRect(x - bunkerWidth/2 + 5, y - bunkerHeight + 8, 12, 8);
      this.ctx.fillRect(x + bunkerWidth/2 - 17, y - bunkerHeight + 8, 12, 8);
      this.ctx.fillStyle = '#10b981';
      for (let i = 0; i < 3; i++) {
        this.ctx.beginPath();
        this.ctx.arc(x - 15 + i * 15, y - bunkerHeight + 25, 3, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.strokeStyle = '#1f2937';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(x - bunkerWidth/2, y - bunkerHeight, bunkerWidth, bunkerHeight);
    }

    const slotExtensionSprite = this.baseSlotExtensionSprites.get(turretSlotsUnlocked);
    if (slotExtensionSprite && slotExtensionSprite.complete && slotExtensionSprite.naturalHeight > 0) {
      const extWidth = 28;
      const extHeight = 26 + turretSlotsUnlocked * 8;
      this.ctx.drawImage(slotExtensionSprite, x - extWidth / 2, y - extHeight - 2, extWidth, extHeight);
    } else {
      this.ctx.fillStyle = isPlayer ? 'rgba(59,130,246,0.30)' : 'rgba(239,68,68,0.30)';
      for (let i = 0; i < turretSlotsUnlocked; i++) {
        const pos = this.getTurretScreenPositionForSlot(x, y, age, i);
        this.ctx.fillRect(pos.x - 8, pos.y + 3, 16, 5);
      }
    }

    for (let slotIndex = 0; slotIndex < turretSlotsUnlocked; slotIndex++) {
      const slot = base.turretSlots?.[slotIndex];
      const pos = this.getTurretScreenPositionForSlot(x, y, age, slotIndex);
      this.ctx.fillStyle = isPlayer ? '#1d4ed8' : '#b91c1c';
      this.ctx.fillRect(pos.x - 10, pos.y + 2, 20, 4);

      if (!slot?.turretId) {
        this.ctx.strokeStyle = 'rgba(148,163,184,0.35)';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(pos.x - 9, pos.y - 12, 18, 12);
        continue;
      }

      const engineDef = getTurretEngineDef(slot.turretId);
      if (!engineDef) continue;

      const sprite = this.turretEngineSprites.get(slot.turretId);
      if (sprite && sprite.complete && sprite.naturalHeight > 0) {
        if (slot.turretId === 'boiling_pot') {
          const drawW = 88;
          const drawH = 28;
          const forwardShift = isPlayer ? 20 : -20;
          this.ctx.save();
          this.ctx.translate(pos.x + forwardShift, 0);
          this.ctx.scale(isPlayer ? 1 : -1, 1);
          this.ctx.drawImage(sprite, -drawW / 2, pos.y - 26, drawW, drawH);
          this.ctx.restore();
        } else {
          this.ctx.drawImage(sprite, pos.x - 14, pos.y - 22, 28, 22);
        }
      } else {
        this.ctx.fillStyle = isPlayer ? '#60a5fa' : '#f87171';
        this.ctx.beginPath();
        this.ctx.arc(pos.x, pos.y - 8, 8, 0, Math.PI * 2);
        this.ctx.fill();
      }

      const rangePixels = (engineDef.range / battlefieldWidth) * this.canvas.width;
      this.ctx.strokeStyle = isPlayer ? 'rgba(96, 165, 250, 0.18)' : 'rgba(248, 113, 113, 0.18)';
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath();
      this.ctx.arc(pos.x, y, rangePixels, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
  }

  private getManaPoolTier(manaLevel: number): number {
    if (manaLevel >= 20) return 6;
    if (manaLevel >= 15) return 5;
    if (manaLevel >= 10) return 4;
    if (manaLevel >= 6) return 3;
    if (manaLevel >= 3) return 2;
    if (manaLevel >= 1) return 1;
    return 0;
  }

  private getManaPoolInwardShift(age: number, isPlayer: boolean): number {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const shift = dims.width * MANA_POOL_VISUALS.INWARD_SHIFT_BASE_WIDTH_RATIO;
    return isPlayer ? shift : -shift;
  }

  private getReadyManaPoolSprite(tier: number): HTMLImageElement | null {
    const sprite = this.manaPoolSprites.get(tier);
    if (!sprite) return null;
    if (!sprite.complete || sprite.naturalHeight <= 0) return null;
    return sprite;
  }

  private drawManaPool(baseX: number, baseY: number, age: number, manaLevel: number, isPlayer: boolean): void {
    const tier = this.getManaPoolTier(manaLevel);
    if (tier === 0) return;

    const sprite = this.getReadyManaPoolSprite(tier);
    if (!sprite) {
      if (!this.missingManaPoolWarnings.has(tier)) {
        this.missingManaPoolWarnings.add(tier);
        console.warn(`Mana pool tier ${tier} sprite not ready. Skipping render this frame.`);
      }
      return;
    }

    // Keep sprite scale fixed; tier differences come from the SVG artwork only.
    const drawHeight = MANA_POOL_VISUALS.DRAW_HEIGHT_PX;
    const drawWidth = drawHeight * (sprite.naturalWidth / sprite.naturalHeight);

    // Nudge cellar inward by half of the base edge overhang amount.
    const centerX = baseX + this.getManaPoolInwardShift(age, isPlayer);
    const drawX = centerX - drawWidth / 2;
    // Anchor rim close to the lane baseline while letting the well expand downward.
    const rimOffset = drawHeight * MANA_POOL_VISUALS.RIM_OFFSET_RATIO;
    const drawY = baseY - rimOffset + MANA_POOL_VISUALS.BASELINE_Y_OFFSET_PX;

    this.ctx.globalAlpha = 0.95;
    this.ctx.drawImage(sprite, drawX, drawY, drawWidth, drawHeight);
    this.ctx.globalAlpha = 1.0;
  }

  private drawUnit(entity: Entity, battlefieldWidth: number): void {
    const x = (entity.transform.x / battlefieldWidth) * this.canvas.width;
    const y = this.canvas.height / 2 + (entity.transform.laneY * 15);

    const sprite = this.unitSprites.get(entity.unitId);
    if (sprite) {
      // Get visual scale from unit definition
      const def = UNIT_DEFS[entity.unitId];
      const scale = def?.visualScale ?? 1.0;
      
      const sw = sprite.width * scale;
      const sh = sprite.height * scale;
      
      this.ctx.save();
      if (entity.kinematics.vx < 0) {
        this.ctx.translate(x, y);
        this.ctx.scale(-1, 1);
        this.ctx.drawImage(sprite, -sw / 2, -sh / 2, sw, sh);
      } else {
        this.ctx.drawImage(sprite, x - sw / 2, y - sh / 2, sw, sh);
      }
      this.ctx.restore();
    }

    // Health indicator
    const healthPercent = Math.max(0, entity.health.current / entity.health.max);
    this.ctx.fillStyle = healthPercent > 0.5 ? '#22c55e' : healthPercent > 0.25 ? '#eab308' : '#ef4444';
    this.ctx.fillRect(x - 12, y - 33, 24 * healthPercent, 3);
  }

  private drawProjectiles(projectiles: Projectile[], battlefieldWidth: number): void {
    for (const p of projectiles) {
      if (p.delayMs && p.delayMs > 0) continue; // Skip if delayed

      const x = (p.x / battlefieldWidth) * this.canvas.width;
      const baselineY = this.canvas.height / 2;
      const y = baselineY - unitsToPixels(p.y); // Use helper

      if (p.isFalling) {
        // Falling Artillery Shell (Vertical Oval/Teardrop)
        this.ctx.fillStyle = p.color ?? '#ff4400';
        this.ctx.beginPath();
        // Smaller than normal (Radius 2x5)
        this.ctx.ellipse(x, y, 2, 5, 0, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Trail
        this.ctx.fillStyle = p.glowColor ?? 'rgba(255, 100, 0, 0.4)';
        this.ctx.beginPath();
        this.ctx.ellipse(x, y - 6, 1.5, 4, 0, 0, Math.PI * 2);
        this.ctx.fill();
        continue;
      }

      const baseRadius = p.radiusPx ?? (Math.abs(p.damage) >= 40 ? 6 : Math.abs(p.damage) >= 18 ? 5 : 4);
      const fill = p.color ?? (p.owner === 'PLAYER' ? '#fef08a' : '#fca5a5');
      const glow = p.glowColor ?? (p.owner === 'PLAYER' ? 'rgba(251,191,36,0.78)' : 'rgba(248,113,113,0.78)');
      const trailAlpha = p.trailAlpha ?? (baseRadius >= 6 ? 0.45 : 0.30);
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const tail = Math.min(20, Math.max(6, speed * 0.18));
      const nx = speed > 0.1 ? p.vx / speed : 0;
      const ny = speed > 0.1 ? p.vy / speed : 0;
      const screenVx = p.vx;
      const screenVy = -p.vy;
      const screenSpeed = Math.max(0.1, Math.sqrt(screenVx * screenVx + screenVy * screenVy));
      const angle = Math.atan2(screenVy, screenVx);

      this.ctx.globalAlpha = trailAlpha;
      this.ctx.strokeStyle = glow;
      this.ctx.lineWidth = Math.max(1.5, baseRadius * 0.65);
      this.ctx.lineCap = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(x - nx * tail, y + ny * tail);
      this.ctx.lineTo(x, y);
      this.ctx.stroke();

      this.ctx.globalAlpha = 1.0;
      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(angle);
      this.ctx.fillStyle = fill;
      this.ctx.beginPath();
      // Velocity-oriented projectile body.
      this.ctx.ellipse(0, 0, baseRadius * 1.35, Math.max(1.5, baseRadius * 0.75), 0, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();

      this.ctx.strokeStyle = glow;
      this.ctx.lineWidth = Math.max(1, baseRadius * 0.25);
      this.ctx.beginPath();
      this.ctx.arc(x, y, baseRadius + 0.5, 0, Math.PI * 2);
      this.ctx.stroke();

      // Secondary velocity wake for high-speed shots.
      if (screenSpeed > 24) {
        this.ctx.globalAlpha = Math.min(0.6, trailAlpha + 0.15);
        this.ctx.strokeStyle = glow;
        this.ctx.lineWidth = Math.max(1, baseRadius * 0.4);
        this.ctx.beginPath();
        this.ctx.moveTo(x - nx * (tail * 1.6), y + ny * (tail * 1.6));
        this.ctx.lineTo(x - nx * (tail * 0.35), y + ny * (tail * 0.35));
        this.ctx.stroke();
        this.ctx.globalAlpha = 1.0;
      }
    }
  }

  private drawVFX(state: GameState, battlefieldWidth: number): void {
    for (const vfx of state.vfx) {
      const x = (vfx.x / battlefieldWidth) * this.canvas.width;
      const y = this.canvas.height / 2 + (vfx.y * 15);
      const alpha = Math.max(
        0,
        Math.min(1, vfx.lifeMs / (vfx.type === 'kill_reward' ? 800 : vfx.type === 'ability_cast' ? 600 : 1000))
      );
      
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      
      if (vfx.type === 'ability_cast') {
        if (vfx.data?.turretAbility === 'chain_lightning' && vfx.data.targetPositions) {
            // Chain Lightning Visuals
            
            // Phase Logic (Total 600ms)
            const maxLife = 600;
            const elapsed = maxLife - vfx.lifeMs;
            
            // Draw SOURCE Glow (Charge Up)
            const chargeSize = Math.min(20, elapsed / 5); // Grow to 20px
            const pulse = 1.0 + Math.sin(vfx.lifeMs / 50) * 0.2;
            
            const grad = this.ctx.createRadialGradient(x, y, 0, x, y, chargeSize * pulse);
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(0.5, '#00ffff');
            grad.addColorStop(1, 'rgba(0,0,255,0)');
            
            this.ctx.fillStyle = grad;
            this.ctx.beginPath();
            this.ctx.arc(x, y, chargeSize * pulse, 0, Math.PI * 2);
            this.ctx.fill();

            // Draw Bolts (Only after 150ms charge)
            if (elapsed > 150) {
                this.ctx.shadowBlur = 10;
                this.ctx.shadowColor = '#00ffff';
                this.ctx.lineCap = 'round';
                this.ctx.lineJoin = 'round';
                
                // Draw bolts from source to targets
                let startX = x; // Base position
                let startY = y;
                
                this.ctx.beginPath();
                
                for (const targetPos of vfx.data.targetPositions) {
                    const tx = (targetPos.x / battlefieldWidth) * this.canvas.width;
                    const ty = this.canvas.height / 2 + (targetPos.y * 15);
                    
                    // Draw jagged line for lightning
                    const segments = 5;
                    let curX = startX;
                    let curY = startY;
                    
                    this.ctx.moveTo(startX, startY);
                    
                    for (let i = 1; i <= segments; i++) {
                        const progress = i / segments;
                        const nextX = startX + (tx - startX) * progress;
                        const nextY = startY + (ty - startY) * progress;
                        
                        // Jitter
                        const jitterX = (Math.random() - 0.5) * 20 * (1 - progress); // More jitter near start
                        const jitterY = (Math.random() - 0.5) * 30; // Random vertical jitter
                        
                        const drawX = (i === segments) ? tx : nextX + jitterX;
                        const drawY = (i === segments) ? ty : nextY + jitterY;
                        
                        this.ctx.lineTo(drawX, drawY);
                        
                        curX = drawX;
                        curY = drawY;
                    }
                    
                    // Chain to next target
                    startX = tx;
                    startY = ty;
                }
                
                this.ctx.strokeStyle = `rgba(180, 230, 255, ${alpha})`;
                this.ctx.lineWidth = 4;
                this.ctx.stroke();
                
                this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
                this.ctx.lineWidth = 2;
                this.ctx.stroke();
                
                this.ctx.shadowBlur = 0;
            }
        } else if (vfx.data?.turretAbility === 'piercing_shot' && vfx.data.targetPositions) {
            // Piercing Shot: quick traveling beam with a soft trailing fade.
            const startX = x;
            const startY = y;
            const durationMs = vfx.data?.durationMs ?? 220;
            const elapsedMs = Math.max(0, durationMs - vfx.lifeMs);
            const travelProgress = Math.min(1, elapsedMs / Math.max(1, durationMs));
            const trailLength = 0.35;
            const tailProgress = Math.max(0, travelProgress - trailLength);

            for (const targetPos of vfx.data.targetPositions) {
                const tx = (targetPos.x / battlefieldWidth) * this.canvas.width;
                const ty = this.canvas.height / 2 + (targetPos.y * 15);

                const headX = startX + (tx - startX) * travelProgress;
                const headY = startY + (ty - startY) * travelProgress;
                const tailX = startX + (tx - startX) * tailProgress;
                const tailY = startY + (ty - startY) * tailProgress;

                const grad = this.ctx.createLinearGradient(tailX, tailY, headX, headY);
                grad.addColorStop(0, `rgba(180, 120, 255, ${alpha * 0.06})`);
                grad.addColorStop(1, `rgba(230, 215, 255, ${alpha * 0.35})`);

                this.ctx.beginPath();
                this.ctx.moveTo(tailX, tailY);
                this.ctx.lineTo(headX, headY);
                this.ctx.lineWidth = 2;
                this.ctx.strokeStyle = grad;
                this.ctx.stroke();

                // Subtle core so impact is visible without being too intense.
                this.ctx.beginPath();
                this.ctx.moveTo(tailX, tailY);
                this.ctx.lineTo(headX, headY);
                this.ctx.lineWidth = 1;
                this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.30})`;
                this.ctx.stroke();
            }

        } else if (vfx.data?.turretAbility === 'oil_pour') {
            const oilRadiusUnits = Math.max(1, vfx.data?.radius ?? 2.5);
            const forwardReachUnits = Math.max(0.4, vfx.data?.forwardReachUnits ?? oilRadiusUnits);
            const backReachUnits = Math.max(0.2, vfx.data?.backReachUnits ?? oilRadiusUnits * 0.6);
            const direction = vfx.data?.direction === -1 ? -1 : 1;
            const halfSpanUnits = (forwardReachUnits + backReachUnits) * 0.5;
            const forwardBiasUnits = ((forwardReachUnits - backReachUnits) * 0.5) * direction;
            const oilRadiusPx = (halfSpanUnits / battlefieldWidth) * this.canvas.width;
            const oilCenterX = x + (forwardBiasUnits / battlefieldWidth) * this.canvas.width;
            const durationMs = Math.max(300, vfx.data?.durationMs ?? 900);
            const phase = 1 - Math.max(0, vfx.lifeMs) / durationMs;
            const splashCount = 10;

            // Ground pool
            const poolGradient = this.ctx.createRadialGradient(
              oilCenterX,
              y + 3,
              oilRadiusPx * 0.2,
              oilCenterX,
              y + 3,
              oilRadiusPx
            );
            poolGradient.addColorStop(0, `rgba(255, 180, 70, ${0.5 * alpha})`);
            poolGradient.addColorStop(0.45, `rgba(180, 70, 15, ${0.55 * alpha})`);
            poolGradient.addColorStop(1, `rgba(35, 12, 4, ${0.38 * alpha})`);
            this.ctx.fillStyle = poolGradient;
            this.ctx.beginPath();
            this.ctx.ellipse(oilCenterX, y + 4, oilRadiusPx, Math.max(8, oilRadiusPx * 0.45), 0, 0, Math.PI * 2);
            this.ctx.fill();

            // Boiling splashes
            for (let i = 0; i < splashCount; i++) {
              const t = (i / splashCount) * Math.PI * 2 + phase * 5;
              const r = oilRadiusPx * (0.25 + (i % 4) * 0.15);
              const sx = oilCenterX + Math.cos(t) * r;
              const sy = y + 2 - Math.abs(Math.sin(phase * 8 + i)) * (6 + i * 0.3);
              const sr = 1.5 + (i % 3);
              this.ctx.fillStyle = `rgba(255, 210, 120, ${0.35 * alpha})`;
              this.ctx.beginPath();
              this.ctx.arc(sx, sy, sr, 0, Math.PI * 2);
              this.ctx.fill();
            }

        } else if (vfx.data?.turretAbility === 'artillery_barrage') {
             // MUZZLE FLASH ANIMATION (Instead of Rocket Launch)
             // Rapid flashing (Machine Gun style or Pulse width)
             const pulse = Math.sin(vfx.lifeMs * 0.5); // Rapid flicker
             if (pulse > 0) {
                 // Draw Flash pointing UP
                 this.ctx.save();
                 this.ctx.translate(x, y);
                 // IsPlayer?? We just assume pointing UP
                 // Draw a cone cone facing -Y (Up)
                 const flashSize = 25 + Math.random() * 10;
                 
                 const grad = this.ctx.createRadialGradient(0, -10, 0, 0, -20, flashSize);
                 grad.addColorStop(0, '#ffffff');
                 grad.addColorStop(0.3, '#ffaa00');
                 grad.addColorStop(1, 'rgba(255, 0, 0, 0)');
                 
                 this.ctx.fillStyle = grad;
                 this.ctx.beginPath();
                 this.ctx.ellipse(0, -20, 10, flashSize, 0, 0, Math.PI * 2);
                 this.ctx.fill();
                 
                 // Smoke Puff
                 this.ctx.fillStyle = `rgba(100, 100, 100, 0.3)`;
                 this.ctx.beginPath();
                 this.ctx.arc(0 + (Math.random()-0.5)*10, -40, 15, 0, Math.PI*2);
                 this.ctx.fill();

                 this.ctx.restore();
             }

        } else {
            // Standard Cast Visuals
            const castRadius = 15 + (vfx.age * 2);
            if (vfx.age <= 2) {
                this.ctx.strokeStyle = '#fbbf24';
                this.ctx.lineWidth = 3;
                this.ctx.beginPath();
                this.ctx.arc(x, y, castRadius, 0, Math.PI * 2);
                this.ctx.stroke();
            } else if (vfx.age <= 4) {
                this.ctx.strokeStyle = '#8b5cf6';
                this.ctx.lineWidth = 2;
                for (let i = 0; i < 3; i++) {
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, castRadius - i * 5, 0, Math.PI * 2);
                    this.ctx.stroke();
                }
            } else {
                const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, castRadius);
                gradient.addColorStop(0, '#00ffff');
                gradient.addColorStop(0.5, '#0080ff');
                gradient.addColorStop(1, 'transparent');
                this.ctx.fillStyle = gradient;
                this.ctx.beginPath();
                this.ctx.arc(x, y, castRadius, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
      } else if (vfx.type === 'ability_impact') {
        const isArtilleryShell = vfx.data?.subtype === 'artillery_shell';
        const delay = vfx.data?.delay || 0;
        
        // Handle delayed articulation (if delay > 0, we might want to hide it, but VfxSystem doesn't handle delay logic separately)
        // Ideally we'd decrement delay in data, but we can just use lifeMs phase.
        
        if (isArtilleryShell) {
             const maxLife = 1000;
             const progress = 1.0 - (vfx.lifeMs / maxLife); // 0.0 to 1.0
             
             // Phase 1: Falling (0.0 to 0.8)
             // Phase 2: Explosion (0.8 to 1.0)
             
             if (progress < 0.8) {
                 const fallProgress = progress / 0.8; // 0 to 1
                 // Drop from height
                 const height = 300 * (1 - fallProgress * fallProgress); // Accelerate down
                 
                 this.ctx.fillStyle = '#ff4500';
                 this.ctx.beginPath();
                 this.ctx.arc(x, y - height, 4, 0, Math.PI * 2);
                 this.ctx.fill();
                 
                 // Trail
                 this.ctx.strokeStyle = `rgba(255, 100, 0, ${0.5 * (1 - fallProgress)})`;
                 this.ctx.lineWidth = 2;
                 this.ctx.beginPath();
                 this.ctx.moveTo(x, y - height - 10);
                 this.ctx.lineTo(x, y - height);
                 this.ctx.stroke();
             } else {
                 // Explosion
                 const explodeProgress = (progress - 0.8) / 0.2; // 0 to 1
                 const radius = 5 + explodeProgress * 30;
                 const alphaExp = alpha * (1 - explodeProgress);
                 
                 this.ctx.fillStyle = `rgba(255, 200, 50, ${alphaExp})`;
                 this.ctx.beginPath();
                 this.ctx.arc(x, y, radius, 0, Math.PI * 2);
                 this.ctx.fill();
                 
                 this.ctx.strokeStyle = `rgba(255, 50, 0, ${alphaExp})`;
                 this.ctx.lineWidth = 2;
                 this.ctx.beginPath();
                 this.ctx.arc(x, y, radius * 0.7, 0, Math.PI * 2);
                 this.ctx.stroke();
             }
             
             return; // Skip default impact rendering
        }

        if (vfx.data?.radius) {
            // ... (AOE rendering existing code) ...
            const impactRadius = (vfx.data.radius / battlefieldWidth) * this.canvas.width;
            this.ctx.fillStyle = vfx.age <= 2 ? `rgba(255, 140, 0, ${alpha * 0.3})` : vfx.age <= 4 ? `rgba(139, 92, 246, ${alpha * 0.4})` : `rgba(0, 255, 255, ${alpha * 0.5})`;
            this.ctx.beginPath();
            this.ctx.arc(x, y, impactRadius, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.strokeStyle = vfx.age <= 2 ? '#ff8c00' : vfx.age <= 4 ? '#a855f7' : '#00ffff';
            this.ctx.lineWidth = 3;
            // ...
        } else {
            // DIRECT IMPACT
            // Check for negative damage (Healing)
            const damage = vfx.data?.damage || 0;
            const isHealing = damage < 0;

            if (isHealing) {
                // DRAW GREEN CROSS
                const size = 15;
                this.ctx.fillStyle = '#22c55e'; // Green
                this.ctx.globalAlpha = alpha;
                
                // Draw + Shape
                this.ctx.fillRect(x - size/2, y - size/6, size, size/3); // Horiz
                this.ctx.fillRect(x - size/6, y - size/2, size/3, size); // Vert
                
                // Draw Floating Text (+Healing)
                this.ctx.globalAlpha = alpha;
                this.ctx.fillStyle = '#4ade80'; // Lighter green text
                this.ctx.font = 'bold 16px monospace';
                this.ctx.textAlign = 'center';
                this.ctx.fillText(`+${Math.abs(Math.floor(damage))}`, x, y - 25);

            } else {
                // NORMAL DAMAGE VISUALS
                const size = 10 + (damage) / 5;
                this.ctx.fillStyle = vfx.age <= 2 ? '#ff4444' : vfx.age <= 4 ? '#ff00ff' : '#00ffff';
                this.ctx.beginPath();
                this.ctx.arc(x, y, size, 0, Math.PI * 2);
                this.ctx.fill();
                if (vfx.data?.damage > 0) {
                  this.ctx.globalAlpha = alpha * 1.5;
                  this.ctx.fillStyle = '#ffffff';
                  this.ctx.font = 'bold 14px monospace';
                  this.ctx.textAlign = 'center';
                  this.ctx.fillText(`-${Math.floor(vfx.data.damage)}`, x, y - 20);
                }
            }
        }
      } else if (vfx.type === 'flamethrower') {
        const direction = vfx.data?.direction || 1;
        const range = vfx.data?.range || 4;
        const screenRange = (range / battlefieldWidth) * this.canvas.width;
        const isDarkCultist = vfx.data?.unitId === 'dark_cultist';
        
        // Use additive blending for brighter fire
        this.ctx.globalCompositeOperation = 'screen';

        const segments = 25; // Dense fire (was 20)
        const step = screenRange / segments;
        
        for (let i = 0; i < segments; i++) {
           const progress = i / segments; // 0 to 1
           const dist = i * step;
           
           // Radius grows with distance (BOOSTED for visibility)
           const radius = (8 + progress * 35) * (0.8 + Math.random() * 0.4);
           
           // Wiggle (Chaotic, not just sine)
           const timeScale = (state.tick / 60) * 20;
           const wiggle = Math.sin(timeScale + i * 0.5) * (15 * progress) + Math.cos(timeScale * 1.5 + i) * 5;
           const yOffset = wiggle;
           
           const cx = x + (dist * direction);
           const cy = y + yOffset;
           
           // Alpha fades out at end.
           // BOOSTED VISIBILITY: Multiplier 6.0 -> 12.0 to keep it opaque longer.
           // CURVE: pow(4) keeps the tip thicker for longer than pow(2).
           const particleAlpha = Math.min(1.0, alpha * 12.0) * (1 - Math.pow(progress, 4));
           
           this.ctx.beginPath();
           this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
           
           if (isDarkCultist) {
              // Purple/Green fel fire (Dark Cultist)
              // Core: Cyan/White, Mid: Purple, Outer: Dark Blue/Green mist
              const r = Math.floor(50 + progress * 50); 
              const g = Math.floor(255 - progress * 200);
              const b = Math.floor(100 + progress * 155);
              
              const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
              grad.addColorStop(0, `rgba(200, 255, 200, ${particleAlpha})`);
              grad.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${particleAlpha * 0.95})`);
              grad.addColorStop(1, `rgba(0, 0, 0, 0)`);
              this.ctx.fillStyle = grad;

           } else {
              // Standard Fire: White -> Yellow -> Red -> Smoke
              const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
              
              if (progress < 0.2) {
                 grad.addColorStop(0, `rgba(255, 255, 255, ${particleAlpha})`);
                 grad.addColorStop(0.7, `rgba(255, 255, 200, ${particleAlpha * 0.9})`);
                 grad.addColorStop(1, `rgba(255, 200, 100, 0)`);
              } else if (progress < 0.6) {
                 grad.addColorStop(0, `rgba(255, 220, 50, ${particleAlpha})`);
                 grad.addColorStop(0.7, `rgba(255, 100, 0, ${particleAlpha * 0.9})`);
                 grad.addColorStop(1, `rgba(200, 50, 0, 0)`);
              } else {
                 grad.addColorStop(0, `rgba(255, 80, 0, ${particleAlpha * 0.95})`);
                 grad.addColorStop(1, `rgba(100, 50, 50, 0)`);
              }
              this.ctx.fillStyle = grad;
           }
           this.ctx.fill();
        }

        // Draw projectile cone logic removed - replaced entirely by particle stream
      } else if (vfx.type === 'kill_reward') {
          const bounty = vfx.data?.bounty || 0;
          const offsetY = (1 - alpha) * 30;
          this.ctx.fillStyle = '#fbbf24';
          this.ctx.font = 'bold 16px monospace';
          this.ctx.textAlign = 'center';
          this.ctx.strokeStyle = '#000000';
          this.ctx.lineWidth = 3;
          this.ctx.strokeText(`+${bounty}g`, x, y - offsetY);
          this.ctx.fillText(`+${bounty}g`, x, y - offsetY);
      }

      this.ctx.restore();
    }
  }

  private drawHUD(state: GameState): void {
    if (!this.ctx || !this.canvas) return;

    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '12px monospace';
    this.ctx.textAlign = 'left';

    const playerUnits = Array.from(state.entities.values()).filter(e => e.owner === 'PLAYER').length;
    const enemyUnits = Array.from(state.entities.values()).filter(e => e.owner === 'ENEMY').length;

    this.ctx.fillText(`Units: ${playerUnits} vs ${enemyUnits}`, 10, 20);
    this.ctx.fillText(
      `Health: ${Math.floor(state.playerBase.health)} vs ${Math.floor(state.enemyBase.health)}`,
      10,
      35
    );
  }
}
