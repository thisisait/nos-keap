interface TabsProps {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="flex gap-1 border-b border-white/20 bg-white/5 px-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={[
            'px-3 py-2 text-xs font-medium transition-colors',
            active === tab.id
              ? 'border-b-2 border-blue-600 text-blue-700'
              : 'text-slate-600 hover:text-slate-900',
          ].join(' ')}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
