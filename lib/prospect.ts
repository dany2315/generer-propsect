import type { Prisma } from "@prisma/client";

export const API_URL = "https://recherche-entreprises.api.gouv.fr/search";
export const SCI_NATURE_JURIDIQUE = "6540";
export const TARGET_ACTIVITIES = new Set(["68.20A", "68.20B"]);

type ApiCompany = Record<string, any>;

export type NormalizedProspect = {
  siren: string;
  siretSiege?: string;
  name: string;
  activity?: string;
  legalForm?: string;
  companyCategory?: string;
  creationDate?: Date;
  openEstablishments?: number;
  address?: string;
  postalCode?: string;
  city?: string;
  department?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  leadersText?: string;
  leaders?: Prisma.InputJsonValue;
  score: number;
  scoreReasons: string[];
  source: string;
  raw: Prisma.InputJsonValue;
};

export function scoreCompany(company: ApiCompany): { score: number; reasons: string[] } {
  let score = 20;
  const reasons = ["SCI active"];
  const activity = company.activite_principale;

  if (TARGET_ACTIVITIES.has(activity)) {
    score += 35;
    reasons.push(`activite immobiliere cible ${activity}`);
  } else if (company.section_activite_principale === "L") {
    score += 15;
    reasons.push("section activites immobilieres");
  }

  const openLocations = Number(company.nombre_etablissements_ouverts ?? 0);
  if (openLocations >= 2) {
    score += Math.min(15, openLocations);
    reasons.push(`${openLocations} etablissements ouverts`);
  }

  if (Array.isArray(company.dirigeants) && company.dirigeants.length > 0) {
    score += 10;
    reasons.push("dirigeants disponibles");
  }

  if (["PME", "ETI", "GE"].includes(company.categorie_entreprise)) {
    score += 5;
    reasons.push(`categorie ${company.categorie_entreprise}`);
  }

  const createdAt = String(company.date_creation ?? "");
  const createdYear = Number(createdAt.slice(0, 4));
  if (Number.isFinite(createdYear) && createdYear > 1900) {
    const age = new Date().getFullYear() - createdYear;
    if (age >= 10) {
      score += 10;
      reasons.push(`anciennete ${age} ans`);
    }
  }

  const siege = company.siege ?? {};
  if (siege.latitude && siege.longitude) {
    score += 5;
    reasons.push("geolocalisation disponible");
  }

  return { score: Math.min(score, 100), reasons };
}

export function normalizeCompany(company: ApiCompany): NormalizedProspect | null {
  if (company.nature_juridique !== SCI_NATURE_JURIDIQUE) return null;
  if (company.etat_administratif !== "A") return null;

  const siren = String(company.siren ?? "");
  if (!siren) return null;

  const siege = company.siege ?? {};
  const leaders = Array.isArray(company.dirigeants) ? company.dirigeants : [];
  const physicalLeaders = leaders
    .filter((leader) => leader.type_dirigeant === "personne physique")
    .map((leader) => [leader.prenoms, leader.nom].filter(Boolean).join(" "))
    .filter(Boolean);
  const { score, reasons } = scoreCompany(company);

  return {
    siren,
    siretSiege: optionalString(siege.siret),
    name: String(company.nom_complet ?? company.nom_raison_sociale ?? siren),
    activity: optionalString(company.activite_principale),
    legalForm: optionalString(company.nature_juridique),
    companyCategory: optionalString(company.categorie_entreprise),
    creationDate: parseDate(company.date_creation),
    openEstablishments: optionalNumber(company.nombre_etablissements_ouverts),
    address: optionalString(siege.adresse),
    postalCode: optionalString(siege.code_postal),
    city: optionalString(siege.libelle_commune),
    department: optionalString(siege.departement),
    region: optionalString(siege.region),
    latitude: optionalNumber(siege.latitude),
    longitude: optionalNumber(siege.longitude),
    leadersText: physicalLeaders.join("; ") || undefined,
    leaders: leaders as Prisma.InputJsonValue,
    score,
    scoreReasons: reasons,
    source: API_URL,
    raw: company as Prisma.InputJsonValue,
  };
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
