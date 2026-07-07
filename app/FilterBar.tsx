"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { activityLabel, structureLabel } from "../lib/display";

type FilterBarProps = {
  q: string;
  minScoreRaw?: string;
  activity?: string;
  department?: string;
  status?: string;
  enrichmentType?: string;
  lessorPriority?: string;
  structureType?: string;
  maxAge?: string;
  statusLabels: Record<string, string>;
};

function FilterButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className={pending ? "loadingButton" : ""} disabled={pending}>
      {pending ? <span className="spinner" aria-hidden="true" /> : null}
      {pending ? "Filtrage..." : "Filtrer"}
    </button>
  );
}

export function FilterBar(props: FilterBarProps) {
  return (
    <form className="filters">
      <input name="q" defaultValue={props.q} placeholder="Nom, SIREN, ville, dirigeant" />
      <input name="minScore" defaultValue={props.minScoreRaw} placeholder="Score min" />
      <select name="activity" defaultValue={props.activity ?? ""}>
        <option value="">Toutes activites</option>
        <option value="68.20B">{activityLabel("68.20B")}</option>
        <option value="68.20A">{activityLabel("68.20A")}</option>
        <option value="68.32A">{activityLabel("68.32A")}</option>
        <option value="68.32B">{activityLabel("68.32B")}</option>
        <option value="68.10Z">{activityLabel("68.10Z")}</option>
        <option value="68.31Z">{activityLabel("68.31Z")}</option>
      </select>
      <input name="department" defaultValue={props.department} placeholder="Departement" />
      <select name="status" defaultValue={props.status ?? ""}>
        <option value="">Tous statuts</option>
        {Object.entries(props.statusLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select name="enrichmentType" defaultValue={props.enrichmentType}>
        <option value="">Type enrichissement</option>
        <option value="analysis">Analyse interne faite</option>
        <option value="no_analysis">Analyse interne manquante</option>
        <option value="establishments">Etablissements detectes</option>
        <option value="no_establishments">Etablissements manquants</option>
        <option value="addresses">Adresse detectee</option>
        <option value="contacts">Contacts trouves</option>
        <option value="no_contacts">Contacts manquants</option>
        <option value="rne">RNE / INPI disponible</option>
        <option value="sirene">Sirene complet disponible</option>
      </select>
      <select name="lessorPriority" defaultValue={props.lessorPriority}>
        <option value="">Priorite bailleur</option>
        <option value="95">Exceptionnel 95+</option>
        <option value="90">Tres fort 90+</option>
        <option value="85">Fort 85+</option>
        <option value="70">Correct 70+</option>
      </select>
      <select name="structureType" defaultValue={props.structureType}>
        <option value="">Type de SCI</option>
        <option value="sci_patrimoniale_probable">{structureLabel("sci_patrimoniale_probable")}</option>
        <option value="fonciere_ou_structure_institutionnelle">{structureLabel("fonciere_ou_structure_institutionnelle")}</option>
        <option value="sci_avec_gouvernance_personne_morale">{structureLabel("sci_avec_gouvernance_personne_morale")}</option>
        <option value="sci_immobiliere_a_qualifier">{structureLabel("sci_immobiliere_a_qualifier")}</option>
      </select>
      <select name="maxAge" defaultValue={props.maxAge}>
        <option value="">Anciennete</option>
        <option value="5">Pas plus de 5 ans</option>
        <option value="10">Pas plus de 10 ans</option>
        <option value="20">Pas plus de 20 ans</option>
      </select>
      <FilterButton />
      <Link href="/" className="button secondary resetButton">
        Reset
      </Link>
    </form>
  );
}
