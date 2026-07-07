import Link from "next/link";
import {
  getSearchSettings,
  queriesUsedToday,
  isProviderConfigured,
  PROVIDER_LABELS,
  PROVIDER_ENV_VAR,
  JOB_DISCOVER_CONTACTS,
  type SearchProviderName,
} from "../../lib/search-provider";
import { updateSearchSettingsAction } from "./actions";
import { SaveSettingsButton } from "./SaveSettingsButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROVIDERS: SearchProviderName[] = ["brave", "serper", "serpapi"];

export default async function SettingsPage() {
  const [settings, usedToday] = await Promise.all([
    getSearchSettings(JOB_DISCOVER_CONTACTS),
    queriesUsedToday(JOB_DISCOVER_CONTACTS),
  ]);

  const remaining = Math.max(0, settings.maxQueriesPerDay - usedToday);
  const usagePercent = settings.maxQueriesPerDay > 0
    ? Math.min(100, Math.round((usedToday / settings.maxQueriesPerDay) * 100))
    : 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>Parametres du bouton "Pistes web"</h1>
          <p>Fournisseur de recherche, quota quotidien et delai entre deux recherches pour un meme prospect.</p>
        </div>
        <Link href="/" className="button secondary">
          Retour au tableau de bord
        </Link>
      </header>

      <div className="content">
        <section className="section">
          <div className="sectionHeader">
            <h2>Fournisseurs disponibles</h2>
          </div>
          <div className="compactSignalList">
            {PROVIDERS.map((provider) => (
              <span key={provider}>
                <strong>{PROVIDER_LABELS[provider]}</strong>
                {" - "}
                {isProviderConfigured(provider) ? "cle configuree" : `cle manquante (${PROVIDER_ENV_VAR[provider]})`}
              </span>
            ))}
          </div>
        </section>

        <section className="metrics">
          <div className="metric">
            <span>Requetes aujourd'hui</span>
            <strong>{usedToday.toLocaleString("fr-FR")}</strong>
          </div>
          <div className="metric">
            <span>Quota restant aujourd'hui</span>
            <strong>{remaining.toLocaleString("fr-FR")}</strong>
          </div>
          <div className="metric">
            <span>Utilisation du quota</span>
            <strong>{usagePercent}%</strong>
          </div>
        </section>

        <section className="section">
          <div className="sectionHeader">
            <h2>Configuration</h2>
          </div>
          <form action={updateSearchSettingsAction} className="formStack">
            <label>
              Fournisseur principal
              <select name="provider" defaultValue={settings.provider}>
                {PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]} {isProviderConfigured(provider) ? "" : "(cle manquante)"}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Fournisseur de secours (utilise si le principal echoue)
              <select name="fallbackProvider" defaultValue={settings.fallbackProvider ?? "none"}>
                <option value="none">Aucun</option>
                {PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]} {isProviderConfigured(provider) ? "" : "(cle manquante)"}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Limite de recherches par jour
              <input
                type="number"
                name="maxQueriesPerDay"
                min={1}
                defaultValue={settings.maxQueriesPerDay}
              />
            </label>

            <label>
              Delai minimum avant de relancer une recherche sur le meme prospect (minutes)
              <input
                type="number"
                name="minIntervalMinutes"
                min={1}
                defaultValue={settings.minIntervalMinutes}
              />
              <small>
                S'applique uniquement au bouton "Chercher des pistes web" sur une fiche prospect - empeche de
                relancer une recherche (et de consommer du quota) trop souvent sur la meme SCI.
              </small>
            </label>

            <SaveSettingsButton />
          </form>
        </section>
      </div>
    </main>
  );
}
