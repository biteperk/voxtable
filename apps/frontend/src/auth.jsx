import React, { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";

import { auth, completeRedirectSignIn } from "./firebase";

const AuthContext = createContext({ user: null, loading: true });

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // If we just returned from a signInWithRedirect, resolve it first so
    // onAuthStateChanged fires with the new user immediately.
    completeRedirectSignIn().finally(() => {
      const unsub = onAuthStateChanged(auth, (next) => {
        setUser(next);
        setLoading(false);
      });
      // returned cleanup is the unsubscribe
      return unsub;
    });
  }, []);

  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
