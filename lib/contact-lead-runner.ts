import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { buildSearchQueriesForLead, classifyLeadSource } from "./contact-leads";
import {
  search as runSearch,
  getSearchSettings,
  SearchQuotaExceededError,
  SearchCooldownError,
  JOB_DISCOVER_CONTACTS as JOB_NAME,
} from "./search-provider";

type ProspectLeadInput = {
  siren: string;
  name: string;
  city: string | null;
  address: string | null;
  leadersText: string | null;
  leaders: unknown;
  raw: unknown;
};

export async function ensureContactLeadTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS contact_leads (
      id TEXT PRIMARY KEY,
      prospect_siren TEXT NOT NULL,
      lead_type TEXT NOT NULL,
      searched_entity TEXT NOT NULL,
      title TEXT,
      url TEXT NOT NULL,
      snippet TEXT,
      source_domain TEXT,
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0.4,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'TO_VERIFY',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (prospect_siren, url)
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS contact_leads_prospect_siren_idx ON contact_leads (prospect_siren)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS contact_leads_status_idx ON contact_leads (status)
  `);

  // Cooldown par prospect specifique au bouton "Pistes web" (pas utilise par le batch automatique).
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS contact_lead_manual_attempts (
      prospect_siren TEXT PRIMARY KEY,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/** Recherche manuelle declenchee par le bouton "Pistes web" sur la fiche prospect. */
export async function discoverContactLeadsForSiren(siren: string) {
  await ensureContactLeadTables();

  const settings = await getSearchSettings(JOB_NAME);
  const rows = await prisma.$queryRaw<Array<{ attempted_at: Date }>>`
    SELECT attempted_at FROM contact_lead_manual_attempts WHERE prospect_siren = ${siren}
  `;
  const lastAttempt = rows[0]?.attempted_at;
  if (lastAttempt) {
    const elapsedMinutes = (Date.now() - new Date(lastAttempt).getTime()) / 60_000;
    if (elapsedMinutes < settings.minIntervalMinutes) {
      throw new SearchCooldownError(settings.minIntervalMinutes);
    }
  }

  const prospect = await prisma.prospect.findUnique({
    where: { siren },
    select: {
      siren: true,
      name: true,
      city: true,
      address: true,
      leadersText: true,
      leaders: true,
      raw: true,
    },
  });

  if (!prospect) throw new Error("Prospect introuvable");

  const saved = await discoverForProspect(prospect);
  await prisma.$executeRaw`
    INSERT INTO contact_lead_manual_attempts (prospect_siren, attempted_at)
    VALUES (${siren}, now())
    ON CONFLICT (prospect_siren) DO UPDATE SET attempted_at = now()
  `;
  return saved;
}

/** Utilise par le worker automatique (script discover-contact-leads.ts / GitHub Actions). */
export async function discoverContactLeadsBatch(batch: number) {
  await ensureContactLeadTables();

  const prospects = await prisma.prospect.findMany({
    where: {
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
      leaders: true,
      raw: true,
    },
  });

  const results = [];
  for (const prospect of prospects) {
    try {
      results.push({
        prospect,
        saved: await discoverForProspect(prospect),
      });
    } catch (error) {
      if (error instanceof SearchQuotaExceededError) {
        console.log(`${error.message} Arret du batch (${results.length}/${prospects.length} traites).`);
        break;
      }
      throw error;
    }
  }

  return results;
}

async function recentlyAttemptedSirens() {
  const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(`
    SELECT DISTINCT prospect_siren
    FROM contact_leads
    WHERE created_at > now() - interval '14 days'
  `);
  return rows.map((row) => row.prospect_siren);
}

async function discoverForProspect(prospect: ProspectLeadInput) {
  const queryPlans = buildSearchQueriesForLead(prospect).slice(0, 12);
  let saved = 0;

  for (const plan of queryPlans) {
    let savedForPlan = 0;
    const results = await runSearch(JOB_NAME, plan.query);
    for (const result of results) {
      const classified = classifyLeadSource(result, plan, prospect);
      if (await saveLead(prospect.siren, plan.entity, classified)) {
        saved += 1;
        savedForPlan += 1;
      }
      if (savedForPlan >= 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return saved;
}

async function saveLead(prospectSiren: string, searchedEntity: string, result: ReturnType<typeof classifyLeadSource>) {
  if (!result) return false;

  const rows = await prisma.$queryRaw<Array<{ inserted: boolean }>>`
    INSERT INTO contact_leads (
      id,
      prospect_siren,
      lead_type,
      searched_entity,
      title,
      url,
      snippet,
      source_domain,
      confidence,
      reason,
      status,
      updated_at
    )
    VALUES (
      ${randomUUID()},
      ${prospectSiren},
      ${result.leadType},
      ${searchedEntity},
      ${result.title},
      ${result.url},
      ${result.snippet},
      ${result.sourceDomain},
      ${result.confidence},
      ${result.reason},
      'TO_VERIFY',
      now()
    )
    ON CONFLICT (prospect_siren, url) DO UPDATE SET
      confidence = GREATEST(contact_leads.confidence, EXCLUDED.confidence),
      reason = EXCLUDED.reason,
      updated_at = now()
    RETURNING (xmax = 0) AS inserted
  `;
  return Boolean(rows[0]?.inserted);
}
