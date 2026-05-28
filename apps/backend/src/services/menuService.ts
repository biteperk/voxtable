import { AppError } from "../domain/errors";
import { withTransaction } from "../db/pool";
import {
  createCategory as repoCreateCategory,
  createMenuItem as repoCreateMenuItem,
  deleteCategory as repoDeleteCategory,
  deleteMenuItem as repoDeleteMenuItem,
  getFullMenu,
  MenuCategoryRow,
  MenuItemModifierRow,
  MenuItemRow,
  MenuItemVariantRow,
  replaceModifiers,
  replaceVariants,
  searchMenuItemsByName,
  updateCategory as repoUpdateCategory,
  updateMenuItem as repoUpdateMenuItem
} from "../repositories/menu";
import { logger } from "../utils/logger";

export interface MenuItemPayload {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  base_price_cents: number;
  is_available: boolean;
  image_url: string | null;
  image_blurhash: string | null;
  display_order: number;
  variants: MenuItemVariantRow[];
  modifier_groups: Array<{
    group_name: string;
    group_min_select: number;
    group_max_select: number;
    options: Array<{
      id: string;
      name: string;
      price_delta_cents: number;
      is_default: boolean;
      display_order: number;
    }>;
  }>;
}

export interface MenuPayload {
  categories: Array<MenuCategoryRow & { items: MenuItemPayload[] }>;
}

export async function getMenu(restaurantId: string): Promise<MenuPayload> {
  const { categories, items, variants, modifiers } = await getFullMenu(restaurantId);

  const variantsByItem = new Map<string, MenuItemVariantRow[]>();
  for (const v of variants) {
    const list = variantsByItem.get(v.menu_item_id) ?? [];
    list.push(v);
    variantsByItem.set(v.menu_item_id, list);
  }

  const modifiersByItemAndGroup = new Map<string, Map<string, MenuItemModifierRow[]>>();
  for (const m of modifiers) {
    const byGroup = modifiersByItemAndGroup.get(m.menu_item_id) ?? new Map();
    const list = byGroup.get(m.group_name) ?? [];
    list.push(m);
    byGroup.set(m.group_name, list);
    modifiersByItemAndGroup.set(m.menu_item_id, byGroup);
  }

  const itemsByCategory = new Map<string, MenuItemPayload[]>();
  for (const item of items) {
    const itemVariants = (variantsByItem.get(item.id) ?? []).slice().sort(
      (a, b) => a.display_order - b.display_order
    );
    const itemModifierMap: Map<string, MenuItemModifierRow[]> =
      modifiersByItemAndGroup.get(item.id) ?? new Map();
    const groups = Array.from(itemModifierMap.entries()).map(([groupName, rows]) => {
      const sorted = rows.slice().sort((a, b) => a.display_order - b.display_order);
      const first = sorted[0]!;
      return {
        group_name: groupName,
        group_min_select: first.group_min_select,
        group_max_select: first.group_max_select,
        options: sorted.map((o) => ({
          id: o.id,
          name: o.name,
          price_delta_cents: o.price_delta_cents,
          is_default: o.is_default,
          display_order: o.display_order
        }))
      };
    });
    const payload: MenuItemPayload = {
      id: item.id,
      category_id: item.category_id,
      name: item.name,
      description: item.description,
      base_price_cents: item.base_price_cents,
      is_available: item.is_available,
      image_url: item.image_url,
      image_blurhash: item.image_blurhash,
      display_order: item.display_order,
      variants: itemVariants,
      modifier_groups: groups
    };
    const list = itemsByCategory.get(item.category_id) ?? [];
    list.push(payload);
    itemsByCategory.set(item.category_id, list);
  }

  return {
    categories: categories
      .filter((c) => c.is_active)
      .map((c) => ({
        ...c,
        items: (itemsByCategory.get(c.id) ?? []).sort(
          (a, b) => a.display_order - b.display_order
        )
      }))
  };
}

export async function createCategory(input: {
  restaurantId: string;
  name: string;
  displayOrder?: number;
}): Promise<MenuCategoryRow> {
  return repoCreateCategory(input);
}

export async function updateCategory(input: {
  id: string;
  restaurantId: string;
  name?: string;
  displayOrder?: number;
  isActive?: boolean;
}): Promise<MenuCategoryRow> {
  const result = await repoUpdateCategory(input);
  if (!result) {
    throw new AppError(404, "CATEGORY_NOT_FOUND", "Category not found.");
  }
  return result;
}

export async function deleteCategory(id: string, restaurantId: string): Promise<void> {
  try {
    const removed = await repoDeleteCategory(id, restaurantId);
    if (!removed) {
      throw new AppError(404, "CATEGORY_NOT_FOUND", "Category not found.");
    }
  } catch (error) {
    // FK violation: items still reference this category.
    if ((error as { code?: string })?.code === "23503") {
      throw new AppError(
        409,
        "CATEGORY_HAS_ITEMS",
        "This category still has menu items. Move or remove them first."
      );
    }
    throw error;
  }
}

