/**
 * Render Configuration and Constants
 * 
 * Central place for all rendering-related constants and conversion functions.
 * Separating this prevents hardcoded "magic numbers" in the Game Engine.
 */

// Core rendering constants
export const RENDER_CONFIG = {
  // Scaling factor: How many pixels represent one logical game unit (meter)
  PIXELS_PER_GAME_UNIT: 15,
  
  // Default canvas dimensions (can be responsive, but these are base aspect ratios)
  DEFAULT_WIDTH: 800,
  DEFAULT_HEIGHT: 600,
  
  // Lane positions (relative to canvas height or absolute)
  LANE_Y_OFFSET: 0, // Vertical offset for lanes
  
  // UI Layer Z-indices
  Z_INDEX: {
    BACKGROUND: 0,
    UNITS_HIND: 10,
    BASE: 20,
    UNITS_FORE: 30,
    PROJECTILES: 40,
    UI_OVERLAY: 100,
  },
  
  // Visual effect settings
  FX: {
    DAMAGE_TEXT_DURATION_MS: 1000,
    PROJECTILE_TRAIL_LENGTH: 10,
  }
};

export const TURRET_VISUALS = {
  BASE_DIMENSIONS: [
    { width: 35, height: 30 }, // Age 1
    { width: 38, height: 32 }, // Age 2
    { width: 35, height: 35 }, // Age 3
    { width: 36, height: 40 }, // Age 4
    { width: 40, height: 42 }, // Age 5
    { width: 42, height: 45 }, // Age 6
    { width: 45, height: 48 }, // Age 7
  ],
  BASE_SIZE: 12,
  SIZE_PER_LEVEL: 1.5,
  PLATFORM_OFFSET_UNITS: 0.3,
};

/**
 * Converts screen pixels to logical game units
 */
export const pixelsToUnits = (pixels: number): number => {
  return pixels / RENDER_CONFIG.PIXELS_PER_GAME_UNIT;
};

/**
 * Converts logical game units to screen pixels
 */
export const unitsToPixels = (units: number): number => {
  return units * RENDER_CONFIG.PIXELS_PER_GAME_UNIT;
};

// Map of asset paths to ensure centralized asset management
export const ASSET_PATHS = {
  SPRITES: 'assets/sprites/',
  AUDIO: 'assets/audio/',
  UI: 'assets/ui/',
};
