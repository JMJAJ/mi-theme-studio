export const PERMISSION_MODES = ['read-only', 'workspace', 'supervised', 'full-access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'supervised';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export const PERMISSION_INFO: Record<PermissionMode, { label: string; description: string }> = {
  'read-only': {
    label: 'Read only',
    description: 'Can inspect the theme and local image names. File changes, exports, and terminal commands are disabled.',
  },
  workspace: {
    label: 'Theme edits',
    description: 'Can change the open theme without asking. Local exports and terminal commands are disabled.',
  },
  supervised: {
    label: 'Supervised',
    description: 'Ask before every theme change, local import or export, and terminal command.',
  },
  'full-access': {
    label: 'Full access',
    description: 'Theme changes, local exports, and terminal commands run without approval, using your Windows account access.',
  },
};
