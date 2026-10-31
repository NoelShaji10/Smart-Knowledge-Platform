'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';

export default function WorkspacesIndexPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { refreshWorkspaces } = useWorkspace();

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      router.replace('/login');
      return;
    }

    async function redirect() {
      try {
        const workspaces = await refreshWorkspaces();
        if (workspaces && workspaces.length > 0) {
          router.replace(`/workspaces/${workspaces[0].id}`);
        } else {
          router.replace('/workspaces/new');
        }
      } catch {
        router.replace('/workspaces/new');
      }
    }

    redirect();
  }, [user, authLoading, router, refreshWorkspaces]);

  return (
    <main
      id="main-content"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
      }}
    >
      <span className="kp-spinner kp-spinner--lg" aria-label="Loading workspace..." />
    </main>
  );
}
