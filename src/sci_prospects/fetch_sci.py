from __future__ import annotations

import argparse
import csv
import json
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://recherche-entreprises.api.gouv.fr/search"
USER_AGENT = "sci-prospects-mvp/0.1"
SCI_NATURE_JURIDIQUE = "6540"
TARGET_ACTIVITIES = {"68.20A", "68.20B"}


@dataclass(frozen=True)
class FetchConfig:
    limit: int
    departement: str | None
    region: str | None
    sleep_seconds: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extrait des SCI actives depuis l'API Recherche d'entreprises."
    )
    parser.add_argument("--limit", type=int, default=100, help="Nombre maximum de prospects.")
    parser.add_argument("--departement", help="Filtre département, exemple: 75, 92, 13.")
    parser.add_argument("--region", help="Filtre région INSEE, exemple: 11 pour Ile-de-France.")
    parser.add_argument("--csv", type=Path, default=Path("data/prospects_sci.csv"))
    parser.add_argument("--jsonl", type=Path, help="Export JSONL brut enrichi.")
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.18,
        help="Pause entre appels API. 0.18s reste sous la limite de 7 appels/seconde.",
    )
    return parser.parse_args()


def fetch_page(page: int, config: FetchConfig) -> dict[str, Any]:
    params: dict[str, Any] = {
        "nature_juridique": SCI_NATURE_JURIDIQUE,
        "etat_administratif": "A",
        "section_activite_principale": "L",
        "page": page,
        "per_page": 25,
    }
    if config.departement:
        params["departement"] = config.departement
    if config.region:
        params["region"] = config.region

    request = Request(
        f"{API_URL}?{urlencode(params)}",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 429:
            retry_after = int(exc.headers.get("Retry-After", "2"))
            time.sleep(retry_after)
            return fetch_page(page, config)
        raise


def iter_companies(config: FetchConfig) -> Iterable[dict[str, Any]]:
    collected = 0
    page = 1

    while collected < config.limit:
        payload = fetch_page(page, config)
        results = payload.get("results", [])
        if not results:
            break

        for company in results:
            yield company
            collected += 1
            if collected >= config.limit:
                break

        page += 1
        if page > int(payload.get("total_pages", page)):
            break
        time.sleep(config.sleep_seconds)


def prospect_score(company: dict[str, Any]) -> tuple[int, list[str]]:
    score = 20
    reasons = ["SCI active"]

    activity = company.get("activite_principale")
    if activity in TARGET_ACTIVITIES:
        score += 35
        reasons.append(f"activité immobilière cible {activity}")
    elif company.get("section_activite_principale") == "L":
        score += 15
        reasons.append("section activités immobilières")

    open_locations = company.get("nombre_etablissements_ouverts") or 0
    if open_locations >= 2:
        score += min(15, open_locations)
        reasons.append(f"{open_locations} établissements ouverts")

    if company.get("dirigeants"):
        score += 10
        reasons.append("dirigeants disponibles")

    if company.get("categorie_entreprise") in {"PME", "ETI", "GE"}:
        score += 5
        reasons.append(f"catégorie {company.get('categorie_entreprise')}")

    created_at = company.get("date_creation")
    if created_at:
        try:
            age = date.today().year - int(created_at[:4])
            if age >= 10:
                score += 10
                reasons.append(f"ancienneté {age} ans")
        except ValueError:
            pass

    siege = company.get("siege") or {}
    if siege.get("latitude") and siege.get("longitude"):
        score += 5
        reasons.append("géolocalisation disponible")

    return min(score, 100), reasons


def flatten_company(company: dict[str, Any]) -> dict[str, Any]:
    siege = company.get("siege") or {}
    dirigeants = company.get("dirigeants") or []
    score, reasons = prospect_score(company)

    physical_leaders = [
        " ".join(part for part in [leader.get("prenoms"), leader.get("nom")] if part)
        for leader in dirigeants
        if leader.get("type_dirigeant") == "personne physique"
    ]

    return {
        "score": score,
        "raisons_score": " | ".join(reasons),
        "siren": company.get("siren"),
        "siret_siege": siege.get("siret"),
        "nom": company.get("nom_complet") or company.get("nom_raison_sociale"),
        "activite": company.get("activite_principale"),
        "nature_juridique": company.get("nature_juridique"),
        "categorie_entreprise": company.get("categorie_entreprise"),
        "date_creation": company.get("date_creation"),
        "etablissements_ouverts": company.get("nombre_etablissements_ouverts"),
        "adresse_siege": siege.get("adresse"),
        "code_postal": siege.get("code_postal"),
        "commune": siege.get("libelle_commune"),
        "departement": siege.get("departement"),
        "region": siege.get("region"),
        "latitude": siege.get("latitude"),
        "longitude": siege.get("longitude"),
        "dirigeants_personnes_physiques": "; ".join(physical_leaders),
        "nb_dirigeants": len(dirigeants),
        "source": API_URL,
        "date_collecte": date.today().isoformat(),
        "prochaine_action": "enrichir_contact",
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(path: Path, companies: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for company in companies:
            handle.write(json.dumps(company, ensure_ascii=False) + "\n")


def main() -> None:
    args = parse_args()
    config = FetchConfig(
        limit=args.limit,
        departement=args.departement,
        region=args.region,
        sleep_seconds=args.sleep,
    )

    companies = list(iter_companies(config))
    if not companies:
        raise SystemExit("Aucune SCI trouvée avec ces filtres.")

    rows = sorted((flatten_company(company) for company in companies), key=lambda row: row["score"], reverse=True)
    write_csv(args.csv, rows)
    if args.jsonl:
        write_jsonl(args.jsonl, companies)

    print(f"{len(rows)} prospects exportés dans {args.csv}")
    if args.jsonl:
        print(f"Données brutes exportées dans {args.jsonl}")


if __name__ == "__main__":
    main()
