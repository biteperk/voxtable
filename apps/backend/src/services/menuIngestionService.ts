import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { withTransaction } from "../db/pool";
import { logger } from "../utils/logger";
import { menuDraftSchema, type MenuDraft } from "../http/schemas";
import {
  createCategory as repoCreateCategory,
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
import { isMenuOcrEnabled } from "./menuOcrClient";

/**
 * Begin an OCR ingestion: rate-limit, then enqueue a job for the worker to
 * parse. The file is already uploaded to storage by the client; we only get its
 * URL + hash here (large binaries never hit our JSON body).
 */
export async function startIngestion(input: {
  restaurantId: string;
  sourceUrl: string;
  sourceKind: "image" | "pdf";
  sha256?: string | null;
}): Promise<MenuIngestionJob> {
  if (!isMenuOcrEnabled()) {
    throw new AppError(503, "MENU_OCR_DISABLED", "Menu photo import isn't enabled yet — add your menu manually for now.");
  }

  // Abuse/cost cap: bound parses per restaurant per rolling 24h.
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
    sourceUrl: input.sourceUrl,
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
      const cat = await repoCreateCategory(
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
            displayOrder: itemIndex
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
    await markCommitted(job.id, db);
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
