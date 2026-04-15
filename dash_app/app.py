"""
app.py — Main entry point for the ICD-10-GM / OPS Catalogue Explorer.

Run with:
    uv run python app.py
    or (if dash and dash-cytoscape are on PATH)
    python app.py

The app loads the catalogue parquet cache on startup and serves an
interactive Dash application at http://127.0.0.1:8050/.

Default view: top-level chapters + their immediate children (blocks).
Click any non-leaf node to expand its children into the graph.
"""

import json

import pandas as pd
from dash import Dash, Input, Output, State, callback_context, html, no_update

from data import (
    MAX_YEAR,
    build_elements,
    build_search_elements,
    get_catalogue,
    get_year_span,
)
from layout import build_layout

# ── App init ───────────────────────────────────────────────────────────────────

app = Dash(
    __name__,
    title="Catalogue Explorer",
)

# Load catalogue once at startup (uses parquet cache)
print("Loading catalogue…")
DF: pd.DataFrame = get_catalogue()
YEAR_SPAN: pd.DataFrame = get_year_span(DF)
print(f"Catalogue loaded: {len(DF):,} rows, years {DF['year'].min()}–{DF['year'].max()}")

app.layout = build_layout()


# ── Expand store: track which nodes have been expanded ─────────────────────────

@app.callback(
    Output("store-expanded-nodes", "data"),
    Input("cyto-graph",       "tapNodeData"),
    Input("year-slider",      "value"),
    Input("catalogue-toggle", "value"),
    Input("search-input",     "value"),
    Input("search-input",     "n_submit"),  # Enter key press
    Input("exclude-input",    "value"),
    Input("exclude-input",    "n_submit"),  # Enter key press
    State("store-expanded-nodes", "data"),
    prevent_initial_call=True,
)
def update_expanded_nodes(
    node_data: dict | None,
    year: int | None,
    catalogue_type: str | None,
    query: str | None,
    _n_submit_search: int | None,
    exclude: str | None,
    _n_submit_exclude: int | None,
    expanded: list[str],
) -> list[str]:
    """
    Toggle expansion of a clicked node (adds its code to the expanded set).

    Clears expansions when year, catalogue, or search filters change.
    """
    triggered = callback_context.triggered_id
    expanded = list(expanded or [])

    # Any filter change resets the expansion state
    if triggered in ("year-slider", "catalogue-toggle", "search-input", "exclude-input"):
        return []

    if triggered == "cyto-graph" and node_data:
        code = node_data.get("id")
        is_leaf = node_data.get("is_leaf", True)
        if code and not is_leaf:
            if code in expanded:
                expanded.remove(code)   # collapse
            else:
                expanded.append(code)   # expand

    return expanded


# ── Browse tab: graph elements ─────────────────────────────────────────────────

@app.callback(
    Output("cyto-graph", "elements"),
    Input("year-slider",          "value"),
    Input("catalogue-toggle",     "value"),
    Input("search-input",         "value"),
    Input("search-input",         "n_submit"),  # Enter key press
    Input("exclude-input",        "value"),
    Input("exclude-input",        "n_submit"),  # Enter key press
    Input("search-mode",          "value"),
    Input("store-expanded-nodes", "data"),
    State("store-group-codes",    "data"),
    prevent_initial_call=False,
)
def update_graph(
    year: int | None,
    catalogue_type: str | None,
    query: str | None,
    _n_submit_search: int | None,
    exclude: str | None,
    _n_submit_exclude: int | None,
    search_mode: str,
    expanded_nodes: list[str],
    group_codes: list[str],
) -> list[dict]:
    """
    Rebuild graph elements whenever a filter or expansion changes.

    Browse mode: shows chapters + blocks by default (depth=1).
    Expanded nodes (clicked) reveal their children one level deeper.
    """
    year           = year or MAX_YEAR
    catalogue_type = catalogue_type or "ICD"
    group_set      = set(group_codes or [])
    expanded_set   = set(expanded_nodes or [])

    # Only enter search mode if at least one non-empty term exists after splitting
    include_terms = [t.strip() for t in query.split(",") if t.strip()] if query else []
    if include_terms:
        elements = build_search_elements(
            DF, year, catalogue_type,
            query.strip(), search_mode or "label",
            exclude=exclude.strip() if exclude and exclude.strip() else None,
        )
    else:
        # Default view: depth=1 from top-level; expanded nodes also show +1 level
        elements = build_elements(
            DF, year, catalogue_type,
            root_codes=None,
            max_depth=1,
            expanded_nodes=expanded_set,
        )

    # Mark nodes that are in the current feature group
    for el in elements:
        if "source" not in el["data"] and el["data"]["id"] in group_set:
            cls = el.get("classes", "")
            if "in-group" not in cls:
                el["classes"] = (cls + " in-group").strip()

    return elements


# ── Cytoscape layout: switch to cose for search (better for arbitrary graphs) ──

