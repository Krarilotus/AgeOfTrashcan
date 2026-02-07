import React from 'react';

interface GameOverOverlayProps {
  winner: 'PLAYER' | 'ENEMY';
  onPlayAgain: () => void;
}

export function GameOverOverlay({ winner, onPlayAgain }: GameOverOverlayProps) {
  return (
    <div className="absolute inset-0 bg-black/90 flex items-center justify-center overflow-hidden">
      {winner === 'PLAYER' && (
        <div className="absolute inset-0 pointer-events-none">
          {[...Array(50)].map((_, i) => (
            <div
              key={i}
              className="absolute animate-fall"
              style={{
                left: `${Math.random() * 100}%`,
                top: '-20px',
                animationDelay: `${Math.random() * 3}s`,
                animationDuration: `${2 + Math.random() * 2}s`,
              }}
            >
              <div
                className="w-3 h-3 opacity-80"
                style={{
                  backgroundColor: ['#fbbf24', '#a855f7', '#22c55e', '#3b82f6', '#ef4444'][
                    Math.floor(Math.random() * 5)
                  ],
                  transform: `rotate(${Math.random() * 360}deg)`,
                }}
              />
            </div>
          ))}
        </div>
      )}
      {winner !== 'PLAYER' && (
        <div className="absolute inset-0 pointer-events-none">
          {[...Array(30)].map((_, i) => (
            <div
              key={i}
              className="absolute animate-fall-slow"
              style={{
                left: `${Math.random() * 100}%`,
                top: '-20px',
                animationDelay: `${Math.random() * 2}s`,
                animationDuration: `${3 + Math.random() * 2}s`,
              }}
            >
              <div className="w-2 h-2 bg-red-900/50 rounded-full" style={{ filter: 'blur(1px)' }} />
            </div>
          ))}
        </div>
      )}
      <div className="bg-slate-800 border-4 border-slate-600 p-12 rounded-2xl text-center relative z-10 animate-scale-in">
        <h2 className="text-6xl mb-8 font-bold">
          {winner === 'PLAYER' ? (
            <span className="text-green-400 animate-pulse-slow">Victory!</span>
          ) : (
            <span className="text-red-400 animate-shake">Defeat</span>
          )}
        </h2>
        <p className="text-slate-400 mb-8 text-lg">
          {winner === 'PLAYER'
            ? 'You have conquered your enemy and brought peace to the realm!'
            : 'Your base has fallen. Regroup and try again!'}
        </p>
        <button
          onClick={onPlayAgain}
          className="bg-gradient-to-r from-amber-500 to-purple-500 hover:from-amber-600 hover:to-purple-600 text-white px-8 py-4 rounded-lg font-semibold text-xl transition-all hover:scale-105"
        >
          Play Again
        </button>
      </div>
    </div>
  );
}