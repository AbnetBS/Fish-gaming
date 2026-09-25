import type { AdminRole, Role } from './constants.js';

/**
 * Capability-based access control.
 *
 * Every privileged API route declares the capability it needs; the server
 * resolves the caller's role to a capability set *from the database*, never
 * from anything the browser supplies. Adding a new admin role therefore only
 * requires a new entry in this map.
 */
export const PERMISSIONS = [
  'admin:panel',
  'users:read',
  'users:write',
  'rooms:read',
  'rooms:write',
  'tournaments:read',
  'tournaments:write',
  'fish:read',
  'fish:write',
  'cannons:read',
  'cannons:write',
  'config:read',
  'config:write',
  'history:read',
  'transactions:read',
  'transactions:write',
  'reports:read',
  'audit:read',
  'settings:read',
  'settings:write',
  'maintenance:write',
  'admin:full',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY_GAME: Permission[] = [
  'admin:panel',
  'rooms:read',
  'tournaments:read',
  'fish:read',
  'cannons:read',
  'config:read',
  'history:read',
  'reports:read',
];

export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  /** Full control. Reserved for the operator's break-glass account. */
  SUPER_ADMIN: [...PERMISSIONS],

  /** Game design: fish, cannons, rounds and configuration. */
  GAME_ADMIN: [
    'admin:panel',
    'users:read',
    'rooms:read',
    'rooms:write',
    'tournaments:read',
    'tournaments:write',
    'fish:read',
    'fish:write',
    'cannons:read',
    'cannons:write',
    'config:read',
    'config:write',
    'history:read',
    'reports:read',
  ],

  /** Ledger + transactions. Becomes meaningful if real-money mode is ever licensed. */
  FINANCE_ADMIN: [
    'admin:panel',
    'users:read',
    'transactions:read',
    'transactions:write',
    'tournaments:read',
    'history:read',
    'reports:read',
    'audit:read',
  ],

  /** Player support: look-ups and account status, no economy control. */
  SUPPORT_ADMIN: [
    'admin:panel',
    'users:read',
    'users:write',
    'history:read',
    'transactions:read',
  ],

  /** Read-only oversight: audit trail, reports, configuration inspection. */
  COMPLIANCE_ADMIN: [...READ_ONLY_GAME, 'transactions:read', 'audit:read', 'settings:read'],

  /**
   * Generic legacy administrator. Deliberately limited to support duties —
   * least privilege by default. Promote to a specific role when needed.
   */
  ADMIN: [
    'admin:panel',
    'users:read',
    'users:write',
    'history:read',
    'transactions:read',
    'rooms:read',
    'fish:read',
    'cannons:read',
    'config:read',
    'reports:read',
  ],
};

export function permissionsForRole(role: Role): Permission[] {
  if (role === 'USER') return [];
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export function isAdminRole(role: Role): boolean {
  return role !== 'USER';
}
