import { ContactType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  buildSearchQueries,
  discoverInternalPages,
  extractContactsFromHtml,
  isRegistryDomain,
  isLikelyOfficialCompanySite,
  rankWebsiteCandidates,
  type ContactCandidate,
  type SearchResult,
  unique,
} from "../lib/web-contact";

type Args = {
  batch: number;
  sleep: number;
  once: boolean;
};

type ProspectForWeb = {
  siren: string;
  name: string;
  city: string | null;
  address: string | null;
  leadersText: string | null;
};

const SOURCE = "web_contact_enrichment_v1";

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    batch: Number(readValue("--batch") ?? 25),
    sleep: Number(readValue("--sleep") ?? 60_000),
    once: args.includes("--once"),
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS web_contact_attempts (
      prospect_siren TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      queries JSONB NOT NULL,
      status TEXT NOT NULL,
      results_count INTEGER NOT NULL DEFAULT 0,
      contacts_found INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS web_contact_attempts_status_idx
    ON web_contact_attempts (status)
  `);
}

async function fetchBatch(batch: number) {
  return prisma.prospect.findMany({
    where: {
      contactPoints: { none: {} },
      NOT: {
        siren: {
          in: await recentlyAttemptedSirens(),
        },
      },
    },
    orderBy: [{ score: "desc" }, { firstSeenAt: "asc" }],
    take: batch,
    select: {
      siren: true,
      name: true,
      city: true,
      address: true,
      leadersText: true,
    },
  });
}

async function recentlyAttemptedSirens() {
  const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(`
    SELECT prospect_siren
    FROM web_contact_attempts
    WHERE attempted_at > now() - interval '7 days'
  `);
  return rows.map((row) => row.prospect_siren);
}

async function searchWeb(query: string): Promise<SearchResult[]> {
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("country", "FR");
    url.searchParams.set("search_lang", "fr");
    url.searchParams.set("count", "10");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY,
      },
    });
    if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.web?.results ?? []).map((item: any) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      description: item.description ?? "",
    }));
  }

  if (process.env.SERPAPI_KEY) {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("google_domain", "google.fr");
    url.searchParams.set("hl", "fr");
    url.searchParams.set("gl", "fr");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", process.env.SERPAPI_KEY);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`SerpApi HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.organic_results ?? []).map((item: any) => ({
      title: item.title ?? "",
      url: item.link ?? "",
      description: item.snippet ?? "",
    }));
  }

  throw new Error("Aucune API de recherche configuree. Ajouter BRAVE_SEARCH_API_KEY ou SERPAPI_KEY dans .env.");
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "sci-prospects-contact-enricher/0.1",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return "";
  return response.text();
}

async function saveContact(prospectSiren: string, contact: ContactCandidate) {
  await prisma.contactPoint.upsert({
    where: {
      prospectSiren_type_value: {
        prospectSiren,
        type: contact.type,
        value: contact.value,
      },
    },
    create: {
      prospectSiren,
      type: contact.type,
      value: contact.value,
      source: contact.source,
      confidence: contact.confidence,
    },
    update: {
      source: contact.source,
      confidence: Math.max(contact.confidence, 0.4),
    },
  });
}

async function markAttempt(
  prospectSiren: string,
  provider: string,
  queries: string[],
  status: string,
  resultsCount: number,
  contactsFound: number,
  error?: string,
) {
  const queriesJson = JSON.stringify(queries);
  await prisma.$executeRaw`
    INSERT INTO web_contact_attempts (
      prospect_siren,
      provider,
      queries,
      status,
      results_count,
      contacts_found,
      error,
      attempted_at,
      updated_at
    )
    VALUES (
      ${prospectSiren},
      ${provider},
      ${queriesJson}::jsonb,
      ${status},
      ${resultsCount},
      ${contactsFound},
      ${error?.slice(0, 1000) ?? null},
      now(),
      now()
    )
    ON CONFLICT (prospect_siren) DO UPDATE SET
      provider = EXCLUDED.provider,
      queries = EXCLUDED.queries,
      status = EXCLUDED.status,
      results_count = EXCLUDED.results_count,
      contacts_found = EXCLUDED.contacts_found,
      error = EXCLUDED.error,
      attempted_at = now(),
      updated_at = now()
  `;
}

async function enrichProspect(prospect: ProspectForWeb) {
  const queries = buildSearchQueries(prospect);
  const allResults: SearchResult[] = [];

  for (const query of queries.slice(0, 3)) {
    const results = await searchWeb(query);
    allResults.push(...results);
    await wait(350);
  }

  const candidates = rankWebsiteCandidates(uniqueByUrl(allResults), prospect).slice(0, 3);
  const contacts: ContactCandidate[] = [];

  for (const candidate of candidates) {
    if (isRegistryDomain(candidate.url)) {
      continue;
    }
    if (!isLikelyOfficialCompanySite(candidate.url, prospect.name, prospect.siren)) {
      continue;
    }

    contacts.push({
      type: ContactType.WEBSITE,
      value: new URL(candidate.url).origin,
      source: candidate.url,
      confidence: Math.min(0.78, 0.35 + candidate.score / 100),
    });

    try {
      const html = await fetchHtml(candidate.url);
      contacts.push(...extractContactsFromHtml(html, candidate.url));
      for (const page of discoverInternalPages(html, candidate.url)) {
        const pageHtml = await fetchHtml(page).catch(() => "");
        if (pageHtml) contacts.push(...extractContactsFromHtml(pageHtml, page));
      }
    } catch {
      // Search result can still be useful as a website candidate.
    }
  }

  const uniqueContacts = dedupeContacts(contacts).slice(0, 12);
  for (const contact of uniqueContacts) {
    await saveContact(prospect.siren, contact);
  }

  await markAttempt(
    prospect.siren,
    process.env.BRAVE_SEARCH_API_KEY ? "brave" : process.env.SERPAPI_KEY ? "serpapi" : "none",
    queries,
    "OK",
    allResults.length,
    uniqueContacts.length,
  );

  return uniqueContacts.length;
}

async function runBatch(batch: number) {
  const prospects = await fetchBatch(batch);
  let contacts = 0;
  let processed = 0;
  let errors = 0;

  for (const prospect of prospects) {
    try {
      contacts += await enrichProspect(prospect);
      processed += 1;
    } catch (error) {
      await markAttempt(prospect.siren, "none", buildSearchQueries(prospect), "ERROR", 0, 0, (error as Error).message);
      errors += 1;
      if ((error as Error).message.includes("Aucune API de recherche")) throw error;
    }
  }

  return { found: prospects.length, processed, contacts, errors };
}

async function main() {
  const args = parseArgs();
  await ensureTable();

  if (!process.env.BRAVE_SEARCH_API_KEY && !process.env.SERPAPI_KEY) {
    console.log("Enrichissement web contact pret, mais BRAVE_SEARCH_API_KEY ou SERPAPI_KEY manque dans .env.");
    return;
  }

  console.log(`Enrichissement web contact demarre. Batch=${args.batch}.`);
  while (true) {
    const result = await runBatch(args.batch);
    console.log(`${result.processed} prospects traites, ${result.contacts} contacts trouves, ${result.errors} erreurs.`);

    if (args.once) return;
    if (result.found === 0) {
      console.log(`Aucun prospect contact a enrichir. Pause ${args.sleep}ms.`);
      await wait(args.sleep);
    }
  }
}

function uniqueByUrl(results: SearchResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function dedupeContacts(contacts: ContactCandidate[]) {
  const seen = new Set<string>();
  return contacts.filter((contact) => {
    const key = `${contact.type}:${contact.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
