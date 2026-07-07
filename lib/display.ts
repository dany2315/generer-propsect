export function activityLabel(code?: string | null) {
  const labels: Record<string, string> = {
    "68.20A": "Location de logements",
    "68.20B": "Location de terrains et autres biens",
    "68.10Z": "Activites des marchands de biens immobiliers",
    "68.31Z": "Agences immobilieres",
    "68.32A": "Administration d'immeubles",
    "68.32B": "Supports juridiques immobiliers",
  };

  if (!code) return "Activite inconnue";
  return labels[code] ? `${labels[code]} (${code})` : code;
}

export function structureLabel(value?: string | null) {
  const labels: Record<string, string> = {
    fonciere_ou_structure_institutionnelle: "Gros proprietaire immobilier probable",
    sci_avec_gouvernance_personne_morale: "SCI rattachee a une autre societe",
    sci_patrimoniale_probable: "SCI patrimoniale familiale probable",
    sci_immobiliere_a_qualifier: "SCI immobiliere a verifier",
  };

  if (!value) return "Type encore non analyse";
  return labels[value] ?? value.replaceAll("_", " ");
}

export function structureHelp(value?: string | null) {
  const labels: Record<string, string> = {
    fonciere_ou_structure_institutionnelle: "Plusieurs etablissements ou taille importante : priorite commerciale forte.",
    sci_avec_gouvernance_personne_morale: "La SCI semble controlee par une autre societe : contact souvent plus structure.",
    sci_patrimoniale_probable: "Profil proche d'une SCI de patrimoine : interessant pour des baux longue duree.",
    sci_immobiliere_a_qualifier: "Les donnees sont encore insuffisantes : a enrichir avant prospection.",
  };

  if (!value) return "L'analyse sera affichee apres enrichissement automatique.";
  return labels[value] ?? "Type estime a partir des donnees publiques disponibles.";
}

export function signalLabel(key: string, fallback: string) {
  const labels: Record<string, string> = {
    long_term_lessor_score: "Potentiel bailleur longue duree",
    structure_type: "Type de SCI estime",
    open_establishments: "Taille du patrimoine detecte",
    departments_count: "Presence geographique",
    leaders_total: "Responsables identifies",
    cities_count: "Villes detectees",
    physical_leaders: "Dirigeants personnes physiques",
    corporate_leaders: "Societes dirigeantes",
    vat_numbers: "Numeros TVA trouves",
    idcc_count: "Conventions collectives trouvees",
    employee_tranche_known: "Effectif connu",
  };

  return labels[key] ?? fallback;
}

export function signalValue(key: string, value: string) {
  if (key === "structure_type") return structureLabel(value);
  if (key === "long_term_lessor_score") return priorityLabel(value);
  if (key === "open_establishments") return `${value} etablissement${value === "1" ? "" : "s"} ouvert${value === "1" ? "" : "s"}`;
  if (key === "departments_count") return `${value} departement${value === "1" ? "" : "s"}`;
  if (key === "leaders_total") return `${value} responsable${value === "1" ? "" : "s"} identifie${value === "1" ? "" : "s"}`;
  return value;
}

export function priorityLabel(score?: string | null) {
  if (!score) return "En attente";
  const numeric = Number(String(score).replace("/100", ""));
  if (!Number.isFinite(numeric)) return score;
  if (numeric >= 85) return `Tres prioritaire (${score})`;
  if (numeric >= 70) return `Prioritaire (${score})`;
  if (numeric >= 50) return `A verifier (${score})`;
  return `Faible priorite (${score})`;
}

export function emptyText(value?: string | null) {
  return value && value.trim() ? value : "Non disponible";
}
