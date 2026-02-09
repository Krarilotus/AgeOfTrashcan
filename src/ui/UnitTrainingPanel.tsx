import React, { useEffect, useMemo, useRef, useState } from 'react';
import { UNIT_DEFS } from '../GameEngine';
import { type TurretEngineDef } from '../config/turrets';
import { getAbilityDisplay, getAbilityText, getUnitName } from './unitDisplay';

type TurretCatalog = Record<string, TurretEngineDef>;

interface UnitTrainingPanelProps {
  gameState: any;
  onSpawnUnit: (unitId: string) => void;
  onQueueTurretEngine: (slotIndex: number, turretId: string) => void;
  onCancelQueueItem: (index: number) => void;
}

function getTurretCooldown(def: TurretCatalog[string]): number {
  if (def.attackType === 'chain_lightning') return def.chainLightning?.cooldownSeconds ?? def.fireIntervalSec;
  if (def.attackType === 'artillery_barrage') return def.artillery?.cooldownSeconds ?? def.fireIntervalSec;
  if (def.attackType === 'oil_pour') return def.oil?.cooldownSeconds ?? def.fireIntervalSec;
  if (def.attackType === 'drone_swarm') return def.drones?.cooldownSeconds ?? def.fireIntervalSec;
  if (def.attackType === 'flamethrower') return def.flamethrower?.cooldownSeconds ?? def.fireIntervalSec;
  if (def.attackType === 'laser_pulse') return def.laserPulse?.cooldownSeconds ?? def.fireIntervalSec;
  if (def.attackType === 'mana_siphon') return 1 / Math.max(1, def.manaSiphon?.ticksPerSecond ?? 1);
  if (def.attackType === 'mana_shield') return 0;
  return def.fireIntervalSec;
}

function getTurretAttackDamage(def: TurretCatalog[string]): string {
  if (def.attackType === 'projectile') {
    return `${def.projectile?.damage ?? 0}`;
  }
  if (def.attackType === 'chain_lightning') {
    return `${def.chainLightning?.initialDamage ?? 0} (first jump)`;
  }
  if (def.attackType === 'artillery_barrage') {
    return `${def.artillery?.shellDamage ?? 0} / shell`;
  }
  if (def.attackType === 'oil_pour') {
    const initial = def.oil?.initialDamage ?? Math.round((def.oil?.damage ?? 0) * 0.55);
    return `${initial}`;
  }
  if (def.attackType === 'drone_swarm') {
    return `${def.drones?.droneDamage ?? 0} / drone`;
  }
  if (def.attackType === 'flamethrower') {
    return `${def.flamethrower?.damage ?? 0} / burst`;
  }
  if (def.attackType === 'laser_pulse') {
    return `${def.laserPulse?.damage ?? 0} / pulse`;
  }
  if (def.attackType === 'mana_siphon') {
    const tick = def.manaSiphon?.tickDamage ?? 0;
    const tps = def.manaSiphon?.ticksPerSecond ?? 1;
    return `${tick} / tick @ ${tps}/s`;
  }
  if (def.attackType === 'mana_shield') {
    return '0 (support)';
  }
  return '0';
}

