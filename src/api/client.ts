// The only way this application talks to anything.
//
// Law 9 says one API layer. On the server that is a single Edge Function; here it is a single
// module. Nothing else in `src/` may call fetch against the backend, so there is exactly one
// place where authentication, error translation and offline behaviour are decided.

// The production endpoint is compiled in as the default. It is a public URL — the anon key
// beside it can execute nothing since 0008 — and baking it in is what makes the deploy truly
// drag-and-drop: the owner uploads a folder, and there is no environment step for him to miss.
// Before this default existed, a build made without a .env quietly produced a bundle that
// called /functions/v1/api on its OWN host — a wall that 404s on Cloudflare Pages. The env
// override remains for the test harness, which points builds at its mock server.
const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "https://bdzdvlnmocojsifdkpvd.supabase.co/functions/v1/api";

const TOKEN_KEY = "laqta.session";

export interface StoredSession {
  token: string;
  kind: "operator" | "admin";
  username: string;
  displayName?: string;
  eventId?: string;
  eventSlug?: string;
  booth?: string;
  role?: string;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null): void {
  try {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // A station in private mode simply signs in again after a reload.
  }
}

/** A failure that came back from the API with a name we can act on. */
export class ApiError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
  /** True when the request never reached the server, which is a queue-and-retry case rather
   *  than a real rejection. This is the distinction the offline outbox is built on. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

export async function call<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const session = loadSession();
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: JSON.stringify({ action, ...body }),
      signal: opts.signal,
    });
  } catch {
    // The venue internet died, the request never left. Callers treat this as retryable.
    throw new ApiError("OFFLINE", 0);
  }

  let payload: { ok?: boolean; data?: T; error?: string } = {};
  try {
    payload = await res.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", res.status);
  }

  if (!res.ok || payload.ok === false) {
    throw new ApiError(payload.error || "REQUEST_FAILED", res.status);
  }
  return payload.data as T;
}

/** Turns an error code into something a person can read, in their own language. */
export function messageFor(code: string, t: Record<string, string>): string {
  switch (code) {
    case "OFFLINE":
      return t.connectionLost;
    case "bad_credentials":
      return t.badCredentials;
    case "locked_out":
      return t.lockedOut;
    case "unknown_event":
      return t.unknownEvent;
    case "NOT_SIGNED_IN":
      return t.notSignedIn;
    case "ADMIN_ONLY":
      return t.adminOnly;
    case "INTAKE_PAUSED":
      return t.intakePausedNotice;
    case "rate_limited":
      return t.codeRateLimited;
    case "not_found":
      return t.codeNotFound;
    default:
      return t.somethingWentWrong;
  }
}
