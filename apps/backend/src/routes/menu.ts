import { Router } from "express";

import { requireFirebaseAuth, requireManagerRole } from "../auth/firebaseAuth";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { menuCategoryRequestSchema, menuItemRequestSchema } from "../http/schemas";
import {
  createCategory,
  createMenuItem,
  deleteCategory,
  deleteMenuItem,
  getMenu,
  updateCategory,
  updateMenuItem
} from "../services/menuService";

export const menuRouter = Router();

// Authenticated full-menu read — used by KDS, manager dashboard, and waiter
// flow. The kitchen kiosk needs read access; only mutations are manager-gated.
menuRouter.get(
  "/api/menu",
  requireFirebaseAuth,
  asyncHandler(async (_request, response) => {
    const menu = await getMenu(env.DEFAULT_RESTAURANT_ID);
    response.json(menu);
  })
);

// Anonymous public read — only available items, no internal IDs leaked beyond
// what a QR self-order page would need. Phase 3 will use this.
menuRouter.get(
  "/api/menu/public",
  asyncHandler(async (_request, response) => {
    const menu = await getMenu(env.DEFAULT_RESTAURANT_ID);
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
  requireManagerRole,
  asyncHandler(async (request, response) => {
    const body = menuCategoryRequestSchema.parse(request.body);
    const created = await createCategory({
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      name: body.name,
      displayOrder: body.display_order ?? body.displayOrder
    });
    response.status(201).json(created);
  })
);

menuRouter.patch(
  "/api/menu/categories/:id",
  requireFirebaseAuth,
  requireManagerRole,
  asyncHandler(async (request, response) => {
    const body = menuCategoryRequestSchema.partial().parse(request.body);
    const updated = await updateCategory({
      id: request.params.id!,
      restaurantId: env.DEFAULT_RESTAURANT_ID,
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
  requireManagerRole,
  asyncHandler(async (request, response) => {
    await deleteCategory(request.params.id!, env.DEFAULT_RESTAURANT_ID);
    response.status(204).end();
  })
);

menuRouter.post(
  "/api/menu/items",
  requireFirebaseAuth,
  requireManagerRole,
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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
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
  requireManagerRole,
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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
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
  requireManagerRole,
  asyncHandler(async (request, response) => {
    await deleteMenuItem(request.params.id!, env.DEFAULT_RESTAURANT_ID);
    response.status(204).end();
  })
);
