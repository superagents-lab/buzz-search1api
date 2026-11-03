import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { S1Error, S1_ORIGIN, USER_AGENT, createClient } from "../../src/client";
import { MAX_PAGE_CHARS, MAX_RESULT_CHARS, createTools } from "../../src/tools";
import { GOOD_KEY, createFakeS1 } from "./fake";

function setup(options: { key?: string | undefined } = {}) {
  const key = "key" in options ? options.key : GOOD_KEY;
  const fake = createFakeS1();
  const client = createClient((request) => fake.handle(request), () => key);
  const tools = Object.fromEntries(createTools(client).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools[name];
    if (!tool) throw new Error(`no tool ${name}`);
    const reply = await tool.call(undefined, undefined, args);
    return JSON.parse(reply as string);
  };
  return { fake, client, tools, call };
}

describe("the tools Buzz lists for agents", () => {
  test("three tools, named after the plugin, with object schemas Buzz accepts", () => {
    const { tools } = setup();
    expect(Object.keys(tools)).toEqual(["search1api_search", "search1api_news", "search1api_crawl", "search1api_maps"]);
    for (const tool of Object.values(tools)) {
      // The same check Buzz makes in AgentsService.addTool.
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(JSON.parse(JSON.stringify(tool.inputSchema))).toEqual(tool.inputSchema);
    }
  });
});

describe("search1api_search", () => {
  test("sends only what the agent set, with the key, the plugin's user agent and a JSON body", async () => {
    const { fake, call } = setup();
    const reply = await call("search1api_search", { query: "  buzz plugins ", max_results: 2, search_service: "github" });
    const request = fake.seen[0]!;
    expect(request.url).toBe(`${S1_ORIGIN}/search`);
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ authorization: `Bearer ${GOOD_KEY}`, "user-agent": USER_AGENT, "content-type": "application/json" });
    expect(JSON.parse(request.body!)).toEqual({ query: "buzz plugins", max_results: 2, search_service: "github" });
    expect(reply).toEqual({
      query: "buzz plugins",
      results: [
        { title: "Result 1 for buzz plugins", url: "https://example.com/1", snippet: "Snippet 1", published_date: "2026-11-01" },
        { title: "Result 2 for buzz plugins", url: "https://example.com/2", snippet: "Snippet 2" },
      ],
    });
  });

  test("full text from crawl_results is kept, cut at the per-result limit and marked", async () => {
    const { fake, call } = setup();
    fake.setPage("y".repeat(MAX_RESULT_CHARS + 50));
    const reply = await call("search1api_search", { query: "q", crawl_results: 1 });
    expect(reply.results[0].content).toHaveLength(MAX_RESULT_CHARS);
    expect(reply.results[0].content_truncated).toBe(true);
    expect(reply.results[1].content).toBeUndefined();
    // Reading pages takes longer: the request asks the host for more time.
    expect(fake.seen[0]!.timeoutMs).toBe(90_000);
  });

  test("bad arguments are tool errors the agent can fix, and nothing is sent", async () => {
    const { fake, call } = setup();
    await expect(call("search1api_search", {})).rejects.toThrow("query must be a non-empty string");
    await expect(call("search1api_search", { query: "q", max_results: 0 })).rejects.toThrow("max_results");
    await expect(call("search1api_search", { query: "q", search_service: "altavista" })).rejects.toThrow("search_service must be one of");
    await expect(call("search1api_search", { query: "q", include_sites: "github.com" })).rejects.toThrow("include_sites");
    await expect(call("search1api_search", { query: "q", time_range: "decade" })).rejects.toThrow("time_range");
    expect(fake.seen).toHaveLength(0);
  });
});

describe("search1api_news", () => {
  test("posts to /news", async () => {
    const { fake, call } = setup();
    const reply = await call("search1api_news", { query: "block buzz", time_range: "day", search_service: "hackernews" });
    expect(fake.seen[0]!.url).toBe(`${S1_ORIGIN}/news`);
    expect(JSON.parse(fake.seen[0]!.body!)).toEqual({ query: "block buzz", time_range: "day", search_service: "hackernews" });
    expect(reply.results).toHaveLength(3);
  });
});

describe("search1api_crawl", () => {
  test("reads a page and hands back its text", async () => {
    const { fake, call } = setup();
    fake.setPage("Hello page");
    const reply = await call("search1api_crawl", { url: "https://buzz.xyz" });
    expect(JSON.parse(fake.seen[0]!.body!)).toEqual({ url: "https://buzz.xyz/" });
    expect(reply).toEqual({ title: "A page", url: "https://buzz.xyz/", content: "Hello page" });
  });

  test("a very long page is cut and says how long it was", async () => {
    const { fake, call } = setup();
    fake.setPage("z".repeat(MAX_PAGE_CHARS + 1));
    const reply = await call("search1api_crawl", { url: "https://example.com/long" });
    expect(reply.content).toHaveLength(MAX_PAGE_CHARS);
    expect(reply).toMatchObject({ truncated: true, total_chars: MAX_PAGE_CHARS + 1 });
  });

  test("only http and https addresses", async () => {
    const { fake, call } = setup();
    await expect(call("search1api_crawl", { url: "file:///etc/passwd" })).rejects.toThrow("http:// or https://");
    await expect(call("search1api_crawl", { url: "not a url" })).rejects.toThrow("full http(s) address");
    expect(fake.seen).toHaveLength(0);
  });

  test("a page with no text is an error, not an empty answer", async () => {
    const { fake, call } = setup();
    fake.setPage("");
    await expect(call("search1api_crawl", { url: "https://example.com/empty" })).rejects.toThrow("could not read any text");
  });
});

