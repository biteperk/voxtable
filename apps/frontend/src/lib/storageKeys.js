/**
 * Browser storage keys, and the one-time migration off the pre-rename prefix.
 *
 * These are the only `vocotable` identifiers that live in someone else's
 * computer. A bare rename does not fail loudly — it silently forgets: the user's
 * selected restaurant resets to the default (so a multi-venue owner lands on the
 * wrong venue's dashboard), an in-flight signup is dropped mid-flow, and the
 * verify-email cooldown restarts so a resend button unlocks early.
 *
 * So we read the old key once, write it under the new one, and delete the old.
 * The user notices nothing, which is the entire goal.
 *
 * Every access is wrapped: localStorage throws outright in a Safari private
 * window and in some embedded webviews, and losing the dashboard to a storage
 * exception would be a far worse bug than the one this file fixes.
 */

const LEGACY_PREFIX = "vocotable";
const PREFIX = "voxtable";

/** `activeRestaurantId` → `voxtable.activeRestaurantId`, migrating the old key. */
export function storageKey(name, separator = ".") {
  return `${PREFIX}${separator}${name}`;
}

function legacyKey(name, separator) {
  return `${LEGACY_PREFIX}${separator}${name}`;
}

/**
 * Move one key from the legacy prefix to the current one, if it is still there.
 * Safe to call repeatedly — after the first run the old key is gone and this is
 * a no-op. Never overwrites a value already stored under the new key.
 */
export function migrateStorageKey(name, separator = ".") {
  const from = legacyKey(name, separator);
  const to = storageKey(name, separator);
  try {
    const existing = localStorage.getItem(to);
    const legacy = localStorage.getItem(from);
    if (legacy !== null && existing === null) localStorage.setItem(to, legacy);
    if (legacy !== null) localStorage.removeItem(from);
  } catch {
    // Storage unavailable or full. The caller falls back to a default, which is
    // the same experience as a first-time visitor — acceptable; a thrown
    // exception here is not.
  }
}

/** Read a migrated key. Runs the migration first so the very first read wins. */
export function readStorageKey(name, separator = ".") {
  migrateStorageKey(name, separator);
  try {
    return localStorage.getItem(storageKey(name, separator));
  } catch {
    return null;
  }
}

/** Write a migrated key. `null` removes it. */
export function writeStorageKey(name, value, separator = ".") {
  try {
    if (value === null || value === undefined) localStorage.removeItem(storageKey(name, separator));
    else localStorage.setItem(storageKey(name, separator), value);
  } catch {
    /* see migrateStorageKey */
  }
}
