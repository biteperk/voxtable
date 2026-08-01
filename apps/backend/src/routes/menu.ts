import { Router } from "express";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireAnyMemberRole, requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { menuIngestLimiter } from "../http/rateLimiters";
import {
  menuCategoryRequestSchema,
  menuDraftSchema,
  menuItemRequestSchema,
  startIngestionSchema
} from "../http/schemas";
import {
  createCategory,
  createMenuItem,
  deleteCategory,
  deleteMenuItem,
  getMenu,
  updateCategory,
  updateMenuItem
} from "../services/menuService";
import {
  commitDraft,
  getIngestionResult,
  saveDraft,
  startIngestion
} from "../services/menuIngestionService";

export const menuRouter = Router();
const RESTAURANT_MEMBER_ROLES = ["staff", "server", "kitchen", "manager", "owner"] as const;

// Authenticated full-menu read — used by KDS, manager dashboard, and waiter
// flow. The kitchen kiosk needs read access; only mutations are manager-gated.
menuRouter.get(
  "/api/menu",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(RESTAURANT_MEMBER_ROLES),
  asyncHandler(async (request, response) => {
    const menu = await getMenu(tenantId(request));
    response.json(menu);
  })
);

// Anonymous public read — only available items, no internal IDs leaked beyond
// what a QR self-order page would need. No auth/tenant context, so the
// restaurant must be named explicitly via ?restaurant_id=. Falls back to the
// default tenant only in non-production (dev/demo). Phase 3 (QR self-order)
// wires this to a per-restaurant public URL.
menuRouter.get(
  "/api/menu/public",
  asyncHandler(async (request, response) => {
    const requested = typeof request.query.restaurant_id === "string" ? request.query.restaurant_id : null;
    if (!requested && env.APP_ENV === "production") {
      throw new AppError(400, "RESTAURANT_REQUIRED", "restaurant_id is required.");
    }
    const restaurantId = requested ?? env.DEFAULT_RESTAURANT_ID;
    const menu = await getMenu(restaurantId);
    response.json({
      categories: menu.categories.map((category) => ({
        id: category.id,
        name: category.name,
        items: category.items
          .filter((item) => item.is_available)
          .map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            price_cents: item.base_price_cents,
            variants: item.variants.map((v) => ({ id: v.id, name: v.name, price_delta_cents: v.price_delta_cents })),
            modifier_groups: item.modifier_groups
          }))
      }))
    });
  })
);

menuRouter.post(
  "/api/menu/categories",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const body = menuCategoryRequestSchema.parse(request.body);
    const created = await createCategory({
      restaurantId: tenantId(request),
      name: body.name,
      displayOrder: body.display_order ?? body.displayOrder
    });
    response.status(201).json(created);
  })
);

menuRouter.patch(
  "/api/menu/categories/:id",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const body = menuCategoryRequestSchema.partial().parse(request.body);
    const updated = await updateCategory({
      id: request.params.id!,
      restaurantId: tenantId(request),
      name: body.name,
      displayOrder: body.display_order ?? body.displayOrder,
      isActive: body.is_active ?? body.isActive
    });
    response.json(updated);
  })
);

menuRouter.delete(
  "/api/menu/categories/:id",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    await deleteCategory(request.params.id!, tenantId(request));
    response.status(204).end();
  })
);

menuRouter.post(
  "/api/menu/items",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const body = menuItemRequestSchema.parse(request.body);
    const categoryId = body.category_id ?? body.categoryId;
    const basePriceCents = body.base_price_cents ?? body.basePriceCents;
    if (!categoryId) throw new AppError(400, "CATEGORY_REQUIRED", "category_id is required.");
    if (basePriceCents === undefined) {
      throw new AppError(400, "PRICE_REQUIRED", "base_price_cents is required.");
    }
    const modifierGroups = (body.modifier_groups ?? body.modifierGroups)?.map((g) => ({
      groupName: (g.group_name ?? g.groupName)!,
      groupMinSelect: g.group_min_select ?? g.groupMinSelect ?? 0,
      groupMaxSelect: g.group_max_select ?? g.groupMaxSelect ?? 1,
      options: g.options.map((o, idx) => ({
        name: o.name,
        priceDeltaCents: o.price_delta_cents ?? o.priceDeltaCents ?? 0,
        isDefault: o.is_default ?? o.isDefault ?? false,
        displayOrder: o.display_order ?? o.displayOrder ?? idx
      }))
    }));
    const variants = body.variants?.map((v, idx) => ({
      name: v.name,
      priceDeltaCents: v.price_delta_cents ?? v.priceDeltaCents ?? 0,
      displayOrder: v.display_order ?? v.displayOrder ?? idx
    }));
    const created = await createMenuItem({
      restaurantId: tenantId(request),
      categoryId,
      name: body.name,
      description: body.description ?? undefined,
      basePriceCents,
      imageUrl: body.image_url ?? body.imageUrl ?? undefined,
      imageBlurhash: body.image_blurhash ?? body.imageBlurhash ?? undefined,
      displayOrder: body.display_order ?? body.displayOrder,
      variants,
      modifierGroups
    });
    response.status(201).json(created);
  })
);

