"""
layout.py — Dash UI layout for the catalogue explorer.

Defines the full page structure: search bar, controls toolbar,
cytoscape graph panel, side panel, and tabs for different views.
"""

from dash import dcc, html
import dash_cytoscape as cyto

from data import YEARS, MIN_YEAR, MAX_YEAR

# ── Cytoscape stylesheet ───────────────────────────────────────────────────────

CYTO_STYLESHEET: list[dict] = [
    # Default node
    {
        "selector": "node",
        "style": {
            "content":             "data(label)",
            "background-color":    "data(colour)",
            "color":               "#fff",
            "text-valign":         "center",
            "text-halign":         "center",
            "font-size":           "10px",
            "text-wrap":           "wrap",
            "text-max-width":      "80px",
            "width":               "60px",
            "height":              "60px",
            "border-width":        "2px",
            "border-color":        "#fff",
        },
    },
    # Chapter nodes are larger
    {
        "selector": "node.chapter",
        "style": {
            "width":  "90px",
            "height": "90px",
            "font-size": "11px",
        },
    },
    # Selected node
    {
        "selector": "node:selected",
        "style": {
            "border-width": "4px",
            "border-color": "#fff",
            "background-color": "#9b59b6",
        },
    },
    # Expanded (user-clicked to drill down) nodes
    {
        "selector": "node.expanded",
        "style": {
            "border-width": "3px",
            "border-color": "#4a90d9",
            "border-style": "solid",
        },
    },
    # Nodes in the feature group
    {
        "selector": "node.in-group",
        "style": {
            "border-width": "4px",
            "border-color": "#e74c3c",
            "border-style": "dashed",
        },
    },
    # Search match highlight
    {
        "selector": "node.match",
        "style": {
            "border-width":  "4px",
            "border-color":  "#f1c40f",
            "border-style":  "solid",
        },
    },
    # Ancestor of search result (dimmed)
    {
        "selector": "node.ancestor",
        "style": {
            "opacity": "0.6",
        },
    },
    # Edges
    {
        "selector": "edge",
        "style": {
            "curve-style":    "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#aaa",
            "line-color":     "#aaa",
            "width":          "1.5px",
        },
    },
]


# ── Helper components ──────────────────────────────────────────────────────────

def _toolbar() -> html.Div:
    """Top control bar: search, catalogue toggle, year slider.

    Always present in the DOM.
    """
    return html.Div(
        id="browse-controls",
        className="toolbar",
        children=[
            # Search input
            dcc.Input(
                id="search-input",
                type="text",
                placeholder="Include: term1, term2, …",
                debounce=True,
                style={"width": "220px", "padding": "6px 10px", "border-radius": "4px",
                       "border": "1px solid #555", "background": "#2a2a2a", "color": "#eee"},
            ),
            # Exclude input
            dcc.Input(
                id="exclude-input",
                type="text",
                placeholder="Exclude: term1, term2, …",
                debounce=True,
                style={"width": "160px", "padding": "6px 10px", "border-radius": "4px",
                       "border": "1px solid #c0392b", "background": "#2a2a2a", "color": "#eee"},
            ),
            # Search mode toggle
            dcc.RadioItems(
                id="search-mode",
                options=[
                    {"label": "Label", "value": "label"},
                    {"label": "Code prefix", "value": "code"},
                ],
                value="label",
                inline=True,
                style={"color": "#ccc", "margin-left": "10px"},
            ),
            html.Div(style={"flex": "1"}),  # spacer
            # Catalogue type toggle
            dcc.RadioItems(
                id="catalogue-toggle",
                options=[
                    {"label": "ICD-10-GM", "value": "ICD"},
                    {"label": "OPS", "value": "OPS"},
                ],
                value="ICD",
                inline=True,
                style={"color": "#ccc"},
            ),
            html.Div(style={"width": "20px"}),  # spacer
            # Year slider
            html.Div(
                children=[
                    html.Label("Year:", style={"color": "#aaa", "margin-right": "8px"}),
                    dcc.Slider(
                        id="year-slider",
                        min=MIN_YEAR,
                        max=MAX_YEAR,
                        step=1,
                        value=MAX_YEAR,
                        marks={y: str(y) for y in YEARS[::2]},
                        tooltip={"placement": "bottom", "always_visible": False},
                        updatemode="mouseup",
                    ),
                ],
                style={"display": "flex", "align-items": "center", "width": "400px"},
            ),
        ],
        style={
            "display":         "flex",
            "align-items":     "center",
            "gap":             "12px",
            "padding":         "10px 16px",
            "background":      "#1e1e1e",
            "border-bottom":   "1px solid #333",
        },
    )


