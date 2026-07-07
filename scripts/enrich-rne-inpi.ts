import { prisma } from "../lib/prisma";
import { fetchJsonWithRetry, wait } from "../lib/http";

type Args = {
  batch: number;
  sleep: number;
  once: boolean;
};

const SOURCE = "inpi_rne_company_api_v1";

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    batch: Number(readValue("--batch") ?? 50),
    sleep: Number(readValue("--sleep") ?? 30_000),
    once: args.includes("--once"),
  };
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rne_inpi_enrichments (
      prospect_siren TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload JSONB,
      company_name TEXT,
      legal_form TEXT,
      has_acts BOOLEAN,
      has_annual_accounts BOOLEAN,
      leaders JSONB,
      representatives JSONB,
      fetched_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'PENDING',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS rne_inpi_enrichments_status_idx
    ON rne_inpi_enrichments (status)
  `);
}

async function fetchBatch(batch: number) {
  return prisma.$queryRawUnsafe<Array<{ siren: string }>>(`
    SELECT p."siren"
    FROM "Prospect" p
    WHERE NOT EXISTS (
      SELECT 1 FROM rne_inpi_enrichments r WHERE r.prospect_siren = p."siren"
    )
    ORDER BY p."score" DESC, p."firstSeenAt" ASC
    LIMIT ${Number(batch)}
  `);
}

async function markError(siren: string, error: string) {
  await prisma.$executeRaw`
    INSERT INTO rne_inpi_enrichments (prospect_siren, source, status, error, updated_at)
    VALUES (${siren}, ${SOURCE}, 'ERROR', ${error.slice(0, 1000)}, now())
    ON CONFLICT (prospect_siren) DO UPDATE SET
      status = 'ERROR',
      error = EXCLUDED.error,
      updated_at = now()
  `;
}

async function saveRnePayload(siren: string, payload: any) {
  const leaders = payload?.formality?.content?.personneMorale?.composition?.pouvoirs ?? payload?.dirigeants ?? null;
  const representatives = payload?.formality?.content?.personneMorale?.composition ?? null;
  const companyName =
    payload?.formality?.content?.personneMorale?.identite?.entreprise?.denomination ??
    payload?.denomination ??
    payload?.nomEntreprise ??
    null;
  const legalForm =
    payload?.formality?.content?.personneMorale?.identite?.description?.formeJuridique ??
    payload?.formeJuridique ??
    null;
  const hasActs = Boolean(JSON.stringify(payload).match(/acte|statut/i));
  const hasAnnualAccounts = Boolean(JSON.stringify(payload).match(/compte|bilan|resultat/i));

  await prisma.$executeRaw`
    INSERT INTO rne_inpi_enrichments (
      prospect_siren,
      source,
      payload,
      company_name,
      legal_form,
      has_acts,
      has_annual_accounts,
      leaders,
      representatives,
      fetched_at,
      status,
      error,
      updated_at
    )
    VALUES (
      ${siren},
      ${SOURCE},
      ${payload},
      ${companyName},
      ${legalForm},
      ${hasActs},
      ${hasAnnualAccounts},
      ${leaders},
      ${representatives},
      now(),
      'OK',
      NULL,
      now()
    )
    ON CONFLICT (prospect_siren) DO UPDATE SET
      payload = EXCLUDED.payload,
      company_name = EXCLUDED.company_name,
      legal_form = EXCLUDED.legal_form,
      has_acts = EXCLUDED.has_acts,
      has_annual_accounts = EXCLUDED.has_annual_accounts,
      leaders = EXCLUDED.leaders,
      representatives = EXCLUDED.representatives,
      fetched_at = now(),
      status = 'OK',
      error = NULL,
      updated_at = now()
  `;
}

async function enrichSiren(siren: string) {
  const baseUrl = process.env.INPI_RNE_API_BASE_URL ?? "https://registre-national-entreprises.inpi.fr/api";
  const token = process.env.INPI_RNE_BEARER_TOKEN;
  if (!token) {
    throw new Error("INPI_RNE_BEARER_TOKEN manquant dans .env");
  }

  const payload = await fetchJsonWithRetry(
    `${baseUrl.replace(/\/$/, "")}/companies/${siren}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "sci-prospects-rne-enricher/0.1",
      },
    },
    `INPI/RNE ${siren}`,
  );
  await saveRnePayload(siren, payload);
}

async function runBatch(batch: number) {
  const prospects = await fetchBatch(batch);
  let ok = 0;
  let errors = 0;

  for (const prospect of prospects) {
    try {
      await enrichSiren(prospect.siren);
      ok += 1;
    } catch (error) {
      await markError(prospect.siren, (error as Error).message);
      errors += 1;
      if ((error as Error).message.includes("INPI_RNE_BEARER_TOKEN")) {
        throw error;
      }
    }
  }

  return { found: prospects.length, ok, errors };
}

async function main() {
  const args = parseArgs();
  await ensureTable();

  if (!process.env.INPI_RNE_BEARER_TOKEN) {
    console.log("INPI/RNE pret, mais INPI_RNE_BEARER_TOKEN manque dans .env. Worker non lance.");
    return;
  }

  console.log(`Enrichissement INPI/RNE demarre. Batch=${args.batch}.`);
  while (true) {
    const result = await runBatch(args.batch);
    console.log(`${result.ok} RNE OK, ${result.errors} erreurs.`);

    if (args.once) return;
    if (result.found === 0) {
      console.log(`Aucun prospect RNE a enrichir. Pause ${args.sleep}ms.`);
      await wait(args.sleep);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
