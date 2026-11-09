import React, { ReactNode } from 'react';
import styles from './StatsCard.module.css';

export interface StatsCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon?: ReactNode;
  badge?: string;
}

export function StatsCard({ label, value, subtext, icon, badge }: StatsCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.leftSection}>
        {icon && <div className={styles.iconWrapper} aria-hidden="true">{icon}</div>}
        <div className={styles.info}>
          <div className={styles.valueRow}>
            <span className={styles.value}>{value}</span>
            {badge && <span className={styles.badge}>{badge}</span>}
          </div>
          <span className={styles.label}>{label}</span>
          {subtext && <span className={styles.subtext}>{subtext}</span>}
        </div>
      </div>
    </div>
  );
}

