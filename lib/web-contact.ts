import { ContactType } from "@prisma/client";

export type SearchResult = {
  title: string;
  url: string;
  description?: string;
};

export type ContactCandidate = {
  type: ContactType;
  value: string;
  source: string;
  confidence: number;
};

const REGISTRY_DOMAINS = [
  "pappers.fr",
  "societe.com",
  "verif.com",
  "manageo.fr",
  "infogreffe.fr",
  "rubypayeur.com",
  "entreprises.lefigaro.fr",
  "ge0prospect.com",
  "hoodspot.fr",
  "b-reputation.com",
  "kompass.com",
  "pagesjaunes.fr",
  "annuaire-mairie.fr",
  "annuaire.petitesaffiches.fr",
  "eterritoire.fr",
  "infonet.fr",
  "doctrine.fr",
  "actulegales.fr",
  "bilansgratuits.fr",
  "corporama.com",
  "ellisphere.fr",
  "annuaire-entreprises.data.gouv.fr",
  "recherche-entreprises.api.gouv.fr",
];

const SOCIAL_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com"];

export function normalizeCompanyName(name: string) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(sci|societe civile immobiliere|sc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildSearchQueries(prospect: {
  siren: string;
  name: string;
  city?: string | null;
  address?: string | null;
  leadersText?: string | null;
}) {
  const city = prospect.city ? ` ${prospect.city}` : "";
  const leader = prospect.leadersText?.split(";")[0]?.trim();
  return [
    `"${prospect.name}" "${prospect.siren}"`,
    `"${prospect.name}"${city} contact`,
    `"${prospect.name}"${city} "mentions legales"`,
    leader ? `"${leader}" "${prospect.name}"` : "",
  ].filter(Boolean);
}

export function rankWebsiteCandidates(results: SearchResult[], prospect: { name: string; siren: string; city?: string | null }) {
  const normalizedName = normalizeCompanyName(prospect.name);
  const tokens = normalizedName.split(" ").filter((token) => token.length >= 3);

  return results
    .map((result) => {
      const host = safeHost(result.url);
      if (!host) return null;
      const haystack = `${result.title} ${result.url} ${result.description ?? ""}`.toLowerCase();
      let score = 0;

      if (haystack.includes(prospect.siren)) score += 40;
      if (prospect.city && haystack.includes(prospect.city.toLowerCase())) score += 10;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 8;
      }
      if (REGISTRY_DOMAINS.some((domain) => host.includes(domain))) score -= 30;
      if (looksLikeDirectoryResult(result.url, host, prospect.siren, tokens)) score -= 45;
      if (SOCIAL_HOSTS.some((domain) => host.includes(domain))) score -= 8;
      if (host.endsWith(".fr")) score += 3;

      return { ...result, host, score };
    })
    .filter((result): result is SearchResult & { host: string; score: number } => {
      return result !== null && result.score > 0;
    })
    .sort((a, b) => b.score - a.score);
}

export function extractContactsFromHtml(html: string, pageUrl: string): ContactCandidate[] {
  const contacts: ContactCandidate[] = [];
  const decoded = decodeHtml(html);
  const cleanText = decoded.replace(/\s+/g, " ");
  const emailMatches = cleanText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  for (const email of unique(emailMatches.map((value) => value.toLowerCase()))) {
    if (isLikelyNoiseEmail(email)) continue;
    contacts.push({ type: ContactType.EMAIL, value: email, source: pageUrl, confidence: 0.72 });
  }

  const phoneMatches = cleanText.match(/(?:\+33|0)\s?[1-9](?:[\s.-]?\d{2}){4}/g) ?? [];
  for (const phone of unique(phoneMatches.map(normalizePhone))) {
    contacts.push({ type: ContactType.PHONE, value: phone, source: pageUrl, confidence: 0.58 });
  }

  const linkedInMatches = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'<\s)]+/gi) ?? [];
  for (const url of unique(linkedInMatches.map(stripTracking))) {
    contacts.push({ type: ContactType.LINKEDIN, value: url, source: pageUrl, confidence: 0.62 });
  }

  const socialMatches = html.match(/https?:\/\/(?:www\.)?(?:facebook|instagram|twitter|x)\.com\/[^"'<\s)]+/gi) ?? [];
  for (const url of unique(socialMatches.map(stripTracking))) {
    contacts.push({ type: ContactType.OTHER, value: url, source: pageUrl, confidence: 0.45 });
  }

  return contacts;
}

export function discoverInternalPages(html: string, baseUrl: string) {
  const urls = new Set<string>();
  const base = new URL(baseUrl);
  const hrefMatches = html.match(/href=["']([^"']+)["']/gi) ?? [];

  for (const raw of hrefMatches) {
    const href = raw.replace(/^href=["']|["']$/gi, "");
    if (!/contact|mentions|legal|legales|a-propos|about/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.hostname !== base.hostname) continue;
      urls.add(url.toString());
    } catch {
      // Ignore malformed links.
    }
  }

  return [...urls].slice(0, 4);
}

export function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isRegistryDomain(url: string) {
  const host = safeHost(url);
  return Boolean(host && REGISTRY_DOMAINS.some((domain) => host.includes(domain)));
}

export function isLikelyOfficialCompanySite(url: string, companyName: string, siren: string) {
  const host = safeHost(url);
  if (!host || isRegistryDomain(url)) return false;

  const tokens = normalizeCompanyName(companyName).split(" ").filter((token) => token.length >= 3);
  if (looksLikeDirectoryResult(url, host, siren, tokens)) return false;
  if (tokens.some((token) => host.includes(token))) return true;

  // Some small SCI sites do not include all tokens, but directories usually expose the SIREN in the path.
  return !url.includes(siren);
}

export function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function normalizePhone(value: string) {
  return value.replace(/[^\d+]/g, "").replace(/^(\+33)0/, "+33");
}

function isLikelyNoiseEmail(email: string) {
  return /example|domain|email|nomail|rgpd|privacy|abuse|postmaster|wordpress|sentry/i.test(email)
    || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(email)
    || /@\d+x\./i.test(email);
}

function stripTracking(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function decodeHtml(value: string) {
  return value
    .replace(/&#64;/g, "@")
    .replace(/\s?\[at\]\s?/gi, "@")
    .replace(/\s?\(at\)\s?/gi, "@")
    .replace(/\s?\[dot\]\s?/gi, ".")
    .replace(/\s?\(dot\)\s?/gi, ".");
}

function looksLikeDirectoryResult(url: string, host: string, siren: string, companyTokens: string[]) {
  const normalizedHost = host.replace(/[^a-z0-9]/g, "");
  const hostContainsCompanyToken = companyTokens.some((token) => normalizedHost.includes(token));
  const pathContainsSiren = url.includes(siren);
  const directoryPath = /\/(societe|entreprise|annuaire|recherche|siren|dirigeants?)\//i.test(url);

  return !hostContainsCompanyToken && (pathContainsSiren || directoryPath);
}
