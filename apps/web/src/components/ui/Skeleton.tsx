'use client';

import React from 'react';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

export function Skeleton({ width, height, borderRadius, className = '' }: SkeletonProps) {
  const inlineStyle: React.CSSProperties = {};
  if (width !== undefined) inlineStyle.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) inlineStyle.height = typeof height === 'number' ? `${height}px` : height;
  if (borderRadius !== undefined)
    inlineStyle.borderRadius = typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius;

  return (
    <span
      className={`${styles.skeleton} ${className}`.trim()}
      style={inlineStyle}
      aria-hidden="true"
    />
  );
}
