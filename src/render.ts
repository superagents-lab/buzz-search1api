import type { AddedTool } from "./buzz";

// Results as cards in a Buzz conversation, the way render_results works in the Search1API MCP server: the agent
// hands over results it already has, in the order to show, and nothing is searched again or charged. Buzz agents
// cannot show an MCP app, so the tool gives back a fenced code block for the agent to put in its reply, and the
// plugin draws that block as cards (`registerCodeBlock`). Where the plugin is not installed the block stays readable
// JSON, and nothing else in the message changes.

export const BLOCK_LANGUAGE = "search1api-results";
export const MAX_CARDS = 50;
const MAX_TITLE = 300;
const MAX_TEXT = 400;
const MAX_HEADING = 120;

/** What a card can show beyond the title and link. Anything else the agent passes is dropped. */
export type CardMeta = {
  published_date?: string;
  source?: string;
  rating?: number;
  review_count?: number;
  category?: string;
  address?: string;
  open_state?: string;
  phone?: string;
  website?: string;
  price?: string;
};
export type Card = { title: string; url: string; text?: string } & CardMeta;
export type Cards = { v: 1; title?: string; results: Card[] };

const STRING_META = ["published_date", "source", "category", "address", "open_state", "phone", "price"] as const;

/** An http(s) address without credentials, or nothing. */
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
  return url.toString();
}

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** One card from what an agent passed, or from a block read back; `undefined` when it has no title or usable link. */
function toCard(raw: unknown): Card | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  // Results from search1api_maps carry `name` and `maps_url`; from the other tools, `title` and `url`.
  const title = clean(item.title ?? item.name, MAX_TITLE);
  const url = safeUrl(item.url ?? item.maps_url);
  if (!title || !url) return undefined;
  // Fields may come flat (as the tools return them) or under `metadata` (as the MCP render_results takes them).
  const meta = { ...(item.metadata && typeof item.metadata === "object" ? (item.metadata as Record<string, unknown>) : {}), ...item };
  const card: Card = { title, url };
  const text = clean(item.text ?? item.snippet ?? item.description, MAX_TEXT);
  if (text) card.text = text;
  for (const key of STRING_META) {
    const value = clean(meta[key], 200);
    if (value) card[key] = value;
  }
  if (typeof meta.rating === "number" && Number.isFinite(meta.rating) && meta.rating >= 0 && meta.rating <= 5) card.rating = meta.rating;
  if (typeof meta.review_count === "number" && Number.isInteger(meta.review_count) && meta.review_count >= 0) card.review_count = meta.review_count;
  const website = safeUrl(meta.website);
  if (website) card.website = website;
  return card;
}

/** Reads a block back. Throws on anything that is not one, so Buzz shows the plain block instead. */
export function parseBlock(code: string): Cards {
  const data = JSON.parse(code) as Record<string, unknown>;
  if (!data || typeof data !== "object" || data.v !== 1 || !Array.isArray(data.results)) throw new Error("Not a Search1API results block");
  const results = data.results.slice(0, MAX_CARDS).map(toCard).filter((card): card is Card => card !== undefined);
  if (results.length === 0) throw new Error("No results to show");
  const title = clean(data.title, MAX_HEADING);
  return { v: 1, ...(title ? { title } : {}), results };
}

export function buildBlock(cards: Cards): string {
  return `\`\`\`${BLOCK_LANGUAGE}\n${JSON.stringify(cards, null, 1)}\n\`\`\``;
}

export function createRenderTool(): AddedTool {
  return {
    name: "search1api_render_results",
    description:
      "Show results you already have from search1api_search, search1api_news or search1api_maps as cards in your Buzz reply. Pass them in the order to show; never invent titles or links. It returns a fenced code block: put that block in your message exactly as given, where the cards should appear, and keep writing your answer around it. It does not search or fetch anything and costs no credits. Use it when the user wants to browse sources or a list of places; skip it when a plain answer is enough.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: MAX_HEADING, description: "Heading above the cards, such as the topic" },
        results: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CARDS,
          description: "Results as the Search1API tools returned them, in display order. Places from search1api_maps can be passed as they are.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Title as returned (or `name` for a place)" },
              url: { type: "string", description: "Link as returned (or `maps_url` for a place)" },
              text: { type: "string", description: "The snippet, or a faithful excerpt; not your own summary" },
              published_date: { type: "string" },
              rating: { type: "number" },
              review_count: { type: "integer" },
              category: { type: "string" },
              address: { type: "string" },
              open_state: { type: "string" },
              phone: { type: "string" },
              website: { type: "string" },
              price: { type: "string" },
            },
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      if (!Array.isArray(args.results) || args.results.length === 0) throw new Error("results must be a non-empty list of results you already have");
      if (args.results.length > MAX_CARDS) throw new Error(`results can hold at most ${MAX_CARDS} items`);
      const results = args.results.map(toCard).filter((card): card is Card => card !== undefined);
      const dropped = args.results.length - results.length;
      if (results.length === 0) throw new Error("None of the results had a title and an http(s) link");
      const title = clean(args.title, MAX_HEADING);
      const block = buildBlock({ v: 1, ...(title ? { title } : {}), results });
      return [
        `Put this block in your reply exactly as it is, where the cards should appear${dropped ? ` (${dropped} result${dropped === 1 ? "" : "s"} without a title or http(s) link left out)` : ""}:`,
        "",
        block,
      ].join("\n");
    },
  };
}
