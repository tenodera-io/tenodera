// Standard page header: sidebar-matching icon + title on the left,
// optional actions on the right. Consistent spacing across all pages.
import React from 'react';
import { Icon, type IconName } from './Icons.tsx';

interface PageHeaderProps {
  icon: IconName;
  title: string;
  actions?: React.ReactNode;
}

export function PageHeader({ icon, title, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <span className="page-header-icon"><Icon name={icon} size={22} /></span>
      <h1 className="page-header-title">{title}</h1>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
