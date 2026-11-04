// The MCP tools. Database and embedding access are injected through `Backend`, so the
// tools can be tested without Supabase.
//
// The result shapes follow OpenAI's convention for `search` and `fetch`: a single text item
// containing JSON, `{results:[{id,title,url,...}]}` for search and `{id,title,text,url,metadata}`
// for fetch. The same data is also returned as `structuredContent`.

import { type Tool, ToolInputError, type ToolResult } from "./mcp.ts";

export interface ChunkHit {
  chunk_id: number;
  article_id: number;
  content: string;
  score: number;
  title: string;
  source_url: string | null;
  published_at: string | null;
  author_name: string | null;
  categories: string[];
  tags: string[];
}

export interface ArticleRow {
  id: number;
  title: string;
  slug: string;
  source_url: string | null;
  published_at_gmt: string | null;
  modified_at_gmt: string | null;
  author_name: string | null;
  excerpt: string | null;
  content_text?: string | null;
  categories: string[];
  tags: string[];
}

export interface MatchParams {
  query_embedding: number[];
  query_text: string;
  match_count: number;
  filter_category: string | null;
  filter_tag: string | null;
  date_from: string | null;
  date_to: string | null;
}

export interface Backend {
  embed(text: string): Promise<number[]>;
  matchChunks(p: MatchParams): Promise<ChunkHit[]>;
  getArticle(id: number | null, slug: string | null): Promise<ArticleRow | null>;
  latestArticles(limit: number, category: string | null, tag: string | null): Promise<ArticleRow[]>;
  categoryCounts(): Promise<Array<{ category: string; article_count: number }>>;
}

export const SITE_NAME = "WiT (Web in Travel)";
const MAX_FETCH_CHARS = 30_000;
const SNIPPET_CHARS = 1_200;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// ---------------------------------------------------------------------------- input helpers

