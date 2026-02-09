import React from 'react';

import { UI_SYMBOLS } from './uiEmotes';

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD' | 'SMART' | 'CHEATER';

interface StartScreenProps {
  difficulty: Difficulty;
  hasSavedGame: boolean;
  onStartNewGame: () => void;
  onContinueGame: () => void;
  onDifficultyChange: (difficulty: Difficulty) => void;
  onClearSavedGame: () => void;
}

export function StartScreen({
  difficulty,
  hasSavedGame,
  onStartNewGame,
  onContinueGame,
  onDifficultyChange,
  onClearSavedGame,
}: StartScreenProps) {
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-4xl font-bold bg-gradient-to-r from-amber-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
        Age of War: Transcended
      </div>
      <div className="text-slate-400 text-center max-w-lg">
        Command armies across 6 ages of warfare. From Stone Age clubmen to futuristic mechs.
        <br />
        <br />
        <span className="text-sm">Spawn units {UI_SYMBOLS.bullet} Upgrade your base {UI_SYMBOLS.bullet} Advance through ages {UI_SYMBOLS.bullet} Destroy the enemy</span>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 w-full max-w-md">
        <div className="text-lg font-semibold mb-4 text-center">Select Difficulty</div>
        <div className="grid grid-cols-3 gap-3">
          {(['EASY', 'MEDIUM', 'HARD', 'SMART', 'CHEATER'] as const).map((diff) => (
            <button
              key={diff}
              onClick={() => onDifficultyChange(diff)}
              className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                difficulty === diff
                  ? 'bg-gradient-to-r from-amber-500 to-purple-500 text-white'
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
              }`}
            >
              {diff === 'EASY' && 'Easy'}
              {diff === 'MEDIUM' && 'Medium'}
              {diff === 'HARD' && 'Hard'}
              {diff === 'SMART' && 'Smart'}
              {diff === 'CHEATER' && 'Cheater'}
            </button>
          ))}
        </div>
        <div className="mt-4 text-sm text-slate-400 text-center">
          {difficulty === 'EASY' && 'Basic reactive AI with no discounts.'}
          {difficulty === 'MEDIUM' && 'Balanced AI with moderate discounts and income.'}
          {difficulty === 'HARD' && 'Balanced AI with stronger economy and discounts.'}
          {difficulty === 'SMART' && 'Hierarchical planner AI with proactive wave + turret strategy.'}
          {difficulty === 'CHEATER' && 'Ruthless AI with extreme economy and pressure.'}
        </div>
      </div>

      <button
        onClick={onStartNewGame}
        className="mt-2 bg-gradient-to-r from-amber-500 to-purple-500 hover:from-amber-600 hover:to-purple-600 text-white text-lg px-8 py-4 rounded-lg font-semibold transition-all"
      >
        Play New Game
      </button>

      {hasSavedGame && (
        <>
          <button
            onClick={onContinueGame}
            className="bg-blue-700 hover:bg-blue-600 text-white text-lg px-8 py-3 rounded-lg font-semibold transition-all"
          >
            Continue Saved Game
          </button>
          <button
            onClick={onClearSavedGame}
            className="bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm px-4 py-2 rounded-lg transition-all"
          >
            Clear Saved Game
          </button>
        </>
      )}
    </div>
  );
}
