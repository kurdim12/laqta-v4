import { useCallback, useEffect, useState } from "react";
import { loadSession, saveSession, type StoredSession } from "../api/client";

/** The signed-in operator or admin, kept in step across tabs on the same device. */
export function useSession() {
  const [session, setSession] = useState<StoredSession | null>(loadSession);

  useEffect(() => {
    const sync = () => setSession(loadSession());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const signIn = useCallback((s: StoredSession) => {
    saveSession(s);
    setSession(s);
  }, []);

  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  return { session, signIn, signOut };
}
