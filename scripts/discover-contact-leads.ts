import { prisma } from "../lib/prisma";
import { discoverContactLeadsBatch, ensureContactLeadTables } from "../lib/contact-lead-runner";

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
    batch: Number(readValue("--batch") ?? 10),
    once: args.includes("--once"),
  };
}

async function main() {
  const args = parseArgs();
  await ensureContactLeadTables();

  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.log("Contact leads pret, mais BRAVE_SEARCH_API_KEY manque dans .env.");
    return;
  }

  while (true) {
    const results = await discoverContactLeadsBatch(args.batch);
    if (results.length === 0) {
      console.log("Aucun prospect a traiter pour les pistes contact.");
      return;
    }

    let saved = 0;
    for (const result of results) {
      saved += result.saved;
      console.log(`${result.prospect.siren} ${result.prospect.name}: ${result.saved} pistes contact.`);
    }

    console.log(`Batch termine: ${saved} pistes sauvegardees.`);
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
