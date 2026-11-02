import type { HostRequest, HostResponse } from "../../src/buzz";

export function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => void map.set(name, value),
    removeItem: (name: string) => void map.delete(name),
  };
}

export const GOOD_KEY = "test-key-good-0000";

const json = (status: number, body: unknown): HostResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * A made-up Search1API, answering the way api.search1api.com does for the calls the plugin makes. The key it
 * accepts opens nothing real. `next` makes the next answer a given status; `seen` records every request.
 */
export function createFakeS1() {
  const seen: HostRequest[] = [];
  let next: { status: number; body?: unknown } | "network" | undefined;
  let credits = 1234;
  let page = "x".repeat(10);

  async function handle(request: HostRequest): Promise<HostResponse> {
    seen.push(request);
    const forced = next;
    next = undefined;
    if (forced === "network") throw new Error(`request to ${request.url} failed`);
    if (forced) return json(forced.status, forced.body ?? { error: "Error", message: `forced ${forced.status}` });
    if (request.headers?.authorization !== `Bearer ${GOOD_KEY}`)
      return json(401, { error: "Unauthorized", message: "Unauthorized: Invalid API key" });
    const url = new URL(request.url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    if (url.pathname === "/usage" && request.method === "GET")
      return json(200, { usage: credits, user_id: "user_fake", credential_type: "api_key", client_id: null });
    if ((url.pathname === "/search" || url.pathname === "/news") && request.method === "POST") {
      const n = body.max_results ?? 10;
      const crawl = body.crawl_results ?? 0;
      return json(200, {
        searchParameters: { ...body, page: 1 },
        results: Array.from({ length: Math.min(n, 3) }, (_, i) => ({
          title: `Result ${i + 1} for ${body.query}`,
          link: `https://example.com/${i + 1}`,
          snippet: `Snippet ${i + 1}`,
          ...(i === 0 ? { published_date: "2026-11-01" } : {}),
          ...(i < crawl ? { content: page } : {}),
        })),
      });
    }
    if (url.pathname === "/crawl" && request.method === "POST")
      return json(200, { crawlParameters: body, results: { title: "A page", link: body.url, content: page } });
    return json(404, { error: "Not Found", message: "Not Found" });
  }

  return {
    handle,
    seen,
    fail: (status: number | "network", body?: unknown) => {
      next = status === "network" ? "network" : { status, ...(body === undefined ? {} : { body }) };
    },
    setCredits: (n: number) => void (credits = n),
    setPage: (text: string) => void (page = text),
  };
}
