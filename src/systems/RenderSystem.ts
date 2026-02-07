import { GameState, Entity, Projectile } from '../GameEngine';
import { MANA_POOL_VISUALS, TURRET_VISUALS, pixelsToUnits, unitsToPixels } from '../config/renderConfig';
import { TURRET_ABILITY_CONFIG } from '../config/turretConfig';
import { UNIT_DEFS } from '../config/units';

export class RenderSystem {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement>;
  private manaPoolSprites: Map<number, HTMLImageElement> = new Map();
  private missingManaPoolWarnings: Set<number> = new Set();
  private baseSprites: Map<string, HTMLImageElement> = new Map();
  private turretSprites: Map<string, HTMLImageElement> = new Map();
  // Keep original procedural visuals as source-of-truth during refactor.
  private readonly useStructureSprites = false;

  constructor(
    ctx: CanvasRenderingContext2D, 
    canvas: HTMLCanvasElement, 
    unitSprites: Map<string, HTMLImageElement | HTMLCanvasElement>
  ) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.unitSprites = unitSprites;
    this.loadManaPoolSprites();
    if (this.useStructureSprites) {
      this.loadStructureSprites();
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

  private loadStructureSprites(): void {
    const sides: Array<'player' | 'enemy'> = ['player', 'enemy'];
    for (const side of sides) {
      for (let age = 1; age <= 7; age++) {
        const img = new Image();
        const key = `${side}_age_${age}`;
        img.onload = () => {
          this.baseSprites.set(key, img);
        };
        img.src = `/base/${side}_age_${age}.svg`;
      }
    }

    for (const side of sides) {
      for (let level = 1; level <= 10; level++) {
        const img = new Image();
        const key = `${side}_level_${level}`;
        img.onload = () => {
          this.turretSprites.set(key, img);
        };
        img.src = `/tower/${side}_level_${level}.svg`;
      }
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

  // Helper to match GameEngine static methods
  // We can import these from config/renderConfig directly if they match
  // The GameEngine ones just wrapped the config ones.
  // GameEngine.getTurretSize was: TURRET_VISUALS.BASE_SIZE + turretLevel * TURRET_VISUALS.SIZE_PER_LEVEL
  private getTurretSize(turretLevel: number): number {
    return TURRET_VISUALS.BASE_SIZE + turretLevel * TURRET_VISUALS.SIZE_PER_LEVEL;
  }
  
  private getCannonOffsetRatio(turretLevel: number): number {
    if (turretLevel >= 7) return 0.6;
    if (turretLevel >= 4) return 0.5;
    return 0.4;
  }

  private getTurretScreenPosition(baseX: number, baseY: number, age: number): { x: number; y: number } {
    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const turretY = baseY - dims.height - 5; 
    return { x: baseX, y: turretY };
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
    
    const turretLevel = base.turretLevel;
    const color1 = isPlayer ? '#3b82f6' : '#ef4444';
    const color2 = isPlayer ? '#1e40af' : '#991b1b';
    const color3 = isPlayer ? '#60a5fa' : '#f87171';

    // Draw cellar/well first so base geometry sits naturally above it.
    this.drawManaPool(x, y, age, manaLevel, isPlayer);

    // Age-progressive designs
    const drewBaseSprite = this.useStructureSprites && this.drawBaseStructureSprite(x, y, age, isPlayer);
    if (!drewBaseSprite && age === 1) { // Stone Age
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
    } else if (!drewBaseSprite && age === 2) { // Tool Age
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
    } else if (!drewBaseSprite && age === 3) { // Bronze Age
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
    } else if (!drewBaseSprite && age === 4) { // Iron Age
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
    } else if (!drewBaseSprite && age === 5) { // Castle Age
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
    } else if (!drewBaseSprite && age === 6) { // Renaissance
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
    } else if (!drewBaseSprite) { // Modern Age (7)
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

    // Check for Active Barrage Effect
    const isBarrageActive = (vfx || []).some(v => 
        v.type === 'ability_cast' && 
        v.data?.turretAbility === 'artillery_barrage' && 
        Math.abs(v.x - base.x) < 5 // Check if this effect belongs to this base
    );

    // TURRET (Level 0 stays clean: no turret rendered)
    if (turretLevel > 0) {
      const drewTurretSprite = this.useStructureSprites && this.drawTurretStructureSprite(x, y, age, turretLevel, isPlayer, isBarrageActive);
      if (!drewTurretSprite) {
        const turretScreenPos = this.getTurretScreenPosition(x, y, age);
        const turretSize = this.getTurretSize(turretLevel);
        const piercingLv = TURRET_ABILITY_CONFIG.PIERCING_SHOT.requiredLevel;
        const chainLv = TURRET_ABILITY_CONFIG.CHAIN_LIGHTNING.requiredLevel;
        const barrageLv = TURRET_ABILITY_CONFIG.ARTILLERY_BARRAGE.requiredLevel;
      
        // Draw reinforced platform and support collar.
        const platformW = turretSize * 2 + 8 + turretLevel;
        const platformH = 9;
        this.ctx.fillStyle = color2;
        this.ctx.beginPath();
        this.ctx.roundRect(
          turretScreenPos.x - platformW / 2,
          turretScreenPos.y,
          platformW,
          platformH,
          4
        );
        this.ctx.fill();
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
      
        this.ctx.fillStyle = isPlayer ? '#93c5fd' : '#fca5a5';
        this.ctx.globalAlpha = 0.2;
        this.ctx.beginPath();
        this.ctx.arc(turretScreenPos.x, turretScreenPos.y + 4, 5 + turretLevel * 0.5, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.globalAlpha = 1.0;

        // Side braces and per-level rivets to show progression at every level.
        if (turretLevel >= 2) {
          this.ctx.fillStyle = '#334155';
          this.ctx.fillRect(turretScreenPos.x - platformW / 2 + 2, turretScreenPos.y + 1, 4, platformH - 2);
          this.ctx.fillRect(turretScreenPos.x + platformW / 2 - 6, turretScreenPos.y + 1, 4, platformH - 2);
        }
        this.ctx.fillStyle = '#0f172a';
        for (let i = 0; i < turretLevel; i++) {
          const px = turretScreenPos.x - platformW / 2 + 8 + i * ((platformW - 16) / Math.max(1, turretLevel - 1));
          this.ctx.fillRect(px, turretScreenPos.y + platformH - 2, 2, 2);
        }

        this.ctx.save();
      
        // Determine Cannon Rotation
        let rotation = 0;
        if (isBarrageActive) {
            // Point UP with recoil jitter (UP is -PI/2 for both sides)
            const jitter = (Math.random() - 0.5) * 0.1;
            rotation = -Math.PI / 2 + jitter; 
        } else {
            // Standard angle (slightly up towards enemy)
            // Player: Face Right (-0.1 rad)
            // Enemy: Face Left (PI + 0.1 rad)
            rotation = isPlayer ? -0.1 : Math.PI + 0.1;
        }
      
        // Translate to pivot point
        this.ctx.translate(turretScreenPos.x, turretScreenPos.y + 4);
        this.ctx.rotate(rotation);

        const barrelLen = 14 + turretLevel * 1.7;
        const barrelHalfH = Math.max(4.5, 4 + turretLevel * 0.3);

      // Main cannon body.
      this.ctx.fillStyle = turretLevel >= 7 ? (isPlayer ? '#cbd5e1' : '#fda4af') : isPlayer ? '#60a5fa' : '#f87171';
      this.ctx.beginPath();
      this.ctx.moveTo(-8, -barrelHalfH);
      this.ctx.lineTo(barrelLen, -barrelHalfH + 1);
      this.ctx.lineTo(barrelLen, barrelHalfH - 1);
      this.ctx.lineTo(-8, barrelHalfH);
      this.ctx.lineTo(-12, 0);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.strokeStyle = '#111827';
      this.ctx.lineWidth = 1;
      this.ctx.stroke();

      // Extra sleeves by level to show continuous upgrades.
      if (turretLevel >= 3) {
        this.ctx.fillStyle = '#334155';
        this.ctx.fillRect(4, -barrelHalfH - 1, 6 + turretLevel * 0.4, (barrelHalfH + 1) * 2);
      }
      if (turretLevel >= 6) {
        this.ctx.fillStyle = '#0f172a';
        this.ctx.fillRect(10, -2, barrelLen - 14, 4);
      }

      // Every level adds an accent stripe on top of the cannon.
      this.ctx.strokeStyle = isPlayer ? 'rgba(186,230,253,0.45)' : 'rgba(254,205,211,0.45)';
      for (let i = 0; i < turretLevel; i++) {
        const sx = -2 + i * ((barrelLen - 2) / Math.max(1, turretLevel));
        this.ctx.beginPath();
        this.ctx.moveTo(sx, -barrelHalfH - 0.5);
        this.ctx.lineTo(Math.min(sx + 2, barrelLen), -barrelHalfH - 0.5);
        this.ctx.stroke();
      }

      // Ability attachments.
      if (turretLevel >= piercingLv) {
        // Piercing attachment: hardened spear-tip muzzle.
        this.ctx.fillStyle = '#f8fafc';
        this.ctx.beginPath();
        this.ctx.moveTo(barrelLen, -3);
        this.ctx.lineTo(barrelLen + 9, 0);
        this.ctx.lineTo(barrelLen, 3);
        this.ctx.closePath();
        this.ctx.fill();
      }
      if (turretLevel >= chainLv) {
        // Chain attachment: lightning rod and capacitor orb.
        this.ctx.strokeStyle = '#67e8f9';
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(2, -barrelHalfH - 1);
        this.ctx.lineTo(2, -barrelHalfH - 10);
        this.ctx.stroke();
        this.ctx.fillStyle = '#22d3ee';
        this.ctx.beginPath();
        this.ctx.arc(2, -barrelHalfH - 11, 2.5, 0, Math.PI * 2);
        this.ctx.fill();
      }
      if (turretLevel >= barrageLv) {
        // Artillery attachment: triple micro-launch pods.
        this.ctx.fillStyle = '#9ca3af';
        for (let i = 0; i < 3; i++) {
          const px = 6 + i * 5;
          this.ctx.fillRect(px, -barrelHalfH - 6, 3, 5);
          this.ctx.fillStyle = '#111827';
          this.ctx.fillRect(px + 0.5, -barrelHalfH - 6, 2, 2);
          this.ctx.fillStyle = '#9ca3af';
        }
      }
      
        this.ctx.restore();
      }
    }

    // RANGE CIRCLE
    if (turretLevel > 0) {
      const baseRange = 10;
      const rangeBonus = turretLevel <= 3 ? turretLevel * 4 : 
                         turretLevel <= 6 ? 12 + (turretLevel - 3) * 2 :
                         18 + (turretLevel - 6) * 1;
      const maxRange = battlefieldWidth / 2;
      const turretRange = Math.min(baseRange + rangeBonus, maxRange);
      const rangePixels = (turretRange / battlefieldWidth) * this.canvas.width;
      
      this.ctx.strokeStyle = isPlayer ? 'rgba(96, 165, 250, 0.3)' : 'rgba(248, 113, 113, 0.3)';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([5, 5]);
      this.ctx.beginPath();
      this.ctx.arc(x, y, rangePixels, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
  }

  private drawBaseStructureSprite(baseX: number, baseY: number, age: number, isPlayer: boolean): boolean {
    const side = isPlayer ? 'player' : 'enemy';
    const sprite = this.baseSprites.get(`${side}_age_${age}`);
    if (!sprite || !sprite.complete || sprite.naturalHeight <= 0) return false;

    const dims = TURRET_VISUALS.BASE_DIMENSIONS[age - 1] || TURRET_VISUALS.BASE_DIMENSIONS[0];
    const drawWidth = dims.width;
    const drawHeight = dims.height;
    this.ctx.drawImage(sprite, baseX - drawWidth / 2, baseY - drawHeight, drawWidth, drawHeight);
    return true;
  }

  private drawTurretStructureSprite(
    baseX: number,
    baseY: number,
    age: number,
    turretLevel: number,
    isPlayer: boolean,
    isBarrageActive: boolean
  ): boolean {
    // Keep original barrage pointing behavior from procedural path for parity.
    if (isBarrageActive) return false;

    const side = isPlayer ? 'player' : 'enemy';
    const normalizedLevel = Math.min(Math.max(turretLevel, 1), 10);
    const sprite = this.turretSprites.get(`${side}_level_${normalizedLevel}`);
    if (!sprite || !sprite.complete || sprite.naturalHeight <= 0) return false;

    const turretScreenPos = this.getTurretScreenPosition(baseX, baseY, age);
    const turretSize = this.getTurretSize(turretLevel);
    const drawWidth = turretSize * 2.5;
    const drawHeight = turretSize * 1.9;
    const drawX = turretScreenPos.x - drawWidth / 2;
    const drawY = turretScreenPos.y - drawHeight + 14;

    this.ctx.save();
    this.ctx.globalAlpha = 0.98;
    this.ctx.drawImage(sprite, drawX, drawY, drawWidth, drawHeight);
    this.ctx.globalAlpha = 1.0;

    if (isBarrageActive) {
      const pulse = 0.35 + Math.random() * 0.25;
      this.ctx.fillStyle = isPlayer ? `rgba(96,165,250,${pulse})` : `rgba(248,113,113,${pulse})`;
      this.ctx.beginPath();
      this.ctx.ellipse(turretScreenPos.x, turretScreenPos.y + 1, 9, 4, 0, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();
    return true;
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
        this.ctx.fillStyle = '#ff4400';
        this.ctx.beginPath();
        // Smaller than normal (Radius 2x5)
        this.ctx.ellipse(x, y, 2, 5, 0, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Trail
        this.ctx.fillStyle = 'rgba(255, 100, 0, 0.4)';
        this.ctx.beginPath();
        this.ctx.ellipse(x, y - 6, 1.5, 4, 0, 0, Math.PI * 2);
        this.ctx.fill();
        continue;
      }

      if (p.id > 200000) {
        // Turret
        this.ctx.fillStyle = p.owner === 'PLAYER' ? '#fbbf24' : '#f87171';
        this.ctx.beginPath();
        this.ctx.arc(x, y, 6, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = p.owner === 'PLAYER' ? 'rgba(251, 191, 36, 0.8)' : 'rgba(248, 113, 113, 0.8)';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
        
        this.ctx.globalAlpha = 0.5;
        this.ctx.fillStyle = p.owner === 'PLAYER' ? '#fbbf24' : '#f87171';
        this.ctx.beginPath();
        this.ctx.arc(x - p.vx * 0.05, y - p.vy * 0.05, 4, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.globalAlpha = 1.0;
      } else {
        // Unit
        this.ctx.fillStyle = p.owner === 'PLAYER' ? '#fef08a' : '#fca5a5';
        this.ctx.beginPath();
        this.ctx.arc(x, y, 4, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
  }

  private drawVFX(state: GameState, battlefieldWidth: number): void {
    for (const vfx of state.vfx) {
      const x = (vfx.x / battlefieldWidth) * this.canvas.width;
      const y = this.canvas.height / 2 + (vfx.y * 15);
      const alpha = vfx.lifeMs / (vfx.type === 'kill_reward' ? 800 : vfx.type === 'ability_cast' ? 600 : 1000);
      
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
