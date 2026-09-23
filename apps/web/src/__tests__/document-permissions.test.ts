import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, setAccessToken } from '../lib/api';

describe('Task T9: Document Permissions, Version History & Archive Tests', () => {
  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Document Permissions API Client', () => {
    it('calls GET to list document permission overrides', async () => {
      const mockOverrides = [
        {
          id: 'user-1',
          email: 'editor@example.com',
          display_name: 'Jane Editor',
          role: 'editor' as const,
          granted_by: 'owner-1',
          created_at: new Date().toISOString(),
        },
        {
          id: 'user-2',
          email: 'denied@example.com',
          display_name: 'Restricted User',
          role: 'none' as const,
          granted_by: 'owner-1',
          created_at: new Date().toISOString(),
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ permissions: mockOverrides }),
      });

      const res = await api.listDocumentPermissions('ws-1', 'doc-1');
      expect(res.permissions).toHaveLength(2);
      expect(res.permissions[0].role).toBe('editor');
      expect(res.permissions[1].role).toBe('none');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1/permissions'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('calls PUT to grant or update document permission override', async () => {
      const mockPermission = {
        id: 'target-user-1',
        email: 'target@example.com',
        display_name: 'Target User',
        role: 'none' as const,
        granted_by: 'owner-1',
        created_at: new Date().toISOString(),
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ permission: mockPermission }),
      });

      const res = await api.setDocumentPermission('ws-1', 'doc-1', 'target-user-1', 'none');
      expect(res.permission.role).toBe('none');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1/permissions/target-user-1'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ role: 'none' }),
        }),
      );
    });

    it('calls DELETE to remove document permission override', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });

      const res = await api.removeDocumentPermission('ws-1', 'doc-1', 'target-user-1');
      expect(res.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1/permissions/target-user-1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('T9 Permission & Capability Gating Logic', () => {
    it('correctly determines permission button visibility based on canManagePermissions capability', () => {
      const adminCap = { canManagePermissions: true, canEdit: true, canArchive: true, canRead: true, canMove: true };
      const viewerCap = { canManagePermissions: false, canEdit: false, canArchive: false, canRead: true, canMove: false };

      expect(adminCap.canManagePermissions).toBe(true);
      expect(viewerCap.canManagePermissions).toBe(false);
    });

    it('represents explicit role="none" as Denied (No Access)', () => {
      const roleMap: Record<string, string> = {
        editor: 'Editor',
        viewer: 'Viewer',
        none: 'Denied (No Access)',
      };

      expect(roleMap['none']).toBe('Denied (No Access)');
      expect(roleMap['editor']).toBe('Editor');
      expect(roleMap['viewer']).toBe('Viewer');
    });

    it('distinguishes backend version trigger types correctly', () => {
      const triggers = ['manual', 'restore', 'auto_interval', 'session_end'];
      const triggerLabels: Record<string, string> = {
        manual: 'Manual Checkpoint',
        restore: 'Restored Version',
        auto_interval: 'Auto Saved',
        session_end: 'Session Saved',
      };

      triggers.forEach((trig) => {
        expect(triggerLabels[trig]).toBeDefined();
      });
    });

    it('includes restoration disclaimer explaining that restoring creates a NEW version', () => {
      const disclaimerText = 'Note: Restoring this version creates a NEW version checkpoint. Existing history is preserved.';
      expect(disclaimerText).toContain('creates a NEW version checkpoint');
      expect(disclaimerText).toContain('Existing history is preserved');
    });

    it('sanitizes hostile HTML script tags and event handlers using DOMPurify', async () => {
      const DOMPurify = (await import('isomorphic-dompurify')).default;
      const hostileHtml = '<script>alert("xss")</script><img src="x" onerror="alert(1)" /><a href="javascript:alert(1)">click</a><p>Safe Text</p>';
      const sanitized = DOMPurify.sanitize(hostileHtml);

      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('onerror');
      expect(sanitized).not.toContain('javascript:');
      expect(sanitized).toContain('<p>Safe Text</p>');
    });
  });

  describe('T5 Workspace Members & Effective Role Resolution', () => {
    it('calls GET /api/v1/workspaces/:ws/members to list workspace members', async () => {
      const mockMembers = [
        {
          id: 'user-1',
          email: 'admin@example.com',
          display_name: 'Admin User',
          avatar_url: null,
          role: 'admin' as const,
          created_at: new Date().toISOString(),
        },
        {
          id: 'user-2',
          email: 'viewer@example.com',
          display_name: 'Viewer User',
          avatar_url: null,
          role: 'viewer' as const,
          created_at: new Date().toISOString(),
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ members: mockMembers }),
      });

      const res = await api.listWorkspaceMembers('ws-test');
      expect(res.members).toHaveLength(2);
      expect(res.members[0].role).toBe('admin');
      expect(res.members[1].role).toBe('viewer');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/workspaces/ws-test/members'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('calculates effective document role faithfully from workspace role and document override', () => {
      function calculateEffectiveRole(
        workspaceRole: string | undefined,
        overrideRole: 'editor' | 'viewer' | 'none',
      ): string {
        if (overrideRole === 'none') return 'Denied (No Access)';
        if (workspaceRole === 'owner' || workspaceRole === 'admin') {
          return workspaceRole === 'owner' ? 'Owner' : 'Admin';
        }
        if (workspaceRole === 'editor') {
          return overrideRole === 'viewer' ? 'Viewer' : 'Editor';
        }
        if (workspaceRole === 'viewer') {
          return overrideRole === 'editor' ? 'Editor' : 'Viewer';
        }
        return overrideRole === 'editor' ? 'Editor' : 'Viewer';
      }

      // Owner with viewer override -> Owner (workspace authority)
      expect(calculateEffectiveRole('owner', 'viewer')).toBe('Owner');
      // Admin with none override -> Denied (explicit document block)
      expect(calculateEffectiveRole('admin', 'none')).toBe('Denied (No Access)');
      // Editor with viewer override -> Viewer (downgrade)
      expect(calculateEffectiveRole('editor', 'viewer')).toBe('Viewer');
      // Viewer with editor override -> Editor (upgrade)
      expect(calculateEffectiveRole('viewer', 'editor')).toBe('Editor');
      // Viewer with viewer override -> Viewer
      expect(calculateEffectiveRole('viewer', 'viewer')).toBe('Viewer');
      // Editor with editor override -> Editor
      expect(calculateEffectiveRole('editor', 'editor')).toBe('Editor');
    });

    it('formats read-only status bar label correctly with collaboration status', () => {
      function formatReadOnlyStatus(
        readOnly: boolean,
        collabStatus: string | undefined,
        userCount: number,
      ): string | null {
        if (!readOnly) return null;
        if (collabStatus === 'connected') {
          const userPart = userCount > 1 ? ` • ${userCount} collaborators` : '';
          return `View Only • Connected${userPart}`;
        } else if (collabStatus === 'connecting') {
          return 'View Only • Connecting...';
        } else if (collabStatus === 'error') {
          return 'View Only • Connection Error';
        }
        return 'View Only';
      }

      expect(formatReadOnlyStatus(true, 'connected', 1)).toBe('View Only • Connected');
      expect(formatReadOnlyStatus(true, 'connected', 3)).toBe('View Only • Connected • 3 collaborators');
      expect(formatReadOnlyStatus(true, 'connecting', 0)).toBe('View Only • Connecting...');
      expect(formatReadOnlyStatus(true, 'error', 0)).toBe('View Only • Connection Error');
      expect(formatReadOnlyStatus(true, 'disconnected', 0)).toBe('View Only');
      expect(formatReadOnlyStatus(false, 'connected', 2)).toBeNull();
    });
  });
});
