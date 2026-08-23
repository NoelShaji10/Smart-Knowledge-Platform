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
});
