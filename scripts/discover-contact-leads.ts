import { prisma } from "../lib/prisma";
import { discoverContactLeadsBatch, ensureContactLeadTables } from "../lib/contact-lead-runner";
import {
  getSearchSettings,
  isProviderConfigured,
  PROVIDER_ENV_VAR,
  PROVIDER_LABELS,
  JOB_DISCOVER_CONTACTS,
} from "../lib/search-provider";

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

  const settings = await getSearchSettings(JOB_DISCOVER_CONTACTS);
  if (!isProviderConfigured(settings.provider) && !(settings.fallbackProvider && isProviderConfigured(settings.fallbackProvider))) {
    console.log(
      `Contact leads pret, mais aucune cle configuree pour le fournisseur ${PROVIDER_LABELS[settings.provider]} ` +
        `(variable ${PROVIDER_ENV_VAR[settings.provider]} manquante dans .env). Fournisseur configurable dans /settings.`,
    );
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