function optString(args: Record<string, unknown>, key: string, max = 200): string | null {
  const v = args[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ToolInputError(`${key} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new ToolInputError(`${key} must be at most ${max} characters`);
  return s || null;
}

function optInt(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolInputError(`${key} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Accepts YYYY, YYYY-MM or YYYY-MM-DD. `end` moves to the start of the next period (exclusive bound). */
function optDate(args: Record<string, unknown>, key: string, end: boolean): string | null {
  const s = optString(args, key, 10);
  if (!s) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) throw new ToolInputError(`${key} must look like YYYY, YYYY-MM or YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ? Number(m[3]) : 1];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== mo - 1) {
    throw new ToolInputError(`${key} is not a valid date`);
  }
  if (end) {
    if (m[3]) date.setUTCDate(date.getUTCDate() + 1);
    else if (m[2]) date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setUTCFullYear(date.getUTCFullYear() + 1);
  }
  return date.toISOString();
}

// ---------------------------------------------------------------------------- formatting

function stripTitle(content: string, title: string): string {
  const prefix = `${title}\n\n`;
  return content.startsWith(prefix) ? content.slice(prefix.length) : content;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return s.slice(0, cut > max * 0.8 ? cut : max) + " …";
}

const day = (ts: string | null) => (ts ? ts.slice(0, 10) : null);

function summary(a: ArticleRow) {
  return {
    id: String(a.id),
    title: a.title,
    url: a.source_url,
    published_at: day(a.published_at_gmt),
    author: a.author_name,
    categories: a.categories,
    excerpt: a.excerpt ? truncate(a.excerpt, 400) : null,
  };
}

function result(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

// ---------------------------------------------------------------------------- tools

export function buildTools(backend: Backend): Tool[] {
  const filterProps = {
    category: { type: "string", description: "Only articles in this category (exact name, case-insensitive). Use list_categories to see valid names." },
    tag: { type: "string", description: "Only articles with this tag (exact name, case-insensitive)." },
  };

  return [
    {
      name: "search",
      title: "Search articles",
      description:
        `Search the ${SITE_NAME} article archive (travel industry news, analysis and opinion) by meaning and keywords. ` +
        "Returns the most relevant articles, each with the best-matching passage. " +
        "Use this for any question about travel/tourism/hospitality companies, people, trends or events covered by the site. " +
        "Cite articles using their url. Use fetch to read a full article when the passage is not enough.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language question or keywords.", minLength: 1, maxLength: 500 },
          limit: { type: "integer", description: "Number of articles to return (1-20, default 8).", minimum: 1, maximum: 20 },
          ...filterProps,
          date_from: { type: "string", description: "Only articles published on/after this date (YYYY, YYYY-MM or YYYY-MM-DD)." },
          date_to: { type: "string", description: "Only articles published on/before this date (YYYY, YYYY-MM or YYYY-MM-DD)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { title: "Search articles", ...READ_ONLY },
      handler: async (args) => {
        const query = optString(args, "query", 500);
        if (!query) throw new ToolInputError("query is required");
        const limit = optInt(args, "limit", 8, 1, 20);
        const hits = await backend.matchChunks({
          query_embedding: await backend.embed(query),
          query_text: query,
          match_count: limit,
          filter_category: optString(args, "category"),
          filter_tag: optString(args, "tag"),
          date_from: optDate(args, "date_from", false),
          date_to: optDate(args, "date_to", true),
        });
        return result({
          results: hits.map((h) => ({
            id: String(h.article_id),
            title: h.title,
            url: h.source_url,
            published_at: day(h.published_at),
            author: h.author_name,
            categories: h.categories,
            snippet: truncate(stripTitle(h.content, h.title), SNIPPET_CHARS),
          })),
        });
      },
    },
    {
      name: "fetch",
      title: "Fetch article",
      description:
        "Get the full text and metadata of one article by its id (from search results), slug, or URL.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Article id from search results (a slug or article URL also works)." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { title: "Fetch article", ...READ_ONLY },
      handler: async (args) => {
        const raw = optString(args, "id", 500);
        if (!raw) throw new ToolInputError("id is required");
        let id: number | null = null;
        let slug: string | null = null;
        if (/^\d+$/.test(raw)) id = Number(raw);
        else {
          // Accept a full URL: use its last path segment as the slug.
          const seg = raw.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
          slug = seg || raw;
        }
        const a = await backend.getArticle(id, slug);
        if (!a) throw new ToolInputError(`No article found for "${raw}"`);
        const text = a.content_text || a.excerpt || "";
        return result({
          id: String(a.id),
          title: a.title,
          text: truncate(text, MAX_FETCH_CHARS),
          url: a.source_url,
          metadata: {
            published_at: day(a.published_at_gmt),
            modified_at: day(a.modified_at_gmt),
            author: a.author_name,
            categories: a.categories,
            tags: a.tags,
            truncated: text.length > MAX_FETCH_CHARS,
          },
        });
      },
    },
    {
      name: "latest_articles",
      title: "Latest articles",
      description:
        `List the most recently published ${SITE_NAME} articles, optionally within a category or tag. ` +
        "Use for 'what's new' or 'recent coverage of X' questions.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Number of articles (1-20, default 10).", minimum: 1, maximum: 20 },
          ...filterProps,
        },
        additionalProperties: false,
      },
      annotations: { title: "Latest articles", ...READ_ONLY },
      handler: async (args) => {
        const rows = await backend.latestArticles(
          optInt(args, "limit", 10, 1, 20),
          optString(args, "category"),
          optString(args, "tag"),
        );
        return result({ results: rows.map(summary) });
      },
    },
    {
      name: "list_categories",
      title: "List categories",
      description: "List article categories with the number of articles in each. Use to pick a category filter.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List categories", ...READ_ONLY },
      handler: async () => result({ categories: await backend.categoryCounts() }),
    },
  ];
}

export const SERVER_INSTRUCTIONS =
  `This server searches the ${SITE_NAME} article archive. Call search with the user's question ` +
  "(rephrase it into a clear query), answer only from the returned articles, and cite them by url. " +
  "If nothing relevant comes back, say the archive does not seem to cover it.";
