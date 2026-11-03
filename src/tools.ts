import type { AddedTool } from "./buzz";
import type { S1Client } from "./client";

// The agent tools. Their names start with the plugin's, as Buzz asks, so they never take a
// name another plugin might want. Each reply is JSON text the agent reads and cites from.

/** Longest page text handed to an agent from one read, in characters. */
export const MAX_PAGE_CHARS = 60_000;
/** Longest full text kept per result when a search also reads its top results. */
export const MAX_RESULT_CHARS = 12_000;

const SEARCH_SERVICES = [
  "google", "bing", "bingcn", "duckduckgo", "yahoo", "yandex", "x", "reddit", "github",
  "youtube", "arxiv", "wechat", "bilibili", "imdb", "wikipedia", "grokipedia",
] as const;
const NEWS_SERVICES = ["google", "bing", "duckduckgo", "yahoo", "hackernews"] as const;
const TIME_RANGES = ["day", "week", "month", "year"] as const;

type RawResult = {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  content?: unknown;
  published_date?: unknown;
};
type SearchBody = { results?: RawResult[] };
type MapsBody = { results?: Record<string, unknown>[] };
type CrawlBody = { results?: { title?: unknown; link?: unknown; content?: unknown } };

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

function cut(value: string, limit: number): { text: string; truncated: boolean } {
  return value.length > limit ? { text: value.slice(0, limit), truncated: true } : { text: value, truncated: false };
}

/** One result as the agent gets it: what it needs to answer and cite, nothing else. */
function shapeResult(result: RawResult) {
  const url = text(result.link);
  if (!url) return undefined;
  const content = text(result.content);
  const page = content ? cut(content, MAX_RESULT_CHARS) : undefined;
  return {
    title: text(result.title) ?? url,
    url,
    ...(text(result.snippet) ? { snippet: text(result.snippet) } : {}),
    ...(text(result.published_date) ? { published_date: text(result.published_date) } : {}),
    ...(page ? { content: page.text, ...(page.truncated ? { content_truncated: true } : {}) } : {}),
  };
}

// --- Argument checks. A throw is a tool error the agent can correct. ---

function requireString(args: Record<string, unknown>, name: string, max = 1000): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return value.trim();
}

function optionalInt(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function optionalEnum<T extends string>(args: Record<string, unknown>, name: string, allowed: readonly T[]): T | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function optionalSites(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20 || !value.every((site) => typeof site === "string" && site.trim() && site.length <= 253))
    throw new Error(`${name} must be a list of up to 20 domains, such as ["github.com"]`);
  return value.map((site: string) => site.trim());
}

function requireHttpUrl(args: Record<string, unknown>, name: string): string {
  const raw = requireString(args, name, 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a full http(s) address, such as https://example.com/page`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must start with http:// or https://`);
  return url.toString();
}

function optionalLocation(value: unknown): { latitude: number; longitude: number; zoom?: number } | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const number = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (typeof value !== "object" || !number(v.latitude, -90, 90) || !number(v.longitude, -180, 180) || (v.zoom !== undefined && !number(v.zoom, 3, 30)))
    throw new Error("location must be {latitude: -90..90, longitude: -180..180, zoom?: 3..30}");
  return defined({ latitude: v.latitude, longitude: v.longitude, zoom: v.zoom }) as { latitude: number; longitude: number; zoom?: number };
}

const defined = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

const sitesSchema = (description: string) => ({ type: "array", items: { type: "string" }, maxItems: 20, description });

