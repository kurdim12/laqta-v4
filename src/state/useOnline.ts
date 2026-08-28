import { useEffect, useState } from "react";

/** Whether the browser currently believes it has a network.
 *
 *  Deliberately only an indicator. navigator.onLine reports whether an interface is up, not
 *  whether the venue's saturated wifi can actually reach Supabase — which is exactly how v1
 *  was fooled into thinking it was fine. Nothing in this application decides whether to keep a
 *  photo based on this value; the outbox in Phase 1 keeps everything regardless and lets the
 *  request itself fail. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
