import { isRegistryDomain, normalizeCompanyName, safeHost } from "./web-contact";

export type LeadSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

type QueryPlan = {
  query: string;
  entity: string;
  kind: "leader" | "corporate_leader" | "establishment" | "address" | "company";
};

const EXCLUDED_ROLES = /commissaire aux comptes|auditeur|expert-comptable|greffe/i;
const DIRECTORY_HINTS = /annuaire|societe|pappers|verif|rubypayeur|infonet|doctrine|actulegales|petitesaffiches|lefigaro|manageo|kompass|hoodspot|b-reputation|dataprospects|118000|telephone\.city|le-site-de|europages|business-directory|toutsurlassurance|horairesdouverture|mappy|seloger|meilleursagents|bienici|logic-immo|efficity|lapporteurdimmo|pagesjaunes|wikipedia|legifrance|info\.gouv|data\.gouv|api\.gouv/i;

export function buildSearchQueriesForLead(prospect: {
  siren: string;
  name: string;
  city?: string | null;
  address?: string | null;
  leadersText?: string | null;
  leaders?: any;
  raw?: any;
}): QueryPlan[] {
  const plans: QueryPlan[] = [];
  const leaders = Array.isArray(prospect.leaders) ? prospect.leaders : [];

  for (const leader of leaders) {
    const quality = String(leader.qualite ?? "");
    if (EXCLUDED_ROLES.test(quality)) continue;

    if (leader.type_dirigeant === "personne physique") {
      for (const name of extractLeaderNameVariants(leader.prenoms, leader.nom)) {
        plans.push({ kind: "leader", entity: name, query: `"${name}" "${prospect.name}"` });
        plans.push({ kind: "leader", entity: name, query: `"${name}" immobilier LinkedIn` });
      }
    }

    if (leader.type_dirigeant === "personne morale" && leader.denomination) {
      const entity = String(leader.denomination);
      plans.push({ kind: "corporate_leader", entity, query: `"${entity}" contact immobilier` });
      plans.push({ kind: "corporate_leader", entity, query: `"${entity}" LinkedIn` });
    }
  }

  plans.push({ kind: "company", entity: prospect.name, query: `"${prospect.name}" "${prospect.siren}" contact` });

  return dedupePlans(plans);
}

export function classifyLeadSource(
  result: LeadSearchResult,
  plan: QueryPlan,
  prospect: { name: string; siren: string; city?: string | null },
) {
  if (!result.url) return null;
  const host = safeHost(result.url);
  if (!host) return null;
  if (isRegistryDomain(result.url) || DIRECTORY_HINTS.test(host)) return null;

  const haystack = `${result.title} ${result.url} ${result.snippet ?? ""}`.toLowerCase();
  if (plan.kind === "company" && !haystack.includes(prospect.siren)) return null;

  let confidence = 0.35;
  const companyTokens = normalizeCompanyName(prospect.name).split(" ").filter((token) => token.length >= 3);
  const entityTokens = normalizeCompanyName(plan.entity).split(" ").filter((token) => token.length >= 3);
  const hasCompanyEvidence =
    haystack.includes(prospect.siren) ||
    companyTokens.some((token) => haystack.includes(token)) ||
    Boolean(prospect.city && haystack.includes(prospect.city.toLowerCase()));
  const hasEntityEvidence = entityTokens.some((token) => haystack.includes(token));
  const weakIdentityMatch = plan.kind !== "company" && !hasCompanyEvidence;

  if (hasEntityEvidence) confidence += 0.18;
  if (companyTokens.some((token) => haystack.includes(token))) confidence += 0.12;
  if (prospect.city && haystack.includes(prospect.city.toLowerCase())) confidence += 0.08;
  if (/linkedin\.com\/in|linkedin\.com\/company/.test(result.url)) confidence += 0.12;
  if (/contact|mentions|equipe|team|about|a-propos/.test(result.url)) confidence += 0.08;
  if (result.url.includes(prospect.siren) && plan.kind !== "company") confidence -= 0.18;
  if (weakIdentityMatch) {
    if (!hasEntityEvidence) return null;
    confidence = Math.min(confidence, 0.34);
  }

  if (!weakIdentityMatch && confidence < 0.48) return null;

  return {
    leadType: plan.kind,
    title: result.title,
    url: stripUrl(result.url),
    snippet: result.snippet ?? "",
    sourceDomain: host,
    confidence: Math.min(confidence, 0.86),
    reason: weakIdentityMatch ? weakReasonFor(plan.kind) : reasonFor(plan.kind),
  };
}

function reasonFor(kind: QueryPlan["kind"]) {
  const reasons: Record<QueryPlan["kind"], string> = {
    leader: "Trouve via un dirigeant personne physique lie a la SCI.",
    corporate_leader: "Trouve via une personne morale liee a la SCI.",
    establishment: "Trouve via un nom commercial ou etablissement rattache.",
    address: "Trouve via une adresse rattachee a la SCI.",
    company: "Trouve via le nom et le SIREN de la SCI.",
  };
  return reasons[kind];
}

function weakReasonFor(kind: QueryPlan["kind"]) {
  const reasons: Record<QueryPlan["kind"], string> = {
    leader: "Correspondance faible : resultat trouve via le nom du dirigeant, mais sans lien clair avec la SCI, le SIREN ou la ville.",
    corporate_leader: "Correspondance faible : resultat trouve via une personne morale liee, mais sans lien clair avec cette SCI.",
    establishment: "Correspondance faible : resultat trouve via un etablissement, mais sans rattachement clair a cette SCI.",
    address: "Correspondance faible : resultat trouve via une adresse, mais sans rattachement clair a cette SCI.",
    company: "Correspondance faible.",
  };
  return reasons[kind];
}

// Le RNE/API Recherche d'entreprises encode le nom d'usage (souvent le nom marital)
// directement dans le champ `nom`, format "NOM_NAISSANCE (NOM_USAGE)". La personne peut
// etre trouvable en ligne sous l'un ou l'autre nom, donc on cherche les deux separement.
function extractLeaderNameVariants(prenoms?: string | null, nom?: string | null): string[] {
  if (!nom) return [];
  const match = nom.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const surnames = match ? [match[1], match[2]] : [nom];

  return surnames
    .map((surname) => [prenoms, surname].filter(Boolean).join(" ").trim())
    .filter(Boolean);
}

function dedupePlans(plans: QueryPlan[]) {
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const key = `${plan.kind}:${plan.query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripUrl(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
