import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";
import { provideReact } from "../../src/react";
import { BLOCK_LANGUAGE, MAX_CARDS, createRenderTool, parseBlock, safeUrl } from "../../src/render";
import { ResultCards } from "../../src/cards";

beforeAll(() => provideReact(React));

const tool = createRenderTool();
const run = async (args: Record<string, unknown>) => (await tool.call(undefined, undefined, args)) as string;
const blockOf = (reply: string) => {
  const match = reply.match(new RegExp("```" + BLOCK_LANGUAGE + "\\n([\\s\\S]*?)\\n```"));
  if (!match) throw new Error(`no block in: ${reply}`);
  return match[1]!;
};

describe("search1api_render_results", () => {
  test("turns search results into a block the agent pastes, keeping only what a card shows", async () => {
    const reply = await run({
      title: "  Buzz   plugins ",
      results: [
        { title: "block/buzz", url: "https://github.com/block/buzz", snippet: "A hive mind", published_date: "2026-10-31", secret: "x" },
        { title: "No link", url: "javascript:alert(1)" },
      ],
    });
    expect(reply).toContain("Put this block in your reply exactly as it is");
    expect(reply).toContain("1 result without a title or http(s) link left out");
    const cards = parseBlock(blockOf(reply));
    expect(cards).toEqual({
      v: 1,
      title: "Buzz plugins",
      results: [{ title: "block/buzz", url: "https://github.com/block/buzz", text: "A hive mind", published_date: "2026-10-31" }],
    });
  });

  test("takes places from search1api_maps as they are", async () => {
    const place = {
      position: 1,
      name: "Terrible Love Coffee",
      place_id: "p1",
      maps_url: "https://www.google.com/maps/search/?api=1&query=Terrible+Love+Coffee",
      address: "3908 Avenue B, Austin, TX 78751",
      website: "http://terriblelovecoffee.com/",
      rating: 4.9,
      review_count: 433,
      category: "Coffee shop",
    };
    const cards = parseBlock(blockOf(await run({ results: [place] })));
    expect(cards.results[0]).toEqual({
      title: "Terrible Love Coffee",
      url: place.maps_url,
      address: place.address,
      website: place.website,
      rating: 4.9,
      review_count: 433,
      category: "Coffee shop",
    });
  });

  test("also takes MCP-style results with fields under metadata", async () => {
    const cards = parseBlock(blockOf(await run({ results: [{ title: "T", url: "https://e.com", text: "s", metadata: { published_date: "2026-11-01" } }] })));
    expect(cards.results[0]).toMatchObject({ published_date: "2026-11-01" });
  });

  test("refuses an empty list, too many results, or results with nothing usable", async () => {
    await expect(run({ results: [] })).rejects.toThrow("non-empty");
    await expect(run({ results: Array.from({ length: MAX_CARDS + 1 }, () => ({ title: "t", url: "https://e.com" })) })).rejects.toThrow("at most");
    await expect(run({ results: [{ title: "t", url: "ftp://e.com" }] })).rejects.toThrow("None of the results");
  });
});

describe("reading a block back", () => {
  test("anything that is not a v1 block throws, so Buzz shows the plain block", () => {
    for (const bad of ["", "not json", "{}", '{"v":2,"results":[]}', '{"v":1,"results":[]}', '{"v":1,"results":[{"title":"x"}]}'])
      expect(() => parseBlock(bad), bad).toThrow();
  });

  test("links with credentials or other schemes are dropped, even in a hand-written block", () => {
    expect(safeUrl("https://user:pw@e.com/")).toBeUndefined();
    expect(safeUrl("data:text/html,x")).toBeUndefined();
    const cards = parseBlock(JSON.stringify({ v: 1, results: [{ title: "ok", url: "https://e.com", website: "javascript:x" }, { title: "bad", url: "https://u:p@e.com" }] }));
    expect(cards.results).toEqual([{ title: "ok", url: "https://e.com/" }]);
  });
});

describe("the cards", () => {
  const render = (code: string) => renderToStaticMarkup(React.createElement(ResultCards, { code, language: BLOCK_LANGUAGE }));

  test("a source card: number, site, date, linked title and snippet", () => {
    const html = render(JSON.stringify({ v: 1, title: "Buzz", results: [{ title: "block/buzz", url: "https://www.github.com/block/buzz", text: "A hive mind", published_date: "2026-10-31" }] }));
    expect(html).toContain('href="https://www.github.com/block/buzz"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("github.com");
    expect(html).toContain("A hive mind");
    expect(html).toContain("1 result · via Search1API");
    expect(html).toContain('data-kind="source"');
  });

  test("a place card: rating, reviews, category, address and website", () => {
    const html = render(JSON.stringify({ v: 1, results: [{ title: "Flora", url: "https://maps.example/p", rating: 4.9, review_count: 1414, category: "Cafe", address: "3300 W Anderson Ln", website: "http://www.floracoffee.co/" }] }));
    expect(html).toContain('data-kind="place"');
    expect(html).toContain("4.9");
    expect(html).toContain("(1,414 reviews)");
    expect(html).toContain("3300 W Anderson Ln");
    expect(html).toContain(">floracoffee.co</a>");
  });

  test("text from the block is escaped, never markup", () => {
    const html = render(JSON.stringify({ v: 1, results: [{ title: "<img src=x onerror=alert(1)>", url: "https://e.com", text: "<script>x</script>" }] }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });

  test("a broken block throws (Buzz then shows the plain block)", () => {
    expect(() => render("{")).toThrow();
  });
});