export async function createMenuItem(input: {
  restaurantId: string;
  categoryId: string;
  name: string;
  description?: string;
  basePriceCents: number;
  imageUrl?: string;
  imageBlurhash?: string;
  displayOrder?: number;
  variants?: Array<{ name: string; priceDeltaCents: number; displayOrder: number }>;
  modifierGroups?: Array<{
    groupName: string;
    groupMinSelect: number;
    groupMaxSelect: number;
    options: Array<{ name: string; priceDeltaCents: number; isDefault?: boolean; displayOrder: number }>;
  }>;
}): Promise<MenuItemRow> {
  return withTransaction(async (db) => {
    const item = await repoCreateMenuItem({ ...input }, db);
    if (input.variants?.length) {
      await replaceVariants(item.id, input.variants, db);
    }
    if (input.modifierGroups?.length) {
      const flat = input.modifierGroups.flatMap((g) =>
        g.options.map((o) => ({
          groupName: g.groupName,
          name: o.name,
          priceDeltaCents: o.priceDeltaCents,
          groupMinSelect: g.groupMinSelect,
          groupMaxSelect: g.groupMaxSelect,
          isDefault: o.isDefault ?? false,
          displayOrder: o.displayOrder
        }))
      );
      await replaceModifiers(item.id, flat, db);
    }
    logger.info({ evt: "menu_item_created", item_id: item.id, restaurant_id: input.restaurantId });
    return item;
  });
}

export async function updateMenuItem(input: {
  id: string;
  restaurantId: string;
  categoryId?: string;
  name?: string;
  description?: string | null;
  basePriceCents?: number;
  imageUrl?: string | null;
  imageBlurhash?: string | null;
  displayOrder?: number;
  isAvailable?: boolean;
  variants?: Array<{ name: string; priceDeltaCents: number; displayOrder: number }>;
  modifierGroups?: Array<{
    groupName: string;
    groupMinSelect: number;
    groupMaxSelect: number;
    options: Array<{ name: string; priceDeltaCents: number; isDefault?: boolean; displayOrder: number }>;
  }>;
}): Promise<MenuItemRow> {
  return withTransaction(async (db) => {
    const item = await repoUpdateMenuItem(input, db);
    if (!item) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found.");
    }
    if (input.variants !== undefined) {
      await replaceVariants(item.id, input.variants, db);
    }
    if (input.modifierGroups !== undefined) {
      const flat = input.modifierGroups.flatMap((g) =>
        g.options.map((o) => ({
          groupName: g.groupName,
          name: o.name,
          priceDeltaCents: o.priceDeltaCents,
          groupMinSelect: g.groupMinSelect,
          groupMaxSelect: g.groupMaxSelect,
          isDefault: o.isDefault ?? false,
          displayOrder: o.displayOrder
        }))
      );
      await replaceModifiers(item.id, flat, db);
    }
    logger.info({ evt: "menu_item_updated", item_id: item.id });
    return item;
  });
}

export async function deleteMenuItem(id: string, restaurantId: string): Promise<void> {
  try {
    const removed = await repoDeleteMenuItem(id, restaurantId);
    if (!removed) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found.");
    }
  } catch (error) {
    // FK violation: order_items still reference this menu item.
    if ((error as { code?: string })?.code === "23503") {
      throw new AppError(
        409,
        "MENU_ITEM_IN_USE",
        "This item has order history and can't be deleted. Mark it unavailable instead."
      );
    }
    throw error;
  }
}

/**
 * Voice-friendly menu search for the Retell `menu_lookup` tool. Returns a
 * speakable string plus structured matches so the agent can decide what to
 * read out.
 */
export async function lookupMenu(input: {
  restaurantId: string;
  query?: string;
  category?: string;
}): Promise<{
  matches: Array<{ id: string; name: string; price_cents: number; category_id: string }>;
  speakable_summary: string;
  ambiguous: boolean;
}> {
  if (input.query && input.query.trim().length > 0) {
    const matches = await searchMenuItemsByName(input.restaurantId, input.query.trim(), 6);
    if (matches.length === 0) {
      return {
        matches: [],
        ambiguous: false,
        speakable_summary: `I couldn't find anything matching ${input.query}. We have mains, salads, kids meals, and drinks. Which are you after?`
      };
    }
    const ambiguous = matches.length > 1 && Math.abs(matches[0]!.similarity - matches[1]!.similarity) < 0.1;
    const summary = matches
      .slice(0, 3)
      .map((m) => `${m.name} ($${(m.base_price_cents / 100).toFixed(2).replace(/\.00$/, "")})`)
      .join(", ");
    return {
      matches: matches.map((m) => ({
        id: m.id,
        name: m.name,
        price_cents: m.base_price_cents,
        category_id: m.category_id
      })),
      ambiguous,
      speakable_summary: ambiguous
        ? `I have ${summary} — which one?`
        : `We have ${summary}. Want one of those?`
    };
  }

  // No query: read the top of each category as a category overview.
  const menu = await getMenu(input.restaurantId);
  const overview = menu.categories
    .slice(0, 4)
    .map((c) => `${c.name}: ${c.items.slice(0, 2).map((i) => i.name).join(" or ") || "(empty)"}`)
    .join("; ");
  return {
    matches: menu.categories.flatMap((c) =>
      c.items.slice(0, 1).map((i) => ({
        id: i.id,
        name: i.name,
        price_cents: i.base_price_cents,
        category_id: c.id
      }))
    ),
    ambiguous: false,
    speakable_summary: `We have ${overview}. What would you like?`
  };
}