function getTurretSkillSummary(def: TurretCatalog[string]): string {
  if (def.attackType === 'chain_lightning' && def.chainLightning) {
    return `Chain lightning: ${def.chainLightning.maxTargets} jumps, ${def.chainLightning.initialDamage} base dmg`;
  }

  if (def.attackType === 'artillery_barrage' && def.artillery) {
    return `Artillery barrage: ${def.artillery.barrageCount} shells, ${def.artillery.shellDamage} dmg, ${def.artillery.shellRadius} radius`;
  }

  if (def.attackType === 'oil_pour' && def.oil) {
    const duration = def.oil.groundDurationSeconds ?? 2;
    const tps = def.oil.ticksPerSecond ?? 3;
    const initial = def.oil.initialDamage ?? Math.round(def.oil.damage * 0.55);
    const tickDmg = def.oil.dotDamagePerTick ?? Math.round(def.oil.damage * (def.oil.dotTickMultiplier ?? 0.25));
    const offset = def.oil.pourOffsetUnits ?? 5.5;
    const forward = def.oil.forwardReachUnits ?? def.oil.radius;
    const back = def.oil.backReachUnits ?? Math.max(0.6, def.oil.radius * 0.6);
    return `Oil pour: ${initial} initial dmg, DoT ${tickDmg}/tick @ ${tps}/s for ${duration}s, zone off ${offset} (fwd ${forward}, back ${back})`;
  }

  if (def.attackType === 'drone_swarm' && def.drones) {
    return `Drone swarm: ${def.drones.droneCount} drones, ${def.drones.droneDamage} dmg each`;
  }

  if (def.attackType === 'flamethrower' && def.flamethrower) {
    return `Flamethrower: ${def.flamethrower.damage} burst dmg in ${def.flamethrower.width ?? 2.8} width`;
  }

  if (def.attackType === 'laser_pulse' && def.laserPulse) {
    return `Laser pulse: ${def.laserPulse.damage} line dmg, infinite pierce on path`;
  }

  if (def.attackType === 'mana_siphon' && def.manaSiphon) {
    const leechPct = Math.round(def.manaSiphon.manaLeechFraction * 100);
    return `Mana siphon: strongest target, ${def.manaSiphon.tickDamage}/tick @ ${def.manaSiphon.ticksPerSecond}/s, returns ${leechPct}% as mana`;
  }

  if (def.attackType === 'mana_shield' && def.baseShield) {
    const ratioPct = Math.round(def.baseShield.damageToManaRatio * 100);
    return `Base mana shield: converts ${ratioPct}% incoming base dmg into mana drain (${def.baseShield.manaPerDamage} mana per dmg)`;
  }

  if (def.projectile?.splitOnImpact) {
    const split = def.projectile.splitOnImpact;
    return `Split impact: +${split.childCount} shards (${split.childDamage} dmg) in ${split.spreadRadius} radius`;
  }

  if (def.projectile?.pierceCount && def.projectile.pierceCount > 0) {
    return `Piercing shot: pierces ${def.projectile.pierceCount} extra targets`;
  }

  if (def.projectile?.splashRadius && def.projectile.splashRadius > 0) {
    return `Explosive shot: ${def.projectile.splashRadius} splash radius`;
  }

  return 'Single-target projectile';
}

