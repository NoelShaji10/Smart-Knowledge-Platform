'use client';

import React from 'react';
import { CollabUser } from '@/hooks/useCollaboration';
import { getUserInitials } from '@/lib/collab-colors';
import styles from './CollaboratorAvatars.module.css';

export interface CollaboratorAvatarsProps {
  users: CollabUser[];
  maxVisible?: number;
}

export function CollaboratorAvatars({ users, maxVisible = 5 }: CollaboratorAvatarsProps) {
  if (!users || users.length === 0) return null;

  const visibleUsers = users.slice(0, maxVisible);
  const overflowCount = users.length - maxVisible;
  const overflowUsers = overflowCount > 0 ? users.slice(maxVisible) : [];
  const overflowTooltip = overflowUsers.map((u) => u.name).join(', ');

  return (
    <div className={styles.avatarGroup} role="group" aria-label="Active collaborators">
      {visibleUsers.map((user) => {
        const initials = getUserInitials(user.name);
        const label = user.isCurrentUser ? `${user.name} (You)` : user.name;

        return (
          <div
            key={`${user.id}-${user.clientId}`}
            className={styles.avatarItem}
            style={{ backgroundColor: user.color }}
            title={label}
            aria-label={label}
          >
            {initials}
          </div>
        );
      })}

      {overflowCount > 0 && (
        <div
          className={styles.overflowBadge}
          title={`Other collaborators: ${overflowTooltip}`}
          aria-label={`${overflowCount} more collaborators`}
        >
          +{overflowCount}
        </div>
      )}
    </div>
  );
}
