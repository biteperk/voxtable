import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { withTransaction } from "../db/pool";
import { logger } from "../utils/logger";
import { MENU_INGEST_MAX_PAGES, menuDraftSchema, type MenuDraft } from "../http/schemas";
import {
  getOrCreateCategory as repoGetOrCreateCategory,
  createMenuItem as repoCreateMenuItem,
  replaceModifiers,
  replaceVariants
} from "../repositories/menu";
import {
  countJobsSince,
  enqueueIngestionJob,
  getIngestionJob,
  markCommitted,
  updateDraft,
  type MenuIngestionJob
} from "../repositories/menuIngestion";
import { assertAllowedMenuSourceUrl, isMenuOcrEnabled } from "./menuOcrClient";

/**
 * Begin an OCR ingestion: rate-limit, then enqueue a job for the worker to
 * parse. The file is already uploaded to storage by the client; we only get its
 * URL + hash here (large binaries never hit our JSON body).
 */
export async function startIngestion(input: {
  restaurantId: string;
  /** Ordered page images, page 1 first. A single photo is an array of one. */
  sourceUrls: string[];
  sourceKind: "image" | "pdf";
  sha256?: string | null;
}): Promise<MenuIngestionJob> {
  if (!isMenuOcrEnabled()) {
    throw new AppError(503, "MENU_OCR_DISABLED", "Menu photo import isn't enabled yet — add your menu manually for now.");
  }

  if (input.sourceUrls.length === 0) {
    throw new AppError(400, "MENU_SOURCE_URL_INVALID", "No menu pages were uploaded. Please try again.");
  }
  if (input.sourceUrls.length > MENU_INGEST_MAX_PAGES) {
    throw new AppError(
      400,
      "MENU_TOO_MANY_PAGES",
      `That menu has more than ${MENU_INGEST_MAX_PAGES} pages. Import the first ${MENU_INGEST_MAX_PAGES} and add the rest in the editor.`
    );
  }

  // EVERY page is checked, not just the first. These URLs are client-supplied
  // and fetched server-side, so validating only one would reopen the SSRF hole
  // the allowlist exists to close — an attacker would simply put the internal
  // address on page 2. Rejected before a job row exists so the caller gets an
  // immediate 400 rather than a failure minutes later in the worker; the worker
  // re-checks at fetch time, which is the actual guarantee.
  for (const url of input.sourceUrls) assertAllowedMenuSourceUrl(url);

  // Abuse/cost cap: bound parses per restaurant per rolling 24h. Deliberately
  // counted per JOB, not per page — a 12-page menu is one import to the owner,
  // and the per-job page cap above is what bounds the vision spend inside it.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await countJobsSince(input.restaurantId, since);
  if (recent >= env.MENU_OCR_MAX_JOBS_PER_DAY) {
    throw new AppError(
      429,
      "MENU_OCR_RATE_LIMITED",
      "You've reached today's menu-import limit. Please try again tomorrow or add items manually."
    );
  }

  return enqueueIngestionJob({
    restaurantId: input.restaurantId,
    sourceKind: input.sourceKind,
    sourceUrls: input.sourceUrls,
    sha256: input.sha256 ?? null
  });
}

export async function getIngestionResult(
  jobId: string,
  restaurantId: string
): Promise<MenuIngestionJob> {
  const job = await getIngestionJob(jobId, restaurantId);
  if (!job) throw new AppError(404, "INGESTION_NOT_FOUND", "Menu import not found.");
  return job;
}

export async function saveDraft(
  jobId: string,
  restaurantId: string,
  draft: MenuDraft
): Promise<MenuIngestionJob> {
  const validated = menuDraftSchema.parse(draft);
  const updated = await updateDraft(jobId, restaurantId, validated);
  if (!updated) {
    throw new AppError(409, "INGESTION_NOT_EDITABLE", "This menu import can't be edited (not in review state).");
  }
  return updated;
}

/**
 * Commit a reviewed draft to real menu items — the ONLY write path into the
 * menu from OCR. Fully atomic: the whole menu lands in one transaction (reusing
 * the validated menu repo), so a failure mid-way writes nothing and the owner
 * can safely retry. Idempotent: a job already committed is a no-op.
 */
export async function commitDraft(jobId: string, restaurantId: string): Promise<{ categories: number; items: number }> {
  const job = await getIngestionJob(jobId, restaurantId);
  if (!job) throw new AppError(404, "INGESTION_NOT_FOUND", "Menu import not found.");
  if (job.status === "committed") return { categories: 0, items: 0 };
  if (job.status !== "parsed") {
    throw new AppError(409, "INGESTION_NOT_READY", "This menu import isn't ready to commit yet.");
  }

  const draft = menuDraftSchema.parse(job.parsed_draft ?? { categories: [] });
  if (draft.categories.length === 0) {
    throw new AppError(400, "MENU_EMPTY", "There's nothing to import — the parsed menu is empty.");
  }

  const counts = await withTransaction(async (db) => {
    let itemCount = 0;
    let catIndex = 0;
    for (const category of draft.categories) {
      catIndex += 1;
      // get-or-create: a repeated or already-existing heading must not abort the import.
      const cat = await repoGetOrCreateCategory(
        { restaurantId, name: category.name, displayOrder: catIndex },
        db
      );
      let itemIndex = 0;
      for (const item of category.items) {
        itemIndex += 1;
        const created = await repoCreateMenuItem(
          {
            restaurantId,
            categoryId: cat.id,
            name: item.name,
            description: item.description,
            basePriceCents: item.price_cents,
            displayOrder: itemIndex,
            availableFrom: item.available_from ?? null,
            availableUntil: item.available_until ?? null,
            isRestricted: item.is_restricted ?? false
          },
          db
        );
        if (item.variants?.length) {
          await replaceVariants(
            created.id,
            item.variants.map((v, i) => ({
              name: v.name,
              priceDeltaCents: v.price_delta_cents,
              displayOrder: i
            })),
            db
          );
        }
        if (item.modifier_groups?.length) {
          const flat = item.modifier_groups.flatMap((g) =>
            g.options.map((o, i) => ({
              groupName: g.group_name,
              name: o.name,
              priceDeltaCents: o.price_delta_cents,
              groupMinSelect: g.min_select,
              groupMaxSelect: g.max_select,
              isDefault: o.is_default ?? false,
              displayOrder: i
            }))
          );
          await replaceModifiers(created.id, flat, db);
        }
        itemCount += 1;
      }
    }
    // Loses the race to a concurrent commit → roll the whole insert back rather
    // than duplicating the menu. The caller retries and gets the no-op above.
    const claimed = await markCommitted(job.id, db);
    if (!claimed) {
      throw new AppError(409, "INGESTION_ALREADY_COMMITTED", "This menu import was already imported.");
    }
    return { categories: draft.categories.length, items: itemCount };
  });

  logger.info({
    evt: "menu_ingestion_committed",
    job_id: job.id,
    restaurant_id: restaurantId,
    categories: counts.categories,
    items: counts.items
  });
  return counts;
}
