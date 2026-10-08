/**
 * Permission service — §16 (Security and Governance).
 *
 * RBAC over a small in-memory permission map. In production this would
 * be backed by an external IdP (e.g. OPA, Auth0, or a SQL table); the
 * interface stays the same.
 */
import { supervisorConfig } from '../config.js';

export type Permission =
  | 'workspace.read'
  | 'workspace.write'
  | 'sandbox.execute'
  | 'tool.invoke'
  | 'production.deploy'
  | 'database.migration'
  | 'external.payment'
  | 'send.email'
  | 'secret.access'
  | 'privileged.terminal'
  | 'irreversible.api'
  | 'admin';

const ROLES: Record<string, Permission[]> = {
  viewer: ['workspace.read'],
  developer: ['workspace.read', 'workspace.write', 'sandbox.execute', 'tool.invoke'],
  operator: [
    'workspace.read',
    'workspace.write',
    'sandbox.execute',
    'tool.invoke',
    'production.deploy',
    'privileged.terminal',
  ],
  admin: [
    'workspace.read',
    'workspace.write',
    'sandbox.execute',
    'tool.invoke',
    'production.deploy',
    'database.migration',
    'external.payment',
    'send.email',
    'secret.access',
    'privileged.terminal',
    'irreversible.api',
    'admin',
  ],
};

export class PermissionService {
  private readonly userPermissions = new Map<string, Set<Permission>>();

  /** Assign a role to a user. Multiple roles are merged. */
  assignRole(userId: string, role: keyof typeof ROLES): void {
    const set = this.userPermissions.get(userId) ?? new Set<Permission>();
    for (const p of ROLES[role] ?? []) set.add(p);
    this.userPermissions.set(userId, set);
  }

  has(userId: string | undefined, permission: Permission | string): boolean {
    if (!userId) return false;
    const set = this.userPermissions.get(userId);
    if (!set) return false;
    return set.has(permission as Permission);
  }

  /**
   * Returns true if the action requires explicit human approval per
   * `SUPERVISOR_REQUIRE_APPROVAL_FOR` (§9.4).
   */
  requiresApproval(action: string): boolean {
    return supervisorConfig.security.requireApprovalFor.includes(action);
  }
}
