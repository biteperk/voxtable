import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";

import { auth, completeRedirectSignIn } from "./firebase";
import { getMe, getActiveRestaurantId, setActiveRestaurantId } from "./api";

const ROLE_RANK = { kitchen: 1, server: 2, staff: 2, manager: 3, owner: 4 };

const AuthContext = createContext({
  user: null,
  loading: true,
  memberships: [],
  activeRestaurantId: null,
  role: null,
  meLoading: false,
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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState([]);
  const [activeRestaurantId, setActiveId] = useState(getActiveRestaurantId());
  const [meLoading, setMeLoading] = useState(false);

  const role = roleForRestaurant(memberships, activeRestaurantId);

  // Load identity + memberships for the signed-in user. Sets the active
  // restaurant (and persists it) so X-Restaurant-Id is sent on later calls.
  async function loadMe() {
    setMeLoading(true);
    try {
      const me = await getMe();
      const list = Array.isArray(me?.memberships) ? me.memberships : [];
      setMemberships(list);
      const active = pickActive(list, me?.active_restaurant_id ?? null);
      setActiveRestaurantId(active);
      setActiveId(active);
    } catch {
      // 403 NO_RESTAURANT_MEMBERSHIP (no restaurant yet) or a transient error:
      // leave memberships empty so the app can route to onboarding (Phase 1).
      setMemberships([]);
      setActiveRestaurantId(null);
      setActiveId(null);
    } finally {
      setMeLoading(false);
    }
  }

  useEffect(() => {
    // If we just returned from a signInWithRedirect, resolve it first so
    // onAuthStateChanged fires with the new user immediately.
    let unsub = () => {};
    completeRedirectSignIn().finally(() => {
      unsub = onAuthStateChanged(auth, (next) => {
        setUser(next);
        setLoading(false);
        if (next) {
          void loadMe();
        } else {
          setMemberships([]);
          setActiveRestaurantId(null);
          setActiveId(null);
        }
      });
    });
    return () => unsub();
  }, []);

  // api.js fires this when the backend rejects the stored X-Restaurant-Id
  // (membership revoked mid-session) — re-fetch memberships and re-pick.
  useEffect(() => {
    const onChanged = () => {
      if (auth.currentUser) void loadMe();
    };
    window.addEventListener("vocotable:memberships-changed", onChanged);
    return () => window.removeEventListener("vocotable:memberships-changed", onChanged);
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

