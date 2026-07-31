import { AppError } from "../domain/errors";
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

const timezoneCache = new Map<string, string>();
const nameCache = new Map<string, string>();
// Maps a trusted dialed number (E.164) -> restaurant id. Immutable per number
// in normal operation, but a number CAN be released and reassigned to a
// different tenant, so the entry is invalidated whenever provisioning bindings
// change (see invalidateRestaurantCache). Keyed by normalized number; the
// value is the restaurant id so we can purge by restaurant on rebind.
const dialedNumberCache = new Map<string, string>();

export async function getRestaurantTimezone(restaurantId: string): Promise<string> {
  const cached = timezoneCache.get(restaurantId);
  if (cached) return cached;

  const result = await pool.query<{ timezone: string }>(
    "SELECT timezone FROM restaurants WHERE id = $1",
    [restaurantId]
  );

  const tz = result.rows[0]?.timezone ?? "Australia/Sydney";
  timezoneCache.set(restaurantId, tz);
  return tz;
}

export async function getRestaurantName(restaurantId: string): Promise<string> {
  const cached = nameCache.get(restaurantId);
  if (cached) return cached;

  const result = await pool.query<{ name: string }>(
    "SELECT name FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  const name = result.rows[0]?.name ?? "the restaurant";
  nameCache.set(restaurantId, name);
  return name;
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
  if (cached) return cached;

  const result = await pool.query<{ id: string }>(
    `SELECT id FROM restaurants
      WHERE twilio_phone_number = $1 OR retell_phone_number = $1
      LIMIT 1`,
    [normalized]
  );
  const id = result.rows[0]?.id ?? null;
  if (id) dialedNumberCache.set(normalized, id);
  return id;
}

/**
 * Drop all memoized values for a restaurant. Call after any write that changes
 * a restaurant's name, timezone, or dialed-number bindings (profile edit,
 * provisioning bind/unbind) so stale cache entries can't route calls or render
 * names for the wrong/old value.
 */
export function invalidateRestaurantCache(restaurantId: string): void {
  timezoneCache.delete(restaurantId);
  nameCache.delete(restaurantId);
  for (const [number, id] of dialedNumberCache) {
    if (id === restaurantId) dialedNumberCache.delete(number);
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
  if (row.timezone) timezoneCache.set(restaurantId, row.timezone);
  if (row.name) nameCache.set(restaurantId, row.name);
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

// --- Provisioning (Phase 4) ------------------------------------------------

export interface ProvisioningRow {
  id: string;
  name: string;
  contact_email: string | null;
  onboarding_status: OnboardingStatus;
  twilio_phone_number: string | null;
  retell_phone_number: string | null;
  retell_agent_id: string | null;
  created_at: string;
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
            twilio_phone_number, retell_phone_number, retell_agent_id, created_at
       FROM restaurants
      WHERE onboarding_status = $1::onboarding_status
      ORDER BY created_at ASC`,
    [status]
  );
  return result.rows;
}

export async function getProvisioning(restaurantId: string): Promise<ProvisioningRow | null> {
  const result = await pool.query<ProvisioningRow>(
    `SELECT id, name, contact_email, onboarding_status,
            twilio_phone_number, retell_phone_number, retell_agent_id, created_at
       FROM restaurants WHERE id = $1`,
    [restaurantId]
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
  }
): Promise<RestaurantProfile> {
  const result = await pool.query<RestaurantProfile>(
    `UPDATE restaurants SET
       twilio_phone_number = COALESCE($2, twilio_phone_number),
       retell_phone_number = COALESCE($3, retell_phone_number),
       retell_agent_id = COALESCE($4, retell_agent_id)
     WHERE id = $1
     RETURNING ${PROFILE_COLUMNS}`,
    [
      restaurantId,
      bindings.twilioPhoneNumber ?? null,
      bindings.retellPhoneNumber ?? null,
      bindings.retellAgentId ?? null
    ]
  );
  if (!result.rows[0]) {
    throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
  }
  invalidateRestaurantCache(restaurantId);
  return result.rows[0];
}

/**
 * Find an existing restaurant that likely matches a new signup, for the
 * duplicate guard: same advertised phone, or same name+postcode. Only
 * COMMITTED tenants (trial and beyond) reserve a number — a half-finished
 * wizard signup must never block a real one, and possession is ultimately
 * proven at the verify-forwarding step. Returns the first match's id + name,
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
