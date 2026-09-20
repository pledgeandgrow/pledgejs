/**
 * Role-based access control (RBAC).
 *
 * Provides:
 * - Declarative route-level roles config
 * - Middleware-level enforcement
 * - usePermissions() hook helper
 * - Role hierarchy support
 */

export interface RoleDefinition {
  /** Role name */
  name: string;
  /** Parent role (for hierarchy) */
  inherits?: string;
  /** Permissions granted by this role */
  permissions?: string[];
  /** Description */
  description?: string;
}

export interface RouteRoleConfig {
  /** Required roles (any of) */
  roles?: string[];
  /** Required permissions (all of) */
  permissions?: string[];
  /** Whether to require all roles or any (default: 'any') */
  match?: 'any' | 'all';
}

export interface RBACContext {
  userId?: string;
  roles: string[];
  permissions: string[];
}

export type RouteRoleMap = Record<string, RouteRoleConfig>;

/**
 * RBAC manager — role definitions, hierarchy, and permission checking.
 */
export class RBACManager {
  private roles: Map<string, RoleDefinition> = new Map();
  private routeConfig: RouteRoleMap = {};

  /**
   * Register a role definition.
   */
  defineRole(role: RoleDefinition): void {
    this.roles.set(role.name, role);
  }

  /**
   * Register multiple role definitions.
   */
  defineRoles(roles: RoleDefinition[]): void {
    for (const role of roles) this.defineRole(role);
  }

  /**
   * Configure route-level access control.
   */
  configureRoutes(routes: RouteRoleMap): void {
    this.routeConfig = { ...this.routeConfig, ...routes };
  }

  /**
   * Get all permissions for a role, including inherited ones.
   */
  getRolePermissions(roleName: string, visited: Set<string> = new Set()): string[] {
    // Guard against circular `inherits` chains (a -> b -> a).
    if (visited.has(roleName)) return [];
    visited.add(roleName);
    const role = this.roles.get(roleName);
    if (!role) return [];

    const permissions = new Set<string>(role.permissions ?? []);

    if (role.inherits) {
      for (const p of this.getRolePermissions(role.inherits, visited)) {
        permissions.add(p);
      }
    }

    return [...permissions];
  }

  /**
   * Get all permissions for a user with the given roles.
   */
  getUserPermissions(roles: string[]): string[] {
    const permissions = new Set<string>();
    for (const role of roles) {
      for (const p of this.getRolePermissions(role)) {
        permissions.add(p);
      }
    }
    return [...permissions];
  }

  /**
   * Check if a context has a specific permission.
   */
  hasPermission(context: RBACContext, permission: string): boolean {
    return context.permissions.includes(permission) ||
      this.getUserPermissions(context.roles).includes(permission);
  }

  /**
   * Check if a context has any of the specified permissions.
   */
  hasAnyPermission(context: RBACContext, permissions: string[]): boolean {
    return permissions.some((p) => this.hasPermission(context, p));
  }

  /**
   * Check if a context has all of the specified permissions.
   */
  hasAllPermissions(context: RBACContext, permissions: string[]): boolean {
    return permissions.every((p) => this.hasPermission(context, p));
  }

  /**
   * Check if a context has a specific role (including inherited).
   */
  hasRole(context: RBACContext, roleName: string): boolean {
    if (context.roles.includes(roleName)) return true;
    return context.roles.some((r) => this.roleInherits(r, roleName));
  }

  /**
   * Check if a context has access to a route.
   */
  canAccessRoute(context: RBACContext, route: string): boolean {
    const config = this.routeConfig[route];
    if (!config) return true;

    if (config.roles && config.roles.length > 0) {
      const match = config.match ?? 'any';
      if (match === 'all') {
        if (!config.roles.every((r) => this.hasRole(context, r))) return false;
      } else {
        if (!config.roles.some((r) => this.hasRole(context, r))) return false;
      }
    }

    if (config.permissions && config.permissions.length > 0) {
      if (!this.hasAllPermissions(context, config.permissions)) return false;
    }

    return true;
  }

  /**
   * Get the route configuration for a route.
   */
  getRouteConfig(route: string): RouteRoleConfig | undefined {
    return this.routeConfig[route];
  }

  /**
   * Create middleware for route access control.
   */
  createMiddleware() {
    return (route: string, context: RBACContext): { allowed: boolean; reason?: string } => {
      if (this.canAccessRoute(context, route)) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Insufficient permissions' };
    };
  }

  /**
   * Check if one role inherits from another (directly or transitively).
   */
  private roleInherits(roleName: string, targetRole: string, visited = new Set<string>()): boolean {
    if (visited.has(roleName)) return false;
    visited.add(roleName);

    const role = this.roles.get(roleName);
    if (!role || !role.inherits) return false;
    if (role.inherits === targetRole) return true;
    return this.roleInherits(role.inherits, targetRole, visited);
  }
}

/**
 * Create a usePermissions hook factory.
 * Returns a function that can be used in React components.
 */
export function createUsePermissions(rbac: RBACManager) {
  return function usePermissions(context: RBACContext) {
    return {
      hasPermission: (permission: string) => rbac.hasPermission(context, permission),
      hasAnyPermission: (permissions: string[]) => rbac.hasAnyPermission(context, permissions),
      hasAllPermissions: (permissions: string[]) => rbac.hasAllPermissions(context, permissions),
      hasRole: (role: string) => rbac.hasRole(context, role),
      canAccessRoute: (route: string) => rbac.canAccessRoute(context, route),
      permissions: context.permissions.length > 0
        ? context.permissions
        : rbac.getUserPermissions(context.roles),
    };
  };
}

/**
 * Common role definitions.
 */
export const COMMON_ROLES: RoleDefinition[] = [
  { name: 'viewer', permissions: ['read'], description: 'Read-only access' },
  { name: 'editor', inherits: 'viewer', permissions: ['write', 'update'], description: 'Read and write access' },
  { name: 'admin', inherits: 'editor', permissions: ['delete', 'manage'], description: 'Full access' },
  { name: 'owner', inherits: 'admin', permissions: ['billing', 'configure'], description: 'Owner access' },
];
