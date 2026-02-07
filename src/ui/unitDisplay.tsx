import React from 'react';

export function getUnitName(unitId: string): string {
  const names: Record<string, string> = {
    stone_clubman: 'Clubman',
    stone_slinger: 'Slinger',
    stone_dino: 'War Dino',
    bronze_spearman: 'Spearman',
    bronze_archer: 'Archer',
    bronze_catapult: 'Catapult',
    iron_knight: 'Knight',
    iron_mage: 'Mage',
    iron_crossbow: 'Crossbow',
    war_elephant: 'Elephant',
    battle_monk: 'Monk',
    steel_tank: 'Tank',
    artillery: 'Artillery',
    medic: 'Medic',
    heavy_cavalry: 'Heavy Cavalry',
    siege_engineer: 'Siege Engineer',
    gunner: 'Gunner',
    pyro_maniac: 'Pyro',
    energy_shield: 'Shield',
    flamethrower: 'Flamethrower',
    steam_mech: 'Steam Mech',
    sniper: 'Sniper',
    mana_vampire: 'Mana Vampire',
    robot_soldier: 'Robot',
    laser_trooper: 'Laser',
    mech_walker: 'Mech',
    plasma_striker: 'Plasma',
    nanoswarm: 'Nanoswarm',
    titan_mech: 'Titan Mech',
    cyber_assassin: 'Cyber Assassin',
    dark_cultist: 'Dark Cultist',
  };

  return names[unitId] ?? unitId;
}

export function getAbilityDisplay(skill: any): React.ReactNode {
  if (!skill) return null;

  const cooldownSec = (skill.cooldownMs / 1000).toFixed(1);
  const manaCost = skill.manaCost;

  if (skill.power < 0) {
    return (
      <div className="flex flex-col leading-tight mt-1">
        <div>💚 Heal {Math.abs(skill.power)} HP</div>
        <div className="text-[10px] opacity-80">Cost: {manaCost}m | CD: {cooldownSec}s</div>
      </div>
    );
  }

  if (skill.type === 'aoe') {
    const damage = skill.damage ?? 0;
    const radius = skill.radius ?? skill.power;
    const range = skill.range ?? 6;

    return (
      <div className="flex flex-col leading-tight mt-1">
        <div>💥 AOE: {damage} Dmg</div>
        <div className="text-[10px] opacity-80">Rng: {range} | Rad: {radius}</div>
        <div className="text-[10px] opacity-80">Cost: {manaCost}m | CD: {cooldownSec}s</div>
      </div>
    );
  }

  if (skill.type === 'flamethrower') {
    const dps = (skill.power * (1000 / skill.cooldownMs)).toFixed(0);
    const manaPerSec = (skill.manaCost * (1000 / skill.cooldownMs)).toFixed(0);

    return (
      <div className="flex flex-col leading-tight mt-1">
        <div>🔥 Flame: {dps} DPS</div>
        <div className="text-[10px] opacity-80">Rng: {skill.range ?? 6} | {manaPerSec} mana/s</div>
      </div>
    );
  }

  const damage = skill.power;
  const range = skill.range ?? 5;

  return (
    <div className="flex flex-col leading-tight mt-1">
      <div>🎯 Strike: {damage} Dmg</div>
      <div className="text-[10px] opacity-80">Rng: {range} | Cost: {manaCost}m | CD: {cooldownSec}s</div>
    </div>
  );
}

export function getAbilityText(skill: any): string {
  if (!skill) return '';

  const cooldownSec = (skill.cooldownMs / 1000).toFixed(1);

  if (skill.power < 0) {
    return `💚 Heal ${Math.abs(skill.power)} HP (Cost: ${skill.manaCost}m, CD: ${cooldownSec}s)`;
  }
  if (skill.type === 'aoe') {
    return `💥 AOE: ${skill.damage ?? 0} Dmg (Rad: ${skill.radius ?? skill.power}, Rng: ${skill.range ?? 6}, Cost: ${skill.manaCost}m, CD: ${cooldownSec}s)`;
  }
  if (skill.type === 'flamethrower') {
    return `🔥 Flamethrower (Range: ${skill.range}, Dmg: ${skill.power}/tick, Rate: ${(1000 / skill.cooldownMs).toFixed(0)}/s)`;
  }

  return `🎯 Strike: ${skill.power} Dmg (Rng: ${skill.range ?? 5}, Cost: ${skill.manaCost}m, CD: ${cooldownSec}s)`;
}
