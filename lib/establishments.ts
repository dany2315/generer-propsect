export type ExtractedEstablishment = {
  siret: string;
  isHeadquarters: boolean;
  isOpen: boolean;
  address?: string;
  postalCode?: string;
  city?: string;
  department?: string;
  region?: string;
  activity?: string;
  employer?: string;
  employeeRange?: string;
  creationDate?: Date;
  startActivityDate?: Date;
  closeDate?: Date;
  latitude?: number;
  longitude?: number;
  raw: Record<string, any>;
};

export function extractEstablishments(raw: any): ExtractedEstablishment[] {
  const siege = raw?.siege ? [{ ...raw.siege, est_siege: true }] : [];
  const matching = Array.isArray(raw?.matching_etablissements) ? raw.matching_etablissements : [];
  const establishments = [...siege, ...matching];
  const bySiret = new Map<string, ExtractedEstablishment>();

  for (const item of establishments) {
    const siret = optionalString(item.siret);
    if (!siret) continue;

    bySiret.set(siret, {
      siret,
      isHeadquarters: Boolean(item.est_siege),
      isOpen: item.etat_administratif === "A" && !item.date_fermeture,
      address: optionalString(item.adresse),
      postalCode: optionalString(item.code_postal),
      city: optionalString(item.libelle_commune),
      department: optionalString(item.departement),
      region: optionalString(item.region),
      activity: optionalString(item.activite_principale),
      employer: optionalString(item.caractere_employeur),
      employeeRange: optionalString(item.tranche_effectif_salarie),
      creationDate: parseDate(item.date_creation),
      startActivityDate: parseDate(item.date_debut_activite),
      closeDate: parseDate(item.date_fermeture),
      latitude: optionalNumber(item.latitude),
      longitude: optionalNumber(item.longitude),
      raw: item,
    });
  }

  return [...bySiret.values()];
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
