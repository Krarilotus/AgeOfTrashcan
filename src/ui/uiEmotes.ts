/**
 * Centralized UI emotes/symbols.
 *
 * Keep this file as the single source of truth for emoji/symbol literals used in UI text.
 * This reduces the risk of encoding regressions across many files.
 */
export const UI_EMOTES = Object.freeze({
  audioOn: '🔊',
  audioOff: '🔇',
  pause: '⏸',
  resume: '▶',
  save: '💾',
  load: '📂',
  restart: '🔄',
  error: '❌',
  warning: '⚠️',
  gold: '💰',
  mana: '✨',
  heal: '💚',
  unlocked: '✅',
  unlockSlot: '🔩',
  ageUp: '⬆️',
  unitTraining: '⚔️',
  health: '❤️',
  speed: '🦶',
  ranged: '🏹',
  manaLeech: '💧',
  shield: '🛡️',
  burst: '🔫',
  teleporter: '🌌',
  turretEngine: '🗼',
  buildTime: '⏱️',
  cooldown: '🕒',
  abilityMana: '🧪',
  targeting: '🧠',
  strike: '🎯',
  aoe: '💥',
  flame: '🔥',
} as const);

export const UI_SYMBOLS = Object.freeze({
  bullet: '•',
  times: '✕',
  arrowRight: '→',
  middleDot: '·',
} as const);
