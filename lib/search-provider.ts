import { prisma } from "./prisma";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchProviderName = "brave" | "serper" | "serpapi";

const VALID_PROVIDERS: SearchProviderName[] = ["brave", "serper", "serpapi"];

export const PROVIDER_LABELS: Record<SearchProviderName, string> = {
  brave: "Brave Search",
  serper: "Serper.dev",
  serpapi: "SerpApi",
};

export const PROVIDER_ENV_VAR: Record<SearchProviderName, string> = {
  brave: "BRAVE_SEARCH_API_KEY",
  serper: "SERPER_API_KEY",
  serpapi: "SERPAPI_KEY",
};

/** The only feature currently backed by these settings: the "Pistes web" button on une fiche prospect. */
export const JOB_DISCOVER_CONTACTS = "discover_contacts";

export type SearchSettings = {
  jobName: string;
  provider: SearchProviderName;
  fallbackProvider: SearchProviderName | null;
  maxQueriesPerDay: number;
  minIntervalMinutes: number;
};

export class SearchQuotaExceededError extends Error {
  readonly limit: number;

  constructor(jobName: string, limit: number) {
    super(`Quota de recherche quotidien atteint (${limit}).`);
    this.name = "SearchQuotaExceededError";
    this.limit = limit;
  }
}

export class SearchCooldownError extends Error {
  readonly minutes: number;

  constructor(minutes: number) {
    super(`Ce prospect a deja ete recherche il y a moins de ${minutes} minutes. Reessaie plus tard.`);
    this.name = "SearchCooldownError";
    this.minutes = minutes;
  }
}

let tablesReady: Promise<void> | null = null;

export function ensureSearchTables() {
  if (!tablesReady) tablesReady = createTables();
  return tablesReady;
}

async function createTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS search_settings (
      job_name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'brave',
      fallback_provider TEXT,
      max_queries_per_day INTEGER NOT NULL DEFAULT 2000,
      min_interval_minutes INTEGER NOT NULL DEFAULT 60,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS search_query_log (
      id BIGSERIAL PRIMARY KEY,
      job_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS search_query_log_job_created_idx ON search_query_log (job_name, created_at)
  `);
}

function normalizeProvider(value?: string | null): SearchProviderName | null {
  if (!value) return null;
  return VALID_PROVIDERS.includes(value as SearchProviderName) ? (value as SearchProviderName) : null;
}

export async function getSearchSettings(jobName: string): Promise<SearchSettings> {
  await ensureSearchTables();
  const rows = await prisma.$queryRaw<
    Array<{
      provider: string;
      fallback_provider: string | null;
      max_queries_per_day: number;
      min_interval_minutes: number;
    }>
  >`SELECT provider, fallback_provider, max_queries_per_day, min_interval_minutes FROM search_settings WHERE job_name = ${jobName}`;

  const row = rows[0];
  return {
    jobName,
    provider: normalizeProvider(row?.provider) ?? "brave",
    fallbackProvider: normalizeProvider(row?.fallback_provider),
    maxQueriesPerDay: row?.max_queries_per_day ?? 2000,
    minIntervalMinutes: row?.min_interval_minutes ?? 60,
  };
}

export async function updateSearchSettings(input: {
  jobName: string;
  provider: SearchProviderName;
  fallbackProvider: SearchProviderName | null;
  maxQueriesPerDay: number;
  minIntervalMinutes: number;
}) {
  await ensureSearchTables();
  await prisma.$executeRaw`
    INSERT INTO search_settings (job_name, provider, fallback_provider, max_queries_per_day, min_interval_minutes, updated_at)
    VALUES (${input.jobName}, ${input.provider}, ${input.fallbackProvider}, ${input.maxQueriesPerDay}, ${input.minIntervalMinutes}, now())
    ON CONFLICT (job_name) DO UPDATE SET
      provider = EXCLUDED.provider,
      fallback_provider = EXCLUDED.fallback_provider,
      max_queries_per_day = EXCLUDED.max_queries_per_day,
      min_interval_minutes = EXCLUDED.min_interval_minutes,
      updated_at = now()
  `;
}

export function isProviderConfigured(provider: SearchProviderName) {
  return Boolean(process.env[PROVIDER_ENV_VAR[provider]]);
}

export async function queriesUsedToday(jobName: string): Promise<number> {
  await ensureSearchTables();
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM search_query_log
    WHERE job_name = ${jobName}
      AND created_at > date_trunc('day', now())
  `;
  return rows[0]?.n ?? 0;
}

async function logQuery(jobName: string, provider: SearchProviderName, query: string) {
  await prisma.$executeRaw`
    INSERT INTO search_query_log (job_name, provider, query) VALUES (${jobName}, ${provider}, ${query})
  `;
}

/**
 * Runs a query against the provider configured for this job, falling back to its
 * secondary provider (if any) when the primary fails. Enforces the shared daily quota.
 */
export async function search(jobName: string, query: string): Promise<SearchResult[]> {
  const settings = await getSearchSettings(jobName);
  const used = await queriesUsedToday(jobName);
  if (used >= settings.maxQueriesPerDay) {
    throw new SearchQuotaExceededError(jobName, settings.maxQueriesPerDay);
  }

  const chain = [settings.provider, settings.fallbackProvider].filter(
    (value): value is SearchProviderName => Boolean(value),
  );

  let lastError: unknown;
  for (const provider of chain) {
    try {
      const results = await callProvider(provider, query);
      await logQuery(jobName, provider, query);
      return results;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Recherche web indisponible.");
}

async function callProvider(provider: SearchProviderName, query: string): Promise<SearchResult[]> {
  if (provider === "brave") return searchBrave(query);
  if (provider === "serper") return searchSerper(query);
  return searchSerpApi(query);
}

async function searchBrave(query: string): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY manquant dans .env");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("country", "FR");
  url.searchParams.set("search_lang", "fr");
  url.searchParams.set("count", "10");

  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.web?.results ?? []).map((item: any) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.description ?? "",
  }));
}

async function searchSerper(query: string): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY manquant dans .env");

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, gl: "fr", hl: "fr", num: 10 }),
  });
  if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.organic ?? []).map((item: any) => ({
    title: item.title ?? "",
    url: item.link ?? "",
    snippet: item.snippet ?? "",
  }));
}

async function searchSerpApi(query: string): Promise<SearchResult[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY manquant dans .env");

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("google_domain", "google.fr");
  url.searchParams.set("hl", "fr");
  url.searchParams.set("gl", "fr");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", key);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`SerpApi HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.organic_results ?? []).map((item: any) => ({
    title: item.title ?? "",
    url: item.link ?? "",
    snippet: item.snippet ?? "",
  }));
}
