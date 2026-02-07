import React, { useEffect, useRef, useState } from 'react';
import { UNIT_DEFS } from '../GameEngine';
import { getAbilityDisplay, getAbilityText, getUnitName } from './unitDisplay';

interface UnitTrainingPanelProps {
  gameState: any;
  onSpawnUnit: (unitId: string) => void;
  onCancelQueueItem: (index: number) => void;
}

export function UnitTrainingPanel({ gameState, onSpawnUnit, onCancelQueueItem }: UnitTrainingPanelProps) {
  const playerAge = gameState?.progression?.player?.age ?? 1;
  const [activeAge, setActiveAge] = useState<number>(playerAge);
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

  return (
    <div className="training-scroll bg-slate-800 border border-slate-700 rounded-xl p-4 max-h-[450px] overflow-y-auto">
      <div className="text-sm text-slate-400 mb-3 flex justify-between items-center">
        <span>⚔️ Unit Training</span>
        <span className="text-xs">
          Build Time: {Math.floor((1 - (playerAge - 1) * 0.1) * 100)}%
          {playerAge > 1 && (
            <span className="text-green-400"> ({(playerAge - 1) * 10}% faster)</span>
          )}
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {unitsInActiveAge.map(([id, def]) => {
              const playerGold = gameState?.economy?.player?.gold ?? 0;
              const playerMana = gameState?.economy?.player?.mana ?? 0;
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
                    {def.manaLeech && (
                      <div className="text-blue-400 text-xs mt-1">💧 Mana Leech: {Math.round(def.manaLeech * 100)}%</div>
                    )}
                    {def.manaShield && <div className="text-cyan-400 text-xs mt-1">🛡️ Mana Shield</div>}
                    {def.burstFire && (
                      <div className="text-orange-400 text-xs mt-1">🔫 Burst: {def.burstFire.shots}x</div>
                    )}
                    {def.teleporter && <div className="text-pink-400 text-xs mt-1">🌌 Teleporter</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 min-h-12 bg-slate-700 rounded p-2">
        {(gameState?.playerQueue?.length ?? 0) > 0 ? (
          <div className="flex items-center gap-2 text-sm text-slate-300">
            <span className="text-xs text-slate-400">Queue:</span>
            <div className="flex gap-1 flex-wrap">
              {(gameState?.playerQueue ?? []).map((q: any, i: number) => (
                <button
                  key={i}
                  onClick={() => onCancelQueueItem(i)}
                  title="Click to cancel"
                  className="bg-slate-600 hover:bg-red-700 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
                >
                  {getUnitName(q.unitId)} {((q.remainingMs ?? 0) / 1000).toFixed(1)}s ✕
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">Queue empty</div>
        )}
      </div>
    </div>
  );
}
