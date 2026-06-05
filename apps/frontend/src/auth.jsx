import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";

import { auth, completeRedirectSignIn } from "./firebase";
import { getMe, getActiveRestaurantId, setActiveRestaurantId } from "./api";

const AuthContext = createContext({
  user: null,
  loading: true,
  memberships: [],
  activeRestaurantId: null,
  meLoading: false,
  setActiveRestaurant: () => {},
  refreshMe: () => {}
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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState([]);
  const [activeRestaurantId, setActiveId] = useState(getActiveRestaurantId());
  const [meLoading, setMeLoading] = useState(false);

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

  const setActiveRestaurant = (id) => {
    setActiveRestaurantId(id);
    setActiveId(id);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        memberships,
        activeRestaurantId,
        meLoading,
        setActiveRestaurant,
        refreshMe: loadMe
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
