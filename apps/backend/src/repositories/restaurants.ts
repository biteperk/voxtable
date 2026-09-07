import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";
import { DEFAULT_OPENING_HOURS, RestaurantSettings } from "../domain/types";
import { DbClient, pool, withTransaction } from "../db/pool";
import { normalizePhone } from "../utils/phone";

export type OnboardingStatus =
  | "account_created"
  | "profile"
  | "agreement"
  | "menu"
  | "trial"
  | "provisioning"
  | "live"
  | "suspended"
  | "cancelled";

export interface RestaurantProfile {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  cuisine_type: string[] | null;
  contact_email: string | null;
  owner_name: string | null;
  logo_url: string | null;
  existing_phone_number: string | null;
  onboarding_status: OnboardingStatus;
  onboarding_completed_at: string | null;
}

interface RestaurantSettingsRow {
  restaurant_id: string;
  booking_duration_minutes: number;
  opening_hours_json: Record<string, unknown>;
  faq_json: Record<string, unknown>;
  voice_config_json: Record<string, unknown>;
}

export async function getRestaurantSettings(
  restaurantId: string,
  db: DbClient = pool
): Promise<RestaurantSettings> {
  const result = await db.query<RestaurantSettingsRow>(
    `
    SELECT
      restaurant_id,
      booking_duration_minutes,
      opening_hours_json,
      faq_json,
      voice_config_json
    FROM restaurant_settings
    WHERE restaurant_id = $1
    `,
    [restaurantId]
  );

  const row = result.rows[0];

  if (!row) {
    throw new AppError(404, "RESTAURANT_SETTINGS_NOT_FOUND", "Restaurant settings were not found.");
  }

  return {
    restaurantId: row.restaurant_id,
    bookingDurationMinutes: row.booking_duration_minutes,
    openingHours: row.opening_hours_json as RestaurantSettings["openingHours"],
    faq: row.faq_json,
    voiceConfig: row.voice_config_json
  };
}

export async function getTransferPhoneNumber(restaurantId: string): Promise<string | null> {
  const result = await pool.query<{ transfer_phone_number: string | null }>(
    "SELECT transfer_phone_number FROM restaurants WHERE id = $1",
    [restaurantId]
  );

  return result.rows[0]?.transfer_phone_number ?? null;
}

/**
 * Memoised per restaurant. Every entry expires.
 *
 * These are read on the inbound-call path (the venue name and time zone go into
 * the dynamic variables Bella speaks), so caching them is worth it — but each
 * api/worker process holds its OWN Map, and `invalidateRestaurantCache` only
 * reaches the process that served the write. A rename through one instance is
 * invisible to the others, and a rename by direct SQL — which the runbooks
 * legitimately do — is invisible to all of them. Without expiry, warm instances
 * would keep telling callers the venue's OLD name until the next deploy.
 *
 * A minute of staleness after a rename is acceptable; indefinite is not.
 */
const RESTAURANT_FIELD_TTL_MS = 60_000;

interface CachedField<T> {
  value: T;
  expiresAt: number;
}

function readCache<T>(cache: Map<string, CachedField<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache<T>(cache: Map<string, CachedField<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + RESTAURANT_FIELD_TTL_MS });
}

const timezoneCache = new Map<string, CachedField<string>>();
const nameCache = new Map<string, CachedField<string>>();
// Maps a trusted dialed number (E.164) -> restaurant id. Immutable per number
// in normal operation, but a number CAN be released and reassigned to a
// different tenant, so the entry is invalidated whenever provisioning bindings
// change (see invalidateRestaurantCache). Keyed by normalized number; the
// value carries the restaurant id so we can purge by restaurant on rebind.
//
// The entry also expires. Purging by restaurant id alone is not sufficient:
// when number N moves from venue A to venue B, the poisoned entry is keyed by
// N and holds A's id, so a purge scoped to B deletes nothing and every call to
// N keeps reaching A. Callers therefore purge by NUMBER too (below) — and the
// TTL is the backstop for the rebinds that never reach this process at all:
// the runbooks legitimately rebind by direct SQL, and each api/worker instance
// holds its own Map, so a bind through one instance is invisible to the others.
// Without expiry those instances would route to the old venue until restart.
const DIALED_NUMBER_TTL_MS = 60_000;
interface DialedNumberEntry {
  restaurantId: string;
  expiresAt: number;
}
const dialedNumberCache = new Map<string, DialedNumberEntry>();

// Maps a Cal.com event type id -> restaurant id, so an inbound Cal.com webhook
// can resolve its tenant the same way an inbound call resolves one from the
// dialed number. Identical hazard, identical shape, identical consequence if
// got wrong: a diner booking venue B lands on venue A's floor.
//
// Hits only, and it expires. An event type moved from venue A to venue B leaves
// an entry keyed by the EVENT TYPE holding A's id, so a purge scoped to B
// deletes nothing — callers must purge by event type id too (see
// invalidateRestaurantCache). The TTL is the backstop for rebinds that never
// reach this process: runbooks rebind by direct SQL, and each api/worker
// instance holds its own Map. Negative results are deliberately NOT cached, so
// binding a venue later is visible within one query rather than at restart.
const calcomEventTypeCache = new Map<number, DialedNumberEntry>();