describe("search1api_maps", () => {
  test("posts to /maps with only what the agent set, and keeps places that have a name and link", async () => {
    const { fake, call } = setup();
    const reply = await call("search1api_maps", { query: "coffee in Austin", country: "us", max_results: 5 });
    expect(fake.seen[0]!.url).toBe(`${S1_ORIGIN}/maps`);
    expect(JSON.parse(fake.seen[0]!.body!)).toEqual({ query: "coffee in Austin", country: "us", max_results: 5 });
    expect(reply.places.map((p: { name: string }) => p.name)).toEqual(["Fake Coffee"]);
    expect(reply.places[0]).toMatchObject({ rating: 4.6, review_count: 120, address: "1 Main St" });
  });

  test("a location is passed through, and later pages need one", async () => {
    const { fake, call } = setup();
    await call("search1api_maps", { query: "tacos", page: 2, location: { latitude: 30.27, longitude: -97.74, zoom: 15 } });
    expect(JSON.parse(fake.seen[0]!.body!)).toEqual({ query: "tacos", page: 2, location: { latitude: 30.27, longitude: -97.74, zoom: 15 } });
    await expect(call("search1api_maps", { query: "tacos", page: 2 })).rejects.toThrow("location is required");
    await expect(call("search1api_maps", { query: "tacos", location: { latitude: 200, longitude: 0 } })).rejects.toThrow("location must be");
    await expect(call("search1api_maps", { query: "tacos", country: "usa" })).rejects.toThrow("country");
    await expect(call("search1api_maps", { query: "tacos", max_results: 21 })).rejects.toThrow("max_results");
    expect(fake.seen).toHaveLength(1);
  });
});

describe("errors", () => {
  test("no key: the agent is told who can add one", async () => {
    const { fake, call } = setup({ key: undefined });
    await expect(call("search1api_search", { query: "q" })).rejects.toThrow("Settings → Plugins → Search1API");
    expect(fake.seen).toHaveLength(0);
  });

  test("each failure has its own kind, and the key never appears in a message", async () => {
    const cases: [number | "network", string][] = [
      [401, "auth"],
      [403, "auth"],
      [402, "credits"],
      [429, "rate-limited"],
      [500, "server"],
      [422, "rejected"],
      ["network", "network"],
    ];
    for (const [status, kind] of cases) {
      const { fake, client } = setup();
      fake.fail(status, status === 422 ? { message: "Query cannot be empty" } : undefined);
      const error = await client.post("/search", { query: "q" }).catch((e) => e);
      expect(error, String(status)).toBeInstanceOf(S1Error);
      expect(error.kind, String(status)).toBe(kind);
      expect(error.message).not.toContain(GOOD_KEY);
    }
  });

  test("a refused request passes Search1API's own reason on, and out of credits says where to top up", async () => {
    const { fake, client } = setup();
    fake.fail(422, { message: "Query cannot be empty" });
    await expect(client.post("/search", { query: "" })).rejects.toThrow("Query cannot be empty");
    fake.fail(402, { message: "Insufficient credits" });
    await expect(client.post("/search", { query: "q" })).rejects.toThrow("Insufficient credits Top up at https://s1.dev/pricing.");
  });
});

describe("checking a key", () => {
  test("GET /usage, free, reports the credits", async () => {
    const { fake, client } = setup();
    fake.setCredits(91_134);
    expect(await client.usage()).toEqual({ credits: 91_134 });
    expect(fake.seen[0]).toMatchObject({ url: `${S1_ORIGIN}/usage`, method: "GET" });
    expect(fake.seen[0]!.body).toBeUndefined();
  });

  test("a candidate key is checked instead of the saved one", async () => {
    const { client } = setup({ key: "some-saved-key-1234" });
    expect(await client.usage(GOOD_KEY)).toEqual({ credits: 1234 });
    await expect(client.usage()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
  test("declares exactly the origin the client calls, and the key-store commands", () => {
    expect(manifest.host.networkOrigins).toEqual([S1_ORIGIN]);
    expect(manifest.host.commands.map((c: { id: string }) => c.id).sort()).toEqual(
      ["keychain-delete", "keychain-read", "keychain-save", "secret-delete", "secret-read", "secret-save"],
    );
  });
  test("its version matches the user agent", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(USER_AGENT).toBe(`search1api-buzz/${pkg.version}`);
  });
});
