import { prisma } from "../lib/prisma";
import { buildEnrichment } from "../lib/enrichment";

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
    batch: Number(readValue("--batch") ?? 100),
    sleep: Number(readValue("--sleep") ?? 15_000),
    once: args.includes("--once"),
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichProspect(siren: string, raw: any) {
  const result = buildEnrichment(raw);

  await prisma.prospectEnrichment.create({
    data: {
      prospectSiren: siren,
      source: "api_gouv_raw_extraction_v1",
      sourceType: "derived_from_existing_raw",
      confidence: 0.74,
      payload: result.payload,
    },
  });

  for (const signal of result.signals) {
    await prisma.prospectSignal.upsert({
      where: {
        prospectSiren_key: {
          prospectSiren: siren,
          key: signal.key,
        },
      },
      create: {
        prospectSiren: siren,
        ...signal,
      },
      update: signal,
    });
  }
}

async function runBatch(batch: number) {
  const prospects = await prisma.prospect.findMany({
    where: {
      enrichments: {
        none: {
          source: "api_gouv_raw_extraction_v1",
        },
      },
    },
    orderBy: [{ score: "desc" }, { firstSeenAt: "asc" }],
    take: batch,
    select: {
      siren: true,
      raw: true,
    },
  });

  let enriched = 0;
  for (const prospect of prospects) {
    await enrichProspect(prospect.siren, prospect.raw);
    enriched += 1;
  }

  return { requested: batch, found: prospects.length, enriched };
}

async function main() {
  const args = parseArgs();
  console.log(`Enrichissement SCI demarre. Batch=${args.batch}.`);

  while (true) {
    const result = await runBatch(args.batch);
    console.log(`${result.enriched} prospects enrichis.`);

    if (args.once) return;
    if (result.found === 0) {
      console.log(`Aucun prospect a enrichir. Pause ${args.sleep}ms.`);
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
