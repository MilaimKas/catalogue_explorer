"""
data.py — Data loading and graph preparation for the catalogue explorer.

Provides functions to load the catalogue, compute year-change annotations,
and build cytoscape-compatible element lists from filtered subsets.
"""

import sys
from pathlib import Path

import pandas as pd

# ── Constants ──────────────────────────────────────────────────────────────────

YEARS: list[int] = list(range(2014, 2027))
MIN_YEAR: int = YEARS[0]
MAX_YEAR: int = YEARS[-1]

# Cytoscape colour palette per node kind
KIND_COLOURS: dict[str, str] = {
    "chapter":  "#4a90d9",  # blue
    "block":    "#7cb87e",  # green
    "category": "#e8a84a",  # amber
}

# ── Catalogue loading ──────────────────────────────────────────────────────────

def get_catalogue() -> pd.DataFrame:
    """Load and return the full catalogue DataFrame (uses parquet cache)."""
    return pd.read_parquet("catalogue.parquet")


def get_year_span(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute the first and last year each code appears in the catalogue.

    Returns a DataFrame indexed by (code, catalogue) with columns first_year, last_year.
    """
    span = (
        df.groupby(["code", "catalogue"])["year"]
        .agg(first_year="min", last_year="max")
        .reset_index()
    )
    return span


# ── Graph element builders ─────────────────────────────────────────────────────

def build_elements(
    df: pd.DataFrame,
    year: int,
    catalogue_type: str,
    root_codes: list[str] | None = None,
    max_depth: int = 1,
    expanded_nodes: set[str] | None = None,
) -> list[dict]:
    """
    Build cytoscape elements (nodes + edges) for the hierarchy browse view.

    Performs a BFS from top-level roots up to `max_depth` levels. Nodes whose
    code is in `expanded_nodes` are allowed one extra level of depth, enabling
    click-to-expand behaviour.

    Args:
        df:             Full catalogue DataFrame.
        year:           Year to filter by.
        catalogue_type: "ICD" or "OPS".
        root_codes:     Starting codes; None = top-level chapters.
        max_depth:      Default depth limit for unexpanded nodes.
        expanded_nodes: Set of node codes the user has clicked to expand.

    Returns:
        List of cytoscape element dicts (nodes then edges).
    """
    sub = df[(df["year"] == year) & (df["catalogue"] == catalogue_type)].copy()
    expanded_nodes = expanded_nodes or set()

    if sub.empty:
        return []

    # Build lookups indexed by code
    children_map: dict[str | None, list[str]] = {}
    code_row: dict[str, pd.Series] = {}
    for _, row in sub.iterrows():
        parent = row["parent"] if pd.notna(row["parent"]) else None
        children_map.setdefault(parent, []).append(row["code"])
        code_row[row["code"]] = row

    roots = (
        children_map.get(None, [])
        if root_codes is None
        else [c for c in root_codes if c in code_row]
    )

    visited: set[str] = set()
    # Queue items: (code, depth, effective_depth_limit)
    # expanded ancestor nodes propagate a +1 depth allowance to their children
    queue: list[tuple[str, int, int]] = [(c, 0, max_depth) for c in roots]
    elements: list[dict] = []
    seen_edges: set[str] = set()

    while queue:
        code, depth, limit = queue.pop(0)
        if code in visited:
            continue
        visited.add(code)

        row = code_row.get(code)
        if row is None:
            continue

        parent = row["parent"] if pd.notna(row["parent"]) else None
        kind   = str(row["kind"])

        elements.append({
            "data": {
                "id":          code,
                "label":       f"{code}\n{row['label'][:40]}{'…' if len(row['label']) > 40 else ''}",
                "full_label":  row["label"],
                "kind":        kind,
                "is_leaf":     bool(row["is_leaf"]),
                "parent_code": parent,
                "colour":      KIND_COLOURS.get(kind, "#aaa"),
                "expanded":    code in expanded_nodes,
            },
            "classes": kind + (" expanded" if code in expanded_nodes else ""),
        })

        if parent and parent in visited:
            edge_id = f"{parent}->{code}"
            if edge_id not in seen_edges:
                seen_edges.add(edge_id)
                elements.append({"data": {"source": parent, "target": code, "id": edge_id}})

        if depth < limit:
            # If this node has been expanded, give its children an extra level
            child_limit = limit + 1 if code in expanded_nodes else limit
            for child in children_map.get(code, []):
                if child not in visited:
                    queue.append((child, depth + 1, child_limit))

    # Ensure all edges to already-visited parents exist (handles BFS ordering)
    visited_set = {el["data"]["id"] for el in elements if "source" not in el["data"]}
    for el in elements:
        if "source" in el["data"]:
            continue
        code   = el["data"]["id"]
        parent = el["data"].get("parent_code")
        if parent and parent in visited_set:
            edge_id = f"{parent}->{code}"
            if edge_id not in seen_edges:
                seen_edges.add(edge_id)
                elements.append({"data": {"source": parent, "target": code, "id": edge_id}})

    return elements


def build_search_elements(
    df: pd.DataFrame,
    year: int,
    catalogue_type: str,
    query: str,
    search_mode: str = "label",
    exclude: str | None = None,
) -> list[dict]:
    """
    Build cytoscape elements for search results, including parent chain nodes.

    Args:
        df:             Full catalogue DataFrame.
        year:           Year to filter by.
        catalogue_type: "ICD" or "OPS".
        query:          Comma-separated include terms (OR logic).
        search_mode:    "label" for text search, "code" for prefix match.
        exclude:        Optional comma-separated exclude terms (AND-NOT logic) —
                        nodes whose label matches any exclude term are dropped.

    Returns:
        Cytoscape element list limited to matched codes and their ancestors.
    """
    sub = df[(df["year"] == year) & (df["catalogue"] == catalogue_type)]

    # Split comma-separated terms; ignore empty strings
    include_terms = [t.strip() for t in query.split(",") if t.strip()]
    exclude_terms = [t.strip() for t in exclude.split(",") if t.strip()] if exclude else []

    if search_mode == "code":
        # OR across prefixes: keep rows matching any include term
        mask = pd.Series(False, index=sub.index)
        for term in include_terms:
            mask |= sub["code"].str.startswith(term.upper())
    else:
        # OR across terms: keep rows whose label contains any include term
        mask = pd.Series(False, index=sub.index)
        for term in include_terms:
            mask |= sub["label"].str.contains(term, case=False, na=False)

    matched = sub[mask]

    # AND-NOT across exclude terms: drop rows whose label contains any exclude term
    for term in exclude_terms:
        matched = matched[~matched["label"].str.contains(term, case=False, na=False)]

    if matched.empty:
        return []

    # Cap results to avoid browser overload
    matched = matched.head(200)

    # Collect ancestors for each matched code
    code_to_parent: dict[str, str | None] = {
        row["code"]: (row["parent"] if pd.notna(row["parent"]) else None)
        for _, row in sub.iterrows()
    }
    code_to_row: dict[str, pd.Series] = {row["code"]: row for _, row in sub.iterrows()}

    all_codes: set[str] = set(matched["code"].tolist())
    # Walk up ancestor chain
    for code in list(all_codes):
        current = code_to_parent.get(code)
        while current and current not in all_codes:
            all_codes.add(current)
            current = code_to_parent.get(current)

    matched_set: set[str] = set(matched["code"].tolist())
    elements: list[dict] = []
    seen_edges: set[str] = set()

    for code in all_codes:
        row = code_to_row.get(code)
        if row is None:
            continue
        kind = str(row["kind"])
        is_match = code in matched_set
        elements.append({
            "data": {
                "id":        code,
                "label":     f"{code}\n{row['label'][:40]}{'…' if len(row['label']) > 40 else ''}",
                "full_label": row["label"],
                "kind":      kind,
                "is_leaf":   bool(row["is_leaf"]),
                "parent_code": code_to_parent.get(code),
                "colour":    KIND_COLOURS.get(kind, "#aaa"),
                "is_match":  is_match,
            },
            "classes": f"{kind} {'match' if is_match else 'ancestor'}",
        })
        parent = code_to_parent.get(code)
        if parent and parent in all_codes:
            edge_id = f"{parent}->{code}"
            if edge_id not in seen_edges:
                seen_edges.add(edge_id)
                elements.append({
                    "data": {"source": parent, "target": code, "id": edge_id}
                })

    return elements


