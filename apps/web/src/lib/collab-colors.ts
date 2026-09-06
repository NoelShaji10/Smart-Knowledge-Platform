/**
 * Curated palette of high-contrast, accessible collaborator colors
 * suitable for dark and light UI themes.
 */
export const COLLAB_PALETTE = [
  '#F59E0B', // Amber
  '#10B981', // Emerald
  '#3B82F6', // Blue
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#EF4444', // Red
  '#14B8A6', // Teal
  '#6366F1', // Indigo
  '#F97316', // Orange
  '#06B6D4', // Cyan
  '#84CC16', // Lime
  '#D946EF', // Fuchsia
] as const;

/**
 * Computes a deterministic collaboration color for a given user ID.
 * The same user ID will always map to the exact same color.
 */
export function getCollaboratorColor(userId: string | undefined | null): string {
  if (!userId) return COLLAB_PALETTE[0];

  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  const index = Math.abs(hash) % COLLAB_PALETTE.length;
  return COLLAB_PALETTE[index];
}

/**
 * Extracts initials from a user's display name.
 * e.g., "Noel Shaji" -> "NS", "Alice" -> "A", "" -> "?"
 */
export function getUserInitials(name: string | undefined | null): string {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