menuRouter.patch(
  "/api/menu/items/:id",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const body = menuItemRequestSchema.partial().parse(request.body);
    const variants = body.variants?.map((v, idx) => ({
      name: v.name,
      priceDeltaCents: v.price_delta_cents ?? v.priceDeltaCents ?? 0,
      displayOrder: v.display_order ?? v.displayOrder ?? idx
    }));
    const modifierGroups = (body.modifier_groups ?? body.modifierGroups)?.map((g) => ({
      groupName: (g.group_name ?? g.groupName)!,
      groupMinSelect: g.group_min_select ?? g.groupMinSelect ?? 0,
      groupMaxSelect: g.group_max_select ?? g.groupMaxSelect ?? 1,
      options: g.options.map((o, idx) => ({
        name: o.name,
        priceDeltaCents: o.price_delta_cents ?? o.priceDeltaCents ?? 0,
        isDefault: o.is_default ?? o.isDefault ?? false,
        displayOrder: o.display_order ?? o.displayOrder ?? idx
      }))
    }));
    const updated = await updateMenuItem({
      id: request.params.id!,
      restaurantId: tenantId(request),
      categoryId: body.category_id ?? body.categoryId,
      name: body.name,
      description: body.description,
      basePriceCents: body.base_price_cents ?? body.basePriceCents,
      imageUrl: body.image_url ?? body.imageUrl,
      imageBlurhash: body.image_blurhash ?? body.imageBlurhash,
      displayOrder: body.display_order ?? body.displayOrder,
      isAvailable: body.is_available ?? body.isAvailable,
      variants,
      modifierGroups
    });
    response.json(updated);
  })
);

menuRouter.delete(
  "/api/menu/items/:id",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    await deleteMenuItem(request.params.id!, tenantId(request));
    response.status(204).end();
  })
);

// --- Menu OCR ingestion (Phase 2) ------------------------------------------
// The file is uploaded to storage client-side; we receive its URL + hash.

menuRouter.post(
  "/api/menu/ingest",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  menuIngestLimiter,
  asyncHandler(async (request, response) => {
    // The schema collapses the legacy `source_url` and the current
    // `source_urls` into one array, so nothing below needs to know which shape
    // the client sent.
    const body = startIngestionSchema.parse(request.body);
    const job = await startIngestion({
      restaurantId: tenantId(request),
      sourceUrls: body.source_urls,
      sourceKind: body.source_kind,
      sha256: body.sha256
    });
    // `status` matters to the client: a re-upload of an already-parsed or
    // already-committed menu returns that terminal status immediately, so the
    // UI can jump straight to review instead of polling for something that has
    // already happened.
    response.status(202).json({ job_id: job.id, status: job.status });
  })
);

menuRouter.get(
  "/api/menu/ingest/:jobId",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const job = await getIngestionResult(request.params.jobId!, tenantId(request));
    response.json({
      job_id: job.id,
      status: job.status,
      draft: job.parsed_draft,
      last_error: job.last_error,
      // [] means "we know nothing about the pages", NOT "every page was fine".
      // The review screen keeps those apart and says so — see
      // describeImportSummary in apps/frontend/src/lib/menuImportPlan.js.
      // One entry per source page, so its length IS the page count; there is no
      // separate pages_total to drift out of step with it.
      page_results: job.page_results ?? []
    });
  })
);

menuRouter.patch(
  "/api/menu/ingest/:jobId/draft",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const draft = menuDraftSchema.parse(request.body);
    const job = await saveDraft(request.params.jobId!, tenantId(request), draft);
    response.json({ job_id: job.id, status: job.status, draft: job.parsed_draft });
  })
);

menuRouter.post(
  "/api/menu/ingest/:jobId/commit",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const result = await commitDraft(request.params.jobId!, tenantId(request));
    response.json({ committed: true, ...result });
  })
);
