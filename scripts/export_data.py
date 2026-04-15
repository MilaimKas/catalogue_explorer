"""
export_data.py — Convert catalogue.parquet to a compact JSON format for the web app.

Output: web/public/catalogue.json.gz

Format: list of records, one per unique (code, catalogue) pair.
Each record:
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

Run from the repo root:
    uv run python scripts/export_data.py
"""

import gzip
import json
from pathlib import Path

import pandas as pd


PARQUET_PATH = Path("catalogue.parquet")
OUTPUT_PATH = Path("web/public/catalogue.json.gz")


def export(parquet_path: Path, output_path: Path) -> None:
    """Load parquet, deduplicate by code, write gzipped JSON."""
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

    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(records, ensure_ascii=False)
    compressed = gzip.compress(payload.encode("utf-8"), compresslevel=9)

    output_path.write_bytes(compressed)

    raw_kb   = len(payload.encode()) / 1024
    gz_kb    = len(compressed) / 1024
    print(f"Wrote {len(records):,} records → {output_path}")
    print(f"  Raw JSON : {raw_kb:,.0f} KB")
    print(f"  Gzipped  : {gz_kb:,.0f} KB")


if __name__ == "__main__":
    export(PARQUET_PATH, OUTPUT_PATH)
