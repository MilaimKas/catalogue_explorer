"""
export_data.py — Convert parquet caches to compact JSON for the web app.

Outputs:
  web/public/catalogue.json.gz    (catalogue records)
  web/public/transitions.json.gz  (year-to-year code transitions)

Catalogue record (one per unique code × catalogue):
  {
    "code":         str,
    "label":        str,          # label as of most recent year
    "parent":       str | "",     # "" means top-level
    "kind":         str,          # "chapter" | "block" | "category"
    "is_leaf":      bool,
    "catalogue":    str,          # "ICD" | "OPS"
    "years":        list[int],    # all years this code appears in
    "label_by_year": {            # only present when label changed over years
      "2014": "old label", ...
    }
  }

Transition record (one per row in transition_cache.parquet; variant columns
dropped per our design — we ignore left/right OPS variants for now):
  {
    "c":  str,   # catalogue: "ICD" | "OPS"
    "sy": int,   # src_year
    "ty": int,   # tgt_year
    "s":  str,   # src_code  ("UNDEF" marks a code-birth boundary)
    "t":  str,   # tgt_code  ("UNDEF" marks a code-death boundary)
    "af": bool,  # auto_fwd
    "ab": bool   # auto_bwd
  }

Run from the repo root:
    uv run python scripts/export_data.py
"""

import gzip
import json
from pathlib import Path

import pandas as pd


CATALOGUE_PARQUET   = Path("catalogue.parquet")
TRANSITIONS_PARQUET = Path("transition_cache.parquet")

CATALOGUE_OUT   = Path("web/public/catalogue.json.gz")
TRANSITIONS_OUT = Path("web/public/transitions.json.gz")


def _write_gzip_json(records: list | dict, path: Path, label: str) -> None:
    """Serialise to JSON, gzip with max compression, and log raw / compressed sizes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload    = json.dumps(records, ensure_ascii=False)
    compressed = gzip.compress(payload.encode("utf-8"), compresslevel=9)
    path.write_bytes(compressed)

    n = len(records) if hasattr(records, "__len__") else "?"
    print(f"Wrote {n:,} {label} → {path}")
    print(f"  Raw JSON : {len(payload.encode()) / 1024:,.0f} KB")
    print(f"  Gzipped  : {len(compressed) / 1024:,.0f} KB")


def export_catalogue(parquet_path: Path, output_path: Path) -> None:
    """Deduplicate catalogue by (code, catalogue), collapse per-year label changes."""
    print(f"Reading {parquet_path} …")
    df = pd.read_parquet(parquet_path)
    df["parent"] = df["parent"].fillna("")

    records: list[dict] = []

    for (code, catalogue), grp in df.groupby(["code", "catalogue"], observed=True):
        grp_sorted = grp.sort_values("year")
        latest = grp_sorted.iloc[-1]
        years: list[int] = [int(y) for y in grp_sorted["year"].tolist()]

        rec: dict = {
            "code":      code,
            "label":     latest["label"],
            "parent":    latest["parent"],
            "kind":      latest["kind"],
            "is_leaf":   bool(latest["is_leaf"]),
            "catalogue": catalogue,
            "years":     years,
        }

        # Store per-year label overrides only where the label differs from the latest
        label_by_year = grp_sorted.set_index("year")["label"].to_dict()
        overrides = {
            str(int(y)): lbl
            for y, lbl in label_by_year.items()
            if lbl != latest["label"]
        }
        if overrides:
            rec["label_by_year"] = overrides

        records.append(rec)

    _write_gzip_json(records, output_path, "catalogue records")


def export_transitions(parquet_path: Path, output_path: Path) -> None:
    """Export the Umsteiger transition table as a compact array of edge records.

    Variant columns are dropped: per our design, we ignore OPS left/right variants
    and treat all variants of a code together.
    """
    print(f"Reading {parquet_path} …")
    df = pd.read_parquet(parquet_path)

    # Drop variant columns and deduplicate — once variants are ignored,
    # multiple rows may collapse into one logical edge.
    df = df.drop(columns=[c for c in ("src_variant", "tgt_variant") if c in df.columns])
    df = df.drop_duplicates(subset=["catalogue", "src_year", "tgt_year", "src_code", "tgt_code"])

    records: list[dict] = [
        {
            "c":  row.catalogue,
            "sy": int(row.src_year),
            "ty": int(row.tgt_year),
            "s":  row.src_code,
            "t":  row.tgt_code,
            "af": bool(row.auto_fwd),
            "ab": bool(row.auto_bwd),
        }
        for row in df.itertuples(index=False)
    ]

    _write_gzip_json(records, output_path, "transition records")


if __name__ == "__main__":
    export_catalogue(CATALOGUE_PARQUET, CATALOGUE_OUT)
    export_transitions(TRANSITIONS_PARQUET, TRANSITIONS_OUT)