export async function getRestaurantTimezone(restaurantId: string): Promise<string> {
  const cached = readCache(timezoneCache, restaurantId);
  if (cached) return cached;

  const result = await pool.query<{ timezone: string }>(
    "SELECT timezone FROM restaurants WHERE id = $1",
    [restaurantId]
  );

  const tz = coerceUsableTimezone(result.rows[0]?.timezone, restaurantId);
  writeCache(timezoneCache, restaurantId, tz);
  return tz;
}

/**
 * Never hand an unusable time zone to Intl.
 *
 * utils/time.ts passes this value straight to Intl.DateTimeFormat, which
 * throws RangeError on anything that is not a real IANA zone. handleRetellInbound
 * calls four of those helpers, so one bad row meant every inbound call for that
 * venue 500'd and Retell could not start the call at all — a dead phone line
 * from a profile-form typo.
 *
 * schemas.ts now refuses bad zones on the way in, but that only protects new
 * writes. A row saved before that, or written by SQL, still has to not kill the
 * line. A wrong-but-working zone shifts times; an invalid one answers nothing.
 * The first is recoverable, so it is the safer failure — logged at error, since
 * silently serving the wrong times is exactly the sort of thing that should
 * page someone.
 */
export function coerceUsableTimezone(timezone: string | undefined, restaurantId: string): string {
  const fallback = "Australia/Sydney";
  if (!timezone) return fallback;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: timezone });
    return timezone;
  } catch {
    logger.error({
      evt: "restaurant_timezone_invalid",
      restaurant_id: restaurantId,
      timezone,
      fallback,
      detail: "stored timezone is not a valid IANA zone; falling back so calls still answer"
    });
    return fallback;
  }
}

