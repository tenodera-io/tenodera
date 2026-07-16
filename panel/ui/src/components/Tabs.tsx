// Shared segmented-control tabs. Colours come from theme variables.
import React from 'react';

export interface TabDef {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  style?: React.CSSProperties;
}

export function Tabs({ tabs, active, onChange, style }: TabsProps) {
  return (
    <div className="seg-tabs" role="tablist" style={style}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`seg-tab${active === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.icon && <span className="seg-tab-icon">{t.icon}</span>}
          {t.label}
        </button>
      ))}
    </div>
  );
}
