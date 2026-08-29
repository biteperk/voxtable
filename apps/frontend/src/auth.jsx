import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";

import { auth, completeRedirectSignIn } from "./firebase";
import { getMe, getActiveRestaurantId, setActiveRestaurantId, submitContact } from "./api";
import { PENDING_SIGNUP_KEY } from "./pages/auth/LoginScreen";

const ROLE_RANK = { kitchen: 1, server: 2, staff: 2, manager: 3, owner: 4 };

const AuthContext = createContext({
  user: null,
  loading: true,
  memberships: [],
  activeRestaurantId: null,
  role: null,
  meLoading: false,
  meError: null,
  setActiveRestaurant: () => {},
  refreshMe: () => {},
  hasMinRole: () => false
});

// Pick the active restaurant deterministically: a previously-stored choice if
// it's still a valid membership, else the backend's suggestion, else the first
// membership, else null (no restaurant yet → onboarding).
function pickActive(memberships, suggested) {
  const ids = memberships.map((m) => m.restaurant_id);
  const stored = getActiveRestaurantId();
  if (stored && ids.includes(stored)) return stored;
  if (suggested && ids.includes(suggested)) return suggested;
  return ids[0] ?? null;
}

function roleForRestaurant(memberships, restaurantId) {
  if (!restaurantId) return null;
  const m = memberships.find((m) => m.restaurant_id === restaurantId);
  return m?.role ?? null;
}

// Representative details captured at signup can only be persisted once the
// account is verified (the backend refuses unverified requests). Flush the
// stash on any verified session so the same-device path AND the
// "verified elsewhere, came back later" path both land the record.
// Best-effort: a failed flush keeps the stash for the next session.
async function flushPendingSignup() {
  let raw;
  try {
    raw = localStorage.getItem(PENDING_SIGNUP_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const pending = JSON.parse(raw);
    await submitContact({ name: pending.name || undefined, phone: pending.phone || undefined });
    localStorage.removeItem(PENDING_SIGNUP_KEY);
  } catch {
    // Invalid JSON is unrecoverable — drop it; a network/API failure keeps
    // the stash so the next verified session retries.
    if (raw && raw[0] !== "{") {
      try {
        localStorage.removeItem(PENDING_SIGNUP_KEY);
      } catch {
        /* ignore */
      }
    }
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState([]);
  const [activeRestaurantId, setActiveId] = useState(getActiveRestaurantId());
  const [meLoading, setMeLoading] = useState(false);
  // Non-null when /api/me failed after retries — the shell renders a retryable
  // error instead of guessing between "new user" and "broken session".
  const [meError, setMeError] = useState(null);
  // Platform admin (BitePerk staff) — a UI hint from /api/me for showing the
  // /admin entry point. Authority lives server-side on every /api/admin call.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  const role = roleForRestaurant(memberships, activeRestaurantId);

  // Load identity + memberships for the signed-in user. Sets the active
  // restaurant (and persists it) so X-Restaurant-Id is sent on later calls.
  //
  // Transient failures retry with backoff and then surface as meError rather
  // than being folded into "no memberships": an existing owner shown the
  // create-restaurant screen because /api/me 500'd once is a single click from
  // a duplicate venue, and the dashboard's fallback for empty memberships is
  // an unlabelled spinner. Only a definitive "this account has no restaurant"
  // may produce the empty state.
  async function loadMe() {
    setMeLoading(true);
    setMeError(null);
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const me = await getMe();
        const list = Array.isArray(me?.memberships) ? me.memberships : [];
        setMemberships(list);
        setIsPlatformAdmin(me?.is_admin === true);
        const active = pickActive(list, me?.active_restaurant_id ?? null);
        setActiveRestaurantId(active);
        setActiveId(active);
        setMeLoading(false);
        return;
      } catch (e) {
        if (e?.code === "NO_RESTAURANT_MEMBERSHIP") {
          // Genuinely no restaurant yet — route to onboarding (Phase 1).
          setMemberships([]);
          setIsPlatformAdmin(false);
          setActiveRestaurantId(null);
          setActiveId(null);
          setMeLoading(false);
          return;
        }
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
          continue;
        }
        // Out of retries: keep whatever memberships we already had (a mid-
        // session refresh failing must not evict a working dashboard) and let
        // the shell render a retryable error instead of a wrong screen.
        setMeError(e?.message || "Couldn't load your account.");
        setMeLoading(false);
        return;
      }
    }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
      if (next && next.emailVerified) {
        // Verified accounts only — an unverified email/password signup would
        // just collect a guaranteed 403 EMAIL_NOT_VERIFIED here (and land in a
        // silently broken wizard). The verify screen calls refreshMe() itself
        // after the post-verification token refresh.
        void loadMe();
        void flushPendingSignup();
      } else if (!next) {
        setMemberships([]);
        setIsPlatformAdmin(false);
        setActiveRestaurantId(null);
        setActiveId(null);
        setMeError(null);
      }
    });

    // Resolve redirect sign-in in parallel with auth subscription. Waiting for
    // this first can leave the SPA mounted but visually blank if Firebase's
    // redirect result call is blocked or slow in local development.
    void completeRedirectSignIn();

    return () => unsub();
  }, []);

  // api.js fires this when the backend rejects the stored X-Restaurant-Id
  // (membership revoked mid-session) — re-fetch memberships and re-pick.
  useEffect(() => {
    const onChanged = () => {
      if (auth.currentUser) void loadMe();
    };
    window.addEventListener("voxtable:memberships-changed", onChanged);
    return () => window.removeEventListener("voxtable:memberships-changed", onChanged);
  }, []);

  const setActiveRestaurant = (id) => {
    setActiveRestaurantId(id);
    setActiveId(id);
  };

  /**
   * Check if the current user has at least the given role at the active
   * restaurant. Used for navigation gating and conditional UI rendering.
   */
  const hasMinRole = (minRole) => {
    if (!role) return false;
    return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 99);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        memberships,
        activeRestaurantId,
        role,
        meLoading,
        meError,
        isPlatformAdmin,
        setActiveRestaurant,
        refreshMe: loadMe,
        hasMinRole
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
