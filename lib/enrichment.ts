import type { Prisma } from "@prisma/client";

type JsonObject = Record<string, any>;

export type SignalInput = {
  key: string;
  label: string;
  value: string;
  numericValue?: number;
  confidence: number;
  source: string;
};

export type EnrichmentResult = {
  payload: Prisma.InputJsonValue;
  signals: SignalInput[];
};

const SOURCE = "api_gouv_raw_extraction_v1";

export function buildEnrichment(raw: Prisma.JsonValue): EnrichmentResult {
  const data = (raw ?? {}) as JsonObject;
  const siege = (data.siege ?? {}) as JsonObject;
  const leaders = Array.isArray(data.dirigeants) ? data.dirigeants : [];
  const establishments = Array.isArray(data.matching_etablissements) ? data.matching_etablissements : [];
  const complements = (data.complements ?? {}) as JsonObject;
  const tva = Array.isArray(data.tva) ? data.tva.filter(Boolean) : [];
  const openEstablishments = Number(data.nombre_etablissements_ouverts ?? 0);
  const physicalLeaders = leaders.filter((leader) => leader.type_dirigeant === "personne physique");
  const corporateLeaders = leaders.filter((leader) => leader.type_dirigeant === "personne morale");
  const departments = unique(
    [siege.departement, ...establishments.map((item) => item.departement)].filter(Boolean).map(String),
  );
  const cities = unique(
    [siege.libelle_commune, ...establishments.map((item) => item.libelle_commune)].filter(Boolean).map(String),
  );
  const idcc = unique([
    ...arrayOfStrings(complements.liste_idcc),
    ...establishments.flatMap((item) => arrayOfStrings(item.liste_idcc)),
  ]);
  const employeeTranches = unique(
    [data.tranche_effectif_salarie, siege.tranche_effectif_salarie, ...establishments.map((item) => item.tranche_effectif_salarie)]
      .filter(Boolean)
      .map(String),
  );

  const longTermLessorScore = computeLongTermLessorScore({
    activity: String(data.activite_principale ?? ""),
    openEstablishments,
    age: companyAge(data.date_creation),
    leadersCount: leaders.length,
    departmentsCount: departments.length,
    hasGeo: Boolean(siege.latitude && siege.longitude),
  });

  const structureType = inferStructureType({
    openEstablishments,
    physicalLeadersCount: physicalLeaders.length,
    corporateLeadersCount: corporateLeaders.length,
    companyCategory: data.categorie_entreprise,
  });

  const signals: SignalInput[] = [
    signal("long_term_lessor_score", "Probabilite bailleur long terme", `${longTermLessorScore}/100`, longTermLessorScore, 0.72),
    signal("structure_type", "Type probable de SCI", structureType, undefined, 0.62),
    signal("open_establishments", "Etablissements ouverts", String(openEstablishments), openEstablishments, 0.9),
    signal("departments_count", "Departements couverts", String(departments.length), departments.length, 0.78),
    signal("cities_count", "Villes detectees", String(cities.length), cities.length, 0.72),
    signal("leaders_total", "Dirigeants detectes", String(leaders.length), leaders.length, 0.86),
    signal("physical_leaders", "Dirigeants personnes physiques", String(physicalLeaders.length), physicalLeaders.length, 0.82),
    signal("corporate_leaders", "Dirigeants personnes morales", String(corporateLeaders.length), corporateLeaders.length, 0.82),
    signal("vat_numbers", "Numeros TVA detectes", String(tva.length), tva.length, 0.8),
    signal("idcc_count", "Conventions collectives detectees", String(idcc.length), idcc.length, 0.65),
    signal("employee_tranche_known", "Tranche effectif disponible", employeeTranches.length > 0 ? "oui" : "non", employeeTranches.length, 0.7),
  ];

  const payload = {
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    structureType,
    longTermLessorScore,
    departments,
    cities,
    tva,
    idcc,
    employeeTranches,
    leaders: {
      total: leaders.length,
      physical: physicalLeaders.length,
      corporate: corporateLeaders.length,
    },
    establishments: {
      open: openEstablishments,
      returnedByApi: establishments.length,
    },
    webContactStatus: "not_started",
    nextEnrichmentSteps: [
      "inpi_rne_documents",
      "website_email_search",
      "linkedin_manual_or_api",
      "ai_qualification",
    ],
  } satisfies Prisma.InputJsonObject;

  return { payload, signals };
}

function computeLongTermLessorScore(input: {
  activity: string;
  openEstablishments: number;
  age: number;
  leadersCount: number;
  departmentsCount: number;
  hasGeo: boolean;
}) {
  let score = 25;
  if (input.activity === "68.20A" || input.activity === "68.20B") score += 35;
  if (input.openEstablishments >= 2) score += Math.min(15, input.openEstablishments);
  if (input.age >= 10) score += 10;
  if (input.leadersCount > 0) score += 8;
  if (input.departmentsCount >= 2) score += 4;
  if (input.hasGeo) score += 3;
  return Math.min(score, 100);
}

function inferStructureType(input: {
  openEstablishments: number;
  physicalLeadersCount: number;
  corporateLeadersCount: number;
  companyCategory?: unknown;
}) {
  if (input.openEstablishments >= 10 || input.companyCategory === "GE" || input.companyCategory === "ETI") {
    return "fonciere_ou_structure_institutionnelle";
  }
  if (input.corporateLeadersCount > 0 && input.physicalLeadersCount === 0) {
    return "sci_avec_gouvernance_personne_morale";
  }
  if (input.physicalLeadersCount > 0 && input.openEstablishments <= 3) {
    return "sci_patrimoniale_probable";
  }
  return "sci_immobiliere_a_qualifier";
}

function companyAge(value: unknown) {
  if (!value) return 0;
  const year = Number(String(value).slice(0, 4));
  if (!Number.isFinite(year)) return 0;
  return new Date().getFullYear() - year;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function signal(key: string, label: string, value: string, numericValue: number | undefined, confidence: number): SignalInput {
  return { key, label, value, numericValue, confidence, source: SOURCE };
}