export async function getRestaurantName(restaurantId: string): Promise<string> {
  const cached = readCache(nameCache, restaurantId);
  if (cached) return cached;

  const result = await pool.query<{ name: string }>(
    "SELECT name FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  const name = result.rows[0]?.name ?? "the restaurant";
  writeCache(nameCache, restaurantId, name);
  return name;
}

/**
 * The name Bella uses when offering a callback ("let me get <owner> to ring you
 * back"). Sent as a dynamic variable so no venue's owner is ever written into a
 * prompt — the live Natalia prompt hard-coded "Natalia" there, which is why a
 * cloned agent kept naming the wrong person even after its venue name was
 * changed (venue-onboarding.md §1 trap 3).
 *
 * Falls back to a neutral phrase: `owner_name` is optional on the profile, and
 * an unset column must never reach a caller as an empty gap or a literal
 * placeholder.
 */
export async function getRestaurantOwnerName(restaurantId: string): Promise<string> {
  const result = await pool.query<{ owner_name: string | null }>(
    "SELECT owner_name FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  const owner = result.rows[0]?.owner_name?.trim();
  return owner ? owner : "the manager";
}

export interface RestaurantVoiceContext {
  name: string;
  ownerName: string;
  timezone: string;
  faq: Record<string, unknown>;
  /** opening_hours_json as stored; {} when the venue has no settings row. */
  openingHours: Record<string, unknown>;
}

const voiceContextCache = new Map<string, CachedField<RestaurantVoiceContext>>();

/**
 * Everything /retell/inbound needs to greet a caller, in ONE query.
 *
 * Call setup used to fire four separate SELECTs against the same `restaurants`
 * row — timezone, name, owner name, agent id — and adding the venue FAQ would
 * have made five, plus a sixth against `restaurant_settings` (which
 * getRestaurantSettings reads uncached). That all runs while the caller is
 * waiting to hear anything, on the same latency budget we are already spending
 * on a richer voice model.
 *
 * `retell_agent_id` is deliberately NOT folded in here: getRetellAgentId stays
 * uncached so a rebind takes effect on the very next call. After the mis-bind
 * incident that immediacy is worth its own round trip.
 *
 * The other getters stay too — calcomService, retellVariablesWorker and
 * orderPaymentService use them, and consolidating those callers is a separate,
 * riskier change than this one.
 *
 * LEFT JOIN, not JOIN: a restaurant without a settings row must still answer the
 * phone with its name and time zone rather than failing the whole call.
 */
export async function getRestaurantVoiceContext(
  restaurantId: string
): Promise<RestaurantVoiceContext> {
  const cached = readCache(voiceContextCache, restaurantId);
  if (cached) return cached;

  const result = await pool.query<{
    name: string | null;
    owner_name: string | null;
    timezone: string | null;
    faq_json: Record<string, unknown> | null;
    opening_hours_json: Record<string, unknown> | null;
  }>(
    `SELECT r.name, r.owner_name, r.timezone, s.faq_json, s.opening_hours_json
       FROM restaurants r
       LEFT JOIN restaurant_settings s ON s.restaurant_id = r.id
      WHERE r.id = $1`,
    [restaurantId]
  );

  const row = result.rows[0];
  const context: RestaurantVoiceContext = {
    name: row?.name ?? "the restaurant",
    ownerName: row?.owner_name?.trim() ? row.owner_name.trim() : "the manager",
    timezone: coerceUsableTimezone(row?.timezone ?? undefined, restaurantId),
    faq: row?.faq_json ?? {},
    openingHours: row?.opening_hours_json ?? {}
  };

  writeCache(voiceContextCache, restaurantId, context);
  return context;
}

/**
 * Resolve the restaurant for an inbound call from the TRUSTED dialed number
 * (the number the caller rang, supplied by Twilio/Retell — never the LLM).
 * This is the security-critical tenant key for the voice path. Returns null
 * when the number maps to no restaurant; the caller MUST fail safe (a polite
 * "not configured" response) rather than fall back to a default tenant in
 * production, otherwise a misconfigured call books at the wrong restaurant.
 *
 * Numbers are stored normalized to E.164 (007 + provisioning), so we normalize
 * the lookup the same way; `+61…` and `0…` forms both resolve. Memoized with
 * invalidation on rebind via invalidateRestaurantCache.
 */
export async function getRestaurantIdByDialedNumber(
  toNumber: string | null | undefined
): Promise<string | null> {
  const normalized = normalizePhone(toNumber) ?? (toNumber?.trim() || null);
  if (!normalized) return null;

  const cached = dialedNumberCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.restaurantId;

  // ORDER BY makes the result deterministic. Migration 007 gives each number
  // column its own partial unique index, but they are per-column: one venue's
  // twilio_phone_number may legally equal another's retell_phone_number, and
  // this OR would then let the planner decide which venue answers the phone.
  // Migration 034 rejects that state on write; the sort keeps an existing row
  // pair from routing differently between two queries in the meantime.
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM restaurants
      WHERE twilio_phone_number = $1 OR retell_phone_number = $1
      ORDER BY id
      LIMIT 1`,
    [normalized]
  );
  const id = result.rows[0]?.id ?? null;
  if (id) {
    dialedNumberCache.set(normalized, {
      restaurantId: id,
      expiresAt: Date.now() + DIALED_NUMBER_TTL_MS
    });
  }
  return id;
}

/**
 * Which venue owns this Cal.com event type. The inbound webhook carries
 * `eventTypeId`, so this is how a web booking finds its tenant — the Cal.com
 * equivalent of resolving a call from the dialed number, and it exists for the
 * same reason: before it, every inbound Cal.com booking was hardcoded to
 * DEFAULT_RESTAURANT_ID, which is correct with exactly one venue and a
 * cross-tenant bug with two.
 *
 * Returns null when nothing claims the event type. Callers MUST fail closed on
 * null in production rather than falling back to a default — a guest already
 * holds a Cal.com confirmation email at this point, so guessing a venue seats
 * them at a restaurant that has no idea they are coming.
 */
export async function getRestaurantIdByCalcomEventTypeId(
  eventTypeId: number | null | undefined
): Promise<string | null> {
  if (typeof eventTypeId !== "number" || !Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    return null;
  }

  const cached = calcomEventTypeCache.get(eventTypeId);
  if (cached && cached.expiresAt > Date.now()) return cached.restaurantId;

  // Migration 035's partial unique index makes at most one row match. ORDER BY
  // keeps the result deterministic anyway, matching the dialed-number lookup:
  // the index rejects a duplicate on write, but a pair that predates it must
  // not resolve differently between two queries.
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM restaurants
      WHERE calcom_event_type_id = $1
      ORDER BY id
      LIMIT 1`,
    [eventTypeId]
  );
  const id = result.rows[0]?.id ?? null;
  if (id) {
    calcomEventTypeCache.set(eventTypeId, {
      restaurantId: id,
      expiresAt: Date.now() + DIALED_NUMBER_TTL_MS
    });
  }
  return id;
}

/**
 * This venue's Cal.com event type, or null when it has none.
 *
 * The outbound gate reads this: a venue with no event type is not mirrored, and
 * that is the per-venue opt-in. It has to be checked at ENQUEUE time — an
 * outbox row written for an unbound venue can only ever dead-letter, and
 * healthAlerter pages Slack at a dead-letter threshold of zero, so "this venue
 * doesn't use Cal.com" would read as a continuous incident.
 *
 * Deliberately NOT cached. It is read once per booking on a path that already
 * does far more work than one indexed lookup, and a stale answer here means
 * either a silently unmirrored booking or a row that dead-letters — both worse
 * than the query.
 *
 * ⚠️ Callers inside a transaction MUST pass their client. `createBooking` calls
 * this while holding the per-day advisory lock, so defaulting to the pool there
 * takes a SECOND write connection per booking — halving effective concurrency
 * and, at pool max, starving itself: every connection held by a booking waiting
 * for a connection nobody can release. pool.ts documents that max was raised
 * precisely because one-connection-per-booking was already the bottleneck.
 */
export async function getRestaurantCalcomEventTypeId(
  restaurantId: string,
  db: DbClient = pool
): Promise<number | null> {
  const result = await db.query<{ calcom_event_type_id: number | null }>(
    "SELECT calcom_event_type_id FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  return result.rows[0]?.calcom_event_type_id ?? null;
}

/**
 * Drop all memoized values for a restaurant. Call after any write that changes
 * a restaurant's name, timezone, or dialed-number bindings (profile edit,
 * provisioning bind/unbind) so stale cache entries can't route calls or render
 * names for the wrong/old value.
 *
 * `numbers` must carry every number involved in the write — both the ones being
 * bound and the ones being cleared. Purging by restaurant id only finds entries
 * that already point AT this restaurant; an entry for a number being taken FROM
 * another venue points at that other venue and survives, which is a silent
 * wrong-venue route until the process restarts.
 *
 * `eventTypeIds` carries the same obligation for Cal.com bindings, with the same
 * consequence in a different channel: a surviving entry sends the new venue's
 * online diners to the old venue's floor.
 */
export function invalidateRestaurantCache(
  restaurantId: string,
  numbers: Array<string | null | undefined> = [],
  eventTypeIds: Array<number | null | undefined> = []
): void {
  timezoneCache.delete(restaurantId);
  nameCache.delete(restaurantId);
  voiceContextCache.delete(restaurantId);
  for (const [number, entry] of dialedNumberCache) {
    if (entry.restaurantId === restaurantId) dialedNumberCache.delete(number);
  }
  for (const raw of numbers) {
    if (!raw) continue;
    dialedNumberCache.delete(normalizePhone(raw) ?? raw.trim());
  }
  for (const [eventTypeId, entry] of calcomEventTypeCache) {
    if (entry.restaurantId === restaurantId) calcomEventTypeCache.delete(eventTypeId);
  }
  // Same reason the numbers are passed explicitly: an event type being taken
  // FROM another venue has a cache entry pointing at that other venue, and a
  // purge scoped to this restaurant id leaves it in place.
  for (const eventTypeId of eventTypeIds) {
    if (typeof eventTypeId !== "number") continue;
    calcomEventTypeCache.delete(eventTypeId);
  }
}

/**
 * Pre-populate the timezone + name caches before the first inbound call after
 * a container restart. Retell holds the SIP leg open waiting for our
 * `/retell/inbound` response — a cold DB hit there is audible silence to the
 * caller. Called from `server.ts` before binding the port.
 *
 * Single combined query so the warm path costs one round-trip, not two.
 * Non-fatal on failure (the caller logs and proceeds — caches will populate
 * lazily on the first real request).
 */
export async function warmRestaurantCache(restaurantId: string): Promise<void> {
  const result = await pool.query<{ name: string | null; timezone: string | null }>(
    "SELECT name, timezone FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.timezone) writeCache(timezoneCache, restaurantId, row.timezone);
  if (row.name) writeCache(nameCache, restaurantId, row.name);
}

// --- Onboarding & profile (migration 008) ----------------------------------

const PROFILE_COLUMNS = `
  id, name, timezone, address, suburb, state, postcode, cuisine_type,
  contact_email, owner_name, logo_url, existing_phone_number,
  onboarding_status, onboarding_completed_at
`;

export async function getRestaurantProfile(
  restaurantId: string,
  db: DbClient = pool
): Promise<RestaurantProfile | null> {
  const result = await db.query<RestaurantProfile>(
    `SELECT ${PROFILE_COLUMNS} FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  return result.rows[0] ?? null;
}

export async function getOnboardingStatus(
  restaurantId: string,
  db: DbClient = pool
): Promise<OnboardingStatus | null> {
  const result = await db.query<{ onboarding_status: OnboardingStatus }>(
    "SELECT onboarding_status FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  return result.rows[0]?.onboarding_status ?? null;
}

export async function setOnboardingStatus(
  restaurantId: string,
  status: OnboardingStatus,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `UPDATE restaurants
        SET onboarding_status = $2::onboarding_status,
            onboarding_completed_at = CASE WHEN $2 = 'live'
              THEN COALESCE(onboarding_completed_at, now()) ELSE onboarding_completed_at END
      WHERE id = $1`,
    [restaurantId, status]
  );
}

/**
 * COALESCE-patch the restaurant's profile fields. Only provided keys change.
 * Invalidates the name/timezone caches since either may have moved.
 */
export async function updateRestaurantProfile(
  restaurantId: string,
  patch: {
    name?: string;
    timezone?: string;
    address?: string | null;
    suburb?: string | null;
    state?: string | null;
    postcode?: string | null;
    cuisineType?: string[] | null;
    contactEmail?: string | null;
    ownerName?: string | null;
    logoUrl?: string | null;
    existingPhoneNumber?: string | null;
  },
  db: DbClient = pool
): Promise<RestaurantProfile> {
  const result = await db.query<RestaurantProfile>(
    `
    UPDATE restaurants SET
      name = COALESCE($2, name),
      timezone = COALESCE($3, timezone),
      address = COALESCE($4, address),
      suburb = COALESCE($5, suburb),
      state = COALESCE($6, state),
      postcode = COALESCE($7, postcode),
      cuisine_type = COALESCE($8, cuisine_type),
      contact_email = COALESCE($9, contact_email),
      owner_name = COALESCE($10, owner_name),
      logo_url = COALESCE($11, logo_url),
      existing_phone_number = COALESCE($12, existing_phone_number)
    WHERE id = $1
    RETURNING ${PROFILE_COLUMNS}
    `,
    [
      restaurantId,
      patch.name ?? null,
      patch.timezone ?? null,
      patch.address ?? null,
      patch.suburb ?? null,
      patch.state ?? null,
      patch.postcode ?? null,
      patch.cuisineType ?? null,
      patch.contactEmail ?? null,
      patch.ownerName ?? null,
      patch.logoUrl ?? null,
      patch.existingPhoneNumber ?? null
    ]
  );
  if (!result.rows[0]) {
    throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
  }
  invalidateRestaurantCache(restaurantId);
  return result.rows[0];
}

/**
 * Patch booking duration / opening hours into restaurant_settings. The row is
 * created by createRestaurantWithOwner, so this is an UPDATE.
 */
export async function upsertRestaurantSettings(
  restaurantId: string,
  patch: { bookingDurationMinutes?: number; openingHours?: unknown },
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `
    INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes, opening_hours_json)
    VALUES ($1, COALESCE($2, 90), COALESCE($3::jsonb, $4::jsonb))
    ON CONFLICT (restaurant_id) DO UPDATE SET
      booking_duration_minutes = COALESCE($2, restaurant_settings.booking_duration_minutes),
      opening_hours_json = COALESCE($3::jsonb, restaurant_settings.opening_hours_json)
    `,
    [
      restaurantId,
      patch.bookingDurationMinutes ?? null,
      patch.openingHours === undefined ? null : JSON.stringify(patch.openingHours),
      JSON.stringify(DEFAULT_OPENING_HOURS)
    ]
  );
}

/**
 * Create a restaurant and its owner membership + a default settings row in one
 * transaction. Returns the new restaurant id (+ whether it already existed).
 * Status starts at 'account_created' so the wizard routes the owner through
 * onboarding.
 *
 * Idempotent under concurrency: takes a per-owner transaction-scoped advisory
 * lock and re-checks membership INSIDE the transaction before inserting, so two
 * simultaneous create submits from one owner can never create two tenants (v1 =
 * one restaurant per owner). A raced duplicate returns the existing tenant with
 * `existing: true`.
 */
export async function createRestaurantWithOwner(input: {
  name: string;
  ownerUserId: string;
  ownerName?: string | null;
  contactEmail?: string | null;
  timezone?: string;
}): Promise<{ restaurantId: string; existing: boolean }> {
  return withTransaction(async (db) => {
    // Serialize concurrent creates for the SAME owner (lock key derived from
    // the uid; other owners proceed freely).
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `onboard:${input.ownerUserId}`
    ]);

    // Re-check inside the lock: if this owner already has a membership, return
    // it rather than creating a second tenant.
    const prior = await db.query<{ restaurant_id: string }>(
      `SELECT restaurant_id FROM restaurant_members
        WHERE user_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [input.ownerUserId]
    );
    if (prior.rows[0]) {
      return { restaurantId: prior.rows[0].restaurant_id, existing: true };
    }

    const restaurant = await db.query<{ id: string }>(
      `INSERT INTO restaurants (name, timezone, owner_name, contact_email, onboarding_status)
       VALUES ($1, $2, $3, $4, 'account_created')
       RETURNING id`,
      [input.name, input.timezone ?? "Australia/Sydney", input.ownerName ?? null, input.contactEmail ?? null]
    );
    const restaurantId = restaurant.rows[0]!.id;

    await db.query(
      `INSERT INTO restaurant_members (user_id, restaurant_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, restaurant_id) DO UPDATE SET role = 'owner'`,
      [input.ownerUserId, restaurantId]
    );

    await db.query(
      `INSERT INTO restaurant_settings (restaurant_id, opening_hours_json) VALUES ($1, $2::jsonb)
       ON CONFLICT (restaurant_id) DO NOTHING`,
      [restaurantId, JSON.stringify(DEFAULT_OPENING_HOURS)]
    );

    return { restaurantId, existing: false };
  });
}

