from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fetch_sci import FetchConfig, fetch_page, flatten_company


DEFAULT_DEPARTMENTS = [
    "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
    "11", "12", "13", "14", "15", "16", "17", "18", "19", "21",
    "22", "23", "24", "25", "26", "27", "28", "29", "2A", "2B",
    "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
    "40", "41", "42", "43", "44", "45", "46", "47", "48", "49",
    "50", "51", "52", "53", "54", "55", "56", "57", "58", "59",
    "60", "61", "62", "63", "64", "65", "66", "67", "68", "69",
    "70", "71", "72", "73", "74", "75", "76", "77", "78", "79",
    "80", "81", "82", "83", "84", "85", "86", "87", "88", "89",
    "90", "91", "92", "93", "94", "95", "971", "972", "973", "974",
    "976",
]


CSV_FIELDS = [
    "score",
    "raisons_score",
    "siren",
    "siret_siege",
    "nom",
    "activite",
    "nature_juridique",
    "categorie_entreprise",
    "date_creation",
    "etablissements_ouverts",
    "adresse_siege",
    "code_postal",
    "commune",
    "departement",
    "region",
    "latitude",
    "longitude",
    "dirigeants_personnes_physiques",
    "nb_dirigeants",
    "source",
    "date_collecte",
    "prochaine_action",
    "first_seen_at",
    "last_seen_at",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collecteur continu de prospects SCI avec limites API et checkpoints."
    )
    parser.add_argument("--db", type=Path, default=Path("data/sci_prospects.sqlite"))
    parser.add_argument("--csv", type=Path, default=Path("data/prospects_sci_live.csv"))
    parser.add_argument(
        "--departements",
        help="Liste separee par virgules. Par defaut: tous les departements.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.25,
        help="Pause entre appels API. 0.25s = 4 appels/s, sous la limite officielle de 7 appels/s.",
    )
    parser.add_argument(
        "--cycle-sleep",
        type=float,
        default=3600,
        help="Pause quand tous les departements sont termines, avant recontrole.",
    )
    parser.add_argument(
        "--export-every",
        type=int,
        default=250,
        help="Exporter le CSV toutes les N societes nouvelles ou mises a jour.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        help="Limite de pages par execution, utile pour tester.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Fait un seul passage sur les departements puis s'arrete.",
    )
    return parser.parse_args()


