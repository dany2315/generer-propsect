import Link from "next/link";
import { Prisma, ProspectStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AutoRefresh } from "./AutoRefresh";
import { AnimatedMetric } from "./AnimatedMetric";
import { activityLabel, priorityLabel, structureLabel } from "../lib/display";
import { FilterBar } from "./FilterBar";
import { ExportControls } from "./ExportControls";
import { discoverContactLeadsAction } from "./contact-actions";
import { ContactSearchButton } from "./ContactSearchButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const statusLabels: Record<ProspectStatus, string> = {
  A_ENRICHIR: "A enrichir",
  A_CONTACTER: "A contacter",
  CONTACTE: "Contacte",
  RELANCE: "Relance",
  EXCLU: "Exclu",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function valueOf(input: string | string[] | undefined) {
  return Array.isArray(input) ? input[0] : input;
}

function currentReturnTo(params: Record<string, string | string[] | undefined>) {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const normalized = valueOf(value);
    if (normalized) output.set(key, normalized);
  }
  const query = output.toString();
  return query ? `/?${query}` : "/";
}

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = valueOf(params.q)?.trim() ?? "";
  const status = valueOf(params.status) as ProspectStatus | undefined;
  const minScoreRaw = valueOf(params.minScore)?.trim();
  const activity = valueOf(params.activity)?.trim();
  const department = valueOf(params.department)?.trim();
  const enrichmentType = valueOf(params.enrichmentType)?.trim();
  const lessorPriority = valueOf(params.lessorPriority)?.trim();
  const structureType = valueOf(params.structureType)?.trim();
  const maxAge = valueOf(params.maxAge)?.trim();
  const maxAgeCreationDate =
    maxAge && Number.isFinite(Number(maxAge))
      ? new Date(new Date().getFullYear() - Number(maxAge), 0, 1)
      : undefined;
  const signalFilters = [
    ...(lessorPriority && Number.isFinite(Number(lessorPriority))
      ? [{ key: "long_term_lessor_score", numericValue: { gte: Number(lessorPriority) } }]
      : []),
    ...(structureType ? [{ key: "structure_type", value: structureType }] : []),
  ];

  const where = {
    ...(status && status in statusLabels ? { status } : {}),
    ...(minScoreRaw && Number.isFinite(Number(minScoreRaw)) ? { score: { gte: Number(minScoreRaw) } } : {}),
    ...(activity ? { activity } : {}),
    ...(department ? { department } : {}),
    ...(maxAgeCreationDate ? { creationDate: { gte: maxAgeCreationDate } } : {}),
    ...(enrichmentType === "analysis" ? { enrichments: { some: {} } } : {}),
    ...(enrichmentType === "no_analysis" ? { enrichments: { none: {} } } : {}),
    ...(enrichmentType === "contacts" ? { contactPoints: { some: {} } } : {}),
    ...(enrichmentType === "no_contacts" ? { contactPoints: { none: {} } } : {}),
    ...(signalFilters.length > 0
      ? {
          AND: signalFilters.map((filter) => ({
            signals: {
              some: filter,
            },
          })),
        }
      : {}),
    ...(q
      ? {
          OR: [
            { siren: { contains: q } },
            { name: { contains: q, mode: "insensitive" as const } },
            { city: { contains: q, mode: "insensitive" as const } },
            { leadersText: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  let filteredSirensByExternalEnrichment: string[] | undefined;
  if (["establishments", "no_establishments", "addresses", "rne", "sirene"].includes(enrichmentType ?? "")) {
    if (enrichmentType === "establishments") {
      const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(
        "SELECT DISTINCT prospect_siren FROM prospect_establishments",
      );
      filteredSirensByExternalEnrichment = rows.map((row) => row.prospect_siren);
    }
    if (enrichmentType === "no_establishments") {
      const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(
        "SELECT DISTINCT prospect_siren FROM prospect_establishments",
      );
      filteredSirensByExternalEnrichment = rows.map((row) => row.prospect_siren);
    }
    if (enrichmentType === "addresses") {
      const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(
        "SELECT DISTINCT prospect_siren FROM prospect_establishments WHERE NULLIF(BTRIM(address), '') IS NOT NULL",
      );
      filteredSirensByExternalEnrichment = rows.map((row) => row.prospect_siren);
    }
    if (enrichmentType === "rne") {
      const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(
        "SELECT prospect_siren FROM rne_inpi_enrichments WHERE status = 'OK'",
      );
      filteredSirensByExternalEnrichment = rows.map((row) => row.prospect_siren);
    }
    if (enrichmentType === "sirene") {
      const rows = await prisma.$queryRawUnsafe<Array<{ prospect_siren: string }>>(
        "SELECT prospect_siren FROM sirene_complete_enrichments WHERE status = 'OK'",
      );
      filteredSirensByExternalEnrichment = rows.map((row) => row.prospect_siren);
    }
  }

  const finalWhere = {
    ...where,
    ...(enrichmentType === "establishments" && filteredSirensByExternalEnrichment
      ? { siren: { in: filteredSirensByExternalEnrichment } }
      : {}),
    ...(enrichmentType === "no_establishments" && filteredSirensByExternalEnrichment
      ? { siren: { notIn: filteredSirensByExternalEnrichment } }
      : {}),
    ...(enrichmentType === "addresses" && filteredSirensByExternalEnrichment
      ? { siren: { in: filteredSirensByExternalEnrichment } }
      : {}),
    ...(enrichmentType === "rne" && filteredSirensByExternalEnrichment
      ? { siren: { in: filteredSirensByExternalEnrichment } }
      : {}),
    ...(enrichmentType === "sirene" && filteredSirensByExternalEnrichment
      ? { siren: { in: filteredSirensByExternalEnrichment } }
      : {}),
  };

  const [
    prospects,
    total,
    filteredTotal,
    statusCounts,
    enrichedProspectCount,
    signalCount,
    contactCount,
    establishmentStats,
    rneCount,
    sireneCompleteCount,
    inpiFtpFiles,
    webContactAttempts,
    contactLeadCount,
  ] = await Promise.all([
    prisma.prospect.findMany({
      where: finalWhere,
      include: {
        signals: {
          where: {
            key: { in: ["long_term_lessor_score", "structure_type"] },
          },
        },
        _count: {
          select: {
            enrichments: true,
            contactPoints: true,
            signals: true,
          },
        },
      },
      orderBy: [{ score: "desc" }, { lastSeenAt: "desc" }],
      take: 500,
    }),
    prisma.prospect.count(),
    prisma.prospect.count({ where: finalWhere }),
    prisma.prospect.groupBy({
      by: ["status"],
      _count: { status: true },
    }),
    prisma.prospect.count({ where: { enrichments: { some: {} } } }),
    prisma.prospectSignal.count(),
    prisma.contactPoint.count(),
    prisma.$queryRawUnsafe<Array<{ total: number; prospects: number; open: number }>>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT prospect_siren)::int AS prospects,
        COUNT(*) FILTER (WHERE is_open)::int AS open
      FROM prospect_establishments
    `).catch(() => [{ total: 0, prospects: 0, open: 0 }]),
    prisma.$queryRawUnsafe<Array<{ total: number }>>(`
      SELECT COUNT(*)::int AS total FROM rne_inpi_enrichments WHERE status = 'OK'
    `).then((rows) => rows[0]?.total ?? 0).catch(() => 0),
    prisma.$queryRawUnsafe<Array<{ total: number }>>(`
      SELECT COUNT(*)::int AS total FROM sirene_complete_enrichments WHERE status = 'OK'
    `).then((rows) => rows[0]?.total ?? 0).catch(() => 0),
    prisma.$queryRawUnsafe<Array<{ total: number }>>(`
      SELECT COUNT(*)::int AS total FROM inpi_ftp_files
    `).then((rows) => rows[0]?.total ?? 0).catch(() => 0),
    prisma.$queryRawUnsafe<Array<{ total: number }>>(`
      SELECT COUNT(*)::int AS total FROM web_contact_attempts
    `).then((rows) => rows[0]?.total ?? 0).catch(() => 0),
    prisma.$queryRawUnsafe<Array<{ total: number }>>(`
      SELECT COUNT(*)::int AS total FROM contact_leads
    `).then((rows) => rows[0]?.total ?? 0).catch(() => 0),
  ]);

  const returnTo = currentReturnTo(params);
  const contactLeadRows = prospects.length > 0
    ? await prisma.$queryRaw<Array<{ prospect_siren: string; total: number }>>(
        Prisma.sql`
          SELECT prospect_siren, COUNT(*)::int AS total
          FROM contact_leads
          WHERE prospect_siren IN (${Prisma.join(prospects.map((prospect) => prospect.siren))})
          GROUP BY prospect_siren
        `,
      ).catch(() => [])
    : [];
  const contactLeadCounts = new Map(contactLeadRows.map((row) => [row.prospect_siren, row.total]));

  const enrichmentProgress = total > 0 ? Math.round((enrichedProspectCount / total) * 100) : 0;
  const enrichmentLabels: Record<string, string> = {
    analysis: "Analyse interne faite",
    no_analysis: "Analyse interne manquante",
    establishments: "Etablissements detectes",
    no_establishments: "Etablissements manquants",
    addresses: "Adresse detectee",
    contacts: "Contacts trouves",
    no_contacts: "Contacts manquants",
    rne: "RNE / INPI disponible",
    sirene: "Sirene complet disponible",
  };
  const activeFilters = [
    q ? `Recherche: ${q}` : null,
    minScoreRaw ? `Score min: ${minScoreRaw}` : null,
    activity ? `Activite: ${activityLabel(activity)}` : null,
    department ? `Departement: ${department}` : null,
    status && status in statusLabels ? `Statut: ${statusLabels[status]}` : null,
    enrichmentType ? `Enrichissement: ${enrichmentLabels[enrichmentType] ?? enrichmentType}` : null,
    lessorPriority ? `Priorite bailleur: ${lessorPriority}+` : null,
    structureType ? `Type: ${structureLabel(structureType)}` : null,
    maxAge ? `Anciennete: pas plus de ${maxAge} ans` : null,
  ].filter(Boolean);

  return (
    <main className="shell">
      <AutoRefresh intervalMs={10_000} />
      <header className="topbar">
        <div className="brand">
          <h1>Prospects SCI actifs</h1>
          <p>Neon + Prisma + Next.js, collecte continue via worker TypeScript.</p>
        </div>
        <ExportControls />
      </header>

      <div className="content">
        <FilterBar
          q={q}
          minScoreRaw={minScoreRaw}
          activity={activity}
          department={department}
          status={status}
          enrichmentType={enrichmentType}
          lessorPriority={lessorPriority}
          structureType={structureType}
          maxAge={maxAge}
          statusLabels={statusLabels}
        />

        <section className="metrics">
          <AnimatedMetric label="Total base" value={total} />
          <AnimatedMetric label="Prospects enrichis" value={enrichedProspectCount} />
          <AnimatedMetric label="Indices analyses" value={signalCount} />
          <AnimatedMetric label="Etablissements extraits" value={establishmentStats[0]?.total ?? 0} />
          <AnimatedMetric label="RNE / INPI" value={rneCount} />
          <AnimatedMetric label="Fichiers INPI FTP" value={inpiFtpFiles} />
          <AnimatedMetric label="Sirene complet" value={sireneCompleteCount} />
          <AnimatedMetric label="Recherche contacts" value={webContactAttempts} />
          <AnimatedMetric label="Contacts trouves" value={contactCount} />
          <AnimatedMetric label="Pistes contact" value={contactLeadCount} />
          {statusCounts.map((item) => (
            <AnimatedMetric
              key={item.status}
              label={statusLabels[item.status]}
              value={item._count.status}
            />
          ))}
        </section>

        <section className="progressPanel">
          <div>
            <strong>Progression enrichissement</strong>
            <span>
              {enrichedProspectCount.toLocaleString("fr-FR")} / {total.toLocaleString("fr-FR")} prospects
            </span>
          </div>
          <div className="progressTrack">
            <div style={{ width: `${enrichmentProgress}%` }} />
          </div>
          <strong>{enrichmentProgress}%</strong>
        </section>

        <section className="tableWrap">
          <div className="tableCaption">
            <div>
              <strong>
                {filteredTotal.toLocaleString("fr-FR")} prospect{filteredTotal > 1 ? "s" : ""} trouve{filteredTotal > 1 ? "s" : ""}
              </strong>
              <span>
                {filteredTotal > prospects.length
                  ? `${prospects.length.toLocaleString("fr-FR")} premiers affiches`
                  : "Tous les resultats sont affiches"}
              </span>
            </div>
            <div className="activeFilters">
              {activeFilters.length > 0 ? (
                activeFilters.map((filter) => <span key={filter}>{filter}</span>)
              ) : (
                <span>Aucun filtre actif</span>
              )}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Priorite</th>
                <th>Societe</th>
                <th>Ce qu'elle fait</th>
                <th>Pourquoi interessante</th>
                <th>Ou</th>
                <th>Contact connu</th>
                <th>Analyse</th>
                <th>Statut</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {prospects.map((prospect) => {
                const lessorSignal = prospect.signals.find((signal) => signal.key === "long_term_lessor_score");
                const structureSignal = prospect.signals.find((signal) => signal.key === "structure_type");
                const leadCount = contactLeadCounts.get(prospect.siren) ?? 0;
                const canSearchWeb = !["A_CONTACTER", "CONTACTE", "EXCLU"].includes(prospect.status);

                return (
                  <tr key={prospect.siren}>
                    <td>
                      <span className="score">{prospect.score}</span>
                    </td>
                    <td>
                      <strong>{prospect.name}</strong>
                      <small>
                        SIREN {prospect.siren}
                        {prospect.creationDate ? ` - creee le ${prospect.creationDate.toLocaleDateString("fr-FR")}` : ""}
                      </small>
                    </td>
                    <td>{activityLabel(prospect.activity)}</td>
                    <td>
                      <div className="cellStack">
                        {lessorSignal ? <span className="pill strong">{priorityLabel(lessorSignal.value)}</span> : <span className="muted">Analyse en attente</span>}
                        {structureSignal ? <small>{structureLabel(structureSignal.value)}</small> : null}
                      </div>
                    </td>
                    <td>
                      {prospect.postalCode} {prospect.city}
                    </td>
                    <td>
                      <div className="cellStack">
                        <span>{prospect.leadersText || "Dirigeant a verifier"}</span>
                        <small>{leadCount} piste{leadCount > 1 ? "s" : ""} web</small>
                      </div>
                    </td>
                    <td>
                      <div className="cellStack">
                        <span className={prospect._count.enrichments > 0 ? "pill" : "pill mutedPill"}>
                          {prospect._count.enrichments > 0 ? "analyse faite" : "a analyser"}
                        </span>
                        <small>
                          {prospect._count.signals} indices / {prospect._count.contactPoints} contacts
                        </small>
                      </div>
                    </td>
                    <td>
                      <span className="pill">{statusLabels[prospect.status]}</span>
                    </td>
                    <td>
                      <div className="rowActions">
                        <Link href={`/prospects/${prospect.siren}`} className="button secondary smallButton">
                          Ouvrir
                        </Link>
                        {canSearchWeb ? (
                          <form action={discoverContactLeadsAction}>
                            <input type="hidden" name="siren" value={prospect.siren} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <ContactSearchButton compact />
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {prospects.length === 0 ? <div className="empty">Aucun prospect trouve.</div> : null}
        </section>
      </div>
    </main>
  );
}
