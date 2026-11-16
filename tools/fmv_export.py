"""Eksport wycen AI z silnika Football Market Value (repo msulikowski96-cmd/transfer-) do fmv-values.json.

Użycie (po `fmv import-tm`, `fmv train`, `fmv value` w backendzie transfer-):
    python tools/fmv_export.py ../transfer-/backend/data/fmv.db fmv-values.json

Plik trafia do repozytorium aplikacji; serwer czyta go przy starcie. Kwoty w tysiącach euro.
Rekord zawodnika (klucz = id zawodnika w Transfermarkt):
  [mv, mv_low, mv_high, tv, tv_low, tv_high, f6, f12, f24, jakosc_danych_0_100, niepewnosc, opis, czynniki, historia]
  czynniki: [[nazwa, wplyw_%], ...] (bez zerowych), historia: [[rok, mv], ...] z rocznych migawek.
"""
import json
import sqlite3
import sys


def k(v):
    return None if v is None else int(round(v / 1000))


def main(db_path: str, out_path: str) -> None:
    c = sqlite3.connect(db_path)
    vid, vname, metrics = c.execute("select id, name, metrics from model_versions order by id desc limit 1").fetchone()
    m = json.loads(metrics)
    as_of = c.execute("select max(as_of_date) from model_predictions where model_version_id = ?", (vid,)).fetchone()[0]

    hist = {}
    for pid, d, mv in c.execute(
        "select player_id, as_of_date, market_value_eur from model_predictions where model_version_id = ? and as_of_date < ? order by as_of_date",
        (vid, as_of),
    ):
        hist.setdefault(str(pid), []).append([int(d[:4]), k(mv)])

    players = {}
    q = """select player_id, market_value_eur, market_value_low_eur, market_value_high_eur,
                  transfer_value_eur, transfer_value_low_eur, transfer_value_high_eur,
                  forecast_6m_eur, forecast_12m_eur, forecast_24m_eur, data_quality, uncertainty, details
           from model_predictions where model_version_id = ? and as_of_date = ?"""
    for r in c.execute(q, (vid, as_of)):
        det = json.loads(r[12]) if r[12] else {}
        factors = [[f["factor"], round(f["effect_pct"])] for f in det.get("factors", []) if round(f.get("effect_pct", 0))]
        players[str(r[0])] = [k(r[1]), k(r[2]), k(r[3]), k(r[4]), k(r[5]), k(r[6]), k(r[7]), k(r[8]), k(r[9]),
                              round((r[10] or 0) * 100), r[11], det.get("summary", ""), factors, hist.get(str(r[0]), [])[-5:]]

    ov, tv = m["market_value"]["overall"], m.get("transfer_value", {}).get("overall", {})
    out = {
        "asOf": as_of, "version": vname,
        "model": {"n_test": m["split"]["n_test"], "test_from": m["split"]["test_from"], "test_to": m["split"]["test_to"],
                  "mv_median_ape": round(ov["median_ape"], 3), "tv_median_ape": round(tv.get("median_ape", 0), 3) or None,
                  "coverage": round(ov["interval_coverage"], 3)},
        "p": players,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(players)} zawodników, stan na {as_of}, model {vname}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
