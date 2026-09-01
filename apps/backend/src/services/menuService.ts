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
  getRequiredModifierGroups,
  listMenuItemWindows,
  listRecommendedItems,
  searchMenuItemsByName,
  updateCategory as repoUpdateCategory,
  updateMenuItem as repoUpdateMenuItem
} from "../repositories/menu";
import { logger } from "../utils/logger";
import { formatDailyWindow, isWithinDailyWindow } from "../utils/time";

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
  available_from: string | null;
  available_until: string | null;
  is_restricted: boolean;
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
      available_from: item.available_from,
      available_until: item.available_until,
      is_restricted: item.is_restricted,
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

const PG_FK_VIOLATION = "23503";

// Postgres FK-violation (ON DELETE/UPDATE RESTRICT). Rethrow as a 409 with
// actionable copy instead of leaking a generic 500; pass anything else through.
function rethrowFkViolationAs(error: unknown, code: string, message: string): never {
  if ((error as { code?: string })?.code === PG_FK_VIOLATION) {
    throw new AppError(409, code, message);
  }
  throw error;
}

export async function deleteCategory(id: string, restaurantId: string): Promise<void> {
  try {
    const removed = await repoDeleteCategory(id, restaurantId);
    if (!removed) {
      throw new AppError(404, "CATEGORY_NOT_FOUND", "Category not found.");
    }
  } catch (error) {
    // FK violation: items still reference this category.
    rethrowFkViolationAs(
      error,
      "CATEGORY_HAS_ITEMS",
      "This category still has menu items. Move or remove them first."
    );
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
  availableFrom?: string | null;
  availableUntil?: string | null;
  isRestricted?: boolean;
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
  availableFrom?: string | null;
  availableUntil?: string | null;
  isRestricted?: boolean;
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
    try {
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
    } catch (error) {
      // FK violation: replaceVariants does DELETE then INSERT; if any
      // order_items.variant_id still references a current variant
      // (ON DELETE RESTRICT), PG throws 23503. Bubble a clear 409 instead
      // of a generic 500 so the dashboard can show actionable copy.
      rethrowFkViolationAs(
        error,
        "MENU_ITEM_VARIANTS_IN_USE",
        "One or more variants of this item are tied to past orders. Edit the name/price of the menu item itself, or mark it unavailable instead of changing variants."
      );
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
    rethrowFkViolationAs(
      error,
      "MENU_ITEM_IN_USE",
      "This item has order history and can't be deleted. Mark it unavailable instead."
    );
  }
}

/**
 * Voice-friendly menu search for the Retell `menu_lookup` tool. Returns a
 * speakable string plus structured matches so the agent can decide what to
 * read out.
 */
export interface MenuLookupMatch {
  id: string;
  name: string;
  // A formatted string, NOT cents. The model was handed `price_cents: 150` and
  // read it aloud as "fifteen cents" — and 900 as "nine hundred cents" — on a
  // real call, quoting a $1.50 item at 1% of its price. It converted correctly
  // some of the time, which is worse than never: an arithmetic step the model
  // can skip is one it eventually will. Giving it only the spoken form removes
  // the possibility rather than asking it to be careful.
  price: string;
  category_id: string;
  is_restricted: boolean;
  available_from: string | null;
  available_until: string | null;
  // Whether the item is servable at the reference time (the call's "now", or
  // the pickup time for orders). Absent when the caller didn't supply a time.
  // On call_4e871f4b (30 Aug 2026) three haloumi variants — one late-night
  // only, one breakfast only — were offered identically for a 2 PM pickup and
  // the order was refused only at create_order. The agent must know BEFORE
  // offering.
  available_now?: boolean;
  // Spoken window for a windowed item, e.g. "between 7 AM and midday".
  served?: string;
  // The choices that BLOCK an order until the caller picks one — e.g. which
  // filling a pressed sandwich comes with. Absent when the dish needs none.
  // Without this the agent has to guess the caller's word for a variant, and a
  // guess that misses reads to the caller as the system being broken.
  required_choices?: Array<{ group: string; options: string[] }>;
}

/**
 * Callers ask for "the menu" as a thing, not a dish — and the LLM passes those
 * words through as a search query, which can never match an item name. Route
 * them to the category overview instead of a nonsense "couldn't find menu" miss.
 */
const GENERIC_MENU_QUERY = /^(the |your |whole |full )*(menu|menus|food|meals|dishes|options|specials|everything)\s*$/i;

function speakablePrice(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

// The window annotations, shared by every lookup shape. Only added when a
// reference time exists — dashboard callers get the raw columns as before.
function windowFields(
  from: string | null,
  until: string | null,
  nowHm?: string
): Pick<MenuLookupMatch, "available_now" | "served"> {
  if (!nowHm) return {};
  const windowed = Boolean(from || until);
  return {
    available_now: isWithinDailyWindow(nowHm, from, until),
    ...(windowed ? { served: formatDailyWindow(from, until) } : {})
  };
}

function toLookupMatch(i: MenuItemPayload, categoryId: string, nowHm?: string): MenuLookupMatch {
  return {
    id: i.id,
    name: i.name,
    price: speakablePrice(i.base_price_cents),
    category_id: categoryId,
    is_restricted: i.is_restricted,
    available_from: i.available_from,
    available_until: i.available_until,
    ...windowFields(i.available_from, i.available_until, nowHm)
  };
}

/**
 * One category as the overview sees it. Offerable items are kept apart from
 * licensed ones so a section can be NAMED without being SOLD: a list made
 * entirely of licensed drinks still exists, and dropping it outright made
 * Bella deny the venue had a cocktail list at all.
 */
interface OverviewCategory {
  id: string;
  name: string;
  /** Bella may name these and take the order. */
  items: MenuItemPayload[];
  /** Licensed: describable, refused by `create_order`. */
  restricted: MenuItemPayload[];
}

/** "a, b and c" — the spoken list form used for section names. */
function speakList(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/**
 * Callers ask for "drinks" as one thing, but venues name their sections
 * "Cocktails", "Mocktails & Frappes", "Beer, Wine & Spirits" — not one of
 * which contains the word. Matching the caller's word alone answers from
 * whichever section happens to spell it out and hides the rest.
 */
const DRINK_UMBRELLA = /^(a |any |some )*(thing to )?(drinks?|beverages?|something to drink)\s*$/i;
// Matched as substrings, so plurals and "&" joins fall out for free.
// Deliberately no "tea" — "steak" contains it.
const DRINK_SECTION_WORDS = [
  "drink",
  "juice",
  "cocktail",
  "mocktail",
  "beer",
  "wine",
  "spirit",
  "frappe",
  "soda",
  "smoothie",
  "coffee"
];

/**
 * Section synonyms. Category matching is plain substring against the venue's
 * own section names, which works for "mains", "sides", "salads", "desserts",
 * "kids" and even "sharing"/"chef" (both substrings of "Chef Suggestions for
 * Sharing") — but silently misses the words callers actually use for the
 * starters section. A miss is not harmless: it answers "we don't have a
 * starters section" about a section the venue definitely has.
 *
 * Australian usage: "entree" is a STARTER here, not a main. This venue is in
 * Sydney; do not map it the American way.
 */
const CATEGORY_SYNONYMS: Array<{ spoken: RegExp; sectionWords: string[] }> = [
  {
    spoken:
      /^(a |some |any |the )*(entr[ée]e|appeti[sz]er|small plate|nibble|starter)s?$|^(something |anything )?to (start|begin)( with)?$/i,
    sectionWords: ["starter", "entree", "entrée", "appetiser", "appetizer", "small plate", "to start"]
  },
  {
    spoken: /^(a |some |any |the )*(platter|board|share plate|sharing plate|shared plate)s?$|^(something )?to share$/i,
    sectionWords: ["sharing", "share", "platter", "board", "chef suggestion"]
  }
];

/**
 * Resolve a caller's word for a section to the venue's actual categories.
 * Shared by the query path and the browse path so both answer identically —
 * they used to disagree, which is how a category-shaped query bypassed all of
 * this and searched the whole menu by name.
 */
export function resolveCategoryHits<T extends { name: string }>(categories: T[], categoryWord: string): T[] {
  const wanted = categoryWord.trim().toLowerCase();
  const direct = categories.filter(
    (c) => c.name.toLowerCase().includes(wanted) || wanted.includes(c.name.toLowerCase())
  );

  // The umbrella fans out when the caller's word landed on AT MOST one section.
  // Checked before the plain-substring return on purpose: "Juices & Soft
  // Drinks" contains "drinks", so a direct-match-wins rule answers "what
  // drinks do you have?" from the juices alone and never mentions the bar.
  if (DRINK_UMBRELLA.test(wanted) && direct.length <= 1) {
    const bar = categories.filter((c) =>
      DRINK_SECTION_WORDS.some((w) => c.name.toLowerCase().includes(w))
    );
    if (bar.length > 0) return bar;
  }

  if (direct.length > 0) return direct;

  const synonym = CATEGORY_SYNONYMS.find((s) => s.spoken.test(wanted));
  if (synonym) {
    const viaSynonym = categories.filter((c) =>
      synonym.sectionWords.some((w) => c.name.toLowerCase().includes(w))
    );
    if (viaSynonym.length > 0) return viaSynonym;
  }

  return [];
}

/**
 * Is the caller naming a SECTION rather than a dish? "Can I have some
 * suggestions for starters?" is a browse, but it arrives as `query` because
 * the LLM passes the caller's words through — and a query beat the category
 * parameter to the return, so it was searched as a dish name against all 97
 * items. That is exactly how the owner was offered a side and a salad when he
 * asked for starters.
 */
export function categoryShapedQuery(query: string): string | null {
  const cleaned = query
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/, "")
    // Strip the polite scaffolding the caller wraps the section name in.
    .replace(
      /^(can i (have|get)|could i (have|get)|what|whats|what's|do you have|have you got|any|some|give me|i'd like|id like|tell me about)\s+/,
      ""
    )
    .replace(/^(are |is )?(some |any |your |the )?(good |nice |best )?(suggestions?|recommendations?|options?|choices?)\s+(for|from|in|on)\s+/, "")
    .replace(/^(you have|you got|do you have)\s+/, "")
    .replace(/\s+(do you have|have you got|are there|on the menu)$/, "")
    // "what's GOOD to share" / "your BEST starters" — the quality adjective is
    // not part of the section name.
    .replace(/^(is|are|was)\s+/, "")
    .replace(/^(the |your |our |some |any )+/, "")
    .replace(/^(good|best|nice|great|popular|top|favourite|favorite)\s+/, "")
    .replace(/^(on|in|from|for)\s+(the\s+)?/, "")
    .replace(/^(the |your |some |any )+/, "")
    .trim();
  if (cleaned.length === 0 || cleaned.length > 40) return null;
  return cleaned;
}

/**
 * The real category overview, built from THIS venue's menu. The summary speaks
 * category NAMES only — an earlier version read 2 items from each of the first
 * 4 categories, which on a real 8-category menu produced a 17-second monologue
 * that also never mentioned half the menu. Names are short, complete, and
 * invite the caller to pick a section; `matches` still carries one sample item
 * per category so the agent has something concrete to suggest.
 */
async function categoryOverview(restaurantId: string, nowHm?: string): Promise<{
  matches: MenuLookupMatch[];
  categories: OverviewCategory[];
  names: string;
}> {
  const fullMenu = await getMenu(restaurantId);
  // Unavailable items are dropped before anything here can speak them. This
  // overview is what Bella reads out when a caller asks "what have you got?",
  // and it used to include items the kitchen had switched off — on 26 Aug 2026
  // it offered "Fish & Chips", the caller ordered it, and because create_order
  // only searches AVAILABLE items the order silently became "Chips" at less
  // than half the price. Never offer what cannot be sold.
  const menu = {
    ...fullMenu,
    categories: fullMenu.categories.map((c) => ({
      ...c,
      items: c.items.filter((i) => i.is_available)
    }))
  };
  // Licensed items are split out rather than filtered away: the section keeps
  // its place in the overview, but never supplies a sample Bella might offer.
  const categories = menu.categories
    .map((c) => ({
      id: c.id,
      name: c.name,
      items: c.items.filter((i) => !i.is_restricted),
      restricted: c.items.filter((i) => i.is_restricted)
    }))
    .filter((c) => c.items.length + c.restricted.length > 0);
  return {
    names: speakList(categories.map((c) => c.name)),
    categories,
    // The sample item a section is introduced with prefers one servable at the
    // reference time — the 8 PM caller should not meet the breakfast toastie
    // as a section's example (call_4e871f4b's cousin failure).
    matches: categories.flatMap((c) => {
      const sample = nowHm
        ? (c.items.find((i) => isWithinDailyWindow(nowHm, i.available_from, i.available_until)) ?? c.items[0])
        : c.items[0];
      return sample ? [toLookupMatch(sample, c.id, nowHm)] : [];
    })
  };
}

// menu_status caps. Cuban Corner has 109 windowed items across an unknown
// number of distinct windows; an unbounded paragraph would bloat every call's
// prompt. Name periods, never items — items are menu_lookup's job.
const MENU_STATUS_MAX_WINDOWS = 4;
const MENU_STATUS_MAX_CHARS = 320;

// Same scrub as venueFaq: `{}` corrupts Retell's variable rendering, control
// characters corrupt the prompt.
function sanitiseForVariable(text: string): string {
  return (
    text
      .replace(/[{}]/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The spoken menu-period sentence for `{{menu_status}}` — pure, so every edge
 * (half-open, midnight-wrap, no windows, over-cap) is unit-testable.
 * "" when the venue has no windowed items: the variable then says nothing and
 * the prompt's fallback behaviour is unchanged (Mazcina today).
 */
export function formatMenuStatus(
  windows: Array<{ available_from: string | null; available_until: string | null; item_count: number }>,
  nowHm: string
): string {
  const windowed = windows.filter((w) => w.available_from || w.available_until);
  if (windowed.length === 0) return "";
  const allDayCount = windows
    .filter((w) => !w.available_from && !w.available_until)
    .reduce((n, w) => n + w.item_count, 0);

  const parts: string[] = [];
  parts.push(
    allDayCount > 0
      ? "Menu right now: the all-day menu is serving."
      : "Menu right now: every section has serving times."
  );
  for (const w of windowed.slice(0, MENU_STATUS_MAX_WINDOWS)) {
    const spoken = formatDailyWindow(w.available_from, w.available_until);
    const active = isWithinDailyWindow(nowHm, w.available_from, w.available_until);
    parts.push(
      active
        ? `Items served ${spoken} are AVAILABLE now.`
        : `Items served ${spoken} are NOT available now.`
    );
  }
  const sentence = sanitiseForVariable(parts.join(" "));
  return sentence.length > MENU_STATUS_MAX_CHARS
    ? `${sentence.slice(0, MENU_STATUS_MAX_CHARS - 1).trimEnd()}…`
    : sentence;
}

/**
 * `{{menu_status}}` for the inbound webhook. Fail-open: any error returns ""
 * with a warning — a menu hiccup must never 500 /retell/inbound, because that
 * kills the entire call (the invalid-timezone incident's lesson).
 */
export async function buildMenuStatus(restaurantId: string, nowHm: string): Promise<string> {
  try {
    const windows = await listMenuItemWindows(restaurantId);
    return formatMenuStatus(windows, nowHm);
  } catch (error) {
    logger.warn({ evt: "menu_status_build_failed", restaurant_id: restaurantId, error });
    return "";
  }
}

/** Row shape formatMenuHighlights needs. Kept structural so the formatter
 * stays pure and testable without a database. */
export interface RecommendableItem {
  name: string;
  base_price_cents: number;
  recommend_rank: number | null;
  is_signature: boolean;
  is_quick_bite: boolean;
  available_from: string | null;
  available_until: string | null;
  category_name: string;
}

// The variable is injected into the prompt on every call, so it competes with
// the prompt for the model's attention. Long enough to carry the owner's list,
// short enough that it cannot swamp the instructions around it.
const MENU_HIGHLIGHTS_MAX_CHARS = 800;

/**
 * The owner's picks, phrased for the agent to read from.
 *
 * Pure on purpose: the DB half is one query and the judgement is all in here,
 * which is what lets this be covered by DB-free tests per the repo's testing
 * doctrine.
 *
 * Items outside their daily window are dropped, not annotated. This list is
 * what the agent recommends UNPROMPTED; offering a breakfast dish to an 8 PM
 * caller and having create_order refuse it is the call_4e871f4b failure, and a
 * recommendation is a worse place for it than a lookup because the caller never
 * asked.
 */
export function formatMenuHighlights(items: RecommendableItem[], nowHm?: string): string {
  const servable = nowHm
    ? items.filter((i) => isWithinDailyWindow(nowHm, i.available_from, i.available_until))
    : items;
  if (servable.length === 0) return "";

  const describe = (i: RecommendableItem): string => {
    const notes = [i.is_signature ? "signature" : null].filter(Boolean).join(", ");
    return `${i.name} (${speakablePrice(i.base_price_cents)}${notes ? `, ${notes}` : ""})`;
  };

  const lines: string[] = [];

  // The quick-to-make pair leads, and crosses sections deliberately: the owner
  // pairs them precisely because one is a Starter and one is a Side.
  const quick = servable.filter((i) => i.is_quick_bite);
  if (quick.length > 0) {
    lines.push(`Quick to make, good while mains cook: ${quick.map(describe).join(", ")}.`);
  }

  const bySection = new Map<string, RecommendableItem[]>();
  for (const item of servable) {
    const list = bySection.get(item.category_name) ?? [];
    list.push(item);
    bySection.set(item.category_name, list);
  }
  for (const [section, sectionItems] of bySection) {
    const ranked = sectionItems
      .slice()
      .sort((a, b) => (a.recommend_rank ?? 0) - (b.recommend_rank ?? 0))
      .map((i, idx) => `${idx + 1}. ${describe(i)}`)
      .join(" ");
    lines.push(`${section} — ${ranked}`);
  }

  // Truncate at a SECTION boundary. A mid-sentence cut would leave the agent
  // reading half a dish name and half a price out loud.
  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + line.length + (out.length > 0 ? 1 : 0);
    if (next > MENU_HIGHLIGHTS_MAX_CHARS) {
      logger.warn({
        evt: "menu_highlights_truncated",
        kept_sections: out.length,
        total_sections: lines.length
      });
      break;
    }
    out.push(line);
    length = next;
  }
  return out.join("\n");
}

/**
 * Fail-open by design: an empty string makes the agent fall back to
 * menu_lookup. A menu problem must never be able to take the phone line down.
 */
export async function buildMenuHighlights(restaurantId: string, nowHm?: string): Promise<string> {
  try {
    const items = await listRecommendedItems(restaurantId);
    return formatMenuHighlights(items as unknown as RecommendableItem[], nowHm);
  } catch (error) {
    logger.warn({ evt: "menu_highlights_build_failed", restaurant_id: restaurantId, error });
    return "";
  }
}

export async function lookupMenu(input: {
  restaurantId: string;
  query?: string;
  category?: string;
  /** Wall-clock reference time (restaurant tz) for window annotations. */
  nowHm?: string;
}): Promise<{
  matches: MenuLookupMatch[];
  speakable_summary: string;
  ambiguous: boolean;
}> {
  const rawQuery = input.query?.trim() ?? "";
  const hasDishQuery = rawQuery.length > 0 && !GENERIC_MENU_QUERY.test(rawQuery);

  // Resolve the section BEFORE deciding which branch answers. This ordering is
  // the whole fix: the query branch used to return before the category
  // parameter was ever read, so `{query:"starters", category:"Starters"}`
  // searched dish names across the entire menu and offered a side and a salad
  // as starters on a real owner call.
  //
  // The overview runs in parallel with the name search, so resolving a section
  // costs no extra wall-clock on the voice path even though it is a second
  // read. Latency is the scarce resource here, not read-pool capacity.
  const overviewPromise = categoryOverview(input.restaurantId, input.nowHm);
  const categoryWord = input.category?.trim()
    ? input.category.trim()
    : hasDishQuery
      ? categoryShapedQuery(rawQuery)
      : null;

  if (hasDishQuery) {
    const [overview, nameMatches] = await Promise.all([
      overviewPromise,
      searchMenuItemsByName(input.restaurantId, rawQuery, 6)
    ]);
    const sectionHits = categoryWord ? resolveCategoryHits(overview.categories, categoryWord) : [];

    // The caller named a SECTION, not a dish ("suggestions for starters") —
    // browse it. Only when the caller's words landed on exactly one section,
    // so a genuine dish query is never hijacked by a stray category word.
    const explicitCategory = Boolean(input.category?.trim());
    if (sectionHits.length === 1 && (explicitCategory || nameMatches.length === 0 || sectionHits[0]!.name.toLowerCase() === categoryWord?.toLowerCase())) {
      return browseCategory(sectionHits, categoryWord ?? sectionHits[0]!.name, overview.names, input.nowHm);
    }
    if (sectionHits.length > 1) {
      return browseCategory(sectionHits, categoryWord ?? "", overview.names, input.nowHm);
    }

    // A dish query WITH a section: scope the search to that section so a
    // starters request can never surface a salad. `matches` is scoped too, not
    // just the spoken summary — create_order consumes `matches`, so scoping
    // only the summary would make Bella say starters and order a salad.
    const matches =
      explicitCategory && sectionHits.length === 1
        ? await searchMenuItemsByName(input.restaurantId, rawQuery, 6, { categoryId: sectionHits[0]!.id })
        : nameMatches;
    if (matches.length === 0) {
      // The old reply hardcoded "mains, salads, kids meals, and drinks" — the
      // FIXTURE menu's categories, spoken verbatim to every venue's callers.
      // Build the miss reply from the venue's real categories instead.
      const names = overview.names;
      return {
        matches: [],
        ambiguous: false,
        speakable_summary: `I couldn't find anything matching ${input.query}. We have ${names}. Would any of those suit?`
      };
    }
    const ambiguous = matches.length > 1 && Math.abs(matches[0]!.similarity - matches[1]!.similarity) < 0.1;
    // Restricted (licensed) items stay IN matches — create_order refuses them
    // with a clean spoken line; filtering here would turn that into a
    // confusing "not found". But the spoken offer must not upsell them.
    const offerable = matches.filter((m) => !m.is_restricted);
    const summarySource = offerable.length > 0 ? offerable : matches;
    const summary = summarySource
      .slice(0, 3)
      .map((m) => {
        const base = `${m.name} (${speakablePrice(m.base_price_cents)})`;
        // Say the window out loud for anything not servable at the reference
        // time, so the agent never offers what the kitchen will refuse.
        if (input.nowHm && !isWithinDailyWindow(input.nowHm, m.available_from, m.available_until)) {
          return `${base} — served ${formatDailyWindow(m.available_from, m.available_until)}, not right now`;
        }
        return base;
      })
      .join(", ");
    // One extra query for the whole match set, not one per item.
    const requiredByItem = await getRequiredModifierGroups(matches.map((m) => m.id));

    return {
      matches: matches.map((m) => {
        const required = requiredByItem.get(m.id);
        return {
          id: m.id,
          name: m.name,
          price: speakablePrice(m.base_price_cents),
          category_id: m.category_id,
          is_restricted: m.is_restricted,
          available_from: m.available_from,
          available_until: m.available_until,
          ...windowFields(m.available_from, m.available_until, input.nowHm),
          ...(required?.length
            ? {
                required_choices: required.map((g) => ({
                  group: g.group_name,
                  options: g.options
                }))
              }
            : {})
        };
      }),
      ambiguous,
      speakable_summary:
        offerable.length === 0
          ? `That's from our licensed drinks list, which I can't take orders for over the phone — but I can pop a note on your order for the team.`
          : input.nowHm &&
              !summarySource
                .slice(0, 3)
                .some((m) => isWithinDailyWindow(input.nowHm!, m.available_from, m.available_until))
            ? // Everything matched is off its window right now — closing with
              // "want one of those?" would invite exactly the order the gate
              // refuses. Redirect instead.
              `We have ${summary}. Would you like something from the current menu instead?`
            : ambiguous
              ? `I have ${summary} — which one?`
              : `We have ${summary}. Want one of those?`
    };
  }

  const overview = await overviewPromise;

  // Category browse ("what drinks do you have?" → category: "drinks"). This
  // parameter was in the tool schema and its Retell description from day one
  // but was silently ignored — the agent browsing drinks got the generic food
  // overview back and told the caller the drinks list was broken.
  if (categoryWord) {
    const hits = resolveCategoryHits(overview.categories, categoryWord);
    if (hits.length > 0 || input.category) {
      return browseCategory(hits, categoryWord, overview.names, input.nowHm);
    }
  }

  // No query (or a generic "the menu" one): speak the category names.
  return {
    matches: overview.matches,
    ambiguous: false,
    speakable_summary: `We have ${overview.names}. What sounds good?`
  };
}

/**
 * Speak one section, or offer the names when the caller's word spans several.
 * Extracted so the query path and the browse path answer a section request
 * identically — they used to diverge, and the query path won.
 */
function browseCategory(
  hits: OverviewCategory[],
  categoryWord: string,
  allNames: string,
  nowHm?: string
): { matches: MenuLookupMatch[]; speakable_summary: string; ambiguous: boolean } {
  // Several sections match — offer their names. Answering from whichever one
  // sorted first is how "what drinks do you have?" used to return the juices
  // and never mention the cocktails.
  if (hits.length > 1) {
    return {
      matches: hits.flatMap((c) => c.items.slice(0, 1).map((i) => toLookupMatch(i, c.id, nowHm))),
      ambiguous: false,
      speakable_summary: `For ${categoryWord} we have ${speakList(hits.map((c) => c.name))}. Which sounds good?`
    };
  }

  const hit = hits[0];
  if (hit) {
    // Speak what she can sell; fall back to the licensed rows so an all-bar
    // section gets described rather than denied.
    const source = hit.items.length > 0 ? hit.items : hit.restricted;
    // Prefer items servable at the reference time. Offering the breakfast
    // toastie to an 8 PM caller is the call_4e871f4b failure: create_order
    // then refuses what Bella just recommended.
    const servable = nowHm
      ? source.filter((i) => isWithinDailyWindow(nowHm, i.available_from, i.available_until))
      : source;
    const usable = servable.length > 0 ? servable : source;
    const offWindow = servable.length === 0 && source.length > 0;
    const items = usable.slice(0, 6);
    const spoken = items
      .slice(0, 4)
      .map((i) => `${i.name} (${speakablePrice(i.base_price_cents)})`)
      .join(", ");
    const tail = offWindow
      ? ` Those aren't served right now, though — want something from the current menu instead?`
      : hit.items.length === 0
        ? " That's our licensed list, so I can't take those orders over the phone — the team will sort you out when you arrive."
        : hit.restricted.length > 0
          ? " There's a licensed list too, which I can't take orders for over the phone. Want any of those?"
          : " Want any of those?";
    return {
      matches: items.map((i) => toLookupMatch(i, hit.id, nowHm)),
      ambiguous: false,
      speakable_summary: `For ${hit.name} we have ${spoken}${usable.length > 4 ? ", and a few more" : ""}.${tail}`
    };
  }
  // Honest miss: the section genuinely isn't on the menu.
  return {
    matches: [],
    ambiguous: false,
    speakable_summary: `We don't have a ${categoryWord} section on the menu. We have ${allNames}. Which would you like?`
  };
}
