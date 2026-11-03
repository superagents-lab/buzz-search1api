// Loads the built plugin.js the way Buzz does (one ES module exporting inject and apply), against a stand-in
// context: real React, a fake Search1API behind ctx.host.request, and nothing else.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";
import type { AddedTool, CodeBlockRenderer, HostRequest, SettingsCard } from "../../src/buzz";
import { GOOD_KEY, createFakeS1, memoryStorage } from "./fake";

type Loaded = { inject: string[]; apply(ctx: unknown): void };

function loadContext() {
  const fake = createFakeS1();
  const tools: AddedTool[] = [];
  const cards: SettingsCard[] = [];
  const cleanups: (() => void)[] = [];
  const requests: HostRequest[] = [];
  const blocks: CodeBlockRenderer[] = [];
  const ctx: Record<string, unknown> = {
    react: React,
    host: {
      request: (request: HostRequest) => {
        requests.push(request);
        // Buzz refuses any origin the manifest does not declare.
        if (!request.url.startsWith("https://api.search1api.com/")) return Promise.reject(new Error("origin not declared"));
        return fake.handle(request);
      },
      // No system key store here: every command fails, as `runCommand` does for a missing program.
      runCommand: async () => null,
    },
    agents: { addTool: (tool: AddedTool) => tools.push(tool) },
    inject: (deps: string[], callback: (scope: unknown) => void) => {
      if (deps.join() === "conversation") callback({ ...ctx, conversation: { registerCodeBlock: (r: CodeBlockRenderer) => blocks.push(r) } });
    },
    settingsCards: { register: (card: SettingsCard) => cards.push(card) },
    navigation: { open: async () => undefined },
    effect: (setup: () => () => void) => cleanups.push(setup()),
  };
  return { ctx, fake, tools, cards, cleanups, requests, blocks };
}

let plugin: Loaded;
let storage: ReturnType<typeof memoryStorage>;

beforeAll(async () => {
  storage = memoryStorage();
  // What a page gives the plugin: localStorage, navigator, document.head.
  const head: unknown[] = [];
  Object.assign(globalThis, {
    window: { localStorage: storage },
    document: {
      head: { append: (el: unknown) => head.push(el) },
      createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
    },
  });
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Win32", userAgent: "Windows" }, configurable: true });
  plugin = (await import("../../plugin.js" as string)) as Loaded;
});

describe("the built plugin.js", () => {
  test("asks for the services it uses", () => {
    expect(plugin.inject).toEqual(["react", "settingsCards", "agents", "host"]);
  });

  test("apply adds the tools and the settings card, and a style that its cleanup removes", () => {
    const { ctx, tools, cards, cleanups } = loadContext();
    plugin.apply(ctx);
    expect(tools.map((t) => t.name)).toEqual(["search1api_search", "search1api_news", "search1api_crawl", "search1api_maps", "search1api_render_results"]);
    expect(cards.map((c) => [c.id, c.title, c.group])).toEqual([["settings", "Search1API", "Plugins"]]);
    expect(cleanups).toHaveLength(1);
  });

  test("draws search1api-results code blocks as cards through the conversation service", () => {
    const { ctx, blocks } = loadContext();
    plugin.apply(ctx);
    expect(blocks.map((b) => b.id)).toEqual(["results"]);
    expect(blocks[0]!.matches("search1api-results")).toBe(true);
    expect(blocks[0]!.matches("json")).toBe(false);
    const html = renderToStaticMarkup(
      React.createElement(blocks[0]!.component, { code: '{"v":1,"results":[{"title":"T","url":"https://e.com"}]}', language: "search1api-results" }),
    );
    expect(html).toContain("via Search1API");
  });

  test("the settings card renders, asking for a key, with where to get one", () => {
    const { ctx, cards } = loadContext();
    plugin.apply(ctx);
    const Card = cards[0]!.component;
    const html = renderToStaticMarkup(React.createElement(Card, { active: () => true }));
    expect(html).toContain('placeholder="Paste your Search1API key"');
    expect(html).toContain("https://app.s1.dev/?utm_source=buzz&amp;utm_medium=plugin");
    expect(html).toContain("search1api_search");
    // No system store on this platform: the card says the key would be plain text in the profile.
    expect(html).toContain("as plain text");
  });

  test("an agent's search goes to Search1API with the saved key, and nowhere else", async () => {
    storage.setItem("search1api.buzz.api-key.v1", GOOD_KEY);
    const { ctx, tools, requests } = loadContext();
    plugin.apply(ctx);
    const search = tools.find((t) => t.name === "search1api_search")!;
    const reply = JSON.parse((await search.call({}, {}, { query: "buzz plugins", max_results: 1 })) as string);
    expect(reply.results[0].url).toBe("https://example.com/1");
    expect(requests.map((r) => r.url)).toEqual(["https://api.search1api.com/search"]);
    storage.removeItem("search1api.buzz.api-key.v1");
  });
});