def _graph_panel() -> html.Div:
    """Cytoscape graph panel (centre)."""
    return html.Div(
        style={"flex": "1", "position": "relative"},
        children=[
            cyto.Cytoscape(
                id="cyto-graph",
                layout={"name": "breadthfirst", "directed": True, "spacingFactor": 1.5},
                style={"width": "100%", "height": "100%"},
                elements=[],
                stylesheet=CYTO_STYLESHEET,
                minZoom=0.2,
                maxZoom=3.0,
                responsive=True,
            ),
            # Floating legend
            html.Div(
                id="graph-legend",
                style={
                    "position": "absolute",
                    "bottom": "12px",
                    "left": "12px",
                    "background": "rgba(30,30,30,0.85)",
                    "padding": "8px 12px",
                    "border-radius": "6px",
                    "font-size": "11px",
                    "color": "#ccc",
                },
                children=[
                    html.Div("Node types:", style={"font-weight": "bold", "margin-bottom": "4px"}),
                    html.Div([html.Span("■ ", style={"color": "#4a90d9"}), "Chapter"]),
                    html.Div([html.Span("■ ", style={"color": "#7cb87e"}), "Block"]),
                    html.Div([html.Span("■ ", style={"color": "#e8a84a"}), "Category"]),
                    html.Hr(style={"border-color": "#444", "margin": "6px 0"}),
                    html.Div([html.Span("◈ ", style={"color": "#f1c40f"}), "Search match (highlighted)"]),
                ],
            ),
        ],
    )


def _side_panel() -> html.Div:
    """Right side panel: node details and feature builder."""
    return html.Div(
        style={
            "width":        "300px",
            "background":   "#1a1a1a",
            "border-left":  "1px solid #333",
            "padding":      "16px",
            "overflow-y":   "auto",
            "display":      "flex",
            "flex-direction": "column",
            "gap":          "16px",
        },
        children=[
            # Node details section
            html.Div([
                html.H4("Node details", style={"color": "#aaa", "margin": "0 0 10px 0", "font-size": "13px", "text-transform": "uppercase", "letter-spacing": "1px"}),
                html.Div(id="node-details", style={"color": "#ddd", "font-size": "13px"}),
            ]),
            html.Hr(style={"border-color": "#333", "margin": "0"}),
            # Feature builder section
            html.Div([
                html.H4("Feature builder", style={"color": "#aaa", "margin": "0 0 10px 0", "font-size": "13px", "text-transform": "uppercase", "letter-spacing": "1px"}),
                html.Div(
                    style={"display": "flex", "gap": "8px", "margin-bottom": "8px"},
                    children=[
                        dcc.Input(
                            id="group-name-input",
                            type="text",
                            placeholder="Group name…",
                            value="my_group",
                            style={"flex": "1", "padding": "5px 8px", "background": "#2a2a2a",
                                   "border": "1px solid #555", "border-radius": "4px", "color": "#eee", "font-size": "12px"},
                        ),
                    ],
                ),
                html.Div(
                    style={"display": "flex", "gap": "6px", "flex-wrap": "wrap"},
                    children=[
                        html.Button("Add selected", id="btn-add-node", n_clicks=0,
                                    style={"padding": "5px 10px", "background": "#2ecc71", "border": "none",
                                           "border-radius": "4px", "color": "#fff", "cursor": "pointer", "font-size": "12px"}),
                        html.Button("Remove selected", id="btn-remove-node", n_clicks=0,
                                    style={"padding": "5px 10px", "background": "#e74c3c", "border": "none",
                                           "border-radius": "4px", "color": "#fff", "cursor": "pointer", "font-size": "12px"}),
                        html.Button("Clear all", id="btn-clear-group", n_clicks=0,
                                    style={"padding": "5px 10px", "background": "#555", "border": "none",
                                           "border-radius": "4px", "color": "#fff", "cursor": "pointer", "font-size": "12px"}),
                    ],
                ),
                html.Div(id="group-display", style={"margin-top": "10px", "color": "#ccc", "font-size": "12px"}),
                html.Button(
                    "Copy as Python list",
                    id="btn-copy",
                    n_clicks=0,
                    style={
                        "margin-top": "8px",
                        "padding": "7px 12px",
                        "background": "#3498db",
                        "border": "none",
                        "border-radius": "4px",
                        "color": "#fff",
                        "cursor": "pointer",
                        "font-size": "12px",
                        "width": "100%",
                    },
                ),
                dcc.Clipboard(
                    id="clipboard",
                    style={"display": "none"},
                ),
                html.Div(id="copy-feedback", style={"color": "#2ecc71", "font-size": "11px", "margin-top": "4px"}),
            ]),
        ],
    )



# ── Root layout ────────────────────────────────────────────────────────────────

def build_layout() -> html.Div:
    """Construct and return the full application layout."""
    return html.Div(
        style={"height": "100vh", "display": "flex", "flex-direction": "column",
               "background": "#121212", "font-family": "Inter, Segoe UI, Arial, sans-serif"},
        children=[
            # Header
            html.Div(
                style={"padding": "10px 16px", "background": "#0d0d0d", "border-bottom": "1px solid #333",
                       "display": "flex", "align-items": "center", "gap": "12px"},
                children=[
                    html.H2("ICD-10-GM / OPS Catalogue Explorer",
                            style={"margin": "0", "color": "#eee", "font-size": "18px", "font-weight": "600"}),
                    html.Span("Interactive code hierarchy viewer",
                              style={"color": "#666", "font-size": "13px"}),
                ],
            ),
            # Toolbar
            _toolbar(),
            # Main body: graph + side panel
            html.Div(
                style={"flex": "1", "display": "flex", "overflow": "hidden"},
                children=[
                    _graph_panel(),
                    _side_panel(),
                ],
            ),
            # Hidden stores
            dcc.Store(id="store-group-codes",    data=[]),    # list of codes in current feature group
            dcc.Store(id="store-selected-node",  data=None), # currently clicked node id
            dcc.Store(id="store-expanded-nodes", data=[]),   # nodes the user has clicked to expand
        ],
    )
