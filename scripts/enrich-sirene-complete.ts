import { prisma } from "../lib/prisma";
import { fetchJsonWithRetry, wait } from "../lib/http";

type Args = {
  batch: number;
  sleep: number;
  once: boolean;
};

const SOURCE = "insee_sirene_api_v3_unite_legale";

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    batch: Number(readValue("--batch") ?? 100),
    sleep: Number(readValue("--sleep") ?? 30_000),
    once: args.includes("--once"),
  };
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS sirene_complete_enrichments (
      prospect_siren TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload JSONB,
      unite_legale JSONB,
      statut_diffusion TEXT,
      categorie_juridique TEXT,
      activite_principale TEXT,
      tranche_effectif TEXT,
      etat_administratif TEXT,
      fetched_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'PENDING',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS sirene_complete_enrichments_status_idx
    ON sirene_complete_enrichments (status)
  `);
}

async function fetchBatch(batch: number) {
  return prisma.$queryRawUnsafe<Array<{ siren: string }>>(`
    SELECT p."siren"
    FROM "Prospect" p
    WHERE NOT EXISTS (
      SELECT 1 FROM sirene_complete_enrichments s WHERE s.prospect_siren = p."siren"
    )
    ORDER BY p."score" DESC, p."firstSeenAt" ASC
    LIMIT ${Number(batch)}
  `);
}

async function markError(siren: string, error: string) {
  await prisma.$executeRaw`
    INSERT INTO sirene_complete_enrichments (prospect_siren, source, status, error, updated_at)
    VALUES (${siren}, ${SOURCE}, 'ERROR', ${error.slice(0, 1000)}, now())
    ON CONFLICT (prospect_siren) DO UPDATE SET
      status = 'ERROR',
      error = EXCLUDED.error,
      updated_at = now()
  `;
}

async function saveSirenePayload(siren: string, payload: any) {
  const uniteLegale = payload?.uniteLegale ?? payload;
  const currentPeriod = Array.isArray(uniteLegale?.periodesUniteLegale)
    ? uniteLegale.periodesUniteLegale.find((period: any) => period.dateFin === null) ?? uniteLegale.periodesUniteLegale[0]
    : null;

  await prisma.$executeRaw`
    INSERT INTO sirene_complete_enrichments (
      prospect_siren,
      source,
      payload,
      unite_legale,
      statut_diffusion,
      categorie_juridique,
      activite_principale,
      tranche_effectif,
      etat_administratif,
      fetched_at,
      status,
      error,
      updated_at
    )
    VALUES (
      ${siren},
      ${SOURCE},
      ${payload},
      ${uniteLegale},
      ${uniteLegale?.statutDiffusionUniteLegale ?? null},
      ${uniteLegale?.categorieJuridiqueUniteLegale ?? currentPeriod?.categorieJuridiqueUniteLegale ?? null},
      ${currentPeriod?.activitePrincipaleUniteLegale ?? uniteLegale?.activitePrincipaleUniteLegale ?? null},
      ${uniteLegale?.trancheEffectifsUniteLegale ?? null},
      ${currentPeriod?.etatAdministratifUniteLegale ?? null},
      now(),
      'OK',
      NULL,
      now()
    )
    ON CONFLICT (prospect_siren) DO UPDATE SET
      payload = EXCLUDED.payload,
      unite_legale = EXCLUDED.unite_legale,
      statut_diffusion = EXCLUDED.statut_diffusion,
      categorie_juridique = EXCLUDED.categorie_juridique,
      activite_principale = EXCLUDED.activite_principale,
      tranche_effectif = EXCLUDED.tranche_effectif,
      etat_administratif = EXCLUDED.etat_administratif,
      fetched_at = now(),
      status = 'OK',
      error = NULL,
      updated_at = now()
  `;
}

async function enrichSiren(siren: string) {
  const baseUrl = process.env.SIRENE_API_BASE_URL ?? "https://api.insee.fr/api-sirene/3.11";
  const token = process.env.SIRENE_BEARER_TOKEN;
  if (!token) {
    throw new Error("SIRENE_BEARER_TOKEN manquant dans .env");
  }

  const payload = await fetchJsonWithRetry(
    `${baseUrl.replace(/\/$/, "")}/siren/${siren}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "sci-prospects-sirene-enricher/0.1",
      },
    },
    `Sirene ${siren}`,
  );
  await saveSirenePayload(siren, payload);
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
      if ((error as Error).message.includes("SIRENE_BEARER_TOKEN")) {
        throw error;
      }
    }
  }

  return { found: prospects.length, ok, errors };
}

async function main() {
  const args = parseArgs();
  await ensureTable();

  if (!process.env.SIRENE_BEARER_TOKEN) {
    console.log("Sirene complet pret, mais SIRENE_BEARER_TOKEN manque dans .env. Worker non lance.");
    return;
  }

  console.log(`Enrichissement Sirene complet demarre. Batch=${args.batch}.`);
  while (true) {
    const result = await runBatch(args.batch);
    console.log(`${result.ok} Sirene OK, ${result.errors} erreurs.`);

    if (args.once) return;
    if (result.found === 0) {
      console.log(`Aucun prospect Sirene a enrichir. Pause ${args.sleep}ms.`);
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
