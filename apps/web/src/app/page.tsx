'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button } from '@/components/ui';

export default function Home() {
  const router = useRouter();
  const { user, loading: authLoading, isNetworkError, error, clearError } = useAuth();
  const { refreshWorkspaces } = useWorkspace();

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      if (!isNetworkError) {
        router.replace('/login');
      }
      return;
    }

    async function redirectUser() {
      try {
        const workspaces = await refreshWorkspaces();
        if (workspaces.length === 0) {
          router.replace('/workspaces/new');
        } else {
          router.replace(`/workspaces/${workspaces[0].id}`);
        }
      } catch {
        router.replace('/login');
      }
    }

    redirectUser();
  }, [user, authLoading, isNetworkError, router, refreshWorkspaces]);

  if (authLoading) {
    return (
      <main
        id="main-content"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        <span className="kp-spinner kp-spinner--lg" aria-label="Loading application" />
      </main>
    );
  }

  if (isNetworkError) {
    return (
      <main
        id="main-content"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 'var(--space-4)',
          padding: 'var(--space-6)',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 'var(--text-xl)', fontFamily: 'var(--font-display)' }}>
          Service Unavailable
        </h1>
        <p style={{ color: 'var(--fg-secondary)', maxWidth: '400px' }}>
          {error || 'Unable to connect to the server. Please check your network connection.'}
        </p>
        <Button onClick={() => window.location.reload()}>Try Again</Button>
      </main>
    );
  }

  return (
    <main
      id="main-content"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}
    >
      <span className="kp-spinner kp-spinner--lg" aria-label="Loading workspace" />
    </main>
  );
}