def connect_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prospects (
            siren TEXT PRIMARY KEY,
            score INTEGER NOT NULL,
            data_json TEXT NOT NULL,
            raw_json TEXT NOT NULL,
            pipeline_status TEXT NOT NULL DEFAULT 'a_enrichir',
            notes TEXT NOT NULL DEFAULT '',
            contacted_at TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS checkpoints (
            scope TEXT PRIMARY KEY,
            next_page INTEGER NOT NULL,
            total_pages INTEGER,
            completed_at TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    ensure_prospect_columns(connection)
    return connection


def ensure_prospect_columns(connection: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(prospects)").fetchall()
    }
    migrations = {
        "pipeline_status": "ALTER TABLE prospects ADD COLUMN pipeline_status TEXT NOT NULL DEFAULT 'a_enrichir'",
        "notes": "ALTER TABLE prospects ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
        "contacted_at": "ALTER TABLE prospects ADD COLUMN contacted_at TEXT",
    }
    for column, statement in migrations.items():
        if column not in columns:
            connection.execute(statement)
    connection.commit()


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_next_page(connection: sqlite3.Connection, department: str) -> int:
    row = connection.execute(
        "SELECT next_page FROM checkpoints WHERE scope = ?",
        (department,),
    ).fetchone()
    return int(row["next_page"]) if row else 1


def save_checkpoint(
    connection: sqlite3.Connection,
    department: str,
    next_page: int,
    total_pages: int | None,
    completed: bool,
) -> None:
    connection.execute(
        """
        INSERT INTO checkpoints (scope, next_page, total_pages, completed_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
            next_page = excluded.next_page,
            total_pages = excluded.total_pages,
            completed_at = excluded.completed_at,
            updated_at = excluded.updated_at
        """,
        (
            department,
            next_page,
            total_pages,
            now_iso() if completed else None,
            now_iso(),
        ),
    )
    connection.commit()


def reset_completed_checkpoints(connection: sqlite3.Connection, departments: list[str]) -> None:
    placeholders = ",".join("?" for _ in departments)
    rows = connection.execute(
        f"SELECT COUNT(*) AS total FROM checkpoints WHERE scope IN ({placeholders}) AND completed_at IS NOT NULL",
        departments,
    ).fetchone()
    if int(rows["total"]) != len(departments):
        return

    connection.execute(
        f"UPDATE checkpoints SET next_page = 1, completed_at = NULL, updated_at = ? WHERE scope IN ({placeholders})",
        [now_iso(), *departments],
    )
    connection.commit()


def upsert_company(connection: sqlite3.Connection, company: dict[str, Any]) -> bool:
    row = flatten_company(company)
    siren = row.get("siren")
    if not siren:
        return False

    existing = connection.execute(
        "SELECT siren FROM prospects WHERE siren = ?",
        (siren,),
    ).fetchone()
    seen_at = now_iso()

    if existing:
        connection.execute(
            """
            UPDATE prospects
            SET score = ?, data_json = ?, raw_json = ?, last_seen_at = ?
            WHERE siren = ?
            """,
            (
                row["score"],
                json.dumps(row, ensure_ascii=False),
                json.dumps(company, ensure_ascii=False),
                seen_at,
                siren,
            ),
        )
        return False

    connection.execute(
        """
        INSERT INTO prospects (siren, score, data_json, raw_json, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            siren,
            row["score"],
            json.dumps(row, ensure_ascii=False),
            json.dumps(company, ensure_ascii=False),
            seen_at,
            seen_at,
        ),
    )
    return True


def export_csv(connection: sqlite3.Connection, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = connection.execute(
        "SELECT data_json, first_seen_at, last_seen_at FROM prospects ORDER BY score DESC, siren"
    ).fetchall()

    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for db_row in rows:
            prospect = json.loads(db_row["data_json"])
            prospect["first_seen_at"] = db_row["first_seen_at"]
            prospect["last_seen_at"] = db_row["last_seen_at"]
            writer.writerow({field: prospect.get(field) for field in CSV_FIELDS})

    return len(rows)


def collect_department(
    connection: sqlite3.Connection,
    department: str,
    sleep_seconds: float,
) -> tuple[int, int, bool]:
    page = get_next_page(connection, department)
    config = FetchConfig(
        limit=25,
        departement=department,
        region=None,
        sleep_seconds=sleep_seconds,
    )

    payload = fetch_page(page, config)
    results = payload.get("results", [])
    total_pages = int(payload.get("total_pages") or page)
    new_count = 0

    for company in results:
        if upsert_company(connection, company):
            new_count += 1

    completed = page >= total_pages or not results
    save_checkpoint(
        connection,
        department,
        1 if completed else page + 1,
        total_pages,
        completed,
    )
    connection.commit()
    time.sleep(sleep_seconds)
    return len(results), new_count, completed


def selected_departments(raw: str | None) -> list[str]:
    if not raw:
        return DEFAULT_DEPARTMENTS
    return [item.strip().upper() for item in raw.split(",") if item.strip()]


def main() -> None:
    args = parse_args()
    departments = selected_departments(args.departements)
    connection = connect_db(args.db)
    page_budget = args.max_pages
    changed_since_export = 0

    print(f"Collecte continue demarree sur {len(departments)} departements.")
    print(f"DB: {args.db}")
    print(f"CSV: {args.csv}")

    while True:
        reset_completed_checkpoints(connection, departments)
        active_departments = 0

        for department in departments:
            if page_budget is not None and page_budget <= 0:
                total = export_csv(connection, args.csv)
                print(f"Budget pages atteint. {total} prospects exportes.")
                return

            row = connection.execute(
                "SELECT completed_at FROM checkpoints WHERE scope = ?",
                (department,),
            ).fetchone()
            if row and row["completed_at"]:
                continue

            active_departments += 1
            fetched, new_count, completed = collect_department(
                connection,
                department,
                args.sleep,
            )
            page_budget = page_budget - 1 if page_budget is not None else None
            changed_since_export += fetched

            next_page = get_next_page(connection, department)
            status = "termine" if completed else f"prochaine page {next_page}"
            print(
                f"{department}: {fetched} lignes, {new_count} nouvelles, {status}."
            )

            if changed_since_export >= args.export_every:
                total = export_csv(connection, args.csv)
                changed_since_export = 0
                print(f"Export CSV: {total} prospects.")

        if args.once:
            total = export_csv(connection, args.csv)
            print(f"Passage termine. {total} prospects exportes.")
            return

        if active_departments == 0:
            total = export_csv(connection, args.csv)
            print(
                f"Cycle complet. {total} prospects en base. Pause {args.cycle_sleep}s."
            )
            time.sleep(args.cycle_sleep)


if __name__ == "__main__":
    main()