// --- Billing (Phase 3) -----------------------------------------------------

export async function getStripeCustomerId(
  restaurantId: string,
  db: DbClient = pool
): Promise<string | null> {
  const result = await db.query<{ stripe_customer_id: string | null }>(
    "SELECT stripe_customer_id FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  return result.rows[0]?.stripe_customer_id ?? null;
}

export async function setStripeCustomerId(
  restaurantId: string,
  customerId: string,
  db: DbClient = pool
): Promise<void> {
  await db.query("UPDATE restaurants SET stripe_customer_id = $2 WHERE id = $1", [
    restaurantId,
    customerId
  ]);
}

/**
 * Reverse lookup for webhook reconciliation: which restaurant owns a Stripe
 * customer. Used as a fallback when an event lacks our restaurant_id metadata.
 */
export async function findRestaurantIdByStripeCustomerId(
  customerId: string,
  db: DbClient = pool
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM restaurants WHERE stripe_customer_id = $1 LIMIT 1",
    [customerId]
  );
  return result.rows[0]?.id ?? null;
}

// --- Stripe Connect (voice-order payments) ----------------------------------

export interface ConnectAccountState {
  stripe_connect_account_id: string | null;
  stripe_connect_charges_enabled: boolean;
  stripe_connect_payouts_enabled: boolean;
}

