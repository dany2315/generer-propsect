from __future__ import annotations

import argparse
import html
import json
import sqlite3
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse


STATUSES = {
    "a_enrichir": "A enrichir",
    "a_contacter": "A contacter",
    "contacte": "Contacte",
    "relance": "Relance",
    "exclu": "Exclu",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Interface locale de gestion des prospects SCI.")
    parser.add_argument("--db", type=Path, default=Path("data/sci_prospects.sqlite"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    ensure_columns(connection)
    return connection


def ensure_columns(connection: sqlite3.Connection) -> None:
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


def esc(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def status_options(selected: str) -> str:
    return "".join(
        f'<option value="{esc(value)}" {"selected" if value == selected else ""}>{esc(label)}</option>'
        for value, label in STATUSES.items()
    )


class ProspectApp(BaseHTTPRequestHandler):
    db_path: Path

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_html(self.render_index(parsed.query))
            return
        if parsed.path == "/prospect":
            self.send_html(self.render_prospect(parsed.query))
            return
        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/prospect/update":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        form = parse_qs(body)
        siren = form.get("siren", [""])[0]
        status = form.get("pipeline_status", ["a_enrichir"])[0]
        notes = form.get("notes", [""])[0]
        mark_contacted = form.get("mark_contacted", [""])[0] == "1"

        if status not in STATUSES:
            status = "a_enrichir"

        contacted_at = now_iso() if mark_contacted or status == "contacte" else None
        with connect_db(self.db_path) as connection:
            if contacted_at:
                connection.execute(
                    """
                    UPDATE prospects
                    SET pipeline_status = ?, notes = ?, contacted_at = COALESCE(contacted_at, ?)
                    WHERE siren = ?
                    """,
                    (status, notes, contacted_at, siren),
                )
            else:
                connection.execute(
                    "UPDATE prospects SET pipeline_status = ?, notes = ? WHERE siren = ?",
                    (status, notes, siren),
                )
            connection.commit()

        self.redirect(f"/prospect?siren={urlencode({'': siren})[1:]}")

    def render_index(self, query: str) -> str:
        params = parse_qs(query)
        status = params.get("status", [""])[0]
        search = params.get("q", [""])[0].strip()
        min_score = params.get("min_score", [""])[0].strip()
        activity = params.get("activity", [""])[0].strip()

        where = []
        values: list[object] = []
        if status in STATUSES:
            where.append("pipeline_status = ?")
            values.append(status)
        if min_score.isdigit():
            where.append("score >= ?")
            values.append(int(min_score))

        sql = "SELECT * FROM prospects"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY score DESC, last_seen_at DESC LIMIT 500"

        with connect_db(self.db_path) as connection:
            all_rows = connection.execute(sql, values).fetchall()
            stats = connection.execute(
                """
                SELECT pipeline_status, COUNT(*) AS total
                FROM prospects
                GROUP BY pipeline_status
                """
            ).fetchall()
            total = connection.execute("SELECT COUNT(*) AS total FROM prospects").fetchone()["total"]

        prospects = []
        for row in all_rows:
            data = json.loads(row["data_json"])
            if search and search.lower() not in json.dumps(data, ensure_ascii=False).lower():
                continue
            if activity and data.get("activite") != activity:
                continue
            data["pipeline_status"] = row["pipeline_status"]
            data["notes"] = row["notes"]
            data["first_seen_at"] = row["first_seen_at"]
            data["last_seen_at"] = row["last_seen_at"]
            prospects.append(data)

        stat_cards = "".join(
            f'<div class="metric"><span>{esc(STATUSES.get(row["pipeline_status"], row["pipeline_status"]))}</span><strong>{row["total"]}</strong></div>'
            for row in stats
        )

        rows = "".join(self.render_row(prospect) for prospect in prospects)
        return self.layout(
            "Prospects SCI",
            f"""
            <section class="toolbar">
              <form method="get" class="filters">
                <input name="q" value="{esc(search)}" placeholder="Nom, SIREN, ville, dirigeant">
                <input name="min_score" value="{esc(min_score)}" placeholder="Score min">
                <input name="activity" value="{esc(activity)}" placeholder="68.20A ou 68.20B">
                <select name="status">
                  <option value="">Tous statuts</option>
                  {status_options(status)}
                </select>
                <button type="submit">Filtrer</button>
                <a class="button ghost" href="/">Reset</a>
              </form>
            </section>
            <section class="metrics">
              <div class="metric"><span>Total</span><strong>{total}</strong></div>
              {stat_cards}
            </section>
            <main class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Score</th>
                    <th>SCI</th>
                    <th>Activite</th>
                    <th>Lieu</th>
                    <th>Dirigeants</th>
                    <th>Statut</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            </main>
            """,
        )

    def render_row(self, prospect: dict[str, object]) -> str:
        siren = str(prospect.get("siren") or "")
        status = str(prospect.get("pipeline_status") or "a_enrichir")
        return f"""
        <tr>
          <td><span class="score">{esc(prospect.get("score"))}</span></td>
          <td>
            <strong>{esc(prospect.get("nom"))}</strong>
            <small>{esc(siren)} - creee le {esc(prospect.get("date_creation"))}</small>
          </td>
          <td>{esc(prospect.get("activite"))}</td>
          <td>{esc(prospect.get("code_postal"))} {esc(prospect.get("commune"))}</td>
          <td class="leaders">{esc(prospect.get("dirigeants_personnes_physiques"))}</td>
          <td><span class="pill">{esc(STATUSES.get(status, status))}</span></td>
          <td><a class="button" href="/prospect?siren={esc(siren)}">Ouvrir</a></td>
        </tr>
        """

    def render_prospect(self, query: str) -> str:
        siren = parse_qs(query).get("siren", [""])[0]
        with connect_db(self.db_path) as connection:
            row = connection.execute(
                "SELECT * FROM prospects WHERE siren = ?",
                (siren,),
            ).fetchone()
        if not row:
            return self.layout("Prospect introuvable", '<p><a href="/">Retour</a></p>')

        data = json.loads(row["data_json"])
        raw = json.loads(row["raw_json"])
        dirigeants = raw.get("dirigeants") or []
        dirigeants_html = "".join(
            f"<li>{esc(leader.get('prenoms'))} {esc(leader.get('nom') or leader.get('denomination'))} <small>{esc(leader.get('qualite'))}</small></li>"
            for leader in dirigeants
        )
        status = row["pipeline_status"]

        return self.layout(
            esc(data.get("nom")),
            f"""
            <p><a href="/" class="button ghost">Retour liste</a></p>
            <main class="detail">
              <section>
                <h2>{esc(data.get("nom"))}</h2>
                <div class="detail-grid">
                  <div><span>Score</span><strong>{esc(data.get("score"))}</strong></div>
                  <div><span>SIREN</span><strong>{esc(data.get("siren"))}</strong></div>
                  <div><span>Activite</span><strong>{esc(data.get("activite"))}</strong></div>
                  <div><span>Statut</span><strong>{esc(STATUSES.get(status, status))}</strong></div>
                </div>
                <h3>Pourquoi ce score</h3>
                <p>{esc(data.get("raisons_score"))}</p>
                <h3>Adresse</h3>
                <p>{esc(data.get("adresse_siege"))}</p>
                <h3>Dirigeants</h3>
                <ul>{dirigeants_html or "<li>Aucun dirigeant renvoye par la source.</li>"}</ul>
              </section>
              <aside>
                <form method="post" action="/prospect/update">
                  <input type="hidden" name="siren" value="{esc(data.get("siren"))}">
                  <label>Statut</label>
                  <select name="pipeline_status">{status_options(status)}</select>
                  <label>Notes</label>
                  <textarea name="notes" rows="8">{esc(row["notes"])}</textarea>
                  <label class="check"><input type="checkbox" name="mark_contacted" value="1"> Marquer contacte</label>
                  <button type="submit">Enregistrer</button>
                </form>
                <div class="source">
                  <p><strong>Premiere collecte</strong><br>{esc(row["first_seen_at"])}</p>
                  <p><strong>Derniere collecte</strong><br>{esc(row["last_seen_at"])}</p>
                  <p><strong>Contacte le</strong><br>{esc(row["contacted_at"])}</p>
                </div>
              </aside>
            </main>
            """,
        )

    def layout(self, title: object, body: str) -> str:
        return f"""<!doctype html>
        <html lang="fr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>{esc(title)}</title>
          <style>
            :root {{ color-scheme: light; --ink:#17202a; --muted:#667085; --line:#d9dee7; --bg:#f6f7f9; --panel:#fff; --accent:#0f766e; }}
            * {{ box-sizing:border-box; }}
            body {{ margin:0; font-family:Arial, sans-serif; color:var(--ink); background:var(--bg); }}
            header {{ padding:22px 28px; background:#ffffff; border-bottom:1px solid var(--line); }}
            h1 {{ margin:0; font-size:24px; }}
            h2 {{ margin-top:0; }}
            a {{ color:var(--accent); text-decoration:none; }}
            .toolbar, .metrics, .table-wrap, .detail, p {{ margin:18px 28px; }}
            .filters {{ display:grid; grid-template-columns:2fr 120px 150px 170px auto auto; gap:10px; }}
            input, select, textarea {{ width:100%; border:1px solid var(--line); border-radius:6px; padding:10px; font:inherit; background:white; }}
            textarea {{ resize:vertical; }}
            button, .button {{ display:inline-flex; align-items:center; justify-content:center; min-height:38px; border:0; border-radius:6px; padding:9px 13px; background:var(--accent); color:white; font-weight:700; cursor:pointer; }}
            .ghost {{ background:#eef4f3; color:var(--accent); }}
            .metrics {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }}
            .metric {{ background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }}
            .metric span, small, .detail-grid span {{ display:block; color:var(--muted); font-size:12px; }}
            .metric strong {{ font-size:26px; }}
            .table-wrap {{ background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:auto; }}
            table {{ width:100%; border-collapse:collapse; min-width:980px; }}
            th, td {{ padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }}
            th {{ font-size:12px; color:var(--muted); background:#fbfcfd; }}
            .score {{ display:inline-grid; place-items:center; width:44px; height:34px; border-radius:6px; background:#e7f5f3; color:#075e57; font-weight:800; }}
            .pill {{ display:inline-flex; border:1px solid #b8d8d3; border-radius:999px; padding:5px 9px; color:#075e57; background:#eef8f6; font-size:12px; }}
            .leaders {{ max-width:260px; }}
            .detail {{ display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:18px; align-items:start; }}
            .detail section, .detail aside {{ background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }}
            .detail-grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }}
            .detail-grid div {{ border:1px solid var(--line); border-radius:6px; padding:12px; }}
            label {{ display:block; margin:12px 0 6px; font-weight:700; }}
            .check {{ display:flex; gap:8px; align-items:center; font-weight:400; }}
            .check input {{ width:auto; }}
            .source {{ color:var(--muted); font-size:13px; margin-top:16px; }}
            @media (max-width: 820px) {{
              .filters, .detail, .detail-grid {{ grid-template-columns:1fr; }}
              .toolbar, .metrics, .table-wrap, .detail, p {{ margin:14px; }}
              header {{ padding:18px 14px; }}
            }}
          </style>
        </head>
        <body>
          <header><h1>{esc(title)}</h1></header>
          {body}
        </body>
        </html>"""

    def send_html(self, content: str) -> None:
        encoded = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def redirect(self, location: str) -> None:
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()


def main() -> None:
    args = parse_args()
    ProspectApp.db_path = args.db
    connect_db(args.db).close()
    server = ThreadingHTTPServer((args.host, args.port), ProspectApp)
    print(f"Interface lancee: http://{args.host}:{args.port}")
    print(f"Base SQLite: {args.db}")
    server.serve_forever()


if __name__ == "__main__":
    main()
