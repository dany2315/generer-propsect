import { prisma } from "../lib/prisma";
import { buildRneSummary } from "../lib/rne-display";

type Args = {
  batch: number;
  once: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    batch: Number(readValue("--batch") ?? 500),
    once: args.includes("--once"),
  };
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rne_extracted_profiles (
      prospect_siren TEXT PRIMARY KEY,
      company_name TEXT,
      legal_form TEXT,
      creation_date DATE,
      activity_code TEXT,
      capital TEXT,
      duration_years INTEGER,
      end_date DATE,
      object_text TEXT,
      publication_date DATE,
      publication_journal TEXT,
      representatives_count INTEGER NOT NULL DEFAULT 0,
      establishments_count INTEGER NOT NULL DEFAULT 0,
      latest_event_date DATE,
      latest_event_label TEXT,
      rne_updated_at TIMESTAMPTZ,
      representatives JSONB NOT NULL DEFAULT '[]'::jsonb,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      establishments JSONB NOT NULL DEFAULT '[]'::jsonb,
      extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS rne_extracted_profiles_latest_event_idx
    ON rne_extracted_profiles (latest_event_date)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS rne_extracted_profiles_representatives_idx
    ON rne_extracted_profiles (representatives_count)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS rne_extracted_profiles_establishments_idx
    ON rne_extracted_profiles (establishments_count)
  `);
}

async function fetchBatch(batch: number) {
  return prisma.$queryRawUnsafe<
    Array<{
      prospect_siren: string;
      payload: any;
      company_name: string | null;
      forme_juridique: string | null;
      updated_at_rne: Date | null;
      nombre_representants_actifs: number | null;
      nombre_etablissements_ouverts: number | null;
    }>
  >(`
    SELECT m.prospect_siren,
           m.payload,
           m.company_name,
           m.forme_juridique,
           m.updated_at_rne,
           m.nombre_representants_actifs,
           m.nombre_etablissements_ouverts
    FROM rne_formality_matches m
    LEFT JOIN rne_extracted_profiles e ON e.prospect_siren = m.prospect_siren
    WHERE e.prospect_siren IS NULL OR e.updated_at < m.updated_at
    ORDER BY m.prospect_siren
    LIMIT ${Number(batch)}
  `);
}

async function saveProfile(row: Awaited<ReturnType<typeof fetchBatch>>[number]) {
  const summary = buildRneSummary(row);
  if (!summary) return false;
  const latestEvent = summary.history[0];

  await prisma.$executeRaw`
    INSERT INTO rne_extracted_profiles (
      prospect_siren,
      company_name,
      legal_form,
      creation_date,
      activity_code,
      capital,
      duration_years,
      end_date,
      object_text,
      publication_date,
      publication_journal,
      representatives_count,
      establishments_count,
      latest_event_date,
      latest_event_label,
      rne_updated_at,
      representatives,
      history,
      establishments,
      updated_at
    )
    VALUES (
      ${row.prospect_siren},
      ${summary.companyName ?? null},
      ${summary.legalForm ?? null},
      ${dateOrNull(summary.creationDate)},
      ${summary.activityCode ?? null},
      ${summary.capital ?? null},
      ${summary.duration ?? null},
      ${dateOrNull(summary.endDate)},
      ${summary.object ?? null},
      ${dateOrNull(summary.publication?.date)},
      ${summary.publication?.journal ?? null},
      ${summary.representatives.length || row.nombre_representants_actifs || 0},
      ${summary.establishments.length || row.nombre_etablissements_ouverts || 0},
      ${dateOrNull(latestEvent?.date)},
      ${latestEvent?.label ?? null},
      ${summary.updatedAt ?? null},
      ${JSON.stringify(summary.representatives)}::jsonb,
      ${JSON.stringify(summary.history)}::jsonb,
      ${JSON.stringify(summary.establishments)}::jsonb,
      now()
    )
    ON CONFLICT (prospect_siren) DO UPDATE SET
      company_name = EXCLUDED.company_name,
      legal_form = EXCLUDED.legal_form,
      creation_date = EXCLUDED.creation_date,
      activity_code = EXCLUDED.activity_code,
      capital = EXCLUDED.capital,
      duration_years = EXCLUDED.duration_years,
      end_date = EXCLUDED.end_date,
      object_text = EXCLUDED.object_text,
      publication_date = EXCLUDED.publication_date,
      publication_journal = EXCLUDED.publication_journal,
      representatives_count = EXCLUDED.representatives_count,
      establishments_count = EXCLUDED.establishments_count,
      latest_event_date = EXCLUDED.latest_event_date,
      latest_event_label = EXCLUDED.latest_event_label,
      rne_updated_at = EXCLUDED.rne_updated_at,
      representatives = EXCLUDED.representatives,
      history = EXCLUDED.history,
      establishments = EXCLUDED.establishments,
      updated_at = now()
  `;
  return true;
}

function dateOrNull(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function main() {
  const args = parseArgs();
  await ensureTable();

  while (true) {
    const rows = await fetchBatch(args.batch);
    if (rows.length === 0) {
      console.log("Extraction RNE terminee: aucun profil restant.");
      return;
    }

    let saved = 0;
    for (const row of rows) {
      if (await saveProfile(row)) saved += 1;
    }

    console.log(`Batch RNE extrait: ${saved}/${rows.length} profils sauvegardes.`);
    if (args.once) return;
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
