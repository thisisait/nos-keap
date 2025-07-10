
import React from 'react';
import { cn } from '@/lib/utils';

interface PolygonCardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  variant?: 'trapezoid' | 'hexagon' | 'diamond';
  unlocked?: boolean;
  completed?: boolean;
}

export const PolygonCard: React.FC<PolygonCardProps> = ({
  children,
  className,
  onClick,
  variant = 'trapezoid',
  unlocked = true,
  completed = false
}) => {
  const getClipPath = () => {
    switch (variant) {
      case 'trapezoid':
        return 'polygon(10% 0%, 90% 0%, 100% 100%, 0% 100%)';
      case 'hexagon':
        return 'polygon(20% 0%, 80% 0%, 100% 50%, 80% 100%, 20% 100%, 0% 50%)';
      case 'diamond':
        return 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)';
      default:
        return 'polygon(10% 0%, 90% 0%, 100% 100%, 0% 100%)';
    }
  };

  return (
    <div
      className={cn(
        'relative cursor-pointer transition-all duration-300 transform hover:scale-105',
        'bg-gradient-to-br backdrop-blur-sm border',
        unlocked
          ? completed
            ? 'from-green-900/40 to-emerald-800/40 border-green-400/50 hover:from-green-800/50 hover:to-emerald-700/50'
            : 'from-purple-900/40 to-blue-900/40 border-purple-400/50 hover:from-purple-800/50 hover:to-blue-800/50'
          : 'from-gray-900/40 to-gray-800/40 border-gray-600/30 cursor-not-allowed opacity-60',
        className
      )}
      style={{
        clipPath: getClipPath(),
      }}
      onClick={unlocked ? onClick : undefined}
    >
      <div className="p-6 h-full">
        {children}
      </div>
      
      {!unlocked && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center"
             style={{ clipPath: getClipPath() }}>
          <div className="text-gray-400 text-center">
            <div className="w-8 h-8 mx-auto mb-2 opacity-50">🔒</div>
            <span className="text-sm">Locked</span>
          </div>
        </div>
      )}
      
      {completed && (
        <div className="absolute top-2 right-2 text-green-400">
          <div className="w-6 h-6">✓</div>
        </div>
      )}
    </div>
  );
};