export function createTools(client: S1Client): AddedTool[] {
  const search: AddedTool = {
    name: "search1api_search",
    description:
      "Search the live web with Search1API when the answer needs current information or sources. Returns JSON results with title, url, snippet and, when known, published_date. Pick search_service only when the user's intent matches a source (github, reddit, x, youtube, arxiv, wikipedia, wechat, bilibili and more); the default is google. Set crawl_results to also read the top results in full. Read any other result with search1api_crawl. Cite the urls you use.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short, focused search query" },
        max_results: { type: "integer", minimum: 1, maximum: 50, description: "How many results the answer needs; default 10" },
        search_service: { type: "string", enum: [...SEARCH_SERVICES], description: "Engine or source to search; default google" },
        crawl_results: { type: "integer", minimum: 0, maximum: 10, description: "How many top results to also read in full; each page read costs 1 more credit. Default 0" },
        include_sites: sitesSchema("Only search these domains, when the user scopes the search"),
        exclude_sites: sitesSchema("Leave these domains out"),
        time_range: { type: "string", enum: [...TIME_RANGES], description: "Only results from this recent window; leave unset for evergreen topics" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const request = defined({
        query: requireString(args, "query"),
        max_results: optionalInt(args, "max_results", 1, 50),
        search_service: optionalEnum(args, "search_service", SEARCH_SERVICES),
        crawl_results: optionalInt(args, "crawl_results", 0, 10),
        include_sites: optionalSites(args, "include_sites"),
        exclude_sites: optionalSites(args, "exclude_sites"),
        time_range: optionalEnum(args, "time_range", TIME_RANGES),
      });
      const crawling = typeof request.crawl_results === "number" && request.crawl_results > 0;
      const body = await client.post<SearchBody>("/search", request, crawling ? 90_000 : 30_000);
      const results = (body.results ?? []).map(shapeResult).filter((r) => r !== undefined);
      return JSON.stringify({ query: request.query, results }, null, 1);
    },
  };

  const news: AddedTool = {
    name: "search1api_news",
    description:
      "Search recent news with Search1API when the user asks about recent events, announcements or coverage. Returns JSON articles with title, url, snippet and published_date when known. Use time_range day for breaking news. search_service hackernews returns Hacker News discussions instead of publisher articles. Cite the urls you use.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short, focused news query" },
        max_results: { type: "integer", minimum: 1, maximum: 50, description: "How many articles the answer needs; default 10" },
        search_service: { type: "string", enum: [...NEWS_SERVICES], description: "News engine; default bing" },
        include_sites: sitesSchema("Only these news domains"),
        exclude_sites: sitesSchema("Leave these news domains out"),
        time_range: { type: "string", enum: [...TIME_RANGES], description: "Only articles from this window" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const request = defined({
        query: requireString(args, "query"),
        max_results: optionalInt(args, "max_results", 1, 50),
        search_service: optionalEnum(args, "search_service", NEWS_SERVICES),
        include_sites: optionalSites(args, "include_sites"),
        exclude_sites: optionalSites(args, "exclude_sites"),
        time_range: optionalEnum(args, "time_range", TIME_RANGES),
      });
      const body = await client.post<SearchBody>("/news", request, 30_000);
      const results = (body.results ?? []).map(shapeResult).filter((r) => r !== undefined);
      return JSON.stringify({ query: request.query, results }, null, 1);
    },
  };

  const crawl: AddedTool = {
    name: "search1api_crawl",
    description:
      "Read a public web page with Search1API: a link the user shared or a url from search1api_search. Returns JSON with the page's title, url and main content as text, so the answer can rest on the whole page instead of a snippet. Very long pages are cut short and marked truncated.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page's full http(s) address" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const url = requireHttpUrl(args, "url");
      const body = await client.post<CrawlBody>("/crawl", { url }, 90_000);
      const page = body.results;
      const content = text(page?.content);
      if (!content) throw new Error(`Search1API could not read any text from ${url}`);
      const { text: kept, truncated } = cut(content, MAX_PAGE_CHARS);
      return JSON.stringify(
        { title: text(page?.title) ?? url, url: text(page?.link) ?? url, content: kept, ...(truncated ? { truncated: true, total_chars: content.length } : {}) },
        null,
        1,
      );
    },
  };

  const maps: AddedTool = {
    name: "search1api_maps",
    description:
      "Find local businesses and places on Google Maps with Search1API, when the user asks where something is, wants nearby options, or needs a list of businesses with contact details. Returns JSON with one page of up to 20 places: name and Google Maps link, plus address, phone, website, category, rating, review count, coordinates and opening hours when known. Costs 3 credits per page however many places it holds. Use search1api_search for web pages and search1api_crawl to read a business's website.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000, description: 'What to look for, such as "coffee shops" or "dentists in Austin"; a place name in the query sets the area when no location is given' },
        country: { type: "string", pattern: "^[a-zA-Z]{2}$", description: "Two-letter country code for local results; default us" },
        language: { type: "string", description: "Result language, such as en, de or zh-CN; default en" },
        location: {
          type: "object",
          description: "Search around this point instead of letting the query decide the area; required for page 2 and later",
          properties: {
            latitude: { type: "number", minimum: -90, maximum: 90 },
            longitude: { type: "number", minimum: -180, maximum: 180 },
            zoom: { type: "number", minimum: 3, maximum: 30, description: "Map zoom, higher is a smaller area; default 14" },
          },
          required: ["latitude", "longitude"],
          additionalProperties: false,
        },
        page: { type: "integer", minimum: 1, maximum: 6, description: "Page to fetch; each page is a separate 3-credit call and pages after the first need location" },
        max_results: { type: "integer", minimum: 1, maximum: 20, description: "How many places the answer needs; fewer places do not lower the price" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const country = args.country;
      if (country !== undefined && (typeof country !== "string" || !/^[a-zA-Z]{2}$/.test(country)))
        throw new Error("country must be a two-letter country code, such as us or de");
      const language = args.language;
      if (language !== undefined && (typeof language !== "string" || !/^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(language)))
        throw new Error("language must be a language code, such as en, de or zh-CN");
      const location = optionalLocation(args.location);
      const page = optionalInt(args, "page", 1, 6);
      if (page !== undefined && page > 1 && !location) throw new Error("location is required for page 2 and later");
      const request = defined({
        query: requireString(args, "query"),
        country,
        language,
        location,
        page,
        max_results: optionalInt(args, "max_results", 1, 20),
      });
      const body = await client.post<MapsBody>("/maps", request, 45_000);
      const places = (body.results ?? [])
        .filter((place) => typeof place.name === "string" && typeof place.maps_url === "string")
        // The photo link is long and tells the agent nothing it can use.
        .map(({ thumbnail: _thumbnail, ...place }) => place);
      return JSON.stringify({ query: request.query, places }, null, 1);
    },
  };

  return [search, news, crawl, maps];
}
