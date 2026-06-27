import { NextFunction, Request, Response } from "express";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";
import { getUserMemberships, type MemberRole, type Membership } from "../repositories/members";
import { AuthenticatedRequest, isKitchenEmail, isManagerEmail } from "./firebaseAuth";

export interface TenantContext {
  restaurantId: string;
  role: MemberRole;
  memberships: Membership[];
}

const ROLE_RANK: Record<MemberRole, number> = { kitchen: 1, server: 2, staff: 2, manager: 3, owner: 4 };

/**
 * The active restaurant id for a request that passed resolveTenant. Throws if
 * called on a route that wasn't gated by resolveTenant (a wiring bug) rather
 * than silently falling back to a default tenant.
 */
export function tenantId(request: Request): string {
  const id = (request as AuthenticatedRequest).tenant?.restaurantId;
  if (!id) {
    throw new AppError(500, "TENANT_NOT_RESOLVED", "Restaurant context was not resolved.");
  }
  return id;
}

/**
 * Resolve the active restaurant for a dashboard request and attach it to
 * `req.tenant`. MUST run AFTER requireFirebaseAuth.
 *
 * Resolution precedence:
 *   1. Dev escape hatch (DASHBOARD_VERIFY_AUTH=false) → DEFAULT_RESTAURANT_ID as owner.
 *   2. Load the user's memberships. (Legacy bridge: pre-backfill allowlisted
 *      users with no membership get DEFAULT_RESTAURANT_ID when
 *      MULTITENANCY_LEGACY_FALLBACK=true.)
 *   3. No memberships → 403 NO_RESTAURANT_MEMBERSHIP (frontend routes to onboarding).
 *   4. Active restaurant = X-Restaurant-Id header (validated against membership —
 *      never trusted blindly) → else the sole membership → else
 *      409 RESTAURANT_SELECTION_REQUIRED (frontend prompts a switcher).
 *
 * The header is validated against membership on every request: a member of
 * restaurant A can never act on restaurant B by spoofing the header.
 */
export async function resolveTenant(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction
): Promise<void> {
  if (!env.DASHBOARD_VERIFY_AUTH) {
    request.tenant = { restaurantId: env.DEFAULT_RESTAURANT_ID, role: "owner", memberships: [] };
    next();
    return;
  }

  const user = request.firebaseUser;
  if (!user) {
    // resolveTenant was mounted without requireFirebaseAuth ahead of it.
    next(new AppError(401, "MISSING_AUTH", "Authentication required."));
    return;
  }

  try {
    let memberships = await getUserMemberships(user.uid);

    if (memberships.length === 0 && env.MULTITENANCY_LEGACY_FALLBACK) {
      // requireFirebaseAuth already enforced DASHBOARD_ALLOWED_EMAILS, so an
      // authenticated user reaching here is allowlisted. Grant the default
      // tenant with a role derived from the manager/kitchen allowlists (the KDS
      // kiosk needs 'kitchen' to read the now role-gated /api/orders/*).
      const role: MemberRole = isManagerEmail(user.email)
        ? "manager"
        : isKitchenEmail(user.email)
          ? "kitchen"
          : "staff";
      memberships = [
        { restaurantId: env.DEFAULT_RESTAURANT_ID, restaurantName: "", role }
      ];
      logger.warn({ evt: "tenant_legacy_fallback", uid: user.uid });
    }

    if (memberships.length === 0) {
      next(
        new AppError(
          403,
          "NO_RESTAURANT_MEMBERSHIP",
          "No restaurant is associated with this account.",
          { memberships: [] }
        )
      );
      return;
    }

    const requested = (request.header("x-restaurant-id") ?? "").trim() || null;
    let active: Membership | undefined;

    if (requested) {
      active = memberships.find((m) => m.restaurantId === requested);
      if (!active) {
        next(new AppError(403, "NOT_A_MEMBER", "You do not have access to that restaurant."));
        return;
      }
    } else if (memberships.length === 1) {
      active = memberships[0]!;
    } else {
      next(
        new AppError(409, "RESTAURANT_SELECTION_REQUIRED", "Select a restaurant to continue.", {
          memberships: memberships.map((m) => ({
            restaurant_id: m.restaurantId,
            name: m.restaurantName,
            role: m.role
          }))
        })
      );
      return;
    }

    // `active` is guaranteed assigned on every non-returning branch above.
    request.tenant = {
      restaurantId: active!.restaurantId,
      role: active!.role,
      memberships
    };
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    logger.error({ evt: "resolve_tenant_failed", error });
    next(new AppError(500, "TENANT_RESOLUTION_FAILED", "Could not resolve restaurant context."));
  }
}

/**
 * Per-restaurant role gate — apply AFTER resolveTenant. Authorizes against the
 * member's role at the active restaurant rather than a global email allowlist.
 * Dev escape hatch (DASHBOARD_VERIFY_AUTH=false) allows through.
 */

export function requireAnyMemberRole(allowedRoles: readonly MemberRole[]) {
  const allowed = new Set<MemberRole>(allowedRoles);
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    if (!env.DASHBOARD_VERIFY_AUTH) {
      next();
      return;
    }
    const role = request.tenant?.role;
    if (!role) {
      next(new AppError(403, "TENANT_REQUIRED", "Restaurant context required."));
      return;
    }
    if (!allowed.has(role)) {
      next(new AppError(403, "INSUFFICIENT_ROLE", "This role cannot access this action."));
      return;
    }
    next();
  };
}
export function requireMemberRole(min: MemberRole) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    if (!env.DASHBOARD_VERIFY_AUTH) {
      next();
      return;
    }
    const role = request.tenant?.role;
    if (!role) {
      next(new AppError(403, "TENANT_REQUIRED", "Restaurant context required."));
      return;
    }
    if (ROLE_RANK[role] < ROLE_RANK[min]) {
      next(new AppError(403, "INSUFFICIENT_ROLE", `This action requires the ${min} role.`));
      return;
    }
    next();
  };
}