export async function getConnectAccountState(
  restaurantId: string,
  db: DbClient = pool
): Promise<ConnectAccountState | null> {
  const result = await db.query<ConnectAccountState>(
    `SELECT stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled
     FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  return result.rows[0] ?? null;
}

export async function setConnectAccountId(
  restaurantId: string,
  accountId: string,
  db: DbClient = pool
): Promise<void> {
  await db.query("UPDATE restaurants SET stripe_connect_account_id = $2 WHERE id = $1", [
    restaurantId,
    accountId
  ]);
}

/**
 * account.updated events carry no metadata/customer — the connected-account id
 * (event.account) is the only handle, resolved against the unique index.
 */
export async function findRestaurantIdByConnectAccountId(
  accountId: string,
  db: DbClient = pool
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM restaurants WHERE stripe_connect_account_id = $1 LIMIT 1",
    [accountId]
  );
  return result.rows[0]?.id ?? null;
}

export async function updateConnectCapabilities(
  restaurantId: string,
  chargesEnabled: boolean,
  payoutsEnabled: boolean,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `UPDATE restaurants
     SET stripe_connect_charges_enabled = $2, stripe_connect_payouts_enabled = $3
     WHERE id = $1`,
    [restaurantId, chargesEnabled, payoutsEnabled]
  );
}

// --- Provisioning (Phase 4) ------------------------------------------------

export interface ProvisioningRow {
  id: string;
  name: string;
  contact_email: string | null;
  onboarding_status: OnboardingStatus;
  twilio_phone_number: string | null;
  retell_phone_number: string | null;
  retell_agent_id: string | null;
  calcom_event_type_id: number | null;
  created_at: string;
  // Bumped by the set_restaurants_updated_at trigger on every UPDATE, so it
  // doubles as the optimistic-concurrency token the admin drawer sends back as
  // If-Match.
  updated_at: string;
}

/** Counts of restaurants currently in each onboarding status (funnel snapshot). */
export async function getOnboardingFunnel(): Promise<Record<string, number>> {
  const result = await pool.query<{ onboarding_status: string; n: string }>(
    "SELECT onboarding_status, COUNT(*)::text AS n FROM restaurants GROUP BY onboarding_status"
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) out[row.onboarding_status] = Number(row.n);
  return out;
}

/**
 * Mark abandoned onboardings as cancelled: restaurants stuck before billing
 * (account_created/profile/menu) with no activity past `days`. Returns count.
 * These never reached provisioning, so no phone numbers were reserved.
 */
export async function cancelAbandonedOnboarding(days: number): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `UPDATE restaurants
        SET onboarding_status = 'cancelled'
      WHERE onboarding_status IN ('account_created', 'profile', 'agreement', 'menu')
        AND updated_at < now() - ($1 || ' days')::interval
      RETURNING id`,
    [String(days)]
  );
  return result.rowCount ?? 0;
}

export async function listByOnboardingStatus(
  status: OnboardingStatus
): Promise<ProvisioningRow[]> {
  const result = await pool.query<ProvisioningRow>(
    `SELECT id, name, contact_email, onboarding_status,
            twilio_phone_number, retell_phone_number, retell_agent_id,
            calcom_event_type_id, created_at, updated_at
       FROM restaurants
      WHERE onboarding_status = $1::onboarding_status
      ORDER BY created_at ASC`,
    [status]
  );
  return result.rows;
}

/** ProvisioningRow plus the cheap local billing/legal columns the admin venue
 * list shows. Live Stripe subscription state is deliberately NOT here — that
 * is one Stripe API call per venue and loads lazily per-venue instead. */
export interface AdminRestaurantRow extends ProvisioningRow {
  terms_version: string | null;
  has_stripe_customer: boolean;
  stripe_connect_charges_enabled: boolean;
  stripe_connect_payouts_enabled: boolean;
  // Readiness, computed server-side so the list and the drawer cannot
  // disagree about whether a venue can actually take a call.
  voice_paused_at: Date | null;
  menu_item_count: number;
  table_count: number;
  hours_set: boolean;
  last_call_at: Date | null;
  last_booking_at: Date | null;
}

export interface AdminRestaurantListPage {
  rows: AdminRestaurantRow[];
  total: number;
}

/**
 * The admin venue list, one page at a time.
 *
 * Two things this deliberately does that the old version did not. It reports
 * the TOTAL matching count (via a window function over the filtered set, so it
 * costs no second query) — the previous `LIMIT 200` truncated silently, and an
 * operator had no way to know a venue existed beyond the cut. And it carries
 * the readiness figures the list needs to be triaged without expanding every
 * row: a venue's own pause state, whether it has a menu, tables and hours, and
 * when it last took a call or a booking. Those were computed in the browser
 * from partial data, so the list and the drawer could disagree about the same
 * venue.
 */
export async function listRestaurantsAdmin(filter: {
  status?: OnboardingStatus;
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<AdminRestaurantListPage> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`r.onboarding_status = $${params.length}::onboarding_status`);
  }
  if (filter.query) {
    params.push(`%${filter.query}%`);
    clauses.push(`(r.name ILIKE $${params.length} OR r.contact_email ILIKE $${params.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const offset = Math.max(filter.offset ?? 0, 0);
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const result = await pool.query<AdminRestaurantRow & { total_count: string }>(
    `SELECT r.id, r.name, r.contact_email, r.onboarding_status,
            r.twilio_phone_number, r.retell_phone_number, r.retell_agent_id,
            r.calcom_event_type_id, r.created_at,
            r.terms_version,
            r.stripe_customer_id IS NOT NULL AS has_stripe_customer,
            r.stripe_connect_charges_enabled, r.stripe_connect_payouts_enabled,
            r.voice_paused_at,
            (SELECT COUNT(*) FROM menu_items m WHERE m.restaurant_id = r.id)::int AS menu_item_count,
            (SELECT COUNT(*) FROM tables t WHERE t.restaurant_id = r.id AND t.is_active)::int AS table_count,
            COALESCE(
              (SELECT s.opening_hours_json IS NOT NULL AND s.opening_hours_json::text <> '{}'
                 FROM restaurant_settings s WHERE s.restaurant_id = r.id),
              false
            ) AS hours_set,
            (SELECT MAX(c.started_at) FROM call_logs c WHERE c.restaurant_id = r.id) AS last_call_at,
            (SELECT MAX(b.created_at) FROM reservations b WHERE b.restaurant_id = r.id) AS last_booking_at,
            COUNT(*) OVER ()::text AS total_count
       FROM restaurants r
       ${where}
      ORDER BY r.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );

  return {
    rows: result.rows.map(({ total_count: _ignored, ...row }) => row),
    // No rows means no matches, not an unknown total — the window function
    // simply has nothing to report on an empty result.
    total: Number(result.rows[0]?.total_count ?? "0")
  };
}

/**
 * Null out the named binding columns (admin unbind). The bind PATCH is
 * COALESCE-only so it can never clear a value; this is the explicit,
 * confirm-gated counterpart. Field names are validated by adminUnbindSchema
 * before they reach here — never interpolate caller input directly.
 */
export async function clearProvisioningBindings(
  restaurantId: string,
  fields: Array<
    | "twilio_phone_number"
    | "retell_phone_number"
    | "retell_agent_id"
    | "calcom_event_type_id"
  >
): Promise<ProvisioningRow | null> {
  // Deliberately independent of the route's schema — this is the last gate
  // before column names are interpolated into the SQL below. A field missing
  // here is not an error, it is a silent no-op, so it must be kept in step with
  // ADMIN_UNBINDABLE_FIELDS in http/schemas.ts.
  const allowed = new Set([
    "twilio_phone_number",
    "retell_phone_number",
    "retell_agent_id",
    "calcom_event_type_id"
  ]);
  const safe = fields.filter((f) => allowed.has(f));
  if (safe.length === 0) return getProvisioning(restaurantId);
  const sets = safe.map((f) => `${f} = NULL`).join(", ");
  const result = await pool.query<ProvisioningRow>(
    `UPDATE restaurants SET ${sets}
      WHERE id = $1
      RETURNING id, name, contact_email, onboarding_status,
                twilio_phone_number, retell_phone_number, retell_agent_id,
                calcom_event_type_id, created_at, updated_at`,
    [restaurantId]
  );
  if (!result.rows[0]) return null;
  invalidateRestaurantCache(restaurantId);
  return result.rows[0];
}

export async function getProvisioning(restaurantId: string): Promise<ProvisioningRow | null> {
  const result = await pool.query<ProvisioningRow>(
    `SELECT id, name, contact_email, onboarding_status,
            twilio_phone_number, retell_phone_number, retell_agent_id,
            calcom_event_type_id, created_at, updated_at
       FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  return result.rows[0] ?? null;
}

/**
 * Which restaurant, if any, already claims this Retell agent. Used by the admin
 * bind to refuse handing one venue's agent to another — the failure that put a
 * caller through to the wrong venue's persona on 18 Aug. Excludes `exceptId` so
 * re-binding a venue to the agent it already has is not treated as a conflict.
 */
export async function getRestaurantByRetellAgentId(
  agentId: string,
  exceptId?: string
): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM restaurants
      WHERE retell_agent_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)
      ORDER BY id
      LIMIT 1`,
    [agentId, exceptId ?? null]
  );
  return result.rows[0] ?? null;
}

/**
 * Which restaurant, if any, already claims this phone number — in EITHER
 * column. Migration 007's per-column unique indexes cannot see across columns,
 * so venue B's retell_phone_number could legally equal venue A's
 * twilio_phone_number and calls to it would route nondeterministically (#221).
 * The admin bind uses this to refuse with a 409 naming the other venue;
 * migration 039's trigger is the database-level backstop. Excludes `exceptId`
 * so re-binding a venue to a number it already holds is not a conflict.
 */
export async function getRestaurantByPhoneNumber(
  phoneNumber: string,
  exceptId?: string
): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM restaurants
      WHERE (twilio_phone_number = $1 OR retell_phone_number = $1)
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      ORDER BY id
      LIMIT 1`,
    [phoneNumber, exceptId ?? null]
  );
  return result.rows[0] ?? null;
}

/**
 * Which restaurant, if any, already claims this Cal.com event type. Mirrors
 * getRestaurantByRetellAgentId and exists for the same reason: two venues
 * sharing one event type means one venue's diners silently book the other
 * venue's tables. Migration 035's partial unique index is the backstop, but a
 * raw duplicate-key surfaces as a 500 — the admin bind uses this to refuse with
 * a 409 naming the other venue. Excludes `exceptId` so re-binding a venue to
 * the event type it already holds is not a conflict.
 */
export async function getRestaurantByCalcomEventTypeId(
  eventTypeId: number,
  exceptId?: string
): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM restaurants
      WHERE calcom_event_type_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)
      ORDER BY id
      LIMIT 1`,
    [eventTypeId, exceptId ?? null]
  );
  return result.rows[0] ?? null;
}

/** Per-restaurant Retell agent (falls back to the env default at the call site). */
export async function getRetellAgentId(restaurantId: string): Promise<string | null> {
  const result = await pool.query<{ retell_agent_id: string | null }>(
    "SELECT retell_agent_id FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  return result.rows[0]?.retell_agent_id ?? null;
}

/**
 * When this venue's phone line is paused, or null when it is live (the kill
 * switch — migration 045).
 *
 * Deliberately NOT cached, for the same reason as getRetellAgentId: the inbound
 * gate and every voice tool call read it, and a pause must land on the very next
 * call — a caller reaching a "we're not taking bookings" message a minute after
 * the owner hit pause, or a booking landing a minute after, is exactly the
 * "overwhelmed" complaint the switch exists to answer. It is one indexed PK
 * lookup on paths that already do more work than that.
 */
export async function getVoicePausedAt(restaurantId: string): Promise<Date | null> {
  const result = await pool.query<{ voice_paused_at: Date | null }>(
    "SELECT voice_paused_at FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  return result.rows[0]?.voice_paused_at ?? null;
}

/**
 * Pause or resume this venue's phone line (owner/admin kill switch).
 *
 * A CASE expression rather than COALESCE: resume has to set the column back to
 * NULL, and `COALESCE($x, col)` cannot express NULL — routing resume through the
 * COALESCE-based updateRestaurantProfile would make resume a silent no-op.
 * Invalidates the cache like every other binding write, though voice_paused_at
 * itself is read uncached.
 */
export async function setVoicePaused(restaurantId: string, paused: boolean): Promise<Date | null> {
  const result = await pool.query<{ voice_paused_at: Date | null }>(
    `UPDATE restaurants SET voice_paused_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = $1
      RETURNING voice_paused_at`,
    [restaurantId, paused]
  );
  if (result.rowCount === 0) {
    throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
  }
  invalidateRestaurantCache(restaurantId);
  return result.rows[0]?.voice_paused_at ?? null;
}

/**
 * Bind the telephony/provisioning identifiers for a restaurant (admin action).
 * Numbers are stored normalized to E.164 so the dialed-number lookup matches.
 * Invalidates the cache so a rebind takes effect immediately.
 */
export async function setProvisioningBindings(
  restaurantId: string,
  bindings: {
    twilioPhoneNumber?: string | null;
    retellPhoneNumber?: string | null;
    retellAgentId?: string | null;
    calcomEventTypeId?: number | null;
  }
): Promise<RestaurantProfile> {
  const result = await pool.query<RestaurantProfile>(
    `UPDATE restaurants SET
       twilio_phone_number = COALESCE($2, twilio_phone_number),
       retell_phone_number = COALESCE($3, retell_phone_number),
       retell_agent_id = COALESCE($4, retell_agent_id),
       calcom_event_type_id = COALESCE($5, calcom_event_type_id)
     WHERE id = $1
     RETURNING ${PROFILE_COLUMNS}`,
    [
      restaurantId,
      bindings.twilioPhoneNumber ?? null,
      bindings.retellPhoneNumber ?? null,
      bindings.retellAgentId ?? null,
      bindings.calcomEventTypeId ?? null
    ]
  );
  if (!result.rows[0]) {
    throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
  }
  // Pass the numbers explicitly: if either was previously bound to a DIFFERENT
  // venue, its cache entry points at that venue and a purge scoped to this
  // restaurant id would leave it in place.
  invalidateRestaurantCache(
    restaurantId,
    [bindings.twilioPhoneNumber, bindings.retellPhoneNumber],
    [bindings.calcomEventTypeId]
  );
  return result.rows[0];
}

/**
 * Find an existing restaurant that likely matches a new signup, for the
 * duplicate guard: same advertised phone, or same name+postcode. Only
 * COMMITTED tenants (trial and beyond) reserve a number — a half-finished
 * wizard signup must never block a real one. Ownership is confirmed through
 * the authorised onboarding workflow; production never uses a test call.
 * Returns the first match's id + name,
 * or null.
 */
export async function findDuplicateRestaurant(input: {
  existingPhoneNumber?: string | null;
  name?: string | null;
  postcode?: string | null;
}): Promise<{ id: string; name: string } | null> {
  const phone = input.existingPhoneNumber ?? null;
  const name = input.name ?? null;
  const postcode = input.postcode ?? null;
  if (!phone && !(name && postcode)) return null;

  const result = await pool.query<{ id: string; name: string }>(
    `
    SELECT id, name FROM restaurants
    WHERE onboarding_status IN ('trial', 'provisioning', 'live', 'suspended')
      AND (
        ($1::text IS NOT NULL AND existing_phone_number = $1)
        OR ($2::text IS NOT NULL AND $3::text IS NOT NULL
            AND lower(name) = lower($2) AND postcode = $3)
      )
    LIMIT 1
    `,
    [phone, name, postcode]
  );
  return result.rows[0] ?? null;
}