export function UnitTrainingPanel({
  gameState,
  onSpawnUnit,
  onQueueTurretEngine,
  onCancelQueueItem,
}: UnitTrainingPanelProps) {
  const playerAge = gameState?.progression?.player?.age ?? 1;
  const [activeAge, setActiveAge] = useState<number>(playerAge);
  const [selectedTurretSlot, setSelectedTurretSlot] = useState<number>(0);
  const previousAgeRef = useRef<number>(playerAge);

  useEffect(() => {
    if (playerAge > previousAgeRef.current) {
      setActiveAge(playerAge);
    } else if (activeAge > playerAge) {
      setActiveAge(playerAge);
    }
    previousAgeRef.current = playerAge;
  }, [playerAge, activeAge]);

  const ageNames = ['Stone', 'Bronze', 'Iron', 'Steel', 'Industrial', 'Future'];
  const ageColors = ['#8B7355', '#CD7F32', '#B0B0B0', '#4682B4', '#FF6B35', '#00D4FF'];
  const availableAges = [1, 2, 3, 4, 5, 6].filter((age) => age <= playerAge);
  const unitsInActiveAge = Object.entries(UNIT_DEFS).filter(([_, def]) => (def.age ?? 1) === activeAge);

  const turretCatalog = (gameState?.turretCatalog ?? {}) as TurretCatalog;
  const turretEnginesInAge = useMemo(
    () => Object.entries(turretCatalog)
      .filter(([_, def]) => (def.age ?? 1) === activeAge)
      .sort((a, b) => (a[1].cost ?? 0) - (b[1].cost ?? 0)),
    [turretCatalog, activeAge]
  );

  const slotsUnlocked = gameState?.playerBase?.turretSlotsUnlocked ?? 1;
  const slots = gameState?.playerBase?.turretSlots ?? [];
  const maxSlots = gameState?.playerBase?.maxTurretSlots ?? 4;
  const playerGold = gameState?.economy?.player?.gold ?? 0;
  const playerMana = gameState?.economy?.player?.mana ?? 0;

  const firstEmptySlot = useMemo(() => {
    for (let i = 0; i < slotsUnlocked; i++) {
      if (!slots[i]?.turretId) return i;
    }
    return -1;
  }, [slots, slotsUnlocked]);

  useEffect(() => {
    if (selectedTurretSlot >= slotsUnlocked) {
      setSelectedTurretSlot(Math.max(0, slotsUnlocked - 1));
      return;
    }

    if (slots[selectedTurretSlot]?.turretId && firstEmptySlot >= 0) {
      setSelectedTurretSlot(firstEmptySlot);
    }
  }, [selectedTurretSlot, slotsUnlocked, slots, firstEmptySlot]);

  const selectedSlotOccupied = !!slots[selectedTurretSlot]?.turretId;
  const selectedSlotQueued = (gameState?.playerQueue ?? []).some(
    (q: any) => q.kind === 'turret_engine' && q.slotIndex === selectedTurretSlot
  );
  const canBuildInSelectedSlot = selectedTurretSlot < slotsUnlocked && !selectedSlotOccupied && !selectedSlotQueued;
  const selectedSlotStateLabel = selectedTurretSlot >= slotsUnlocked
    ? 'Locked'
    : selectedSlotOccupied
      ? 'Mounted'
      : selectedSlotQueued
        ? 'Queued'
        : 'Empty';

  return (
    <div className="training-scroll bg-slate-800 border border-slate-700 rounded-xl p-4 max-h-[500px] overflow-y-auto">
      <div className="text-sm text-slate-400 mb-3 flex justify-between items-center">
        <span>⚔️ Unit Training</span>
        <span className="text-xs">
          Build Time: {Math.floor((1 - (playerAge - 1) * 0.1) * 100)}%
          {playerAge > 1 && <span className="text-green-400"> ({(playerAge - 1) * 10}% faster)</span>}
        </span>
      </div>

      <div className="space-y-3">
        <div className="bg-slate-700 rounded-lg p-3">
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {availableAges.map((age) => {
              const isActive = age === activeAge;
              const ageColor = ageColors[age - 1];
              return (
                <button
                  key={age}
                  type="button"
                  onClick={() => setActiveAge(age)}
                  className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-bold transition-colors ${
                    isActive
                      ? 'bg-slate-800 border-slate-500'
                      : 'bg-slate-800/60 border-slate-700 hover:bg-slate-700 hover:border-slate-600'
                  }`}
                  style={{
                    color: ageColor,
                    boxShadow: isActive ? `inset 0 0 0 1px ${ageColor}55` : undefined,
                  }}
                  title={`Age ${age}: ${ageNames[age - 1]}`}
                >
                  Age {age} · {ageNames[age - 1]}
                </button>
              );
            })}
          </div>

          <div className="text-xs font-bold mb-2" style={{ color: ageColors[activeAge - 1] }}>
            Age {activeAge}: {ageNames[activeAge - 1]}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
            {unitsInActiveAge.map(([id, def]) => {
              const needsMana = (def.manaCost ?? 0) > 0;
              const disabled = playerGold < def.cost || (needsMana && playerMana < (def.manaCost ?? 0));
              const buildTimeMultiplier = Math.max(0.4, 1 - (playerAge - 1) * 0.1);
              const actualBuildTime = (((def.trainingMs ?? 1000) * buildTimeMultiplier) / 1000).toFixed(1);

              return (
                <button
                  key={id}
                  onClick={() => onSpawnUnit(id)}
                  className="bg-slate-800 hover:bg-slate-600 p-2 rounded text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed group"
                  disabled={disabled}
                  title={`${getUnitName(id)}\nHP: ${def.health} | DMG: ${def.damage} | SPD: ${def.speed}\nRange: ${def.range ?? 1} | Build: ${actualBuildTime}s${def.skill ? '\n' + getAbilityText(def.skill) : ''}${def.manaLeech ? `\nMana Leech: ${Math.round(def.manaLeech * 100)}%` : ''}${def.manaShield ? '\nMana Shield: Active' : ''}`}
                >
                  <div className="text-sm font-semibold truncate">{getUnitName(id)}</div>
                  <div className="text-xs text-slate-400 space-y-0.5">
                    <div>💰 {def.cost}g{needsMana ? ` ✨ ${def.manaCost}m` : ''}</div>
                    <div className="flex gap-2">
                      <span title="Health">❤️ {def.health}</span>
                      <span title="Damage">⚔️ {def.damage}</span>
                      <span title="Speed">🦶 {def.speed}</span>
                    </div>
                    <div className="flex gap-2">
                      <span title="Range">{(def.range ?? 1) > 1.5 ? '🏹' : '⚔️'} {def.range ?? 1}</span>
                      <span title="Build Time">⏱️ {actualBuildTime}s</span>
                    </div>
                    {def.skill && <div className="text-purple-400 text-xs">{getAbilityDisplay(def.skill)}</div>}
                    {def.manaLeech && <div className="text-blue-400 text-xs mt-1">💧 Mana Leech: {Math.round(def.manaLeech * 100)}%</div>}
                    {def.manaShield && <div className="text-cyan-400 text-xs mt-1">🛡️ Mana Shield</div>}
                    {def.burstFire && <div className="text-orange-400 text-xs mt-1">🔫 Burst: {def.burstFire.shots}x</div>}
                    {def.teleporter && <div className="text-pink-400 text-xs mt-1">🌌 Teleporter</div>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-slate-600 pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-300">🗼 Turret Engine Purchase Cards</div>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-slate-500">Slot:</span>
                {Array.from({ length: maxSlots }).map((_, idx) => {
                  const unlocked = idx < slotsUnlocked;
                  const occupied = !!slots[idx]?.turretId;
                  const queued = (gameState?.playerQueue ?? []).some(
                    (q: any) => q.kind === 'turret_engine' && q.slotIndex === idx
                  );
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => unlocked && setSelectedTurretSlot(idx)}
                      disabled={!unlocked}
                      className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                        selectedTurretSlot === idx ? 'border-cyan-400 bg-slate-700 text-cyan-200' : 'border-slate-600 bg-slate-900 text-slate-300'
                      } ${unlocked ? '' : 'opacity-50 cursor-not-allowed'}`}
                      title={unlocked ? (occupied ? 'Mounted' : queued ? 'Queued' : 'Empty') : 'Locked'}
                    >
                      S{idx + 1}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="text-[11px] text-slate-500 mb-2">
              Selected Slot S{selectedTurretSlot + 1}: {selectedSlotStateLabel}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {turretEnginesInAge.map(([turretId, turret]) => {
                const protectionPct = Math.round((1 - (turret.protectionMultiplier ?? 1)) * 100);
                const cooldown = getTurretCooldown(turret);
                const attackDamage = getTurretAttackDamage(turret);
                const turretManaCost = turret.manaCost ?? 0;
                const castManaCost = turret.castManaCost ?? 0;
                const requiresMana = turretManaCost > 0;
                const disabled = !canBuildInSelectedSlot || playerGold < turret.cost || (requiresMana && playerMana < turretManaCost);
                const skillSummary = getTurretSkillSummary(turret);
                return (
                  <button
                    key={turretId}
                    type="button"
                    onClick={() => onQueueTurretEngine(selectedTurretSlot, turretId)}
                    disabled={disabled}
                    className="bg-slate-800 hover:bg-slate-700 p-2 rounded text-left border border-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={`${turret.name}\nCost: ${turret.cost}g${requiresMana ? ` + ${turretManaCost}m` : ''}${castManaCost > 0 ? `\nAbility Mana: ${castManaCost}/cast` : ''}\nAttack Damage: ${attackDamage}\nCooldown: ${cooldown.toFixed(2)}s\nRange: ${turret.range}\nProtection Radius: ${turret.range}\nProtection: ${protectionPct}%\nSkill: ${skillSummary}\nTargeting: ${turret.targeting}\nBuild: ${(turret.buildMs / 1000).toFixed(1)}s\nQueue Target: Slot S${selectedTurretSlot + 1} (${selectedSlotStateLabel})`}
                  >
                    <div className="text-sm font-semibold truncate">{turret.name}</div>
                    <div className="text-xs text-slate-400 space-y-0.5">
                      <div>💰 {turret.cost}g{requiresMana ? ` ✨ ${turretManaCost}m` : ''} · ⏱️ {(turret.buildMs / 1000).toFixed(1)}s</div>
                      <div>⚔️ ATK {attackDamage} · 🕒 CD {cooldown.toFixed(2)}s</div>
                      {castManaCost > 0 && <div>🧪 Ability Mana {castManaCost}/cast</div>}
                      <div>🎯 Range {turret.range} · 🛡️ Protection {protectionPct}%</div>
                      <div>🧠 Targeting: {turret.targeting}</div>
                      <div className="text-purple-300">✨ Skill: {skillSummary}</div>
                    </div>
                    <div className="mt-2 text-[11px] text-cyan-300">
                      Queue on Slot S{selectedTurretSlot + 1}
                    </div>
                  </button>
                );
              })}
              {turretEnginesInAge.length === 0 && (
                <div className="text-xs text-slate-500">No turret engines available in this age yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 min-h-12 bg-slate-700 rounded p-2">
        {(gameState?.playerQueue?.length ?? 0) > 0 ? (
          <div className="flex items-center gap-2 text-sm text-slate-300">
            <span className="text-xs text-slate-400">Queue:</span>
            <div className="flex gap-1 flex-wrap">
              {(gameState?.playerQueue ?? []).map((q: any, i: number) => {
                const label = q.kind === 'unit' ? getUnitName(q.unitId) : (q.label ?? q.kind);
                return (
                  <button
                    key={i}
                    onClick={() => onCancelQueueItem(i)}
                    title="Click to cancel"
                    className="bg-slate-600 hover:bg-red-700 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
                  >
                    {label} {((q.remainingMs ?? 0) / 1000).toFixed(1)}s ✕
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">Queue empty</div>
        )}
      </div>
    </div>
  );
}

