import { prisma } from "../lib/prisma";
import { DEFAULT_DEPARTMENTS } from "../lib/departments";
import { API_URL, SCI_NATURE_JURIDIQUE, normalizeCompany } from "../lib/prospect";

type Args = {
  departements?: string;
  sleep: number;
  cycleSleep: number;
  maxProspects: number;
  maxPages?: number;
  once: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    departements: readValue("--departements"),
    sleep: Number(readValue("--sleep") ?? 250),
    cycleSleep: Number(readValue("--cycle-sleep") ?? 3_600_000),
    maxProspects: Number(readValue("--max-prospects") ?? 10_000),
    maxPages: readValue("--max-pages") ? Number(readValue("--max-pages")) : undefined,
    once: args.includes("--once"),
  };
}

function selectedDepartments(raw?: string): string[] {
  if (!raw) return DEFAULT_DEPARTMENTS;
  return raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(department: string, page: number) {
  const params = new URLSearchParams({
    nature_juridique: SCI_NATURE_JURIDIQUE,
    etat_administratif: "A",
    section_activite_principale: "L",
    departement: department,
    page: String(page),
    per_page: "25",
  });

  let response: Response;
  try {
    response = await fetch(`${API_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "sci-prospects-neon-worker/0.1",
      },
    });
  } catch (error) {
    console.error(`Timeout/reseau sur ${department} page ${page}. Retry dans 30s.`, error);
    await wait(30_000);
    return fetchPage(department, page);
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? 2);
    await wait(retryAfter * 1000);
    return fetchPage(department, page);
  }

  if (!response.ok) {
    console.error(`API ${response.status} ${response.statusText} sur ${department} page ${page}. Retry dans 60s.`);
    await wait(60_000);
    return fetchPage(department, page);
  }

  return response.json() as Promise<{
    results?: Record<string, any>[];
    total_pages?: number;
  }>;
}

async function getNextPage(scope: string) {
  const checkpoint = await prisma.collectionCheckpoint.findUnique({ where: { scope } });
  return checkpoint?.nextPage ?? 1;
}

async function saveCheckpoint(scope: string, nextPage: number, totalPages: number, completed: boolean) {
  await prisma.collectionCheckpoint.upsert({
    where: { scope },
    create: {
      scope,
      nextPage,
      totalPages,
      completedAt: completed ? new Date() : null,
    },
    update: {
      nextPage,
      totalPages,
      completedAt: completed ? new Date() : null,
    },
  });
}

async function resetIfCycleDone(departments: string[]) {
  const done = await prisma.collectionCheckpoint.count({
    where: { scope: { in: departments }, completedAt: { not: null } },
  });
  if (done !== departments.length) return false;

  await prisma.collectionCheckpoint.updateMany({
    where: { scope: { in: departments } },
    data: { nextPage: 1, completedAt: null },
  });
  return true;
}

async function upsertCompany(company: Record<string, any>) {
  const prospect = normalizeCompany(company);
  if (!prospect) return { saved: false, created: false };

  const existing = await prisma.prospect.findUnique({
    where: { siren: prospect.siren },
    select: { siren: true },
  });

  await prisma.prospect.upsert({
    where: { siren: prospect.siren },
    create: prospect,
    update: {
      ...prospect,
      status: undefined,
      notes: undefined,
      contactedAt: undefined,
    },
  });

  return { saved: true, created: !existing };
}

async function collectDepartment(department: string, sleepMs: number) {
  const page = await getNextPage(department);
  const payload = await fetchPage(department, page);
  const results = payload.results ?? [];
  const totalPages = Number(payload.total_pages ?? page);
  let created = 0;
  let saved = 0;

  for (const company of results) {
    const result = await upsertCompany(company);
    if (result.saved) saved += 1;
    if (result.created) created += 1;
  }

  const completed = page >= totalPages || results.length === 0;
  await saveCheckpoint(department, completed ? 1 : page + 1, totalPages, completed);
  await wait(sleepMs);

  return { fetched: results.length, saved, created, completed, nextPage: completed ? 1 : page + 1 };
}

async function main() {
  const args = parseArgs();
  const departments = selectedDepartments(args.departements);
  let pageBudget = args.maxPages;

  console.log(`Collecte SCI active demarree sur ${departments.length} departements.`);
  console.log(`Cadence: 1 appel toutes les ${args.sleep}ms.`);
  console.log(`Limite prospects: ${args.maxProspects}.`);

  while (true) {
    const totalProspects = await prisma.prospect.count();
    if (totalProspects >= args.maxProspects) {
      console.log(`Limite de ${args.maxProspects} prospects atteinte (${totalProspects}). Arret collecte.`);
      return;
    }

    await resetIfCycleDone(departments);
    let activeDepartments = 0;

    for (const department of departments) {
      if (pageBudget !== undefined && pageBudget <= 0) {
        console.log("Budget pages atteint.");
        return;
      }

      const checkpoint = await prisma.collectionCheckpoint.findUnique({ where: { scope: department } });
      if (checkpoint?.completedAt) continue;

      activeDepartments += 1;
      const result = await collectDepartment(department, args.sleep);
      if (pageBudget !== undefined) pageBudget -= 1;

      const totalAfterPage = await prisma.prospect.count();

      console.log(
        `${department}: ${result.fetched} recues, ${result.saved} sauvegardees, ${result.created} nouvelles, ` +
          (result.completed ? "termine" : `prochaine page ${result.nextPage}`) +
          `, total ${totalAfterPage}/${args.maxProspects}`,
      );

      if (totalAfterPage >= args.maxProspects) {
        console.log(`Limite de ${args.maxProspects} prospects atteinte (${totalAfterPage}). Arret collecte.`);
        return;
      }
    }

    if (args.once && args.maxPages === undefined) return;

    if (activeDepartments === 0) {
      if (args.once) return;
      console.log(`Cycle complet. Pause ${args.cycleSleep}ms.`);
      await wait(args.cycleSleep);
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
