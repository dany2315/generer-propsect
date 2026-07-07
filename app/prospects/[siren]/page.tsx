import Link from "next/link";
import { notFound } from "next/navigation";
import { ProspectStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { updateProspect } from "./actions";
import { deleteContactLeadAction, discoverContactLeadsAction, markProspectHasProspectingDataAction, updateContactLeadStatusAction } from "../../contact-actions";
import { ContactSearchButton } from "../../ContactSearchButton";
import { activityLabel, emptyText, priorityLabel, signalLabel, signalValue, structureHelp, structureLabel } from "../../../lib/display";
import { buildRneSummary } from "../../../lib/rne-display";

const statusLabels: Record<ProspectStatus, string> = {
  A_ENRICHIR: "A enrichir",
  A_CONTACTER: "A contacter",
  CONTACTE: "Contacte",
  RELANCE: "Relance",
  EXCLU: "Exclu",
};

type PageParams = Promise<{ siren: string }>;

export default async function ProspectPage({ params }: { params: PageParams }) {
  const { siren } = await params;
  const prospect = await prisma.prospect.findUnique({
    where: { siren },
    include: {
      signals: { orderBy: [{ key: "asc" }] },
      enrichments: { orderBy: { createdAt: "desc" }, take: 3 },
      contactPoints: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!prospect) notFound();

  const leaders = Array.isArray(prospect.leaders) ? prospect.leaders : [];
  const lessorScore = prospect.signals.find((signal) => signal.key === "long_term_lessor_score");
  const structureType = prospect.signals.find((signal) => signal.key === "structure_type");
  const businessSignals = prospect.signals.filter((signal) =>
    ["long_term_lessor_score", "structure_type", "open_establishments", "departments_count", "leaders_total"].includes(signal.key),
  );
  const technicalSignals = prospect.signals.filter((signal) => !businessSignals.some((item) => item.id === signal.id));
  const establishments = await prisma.$queryRawUnsafe<
    Array<{
      siret: string;
      is_headquarters: boolean;
      is_open: boolean;
      address: string | null;
      city: string | null;
      postal_code: string | null;
      activity: string | null;
      employee_range: string | null;
    }>
  >(
    `
      SELECT siret, is_headquarters, is_open, address, city, postal_code, activity, employee_range
      FROM prospect_establishments
      WHERE prospect_siren = $1
      ORDER BY is_headquarters DESC, is_open DESC, city ASC
      LIMIT 25
    `,
    prospect.siren,
  ).catch(() => []);
  const establishmentStats = await prisma.$queryRawUnsafe<
    Array<{
      total: number;
      open: number;
      headquarters: number;
      cities: number;
      departments: number;
    }>
  >(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_open)::int AS open,
        COUNT(*) FILTER (WHERE is_headquarters)::int AS headquarters,
        COUNT(DISTINCT city)::int AS cities,
        COUNT(DISTINCT department)::int AS departments
      FROM prospect_establishments
      WHERE prospect_siren = $1
    `,
    prospect.siren,
  ).catch(() => [{ total: 0, open: 0, headquarters: 0, cities: 0, departments: 0 }]);
  const stats = establishmentStats[0] ?? { total: 0, open: 0, headquarters: 0, cities: 0, departments: 0 };
  const rneRows = await prisma.$queryRawUnsafe<
    Array<{
      status: string;
      company_name: string | null;
      legal_form: string | null;
      has_acts: boolean | null;
      has_annual_accounts: boolean | null;
      fetched_at: Date | null;
      error: string | null;
    }>
  >(
    `
      SELECT status, company_name, legal_form, has_acts, has_annual_accounts, fetched_at, error
      FROM rne_inpi_enrichments
      WHERE prospect_siren = $1
    `,
    prospect.siren,
  ).catch(() => []);
  const sireneRows = await prisma.$queryRawUnsafe<
    Array<{
      status: string;
      statut_diffusion: string | null;
      categorie_juridique: string | null;
      activite_principale: string | null;
      tranche_effectif: string | null;
      etat_administratif: string | null;
      fetched_at: Date | null;
      error: string | null;
    }>
  >(
    `
      SELECT status, statut_diffusion, categorie_juridique, activite_principale, tranche_effectif, etat_administratif, fetched_at, error
      FROM sirene_complete_enrichments
      WHERE prospect_siren = $1
    `,
    prospect.siren,
  ).catch(() => []);
  const rne = rneRows[0];
  const sirene = sireneRows[0];
  const rneMatchRows = await prisma.$queryRawUnsafe<
    Array<{
      payload: any;
      company_name: string | null;
      forme_juridique: string | null;
      updated_at_rne: Date | null;
      nombre_representants_actifs: number | null;
      nombre_etablissements_ouverts: number | null;
    }>
  >(
    `
      SELECT payload, company_name, forme_juridique, updated_at_rne, nombre_representants_actifs, nombre_etablissements_ouverts
      FROM rne_formality_matches
      WHERE prospect_siren = $1
    `,
    prospect.siren,
  ).catch(() => []);
  const rneExtractedRows = await prisma.$queryRawUnsafe<
    Array<{
      company_name: string | null;
      legal_form: string | null;
      creation_date: Date | null;
      activity_code: string | null;
      capital: string | null;
      duration_years: number | null;
      end_date: Date | null;
      object_text: string | null;
      publication_date: Date | null;
      publication_journal: string | null;
      representatives_count: number;
      establishments_count: number;
      latest_event_date: Date | null;
      latest_event_label: string | null;
      rne_updated_at: Date | null;
      representatives: any;
      history: any;
      establishments: any;
    }>
  >(
    `
      SELECT company_name, legal_form, creation_date, activity_code, capital, duration_years, end_date,
             object_text, publication_date, publication_journal, representatives_count, establishments_count,
             latest_event_date, latest_event_label, rne_updated_at, representatives, history, establishments
      FROM rne_extracted_profiles
      WHERE prospect_siren = $1
    `,
    prospect.siren,
  ).catch(() => []);
  const rneSummary = buildRneSummary(rneMatchRows[0]);
  const rneExtracted = rneExtractedRows[0];
  const rneRepresentatives = asArray(rneExtracted?.representatives ?? rneSummary?.representatives);
  const rneHistory = asArray(rneExtracted?.history ?? rneSummary?.history);
  const rneEstablishments = asArray(rneExtracted?.establishments ?? rneSummary?.establishments);
  const hasRneData = Boolean(rneExtracted || rneSummary);
  const creationDate = rneExtracted?.creation_date ?? rneSummary?.creationDate ?? prospect.creationDate;
  const webContactRows = await prisma.$queryRawUnsafe<
    Array<{
      status: string;
      provider: string;
      results_count: number;
      contacts_found: number;
      attempted_at: Date;
      error: string | null;
    }>
  >(
    `
      SELECT status, provider, results_count, contacts_found, attempted_at, error
      FROM web_contact_attempts
      WHERE prospect_siren = $1
    `,
    prospect.siren,
  ).catch(() => []);
  const webContact = webContactRows[0];
  const contactLeads = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      lead_type: string;
      searched_entity: string;
      title: string | null;
      url: string;
      source_domain: string | null;
      confidence: number;
      reason: string;
      status: string;
      updated_at: Date;
    }>
  >(
    `
      SELECT id, lead_type, searched_entity, title, url, source_domain, confidence, reason, status, updated_at
      FROM contact_leads
      WHERE prospect_siren = $1
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 30
    `,
    prospect.siren,
  ).catch(() => []);
  const canSearchWeb = !["A_CONTACTER", "CONTACTE", "EXCLU"].includes(prospect.status);
  const keptContactLeads = contactLeads.filter((lead) => lead.status === "KEPT");

  return (
    <main className="shell">
      <header className="topbar">
        <div className="titleRow">
          <Link href="/" className="button secondary backButton">
            Retour
          </Link>
          <div className="brand">
            <h1>{prospect.name}</h1>
            <p>
              SIREN {prospect.siren} - {activityLabel(prospect.activity)}
            </p>
          </div>
        </div>
      </header>

      <div className="content prospectDetail">
        <section className={keptContactLeads.length > 0 ? "prospectHero prospectHeroReady" : "prospectHero"}>
          <div>
            <span className="label">Priorite commerciale</span>
            <h2>{keptContactLeads.length > 0 ? "Donnees de prospection exploitables" : priorityLabel(lessorScore?.value)}</h2>
            <p>
              <strong>
                {keptContactLeads.length > 0
                  ? `${keptContactLeads.length} piste${keptContactLeads.length > 1 ? "s" : ""} gardee${keptContactLeads.length > 1 ? "s" : ""} :`
                  : "Type de SCI estime :"}
              </strong>{" "}
              {keptContactLeads.length > 0 ? "prospect pret a qualifier commercialement" : structureLabel(structureType?.value)}
            </p>
            <p>{keptContactLeads.length > 0 ? "Les donnees retenues dans les pistes web peuvent servir de point d'entree pour la prospection." : structureHelp(structureType?.value)}</p>
            {canSearchWeb ? (
              <form action={discoverContactLeadsAction} className="heroActionForm">
                <input type="hidden" name="siren" value={prospect.siren} />
                <input type="hidden" name="returnTo" value={`/prospects/${prospect.siren}`} />
                <ContactSearchButton />
              </form>
            ) : null}
          </div>
          <div className="heroFacts">
            <div>
              <span className="label">Score</span>
              <strong>{prospect.score}/100</strong>
            </div>
            <div>
              <span className="label">Statut</span>
              <strong>{statusLabels[prospect.status]}</strong>
            </div>
            <div>
              <span className="label">Creation SCI</span>
              <strong>{formatDateText(creationDate)}</strong>
            </div>
            <div>
              <span className="label">Adresses detectees</span>
              <strong>{stats.total || prospect.openEstablishments || "-"}</strong>
            </div>
            <div>
              <span className="label">Adresses ouvertes</span>
              <strong>{stats.open || prospect.openEstablishments || "-"}</strong>
            </div>
            <div>
              <span className="label">Villes detectees</span>
              <strong>{stats.cities || "-"}</strong>
            </div>
            <div>
              <span className="label">Departements detectes</span>
              <strong>{stats.departments || prospect.department || "-"}</strong>
            </div>
          </div>
        </section>

        <div className="detail">
          <section className="section">
            <div className="sectionHeader">
              <div>
                <span className="label">Qualification</span>
                <h2>Pourquoi cette SCI est interessante</h2>
              </div>
              <span className="pill strong">{activityLabel(prospect.activity)}</span>
            </div>

            <div className="reasonList">
              {prospect.scoreReasons.map((reason) => (
                <span key={reason}>{reason}</span>
              ))}
            </div>

            {prospect.signals.length > 0 ? (
              <>
                <h3>Analyse simple</h3>
                <div className="signalGrid">
                  {businessSignals.map((signal) => (
                  <div key={signal.id}>
                      <span className="label">{signalLabel(signal.key, signal.label)}</span>
                      <strong>{signalValue(signal.key, signal.value)}</strong>
                      <small>confiance {Math.round(signal.confidence * 100)}%</small>
                    </div>
                  ))}
                </div>
                {technicalSignals.length > 0 ? (
                  <>
                    <h3>Indices secondaires</h3>
                    <div className="compactSignalList">
                      {technicalSignals.map((signal) => (
                      <span key={signal.id}>
                          {signalLabel(signal.key, signal.label)}: <strong>{signalValue(signal.key, signal.value)}</strong>
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <p>Pas encore enrichi par le worker.</p>
            )}

            <div className="twoColumns">
              <section>
                <h3>Qui contacter</h3>
                {keptContactLeads.length > 0 ? (
                  <div className="recommendedContactList">
                    {keptContactLeads.slice(0, 5).map((lead) => (
                      <a key={lead.id} href={lead.url} target="_blank" rel="noreferrer">
                        <strong>{lead.title || lead.source_domain || lead.url}</strong>
                        <small>
                          {leadTypeLabel(lead.lead_type)} - via {lead.searched_entity}
                        </small>
                      </a>
                    ))}
                  </div>
                ) : prospect.contactPoints.length > 0 ? (
                  <div className="recommendedContactList">
                    {prospect.contactPoints.map((contact) => (
                      <div key={contact.id}>
                        <strong>{contact.type} : {contact.value}</strong>
                        <small>{contact.source} - {contact.status}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>Aucune piste gardee pour l'instant. Garde les propositions utiles dans la section "Pistes contact web".</p>
                )}
                <div className="sourceNote">
                  <span className="label">Recherche web</span>
                  <strong>
                    {keptContactLeads.length > 0
                      ? `${keptContactLeads.length} piste(s) gardee(s)`
                      : contactLeads.length > 0
                        ? `${contactLeads.length} piste(s) a verifier`
                      : webContact
                        ? `${webContact.status} - ${webContact.contacts_found} contact(s)`
                        : "Recherche manuelle disponible"}
                  </strong>
                  {webContact?.error ? <small>{webContact.error}</small> : null}
                  {canSearchWeb ? (
                    <form action={discoverContactLeadsAction} className="inlineActionForm">
                      <input type="hidden" name="siren" value={prospect.siren} />
                      <input type="hidden" name="returnTo" value={`/prospects/${prospect.siren}`} />
                      <ContactSearchButton compact />
                    </form>
                  ) : null}
                </div>
              </section>

              <section>
                <h3>Adresse du siege</h3>
                <p>{emptyText(prospect.address)}</p>
              </section>
            </div>

            <h3>Dirigeants</h3>
            {leaders.length > 0 ? (
              <div className="leaderList">
                {leaders.map((leader: any, index) => (
                  <div key={index} className="leaderRow">
                    <span className="avatar">{leaderInitials(leader)}</span>
                    <div>
                      <strong>{leaderDisplayName(leader)}</strong>
                      {leader.qualite ? <small>{leader.qualite}</small> : null}
                    </div>
                    {leader.type_dirigeant ? <span className="pill mutedPill">{leader.type_dirigeant}</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p>Aucun dirigeant renvoye par la source officielle pour l'instant.</p>
            )}

            <h3>Pistes contact web</h3>
            {contactLeads.length > 0 ? (
              <>
                {canSearchWeb ? (
                  <form action={markProspectHasProspectingDataAction} className="leadValidationForm">
                    <input type="hidden" name="siren" value={prospect.siren} />
                    <input type="hidden" name="returnTo" value={`/prospects/${prospect.siren}`} />
                    <button type="submit" className="secondaryButton">Prospect avec donnees exploitables</button>
                    <small>Passe le prospect en "A contacter" et masque la recherche web.</small>
                  </form>
                ) : null}
                <div className="contactLeadList">
                  {contactLeads.map((lead) => (
                    <div key={lead.id}>
                      <div className="leadTopLine">
                        <span className="pill">{leadTypeLabel(lead.lead_type)}</span>
                        <span className={lead.status === "KEPT" ? "pill strong" : "pill mutedPill"}>
                          {lead.status === "KEPT" ? "gardee" : "a verifier"}
                        </span>
                        <span className="pill mutedPill">{Math.round(lead.confidence * 100)}% confiance</span>
                      </div>
                      <strong>
                        <a href={lead.url} target="_blank" rel="noreferrer">
                          {lead.title || lead.url}
                        </a>
                      </strong>
                      <small>
                        {lead.source_domain ?? "source web"} - cherche via {lead.searched_entity}
                      </small>
                      <p>{lead.reason}</p>
                      <div className="leadActions">
                        <form action={updateContactLeadStatusAction}>
                          <input type="hidden" name="leadId" value={lead.id} />
                          <input type="hidden" name="siren" value={prospect.siren} />
                          <input type="hidden" name="returnTo" value={`/prospects/${prospect.siren}`} />
                          <input type="hidden" name="status" value={lead.status === "KEPT" ? "TO_VERIFY" : "KEPT"} />
                          <button type="submit" className="secondaryButton smallButton">
                            {lead.status === "KEPT" ? "Ne plus garder" : "Garder cette piste"}
                          </button>
                        </form>
                        <form action={deleteContactLeadAction}>
                          <input type="hidden" name="leadId" value={lead.id} />
                          <input type="hidden" name="siren" value={prospect.siren} />
                          <input type="hidden" name="returnTo" value={`/prospects/${prospect.siren}`} />
                          <button type="submit" className="dangerButton smallButton">Supprimer cette piste</button>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="emptyInline">
                <p>Aucune piste web lancee pour ce prospect. Clique sur "Chercher des pistes web" seulement pour les SCI prioritaires.</p>
              </div>
            )}

            <h3>Etablissements detectes</h3>
            {establishments.length > 0 ? (
              <div className="establishmentList">
                {establishments.map((establishment) => (
                  <div key={establishment.siret}>
                    <div>
                      <strong>{establishment.is_headquarters ? "Siege" : "Etablissement"}</strong>
                      <small>{establishment.siret}</small>
                    </div>
                    <p>{establishment.address ?? `${establishment.postal_code ?? ""} ${establishment.city ?? ""}`}</p>
                    <div className="cellStack">
                      <span className={establishment.is_open ? "pill" : "pill mutedPill"}>
                        {establishment.is_open ? "ouvert" : "ferme"}
                      </span>
                      {establishment.activity ? <small>{activityLabel(establishment.activity)}</small> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p>Les etablissements de cette SCI ne sont pas encore extraits.</p>
            )}

            <h3>Donnees INPI / RNE exploitees</h3>
            {hasRneData ? (
              <div className="rnePanel">
                <div className="rneOverview">
                  <div>
                    <span className="label">Denomination RNE</span>
                    <strong>{rneExtracted?.company_name ?? rneSummary?.companyName ?? prospect.name}</strong>
                  </div>
                  <div>
                    <span className="label">Creation / immatriculation</span>
                    <strong>{formatDateText(rneExtracted?.creation_date ?? rneSummary?.creationDate)}</strong>
                  </div>
                  <div>
                    <span className="label">Capital social</span>
                    <strong>{rneExtracted?.capital ?? rneSummary?.capital ?? "Non renseigne"}</strong>
                  </div>
                  <div>
                    <span className="label">Representants actifs</span>
                    <strong>{rneExtracted?.representatives_count ?? (rneRepresentatives.length || rneMatchRows[0]?.nombre_representants_actifs || 0)}</strong>
                  </div>
                  <div>
                    <span className="label">Etablissements ouverts RNE</span>
                    <strong>{rneExtracted?.establishments_count ?? rneMatchRows[0]?.nombre_etablissements_ouverts ?? rneEstablishments.length}</strong>
                  </div>
                  <div>
                    <span className="label">Derniere mise a jour RNE</span>
                    <strong>{formatDateText(rneExtracted?.rne_updated_at ?? rneSummary?.updatedAt)}</strong>
                  </div>
                </div>
                {(rneExtracted?.object_text ?? rneSummary?.object) ? (
                  <div className="rneTextBlock">
                    <span className="label">Objet social</span>
                    <p>{rneExtracted?.object_text ?? rneSummary?.object}</p>
                  </div>
                ) : null}
                {(rneExtracted?.publication_date || rneExtracted?.publication_journal || rneSummary?.publication) ? (
                  <div className="rneTextBlock">
                    <span className="label">Publication legale</span>
                    <p>{[formatDateText(rneExtracted?.publication_date ?? rneSummary?.publication?.date), rneExtracted?.publication_journal ?? rneSummary?.publication?.journal, rneSummary?.publication?.type].filter(Boolean).join(" - ")}</p>
                  </div>
                ) : null}
                {rneRepresentatives.length > 0 ? (
                  <>
                    <h4>Representants RNE</h4>
                    <div className="rneRepresentativeList">
                      {rneRepresentatives.map((representative: any, index) => (
                        <div key={`${representative.name}-${index}`}>
                          <span className="avatar">{initials(representative.name)}</span>
                          <div>
                            <strong>{representative.name}</strong>
                            <small>{representative.role}</small>
                            <span className="pill mutedPill">{representative.type}</span>
                          </div>
                          <small>{[representative.postalCode, representative.city].filter(Boolean).join(" ")}</small>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {rneHistory.length > 0 ? (
                  <>
                    <h4>Historique juridique RNE</h4>
                    <div className="rneTimeline">
                      {rneHistory.map((event: any, index) => (
                        <div key={`${event.date}-${event.code}-${index}`}>
                          <strong>{formatDateText(event.date)}</strong>
                          <p>{event.label}</p>
                          {event.code ? <small>Code evenement {event.code}</small> : null}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {rneEstablishments.length > 0 ? (
                  <>
                    <h4>Etablissements selon RNE</h4>
                    <div className="rneEstablishmentList">
                      {rneEstablishments.map((establishment: any, index) => (
                        <div key={`${establishment.siret}-${index}`}>
                          <strong>{establishment.label}</strong>
                          <p>{establishment.address}</p>
                          <small>{[establishment.siret, establishment.activityCode ? activityLabel(establishment.activityCode) : null].filter(Boolean).join(" - ")}</small>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <p>Aucune donnee RNE exploitable trouvee pour ce prospect.</p>
            )}

            <h3>Données techniques</h3>
            <div className="technicalGrid">
              <div>
                <span className="label">Premiere collecte</span>
                <strong>{prospect.firstSeenAt.toLocaleString("fr-FR")}</strong>
              </div>
              <div>
                <span className="label">Derniere collecte</span>
                <strong>{prospect.lastSeenAt.toLocaleString("fr-FR")}</strong>
              </div>
              <div>
                <span className="label">Analyses</span>
                <strong>{prospect.enrichments.length}</strong>
              </div>
              <div>
                <span className="label">Adresses extraites</span>
                <strong>{stats.total}</strong>
              </div>
              <div>
                <span className="label">Adresses ouvertes</span>
                <strong>{stats.open}</strong>
              </div>
              <div>
                <span className="label">Source</span>
                <strong>API Recherche d'entreprises</strong>
              </div>
            </div>

            <h3>Sources officielles complémentaires</h3>
            <div className="sourceGrid">
              <div>
                <span className="label">INPI / RNE</span>
                <strong>{rneSummary ? "Correspondance RNE exploitee" : rne?.status === "OK" ? "Disponible" : rne?.status === "ERROR" ? "Erreur" : "Non trouve"}</strong>
                {rneSummary?.companyName ? <small>{rneSummary.companyName}</small> : rne?.company_name ? <small>{rne.company_name}</small> : null}
                {rne?.has_acts ? <span className="pill">actes/statuts detectes</span> : null}
                {rne?.has_annual_accounts ? <span className="pill">comptes detectes</span> : null}
              </div>
              <div>
                <span className="label">Sirene complet</span>
                <strong>{sirene?.status === "OK" ? "Disponible" : sirene?.status === "ERROR" ? "Erreur" : "En attente token/acces"}</strong>
                {sirene?.tranche_effectif ? <small>Effectif: {sirene.tranche_effectif}</small> : null}
                {sirene?.statut_diffusion ? <small>Diffusion: {sirene.statut_diffusion}</small> : null}
              </div>
            </div>
          </section>

          <aside className="section actionPanel">
            <span className="label">Action commerciale</span>
            <h2>Gestion du prospect</h2>
            <form action={updateProspect} className="formStack">
              <input type="hidden" name="siren" value={prospect.siren} />
              <label>
                Statut
                <select name="status" defaultValue={prospect.status}>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Notes
                <textarea name="notes" rows={9} defaultValue={prospect.notes} />
              </label>
              <label>
                <span>Contact</span>
                <select name="markContacted" defaultValue="">
                  <option value="">Ne pas modifier</option>
                  <option value="1">Marquer contacte maintenant</option>
                </select>
              </label>
              <button type="submit">Enregistrer</button>
            </form>
            <div className="contactState">
              <span className="label">Dernier contact</span>
              <strong>{prospect.contactedAt ? prospect.contactedAt.toLocaleString("fr-FR") : "Pas encore contacte"}</strong>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function leadTypeLabel(value: string) {
  const labels: Record<string, string> = {
    leader: "Dirigeant",
    corporate_leader: "Personne morale liee",
    establishment: "Etablissement",
    address: "Adresse",
    company: "SCI",
  };
  return labels[value] ?? value;
}

function leaderDisplayName(leader: any) {
  return [leader.prenoms, leader.nom ?? leader.denomination].filter(Boolean).join(" ") || "Dirigeant non nomme";
}

function leaderInitials(leader: any) {
  return initials(leaderDisplayName(leader));
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatDateText(value?: string | Date | null) {
  if (!value) return "Non renseigne";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("fr-FR");
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}