@app.callback(
    Output("cyto-graph", "layout"),
    Input("search-input", "value"),
    Input("search-input", "n_submit"),  # Enter key press
)
def update_layout(query: str | None, _n_submit: int | None) -> dict:
    """Use breadthfirst for hierarchy view, cose for search results."""
    if query and query.strip():
        return {"name": "cose", "animate": False, "nodeRepulsion": 8000, "idealEdgeLength": 80}
    return {"name": "breadthfirst", "directed": True, "spacingFactor": 1.5, "animate": False}


# ── Selected node → store ──────────────────────────────────────────────────────

@app.callback(
    Output("store-selected-node", "data"),
    Input("cyto-graph", "tapNodeData"),
    prevent_initial_call=True,
)
def store_selected_node(node_data: dict | None) -> str | None:
    """Store the ID of the last tapped node."""
    if node_data:
        return node_data.get("id")
    return None


# ── Node details panel ─────────────────────────────────────────────────────────

@app.callback(
    Output("node-details", "children"),
    Input("cyto-graph", "tapNodeData"),
    prevent_initial_call=True,
)
def show_node_details(node_data: dict | None) -> object:
    """Render node detail cards in the side panel on node click."""
    if not node_data:
        return "Click a node to see details."

    code       = node_data.get("id", "—")
    full_label = node_data.get("full_label", "—")
    kind       = node_data.get("kind", "—")
    is_leaf    = node_data.get("is_leaf", False)

    # Look up year span from precomputed table
    row = YEAR_SPAN[YEAR_SPAN["code"] == code]
    if not row.empty:
        first_y  = int(row["first_year"].iloc[0])
        last_y   = int(row["last_year"].iloc[0])
        cat      = str(row["catalogue"].iloc[0])
        span_str = f"{first_y}–{last_y}" if first_y != last_y else str(first_y)
    else:
        span_str = "—"
        cat      = "—"

    def _field(label: str, value: str) -> html.Div:
        return html.Div(
            style={"margin-bottom": "8px"},
            children=[
                html.Span(label + ": ", style={"color": "#888", "font-size": "11px"}),
                html.Span(value, style={"color": "#eee"}),
            ],
        )

    hint = "" if is_leaf else " (click to expand/collapse)"
    items: list = [
        _field("Code", code),
        _field("Catalogue", cat),
        _field("Kind", kind + hint),
        _field("Leaf", "Yes" if is_leaf else "No"),
        _field("Valid years", span_str),
        html.Div(
            style={"margin-top": "6px"},
            children=[
                html.Span("Label: ", style={"color": "#888", "font-size": "11px"}),
                html.Span(
                    full_label,
                    style={"color": "#eee", "font-style": "italic", "font-size": "12px"},
                ),
            ],
        ),
    ]

    return items


# ── Feature builder ────────────────────────────────────────────────────────────

@app.callback(
    Output("store-group-codes", "data"),
    Input("btn-add-node",    "n_clicks"),
    Input("btn-remove-node", "n_clicks"),
    Input("btn-clear-group", "n_clicks"),
    State("store-selected-node", "data"),
    State("store-group-codes",   "data"),
    prevent_initial_call=True,
)
def update_group(
    _add: int,
    _remove: int,
    _clear: int,
    selected: str | None,
    group: list[str],
) -> list[str]:
    """Add, remove, or clear codes in the feature group store."""
    triggered = callback_context.triggered_id
    group = list(group or [])

    if triggered == "btn-add-node" and selected:
        if selected not in group:
            group.append(selected)
    elif triggered == "btn-remove-node" and selected:
        group = [c for c in group if c != selected]
    elif triggered == "btn-clear-group":
        group = []

    return group


@app.callback(
    Output("group-display", "children"),
    Output("clipboard",     "content"),
    Input("store-group-codes", "data"),
    State("group-name-input",  "value"),
)
def render_group(group: list[str], group_name: str | None) -> tuple[object, str]:
    """Render the current feature group list and update clipboard content."""
    name    = (group_name or "my_group").strip() or "my_group"
    snippet = f"{name} = {json.dumps(sorted(group or []), ensure_ascii=False)}"

    if not group:
        return "No codes selected.", snippet

    items = [
        html.Div(
            code,
            style={
                "padding":       "2px 6px",
                "background":    "#2a2a2a",
                "border-radius": "3px",
                "margin":        "2px 0",
                "font-family":   "monospace",
                "font-size":     "12px",
            },
        )
        for code in sorted(group)
    ]
    header = html.Div(
        f"{len(group)} code(s):", style={"margin-bottom": "4px", "color": "#aaa"}
    )
    return [header] + items, snippet


@app.callback(
    Output("copy-feedback", "children"),
    Input("btn-copy", "n_clicks"),
    prevent_initial_call=True,
)
def copy_feedback(_: int) -> str:
    """Show a brief confirmation message when the copy button is clicked."""
    return "Copied to clipboard!"


@app.callback(
    Output("clipboard", "n_clicks"),
    Input("btn-copy",   "n_clicks"),
    prevent_initial_call=True,
)
def trigger_copy(n: int) -> int:
    """Forward copy-button clicks to the hidden dcc.Clipboard component."""
    return n


# ── Run ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=8050)
