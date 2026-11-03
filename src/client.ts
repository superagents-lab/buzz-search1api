import type { HostRequest, HostResponse } from "./buzz";

export const S1_ORIGIN = "https://api.search1api.com";
export const VERSION = "0.3.0";
/** Tells Search1API which integration a request came from. */
export const USER_AGENT = `search1api-buzz/${VERSION}`;

export type Transport = (request: HostRequest) => Promise<HostResponse>;

export type S1ErrorKind =
  | "no-key" // nothing saved yet
  | "auth" // Search1API refused the key (mistyped, revoked, disabled)
  | "credits" // the key works but its account has no credits left
  | "rate-limited"
  | "network" // the host could not reach Search1API
  | "rejected" // Search1API understood the request and said no (bad parameters)
  | "server"; // anything else: a 5xx or a body that is not JSON

export class S1Error extends Error {
  readonly kind: S1ErrorKind;
  constructor(kind: S1ErrorKind, message: string) {
    super(message);
    this.name = "S1Error";
    this.kind = kind;
  }
}

/** The account a key belongs to, as `GET /usage` reports it. That call costs no credits. */
export type Usage = { credits: number | null };

type ErrorBody = { message?: unknown; error?: unknown };

/**
 * Calls to Search1API through the host's declared-origin HTTP client. The key is read when a
 * call starts and goes nowhere but the Authorization header: not in a URL, an error message
 * or a log line.
 */
export function createClient(
  transport: Transport,
  /** The saved key; a promise lets a call wait for the first look at where the key is kept. */
  readKey: () => string | undefined | Promise<string | undefined>,
) {
  async function call<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
    candidate?: string,
  ): Promise<T> {
    const key = candidate ?? (await readKey());
    if (!key)
      throw new S1Error(
        "no-key",
        "No Search1API key is saved in this app yet. Ask the owner to add one in Settings → Plugins → Search1API.",
      );
    let response: HostResponse;
    try {
      response = await transport({
        url: `${S1_ORIGIN}${path}`,
        method: init.method,
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}),
      });
    } catch {
      // The host's own failure text can name the request; keep ours generic.
      throw new S1Error("network", "Could not reach Search1API.");
    }
    return parse<T>(response);
  }

  return {
    /** Checks a key (the saved one, or `candidate`) without spending credits. */
    usage: async (candidate?: string): Promise<Usage> => {
      const body = await call<{ usage?: unknown }>("/usage", { method: "GET" }, candidate);
      return { credits: typeof body.usage === "number" && Number.isFinite(body.usage) ? body.usage : null };
    },
    post: <T>(path: "/search" | "/news" | "/crawl" | "/maps", body: Record<string, unknown>, timeoutMs?: number) =>
      call<T>(path, { method: "POST", body, ...(timeoutMs ? { timeoutMs } : {}) }),
  };
}

export type S1Client = ReturnType<typeof createClient>;

/** Search1API's own message for a refused request. It never repeats the key; it is still cut short. */
function apiMessage(body: ErrorBody | undefined): string | undefined {
  const text = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : undefined;
  return text ? text.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
}

function parse<T>(response: HostResponse): T {
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = undefined;
  }
  const errorBody = body && typeof body === "object" ? (body as ErrorBody) : undefined;
  const { status } = response;
  if (status === 401) throw new S1Error("auth", "Search1API did not accept the API key.");
  if (status === 402)
    throw new S1Error(
      "credits",
      `${apiMessage(errorBody) ?? "This Search1API account is out of credits."} Top up at https://s1.dev/pricing.`,
    );
  if (status === 403) throw new S1Error("auth", apiMessage(errorBody) ?? "Search1API refused this key.");
  if (status === 429) throw new S1Error("rate-limited", "Search1API is rate limiting this key. Try again in a moment.");
  if (status >= 500) throw new S1Error("server", `Search1API is having trouble right now (${status}).`);
  if (status < 200 || status >= 300)
    throw new S1Error("rejected", apiMessage(errorBody) ?? `Search1API refused the request (${status}).`);
  if (!errorBody) throw new S1Error("server", "Search1API answered with an unexpected response.");
  return body as T;
}
