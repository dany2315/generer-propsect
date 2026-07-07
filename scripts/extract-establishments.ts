import { prisma } from "../lib/prisma";
import { extractEstablishments } from "../lib/establishments";

type RawProspect = {
  siren: string;
  raw: any;
};

type Args = {
  batch: number;
  sleep: number;
  once: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    batch: Number(readValue("--batch") ?? 250),
    sleep: Number(readValue("--sleep") ?? 15_000),
    once: args.includes("--once"),
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS prospect_establishments (
      siret TEXT PRIMARY KEY,
      prospect_siren TEXT NOT NULL,
      is_headquarters BOOLEAN NOT NULL DEFAULT false,
      is_open BOOLEAN NOT NULL DEFAULT false,
      address TEXT,
      postal_code TEXT,
      city TEXT,
      department TEXT,
      region TEXT,
      activity TEXT,
      employer TEXT,
      employee_range TEXT,
      creation_date TIMESTAMPTZ,
      start_activity_date TIMESTAMPTZ,
      close_date TIMESTAMPTZ,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      raw JSONB NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS prospect_establishments_prospect_siren_idx
    ON prospect_establishments (prospect_siren)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS prospect_establishments_department_idx
    ON prospect_establishments (department)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS prospect_establishments_activity_idx
    ON prospect_establishments (activity)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS prospect_establishments_is_open_idx
    ON prospect_establishments (is_open)
  `);
}

async function fetchBatch(batch: number) {
  return prisma.$queryRawUnsafe<RawProspect[]>(`
    SELECT p."siren", p."raw"
    FROM "Prospect" p
    WHERE NOT EXISTS (
      SELECT 1
      FROM prospect_establishments e
      WHERE e.prospect_siren = p."siren"
    )
    ORDER BY p."score" DESC, p."firstSeenAt" ASC
    LIMIT ${Number(batch)}
  `);
}

async function upsertEstablishment(prospectSiren: string, establishment: ReturnType<typeof extractEstablishments>[number]) {
  await prisma.$executeRaw`
    INSERT INTO prospect_establishments (
      siret,
      prospect_siren,
      is_headquarters,
      is_open,
      address,
      postal_code,
      city,
      department,
      region,
      activity,
      employer,
      employee_range,
      creation_date,
      start_activity_date,
      close_date,
      latitude,
      longitude,
      raw
    )
    VALUES (
      ${establishment.siret},
      ${prospectSiren},
      ${establishment.isHeadquarters},
      ${establishment.isOpen},
      ${establishment.address ?? null},
      ${establishment.postalCode ?? null},
      ${establishment.city ?? null},
      ${establishment.department ?? null},
      ${establishment.region ?? null},
      ${establishment.activity ?? null},
      ${establishment.employer ?? null},
      ${establishment.employeeRange ?? null},
      ${establishment.creationDate ?? null},
      ${establishment.startActivityDate ?? null},
      ${establishment.closeDate ?? null},
      ${establishment.latitude ?? null},
      ${establishment.longitude ?? null},
      ${establishment.raw}
    )
    ON CONFLICT (siret) DO UPDATE SET
      prospect_siren = EXCLUDED.prospect_siren,
      is_headquarters = EXCLUDED.is_headquarters,
      is_open = EXCLUDED.is_open,
      address = EXCLUDED.address,
      postal_code = EXCLUDED.postal_code,
      city = EXCLUDED.city,
      department = EXCLUDED.department,
      region = EXCLUDED.region,
      activity = EXCLUDED.activity,
      employer = EXCLUDED.employer,
      employee_range = EXCLUDED.employee_range,
      creation_date = EXCLUDED.creation_date,
      start_activity_date = EXCLUDED.start_activity_date,
      close_date = EXCLUDED.close_date,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      raw = EXCLUDED.raw,
      updated_at = now()
  `;
}

async function runBatch(batch: number) {
  const prospects = await fetchBatch(batch);
  let prospectsProcessed = 0;
  let establishmentsSaved = 0;

  for (const prospect of prospects) {
    const establishments = extractEstablishments(prospect.raw);
    for (const establishment of establishments) {
      await upsertEstablishment(prospect.siren, establishment);
      establishmentsSaved += 1;
    }
    prospectsProcessed += 1;
  }

  return { prospectsFound: prospects.length, prospectsProcessed, establishmentsSaved };
}

async function main() {
  const args = parseArgs();
  await ensureTable();
  console.log(`Extraction etablissements demarree. Batch=${args.batch}.`);

  while (true) {
    const result = await runBatch(args.batch);
    console.log(
      `${result.prospectsProcessed} prospects traites, ${result.establishmentsSaved} etablissements sauvegardes.`,
    );

    if (args.once) return;
    if (result.prospectsFound === 0) {
      console.log(`Aucun nouveau prospect a extraire. Pause ${args.sleep}ms.`);
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
