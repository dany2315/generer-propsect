"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateSearchSettings, JOB_DISCOVER_CONTACTS, type SearchProviderName } from "../../lib/search-provider";

const VALID_PROVIDERS = new Set<SearchProviderName>(["brave", "serper", "serpapi"]);

function parseProvider(value: FormDataEntryValue | null): SearchProviderName {
  const raw = String(value ?? "");
  if (!VALID_PROVIDERS.has(raw as SearchProviderName)) {
    throw new Error("Fournisseur de recherche invalide");
  }
  return raw as SearchProviderName;
}

function parseFallbackProvider(value: FormDataEntryValue | null): SearchProviderName | null {
  const raw = String(value ?? "");
  if (!raw || raw === "none") return null;
  if (!VALID_PROVIDERS.has(raw as SearchProviderName)) {
    throw new Error("Fournisseur de secours invalide");
  }
  return raw as SearchProviderName;
}

export async function updateSearchSettingsAction(formData: FormData) {
  const provider = parseProvider(formData.get("provider"));
  let fallbackProvider = parseFallbackProvider(formData.get("fallbackProvider"));
  if (fallbackProvider === provider) fallbackProvider = null;

  const maxQueriesPerDay = Math.max(1, Number(formData.get("maxQueriesPerDay") ?? 2000));
  const minIntervalMinutes = Math.max(1, Number(formData.get("minIntervalMinutes") ?? 60));

  if (!Number.isFinite(maxQueriesPerDay) || !Number.isFinite(minIntervalMinutes)) {
    throw new Error("Valeurs numeriques invalides");
  }

  await updateSearchSettings({
    jobName: JOB_DISCOVER_CONTACTS,
    provider,
    fallbackProvider,
    maxQueriesPerDay,
    minIntervalMinutes,
  });

  revalidatePath("/settings");
  redirect("/settings");
}
