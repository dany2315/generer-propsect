export type RneSummary = {
  companyName?: string | null;
  legalForm?: string | null;
  updatedAt?: Date | null;
  creationDate?: string | null;
  activityCode?: string | null;
  capital?: string | null;
  duration?: number | null;
  endDate?: string | null;
  object?: string | null;
  publication?: {
    date?: string | null;
    journal?: string | null;
    type?: string | null;
  } | null;
  representatives: Array<{
    name: string;
    type: string;
    role: string;
    city?: string | null;
    postalCode?: string | null;
  }>;
  history: Array<{
    date?: string | null;
    label: string;
    code?: string | null;
    integrationDate?: string | null;
  }>;
  establishments: Array<{
    label: string;
    siret?: string | null;
    activityCode?: string | null;
    address: string;
  }>;
};

export function buildRneSummary(row?: {
  payload: any;
  company_name?: string | null;
  forme_juridique?: string | null;
  updated_at_rne?: Date | null;
  nombre_representants_actifs?: number | null;
  nombre_etablissements_ouverts?: number | null;
} | null): RneSummary | null {
  if (!row?.payload) return null;

  const payload = row.payload;
  const content = payload.formality?.content ?? {};
  const morale = content.personneMorale ?? {};
  const entreprise = morale.identite?.entreprise ?? {};
  const description = morale.identite?.description ?? {};

  return {
    companyName: row.company_name ?? entreprise.denomination ?? null,
    legalForm: row.forme_juridique ?? entreprise.formeJuridique ?? content.natureCreation?.formeJuridique ?? null,
    updatedAt: row.updated_at_rne ?? (payload.updatedAt ? new Date(payload.updatedAt) : null),
    creationDate: content.natureCreation?.dateCreation ?? entreprise.dateImmat ?? null,
    activityCode: entreprise.codeApe ?? null,
    capital: formatCapital(description.montantCapital, description.deviseCapital),
    duration: description.duree ?? null,
    endDate: description.dateFinExistence ?? null,
    object: description.objet ?? null,
    publication: morale.identite?.publicationLegale
      ? {
          date: morale.identite.publicationLegale.datePublication ?? null,
          journal: morale.identite.publicationLegale.journalPublication ?? null,
          type: morale.identite.publicationLegale.typePublication ?? null,
        }
      : null,
    representatives: extractRepresentatives(morale.composition?.pouvoirs),
    history: extractHistory(payload.formality?.historique),
    establishments: extractEstablishments(morale),
  };
}

function extractRepresentatives(value: any): RneSummary["representatives"] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item) => item?.actif !== false)
    .map((item) => {
      const individual = item.individu?.descriptionPersonne;
      const legal = item.entreprise?.entreprise ?? item.personneMorale?.identite?.entreprise;
      const address = item.individu?.adresseDomicile ?? item.entreprise?.adresseEntreprise?.adresse;
      const name = individual
        ? [asArray(individual.prenoms).join(" "), individual.nomUsage ?? individual.nom].filter(Boolean).join(" ")
        : legal?.denomination ?? "Representant non nomme";

      return {
        name,
        type: item.typeDePersonne === "INDIVIDU" ? "Personne physique" : "Personne morale",
        role: roleLabel(item.roleEntreprise, item.autreRoleEntreprise),
        city: address?.commune ?? null,
        postalCode: address?.codePostal ?? null,
      };
    })
    .filter((item) => item.name)
    .slice(0, 12);
}

function extractHistory(value: any): RneSummary["history"] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  return value
    .map((item) => ({
      date: item.dateEffet ?? null,
      label: item.libelleEvenement ?? "Evenement juridique",
      code: item.codeEvenement ?? null,
      integrationDate: item.dateIntegration ?? null,
    }))
    .filter((item) => {
      const key = `${item.date}:${item.code}:${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, 10);
}

function extractEstablishments(morale: any): RneSummary["establishments"] {
  const establishments = [
    { label: "Etablissement principal", value: morale.etablissementPrincipal },
    ...(Array.isArray(morale.autresEtablissements)
      ? morale.autresEtablissements.map((value: any, index: number) => ({ label: `Etablissement rattache ${index + 1}`, value }))
      : []),
  ];

  return establishments
    .filter((item) => item.value)
    .map((item) => ({
      label: item.label,
      siret: item.value.descriptionEtablissement?.siret ?? null,
      activityCode: item.value.descriptionEtablissement?.codeApe ?? item.value.activites?.[0]?.codeApe ?? null,
      address: formatAddress(item.value.adresse),
    }))
    .slice(0, 8);
}

function formatCapital(value?: number | string | null, currency?: string | null) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  const formatted = Number.isFinite(numeric) ? numeric.toLocaleString("fr-FR") : String(value);
  return `${formatted} ${currency ?? "EUR"}`;
}

function formatAddress(address: any) {
  if (!address) return "Adresse non disponible";
  return [
    address.numVoie,
    address.typeVoie,
    address.voie,
    address.codePostal,
    address.commune,
  ].filter(Boolean).join(" ");
}

function roleLabel(code?: string | null, fallback?: string | null) {
  const labels: Record<string, string> = {
    "29": "Gerant",
    "30": "Co-gerant",
    "71": "Associe",
    "99": fallback || "Autre role",
  };
  return code ? labels[code] ?? fallback ?? `Role ${code}` : fallback ?? "Role non precise";
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
}
