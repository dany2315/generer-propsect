import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../lib/prisma";

const execFileAsync = promisify(execFile);

type Args = {
  zip: string;
  batch: number;
  once: boolean;
};

type RneRecord = {
  siren?: string;
  updatedAt?: string;
  nombreRepresentantsActifs?: number;
  nombreEtablissementsOuverts?: number;
  typePersonne?: string;
  formeJuridique?: string;
  formality?: {
    siren?: string;
    content?: any;
  };
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    zip: readValue("--zip") ?? "data/inpi/stock_RNE_formalites_NIVEAU1_20260304_1400.zip",
    batch: Number(readValue("--batch") ?? 25),
    once: args.includes("--once"),
  };
}

async function ensureTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS inpi_rne_zip_entries (
      file_name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PENDING',
      records_count INTEGER,
      matches_count INTEGER,
      error TEXT,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rne_formality_matches (
      prospect_siren TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      payload JSONB NOT NULL,
      company_name TEXT,
      forme_juridique TEXT,
      type_personne TEXT,
      nombre_representants_actifs INTEGER,
      nombre_etablissements_ouverts INTEGER,
      updated_at_rne TIMESTAMPTZ,
      matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS rne_formality_matches_file_name_idx
    ON rne_formality_matches (file_name)
  `);

  await prisma.$executeRawUnsafe(`
    UPDATE inpi_rne_zip_entries
    SET status = 'PENDING', updated_at = now()
    WHERE status = 'PROCESSING'
  `);
}

async function listZipEntries(zip: string) {
  const { stdout } = await execFileAsync("tar", ["-tf", zip], { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".json"));
}

async function seedEntries(entries: string[]) {
  for (const entry of entries) {
    await prisma.$executeRaw`
      INSERT INTO inpi_rne_zip_entries (file_name)
      VALUES (${entry})
      ON CONFLICT (file_name) DO NOTHING
    `;
  }
}

async function nextEntries(batch: number) {
  return prisma.$queryRawUnsafe<Array<{ file_name: string }>>(`
    SELECT file_name
    FROM inpi_rne_zip_entries
    WHERE status IN ('PENDING', 'ERROR')
    ORDER BY file_name ASC
    LIMIT ${Number(batch)}
  `);
}

async function prospectSirenSet() {
  const rows = await prisma.prospect.findMany({ select: { siren: true } });
  return new Set(rows.map((row) => row.siren));
}

async function readZipEntry(zip: string, entry: string) {
  const { stdout } = await execFileAsync("tar", ["-xOf", zip, entry], {
    maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(stdout) as RneRecord[];
}

function extractCompanyName(record: RneRecord) {
  const personneMorale = record.formality?.content?.personneMorale;
  return (
    personneMorale?.identite?.entreprise?.denomination ??
    personneMorale?.identite?.entreprise?.nomCommercial ??
    null
  );
}

function extractFormeJuridique(record: RneRecord) {
  return (
    record.formeJuridique ??
    record.formality?.content?.natureCreation?.formeJuridique ??
    record.formality?.content?.personneMorale?.identite?.entreprise?.formeJuridique ??
    null
  );
}

async function saveMatch(entry: string, record: RneRecord) {
  const siren = record.siren ?? record.formality?.siren;
  if (!siren) return;

  const updatedAtRne = record.updatedAt ? new Date(record.updatedAt) : null;
  await prisma.$executeRaw`
    INSERT INTO rne_formality_matches (
      prospect_siren,
      file_name,
      payload,
      company_name,
      forme_juridique,
      type_personne,
      nombre_representants_actifs,
      nombre_etablissements_ouverts,
      updated_at_rne,
      updated_at
    )
    VALUES (
      ${siren},
      ${entry},
      ${record},
      ${extractCompanyName(record)},
      ${extractFormeJuridique(record)},
      ${record.typePersonne ?? null},
      ${record.nombreRepresentantsActifs ?? null},
      ${record.nombreEtablissementsOuverts ?? null},
      ${updatedAtRne},
      now()
    )
    ON CONFLICT (prospect_siren) DO UPDATE SET
      file_name = EXCLUDED.file_name,
      payload = EXCLUDED.payload,
      company_name = EXCLUDED.company_name,
      forme_juridique = EXCLUDED.forme_juridique,
      type_personne = EXCLUDED.type_personne,
      nombre_representants_actifs = EXCLUDED.nombre_representants_actifs,
      nombre_etablissements_ouverts = EXCLUDED.nombre_etablissements_ouverts,
      updated_at_rne = EXCLUDED.updated_at_rne,
      updated_at = now()
  `;
}

async function processEntry(zip: string, entry: string, sirens: Set<string>) {
  console.log(`Lecture ${entry}...`);
  await prisma.$executeRaw`
    UPDATE inpi_rne_zip_entries
    SET status = 'PROCESSING', updated_at = now()
    WHERE file_name = ${entry}
  `;

  try {
    const records = await readZipEntry(zip, entry);
    console.log(`${entry}: ${records.length} records charges.`);
    let matches = 0;
    for (const record of records) {
      const siren = record.siren ?? record.formality?.siren;
      if (!siren || !sirens.has(siren)) continue;
      await saveMatch(entry, record);
      matches += 1;
    }

    await prisma.$executeRaw`
      UPDATE inpi_rne_zip_entries
      SET status = 'DONE',
          records_count = ${records.length},
          matches_count = ${matches},
          error = NULL,
          processed_at = now(),
          updated_at = now()
      WHERE file_name = ${entry}
    `;

    return { records: records.length, matches };
  } catch (error) {
    await prisma.$executeRaw`
      UPDATE inpi_rne_zip_entries
      SET status = 'ERROR',
          error = ${(error as Error).message.slice(0, 1000)},
          updated_at = now()
      WHERE file_name = ${entry}
    `;
    throw error;
  }
}

async function main() {
  const args = parseArgs();
  await ensureTables();
  const existingEntries = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
    "SELECT COUNT(*)::int AS total FROM inpi_rne_zip_entries",
  );
  if ((existingEntries[0]?.total ?? 0) === 0) {
    const entries = await listZipEntries(args.zip);
    await seedEntries(entries);
    console.log(`${entries.length} fichiers JSON detectes dans le ZIP RNE.`);
  } else {
    console.log(`${existingEntries[0]?.total ?? 0} fichiers JSON deja inventories.`);
  }

  while (true) {
    const pending = await nextEntries(args.batch);
    if (pending.length === 0) {
      console.log("Indexation RNE terminee: aucun fichier restant.");
      return;
    }

    const sirens = await prospectSirenSet();
    console.log(`Batch ${pending.length} fichiers. ${sirens.size} SIREN prospects en base.`);

    let totalRecords = 0;
    let totalMatches = 0;
    for (const entry of pending) {
      const result = await processEntry(args.zip, entry.file_name, sirens);
      totalRecords += result.records;
      totalMatches += result.matches;
      console.log(`${entry.file_name}: ${result.records} records, ${result.matches} matches.`);
    }

    console.log(`Batch termine: ${totalRecords} records lus, ${totalMatches} matches sauvegardes.`);
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
