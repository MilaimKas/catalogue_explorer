/**
 * App.jsx — ICD-10-GM / OPS Catalogue Explorer (React + Cytoscape.js)
 *
 * Mirrors the Dash app in dash_app/. All state is managed with React hooks;
 * Cytoscape.js is initialised imperatively via a ref so we avoid re-mounting
 * the heavy canvas on every render.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Cytoscape from "cytoscape";
import {
  loadCatalogue,
  loadTransitions,
  buildYearSpan,
  buildElements,
  buildSearchElements,
  MIN_YEAR,
  MAX_YEAR,
} from "./data.js";
import {
  buildTransitionIndex,
  computeLifespan,
  headlineTag,
  computeNeighbourhood,
} from "./transitions.js";

// ── Cytoscape stylesheet (mirrors dash_app/layout.py CYTO_STYLESHEET) ─────────

const CYTO_STYLESHEET = [
  {
    selector: "node",
    style: {
      content:            "data(label)",
      "background-color": "data(colour)",
      color:              "#fff",
      "text-valign":      "center",
      "text-halign":      "center",
      "font-size":        "10px",
      "text-wrap":        "wrap",
      "text-max-width":   "80px",
      width:              "60px",
      height:             "60px",
      "border-width":     "2px",
      "border-color":     "#fff",
    },
  },
  {
    selector: "node.chapter",
    style: { width: "90px", height: "90px", "font-size": "11px" },
  },
  {
    selector: "node:selected",
    style: { "border-width": "4px", "border-color": "#fff", "background-color": "#9b59b6" },
  },
  {
    selector: "node.expanded",
    style: { "border-width": "3px", "border-color": "#4a90d9", "border-style": "solid" },
  },
  {
    selector: "node.in-group",
    style: { "border-width": "4px", "border-color": "#e74c3c", "border-style": "dashed" },
  },
  {
    selector: "node.match",
    style: { "border-width": "4px", "border-color": "#f1c40f", "border-style": "solid" },
  },
  {
    selector: "node.ancestor",
    style: { opacity: "0.6" },
  },
  {
    selector: "edge",
    style: {
      "curve-style":        "bezier",
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#aaa",
      "line-color":         "#aaa",
      width:                "1.5px",
    },
  },
];

// ── Reusable UI primitives ─────────────────────────────────────────────────────

/** A labelled field row for the node details panel. */
function Field({ label, value }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span style={{ color: "#888", fontSize: 11 }}>{label}: </span>
      <span style={{ color: "#eee" }}>{value}</span>
    </div>
  );
}

/**
 * Horizontal year-by-year status strip.
 *
 * One cell per year in [firstYear..lastYear]. Cell colour encodes status:
 *   stable    → dark green       (code exists, all edges auto)
 *   ambiguous → yellow           (semantic shift / split / merge)
 *   absent    → light gray       (code not present this year)
 *
 * `bornYear` gets an orange bottom border; `diedYear` a red bottom border.
 * `currentYear` (the year currently viewed) gets a white outline.
 */
function LifespanStrip({ statusByYear, bornYear, diedYear, currentYear, firstYear, lastYear }) {
  const cellColours = { stable: "#2a6b32", ambiguous: "#d4a017", absent: "#3a3a3a" };
  const years       = [];
  for (let y = firstYear; y <= lastYear; y++) years.push(y);

  return (
    <div style={{ display: "flex", gap: 2, marginTop: 4, marginBottom: 2 }}>
      {years.map(y => {
        const status = statusByYear[y] ?? "absent";
        const isBorn = y === bornYear;
        const isDied = y === diedYear;
        const isCurrent = y === currentYear;
        return (
          <div
            key={y}
            title={`${y}: ${status}${isBorn ? " (born)" : ""}${isDied ? " (ended)" : ""}`}
            style={{
              flex: 1, height: 18,
              background: cellColours[status],
              borderBottom:
                isBorn ? "3px solid #e67e22" :
                isDied ? "3px solid #c0392b" : "none",
              outline: isCurrent ? "2px solid #fff" : "none",
              outlineOffset: isCurrent ? -2 : 0,
              borderRadius: 2,
            }}
          />
        );
      })}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function App() {
  // ── Data ──────────────────────────────────────────────────────────────────
  const [records,    setRecords]    = useState(null);
  const [yearSpan,   setYearSpan]   = useState(null);
  const [transIndex, setTransIndex] = useState(null);   // built from transitions.json.gz
  const [loading,    setLoading]    = useState(true);
  const [loadErr,    setLoadErr]    = useState(null);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [year,         setYear]         = useState(MAX_YEAR);
  const [catalogue,    setCatalogue]    = useState("ICD");
  const [searchInput,  setSearchInput]  = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [searchMode,   setSearchMode]   = useState("label");

  // Debounced versions applied 400 ms after last keystroke
  const [query,   setQuery]   = useState("");
  const [exclude, setExclude] = useState("");

  // ── Graph state ───────────────────────────────────────────────────────────
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [selectedNode,  setSelectedNode]  = useState(null);
  const [groupCodes,    setGroupCodes]    = useState([]);
  const [groupName,     setGroupName]     = useState("my_group");
  const [copyFeedback,  setCopyFeedback]  = useState("");

  // Welcome screen: hidden once the user clicks "Explore" or starts searching
  const [exploring, setExploring] = useState(false);

  // Side panel: legend for the Lifespan section (collapsed by default)
  const [showLifespanHelp, setShowLifespanHelp] = useState(false);

  // ── Cytoscape ref (imperatively managed to avoid canvas remounting) ───────
  // cyRef is a callback ref: Cytoscape is created as soon as the DOM node exists.
  const cyInstance = useRef(null);
  const cyRef = useCallback((node) => {
    if (!node) {
      cyInstance.current?.destroy();
      cyInstance.current = null;
      return;
    }
    if (cyInstance.current) return; // already initialised

    cyInstance.current = Cytoscape({
      container: node,
      elements:  [],
      style:     CYTO_STYLESHEET,
      layout:    { name: "breadthfirst", directed: true, spacingFactor: 1.5 },
      minZoom:   0.2,
      maxZoom:   3.0,
    });

    // Node tap → update selected node only; expansion is triggered via the side panel button
    cyInstance.current.on("tap", "node", evt => {
      setSelectedNode(evt.target.data().id);
    });
  }, []); // stable: no deps, created once

  // ── Load catalogue + transitions on mount ─────────────────────────────────
  // Catalogue is required to render the graph; transitions are only needed for
  // the side panel. We kick off both in parallel but only block the initial
  // render on the catalogue. Transitions populate the panel when ready.
  useEffect(() => {
    loadCatalogue()
      .then(recs => {
        setRecords(recs);
        setYearSpan(buildYearSpan(recs));
        setLoading(false);
      })
      .catch(err => {
        setLoadErr(err.message);
        setLoading(false);
      });

    loadTransitions()
      .then(rows => setTransIndex(buildTransitionIndex(rows)))
      .catch(err => console.warn("Transitions unavailable:", err.message));
  }, []);

  // ── Debounce search inputs ────────────────────────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(searchInput);
      setExpandedNodes(new Set()); // reset expansion on new search
      if (searchInput.trim()) setExploring(true); // a query dismisses the welcome
    }, 400);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    const id = setTimeout(() => setExclude(excludeInput), 400);
    return () => clearTimeout(id);
  }, [excludeInput]);

  // Reset expansion when year or catalogue changes
  useEffect(() => { setExpandedNodes(new Set()); }, [year, catalogue]);

  // ── Rebuild graph elements whenever relevant state changes ────────────────
  useEffect(() => {
    const cy = cyInstance.current;
    if (!records || !cy || !exploring) return;

    const includeTerms = query.split(",").map(t => t.trim()).filter(Boolean);
    let elements = includeTerms.length > 0
      ? buildSearchElements(records, year, catalogue, query, searchMode, exclude || null)
      : buildElements(records, year, catalogue, null, expandedNodes);

    const layout = includeTerms.length > 0
      ? { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 }
      : { name: "breadthfirst", directed: true, spacingFactor: 1.5, animate: false };

    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    cy.layout(layout).run();
  }, [records, year, catalogue, query, exclude, searchMode, expandedNodes, exploring]);

  // ── Sync in-group class directly on Cytoscape nodes (no graph rebuild) ────
  // Kept in a separate effect so that feature group changes never retrigger
  // the layout — especially important in search mode where the graph is static.
  useEffect(() => {
    const cy = cyInstance.current;
    if (!cy) return;
    const groupSet = new Set(groupCodes);
    cy.nodes().forEach(node => {
      if (groupSet.has(node.id())) node.addClass("in-group");
      else node.removeClass("in-group");
    });
  }, [groupCodes]);

  // ── Feature builder handlers ──────────────────────────────────────────────
  const addToGroup = useCallback(() => {
    if (selectedNode && !groupCodes.includes(selectedNode))
      setGroupCodes(prev => [...prev, selectedNode]);
  }, [selectedNode, groupCodes]);

  const removeFromGroup = useCallback(() => {
    setGroupCodes(prev => prev.filter(c => c !== selectedNode));
  }, [selectedNode]);

  const clearGroup = useCallback(() => setGroupCodes([]), []);

  const copySnippet = useCallback(() => {
    const name    = (groupName || "my_group").trim() || "my_group";
    const snippet = `${name} = ${JSON.stringify([...groupCodes].sort())}`;
    navigator.clipboard.writeText(snippet).then(() => {
      setCopyFeedback("Copied to clipboard!");
      setTimeout(() => setCopyFeedback(""), 2000);
    });
  }, [groupName, groupCodes]);

  // ── Expand / collapse handler (browse mode only) ─────────────────────────
  const toggleExpand = useCallback(() => {
    if (!selectedNode) return;
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(selectedNode)) next.delete(selectedNode);
      else next.add(selectedNode);
      return next;
    });
  }, [selectedNode]);

  // ── Node details panel content ────────────────────────────────────────────
  const nodeDetails = useCallback(() => {
    if (!selectedNode || !yearSpan) return <span>Click a node to see details.</span>;

    const span   = yearSpan.get(selectedNode);
    const cyNode = cyInstance.current?.getElementById(selectedNode);
    const kind   = cyNode?.data("kind")       ?? "—";
    const isLeaf = cyNode?.data("is_leaf")    ?? false;
    const label  = cyNode?.data("full_label") ?? "—";

    const inSearchMode = query.trim().length > 0;
    const isExpanded   = expandedNodes.has(selectedNode);
    const cat          = span?.catalogue;

    // Compute transition info (undefined if index not yet loaded)
    let tag = null, lifespan = null, nbhd = null;
    if (transIndex && cat) {
      lifespan = computeLifespan(transIndex, cat, selectedNode);
      tag      = headlineTag(lifespan);
      nbhd     = computeNeighbourhood(transIndex, cat, selectedNode, year);
    }

    return (
      <>
        <Field label="Code"      value={selectedNode} />
        <Field label="Catalogue" value={cat ?? "—"} />
        <Field label="Kind"      value={kind} />
        <Field label="Leaf"      value={isLeaf ? "Yes" : "No"} />
        <div style={{ marginTop: 6 }}>
          <span style={{ color: "#888", fontSize: 11 }}>Label: </span>
          <span style={{ color: "#eee", fontStyle: "italic", fontSize: 12 }}>{label}</span>
        </div>

        {/* ── Transition info ── */}
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid #2a2a2a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ color: "#888", fontSize: 11 }}>Lifespan</span>
            <button
              onClick={() => setShowLifespanHelp(s => !s)}
              title={showLifespanHelp ? "Hide legend" : "What does this mean?"}
              style={{
                width: 16, height: 16, lineHeight: "14px", textAlign: "center",
                padding: 0, borderRadius: "50%",
                border: "1px solid #555", background: showLifespanHelp ? "#444" : "transparent",
                color: "#aaa", fontSize: 10, cursor: "pointer",
              }}
            >
              ?
            </button>
          </div>

          {showLifespanHelp && (
            <div style={{
              marginBottom: 10, padding: "8px 10px",
              background: "#0f0f0f", border: "1px solid #2a2a2a",
              borderRadius: 4, fontSize: 11, color: "#bbb", lineHeight: 1.5,
            }}>
              <div style={{ marginBottom: 6 }}>
                Derived from the BfArM <i>Umsteiger</i> year-to-year mapping tables.
              </div>

              <div style={{ marginBottom: 4, color: "#ddd", fontWeight: 600 }}>Headline</div>
              <div style={{ marginBottom: 8 }}>
                One-line summary: stable range, introduction year, deprecation year, or
                years where the mapping was non-automatic (split / merge / semantic shift).
              </div>

              <div style={{ marginBottom: 4, color: "#ddd", fontWeight: 600 }}>Strip</div>
              <div style={{ marginBottom: 4 }}>One cell per year:</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <span><span style={{ display: "inline-block", width: 12, height: 10, background: "#2a6b32", verticalAlign: "middle", marginRight: 4 }} />stable</span>
                <span><span style={{ display: "inline-block", width: 12, height: 10, background: "#d4a017", verticalAlign: "middle", marginRight: 4 }} />non-auto</span>
                <span><span style={{ display: "inline-block", width: 12, height: 10, background: "#3a3a3a", verticalAlign: "middle", marginRight: 4 }} />absent</span>
              </div>
              <div style={{ marginBottom: 2 }}>
                <span style={{ display: "inline-block", width: 12, height: 10, borderBottom: "3px solid #e67e22", verticalAlign: "middle", marginRight: 4 }} />
                born (first appearance)
              </div>
              <div style={{ marginBottom: 2 }}>
                <span style={{ display: "inline-block", width: 12, height: 10, borderBottom: "3px solid #c0392b", verticalAlign: "middle", marginRight: 4 }} />
                ended (last appearance)
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ display: "inline-block", width: 12, height: 10, outline: "2px solid #fff", outlineOffset: -2, verticalAlign: "middle", marginRight: 6 }} />
                current year viewed
              </div>

              <div style={{ marginBottom: 4, color: "#ddd", fontWeight: 600 }}>Neighbourhood</div>
              <div>
                Single-step mapping at the viewed year: which code(s) this code
                comes from (← previous year) and maps to (→ next year).
                <span style={{ color: "#2ecc71" }}> ✓ auto</span> means unambiguous;
                <span style={{ color: "#e67e22" }}> ✗ ambiguous</span> means the mapping involves a split, merge, or semantic shift.
              </div>
            </div>
          )}

          {!transIndex && (
            <div style={{ color: "#666", fontSize: 11, fontStyle: "italic" }}>
              Loading transitions…
            </div>
          )}

          {transIndex && lifespan && lifespan.yearsPresent.length === 0 && (
            <div style={{ color: "#666", fontSize: 11, fontStyle: "italic" }}>
              No transition data for this code.
            </div>
          )}

          {transIndex && lifespan && lifespan.yearsPresent.length > 0 && (
            <>
              {/* 1. Headline tag */}
              <div style={{ color: "#ddd", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {tag}
              </div>

              {/* 2. Lifespan strip */}
              <LifespanStrip
                statusByYear={lifespan.statusByYear}
                bornYear={lifespan.bornYear}
                diedYear={lifespan.diedYear}
                currentYear={year}
                firstYear={lifespan.yearsPresent[0]}
                lastYear={lifespan.yearsPresent[lifespan.yearsPresent.length - 1]}
              />

              {/* 3. Year-Y neighbourhood */}
              {nbhd && (
                <div style={{ marginTop: 10, fontSize: 11, fontFamily: "monospace", color: "#ccc" }}>
                  <div>
                    ← from {year - 1}: {nbhd.prev.length === 0 ? (
                      <span style={{ color: "#666" }}>—</span>
                    ) : nbhd.prev.length === 1 ? (
                      <>
                        <span style={{ color: "#eee" }}>{nbhd.prev[0].code}</span>
                        <span style={{ color: nbhd.prev[0].auto ? "#2ecc71" : "#e67e22", marginLeft: 6 }}>
                          {nbhd.prev[0].auto ? "✓ auto" : "✗ ambiguous"}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: "#e67e22" }}>{nbhd.prev.length} codes</span>
                    )}
                  </div>
                  <div>
                    → to   {year + 1}: {nbhd.next.length === 0 ? (
                      <span style={{ color: "#666" }}>—</span>
                    ) : nbhd.next.length === 1 ? (
                      <>
                        <span style={{ color: "#eee" }}>{nbhd.next[0].code}</span>
                        <span style={{ color: nbhd.next[0].auto ? "#2ecc71" : "#e67e22", marginLeft: 6 }}>
                          {nbhd.next[0].auto ? "✓ auto" : "✗ ambiguous"}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: "#e67e22" }}>{nbhd.next.length} codes</span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {!inSearchMode && !isLeaf && (
          <button
            onClick={toggleExpand}
            style={{
              marginTop: 12, width: "100%", padding: "6px 0",
              background: isExpanded ? "#555" : "#4a90d9",
              border: "none", borderRadius: 4,
              color: "#fff", cursor: "pointer", fontSize: 12,
            }}
          >
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        )}
      </>
    );
  }, [selectedNode, yearSpan, query, expandedNodes, toggleExpand, transIndex, year, showLifespanHelp]);

  // ── Shared style helpers ──────────────────────────────────────────────────
  const btnStyle = (bg) => ({
    padding: "5px 10px", background: bg, border: "none",
    borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: 12,
  });

  const inputStyle = (extra = {}) => ({
    padding: "6px 10px", borderRadius: 4,
    border: "1px solid #555", background: "#2a2a2a",
    color: "#eee", fontSize: 13, ...extra,
  });

  // ── Loading / error states ────────────────────────────────────────────────
  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
                  height: "100vh", background: "#121212", color: "#aaa", fontSize: 16 }}>
      Loading catalogue…
    </div>
  );

  if (loadErr) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
                  height: "100vh", background: "#121212", color: "#e74c3c", fontSize: 16 }}>
      Error: {loadErr}
    </div>
  );

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column",
                  background: "#121212", fontFamily: "Inter, Segoe UI, Arial, sans-serif" }}>

      {/* Header */}
      <div style={{ padding: "10px 16px", background: "#0d0d0d",
                    borderBottom: "1px solid #333", display: "flex",
                    alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0, color: "#eee", fontSize: 18, fontWeight: 600 }}>
          ICD-10-GM / OPS Catalogue Explorer
        </h2>
        <span style={{ color: "#666", fontSize: 13 }}>Interactive code hierarchy viewer</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setExploring(false)}
          title="Show the welcome screen"
          style={{
            padding: "5px 12px",
            background: "transparent",
            border: "1px solid #444",
            borderRadius: 4,
            color: "#aaa", cursor: "pointer", fontSize: 12,
          }}
        >
          Guide
        </button>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                    padding: "10px 16px", background: "#1e1e1e", borderBottom: "1px solid #333" }}>
        <input
          style={inputStyle({ width: 220 })}
          placeholder="Include: term1, term2, …"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { setQuery(e.target.value); setExpandedNodes(new Set()); } }}
        />
        <input
          style={inputStyle({ width: 180, borderColor: "#c0392b" })}
          placeholder="Exclude: term1, term2, …"
          value={excludeInput}
          onChange={e => setExcludeInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") setExclude(e.target.value); }}
        />
        <span style={{ color: "#ccc", fontSize: 13, display: "flex", gap: 10 }}>
          {["label", "code"].map(mode => (
            <label key={mode} style={{ cursor: "pointer" }}>
              <input type="radio" name="searchMode" value={mode}
                     checked={searchMode === mode}
                     onChange={() => setSearchMode(mode)}
                     style={{ marginRight: 4 }} />
              {mode === "label" ? "Label" : "Code prefix"}
            </label>
          ))}
        </span>

        <div style={{ flex: 1 }} />

        <span style={{ color: "#ccc", fontSize: 13, display: "flex", gap: 10 }}>
          {["ICD", "OPS"].map(cat => (
            <label key={cat} style={{ cursor: "pointer" }}>
              <input type="radio" name="catalogue" value={cat}
                     checked={catalogue === cat}
                     onChange={() => setCatalogue(cat)}
                     style={{ marginRight: 4 }} />
              {cat === "ICD" ? "ICD-10-GM" : "OPS"}
            </label>
          ))}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8, width: 380 }}>
          <label style={{ color: "#aaa", whiteSpace: "nowrap" }}>Year: {year}</label>
          <input
            type="range"
            min={MIN_YEAR} max={MAX_YEAR} step={1} value={year}
            onChange={e => setYear(Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {/* Main body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Graph panel */}
        <div style={{ flex: 1, position: "relative" }}>
          <div ref={cyRef} style={{ width: "100%", height: "100%" }} />

          {/* Welcome overlay: shown until the user clicks Explore or enters a query */}
          {!exploring && (
            <div style={{
              position: "absolute", inset: 0,
              background: "radial-gradient(ellipse at center, #1a1a1a 0%, #0e0e0e 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 32, overflowY: "auto",
            }}>
              <div style={{
                maxWidth: 600, width: "100%",
                background: "#181818",
                border: "1px solid #2a2a2a",
                borderRadius: 10,
                padding: "32px 36px",
                boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
                color: "#ddd", lineHeight: 1.65, fontSize: 14,
              }}>
                {/* Accent bar + heading */}
                <div style={{
                  width: 48, height: 3, background: "#4a90d9",
                  borderRadius: 2, marginBottom: 16,
                }} />
                <h2 style={{
                  color: "#f0f0f0", margin: "0 0 8px 0",
                  fontSize: 22, fontWeight: 600, letterSpacing: "-0.3px",
                }}>
                  Welcome
                </h2>
                <p style={{ margin: "0 0 20px 0", color: "#aaa", fontSize: 13 }}>
                  Interactive explorer for German clinical code hierarchies.
                </p>

                <p style={{ margin: "0 0 18px 0" }}>
                  This tool visualises the German <b>ICD-10-GM</b> (diagnoses) and
                  <b> OPS</b> (procedures) code hierarchies as interactive networks,
                  with year-to-year transition information from the BfArM{" "}
                  <i>Umsteiger</i> tables.
                </p>

                <div style={{ borderTop: "1px solid #2a2a2a", margin: "20px 0" }} />

                <div style={{ color: "#aaa", fontSize: 12, textTransform: "uppercase",
                               letterSpacing: 1, marginBottom: 10 }}>
                  How to use it
                </div>
                <ul style={{ margin: "0 0 24px 0", paddingLeft: 20, color: "#ccc" }}>
                  <li style={{ marginBottom: 6 }}>
                    Pick a <b>catalogue</b> and a <b>year</b> in the toolbar.
                  </li>
                  <li style={{ marginBottom: 6 }}>
                    <b>Browse</b> by clicking a node, then <b>Expand</b> it from the
                    side panel to drill down.
                  </li>
                  <li style={{ marginBottom: 6 }}>
                    <b>Search</b> by label or code prefix — comma-separated terms (OR);
                    the <i>Exclude</i> field filters matches out.
                  </li>
                  <li>
                    Build a <b>feature group</b> from selected codes and copy it as a
                    Python list.
                  </li>
                </ul>

                <button
                  onClick={() => setExploring(true)}
                  style={{
                    padding: "11px 24px",
                    background: "linear-gradient(180deg, #5aa0e0 0%, #4a90d9 100%)",
                    border: "none", borderRadius: 6,
                    color: "#fff", cursor: "pointer",
                    fontSize: 14, fontWeight: 500,
                    boxShadow: "0 2px 8px rgba(74,144,217,0.3)",
                  }}
                >
                  Explore {catalogue === "ICD" ? "ICD-10-GM" : "OPS"} ({year}) →
                </button>
                <p style={{ margin: "14px 0 0 0", fontSize: 12, color: "#666" }}>
                  Tip: typing in the search field also opens the graph.
                </p>
              </div>
            </div>
          )}

          {/* Floating legend (hidden until the graph is shown) */}
          {exploring && (
            <div style={{ position: "absolute", bottom: 12, left: 12,
                          background: "rgba(30,30,30,0.85)", padding: "8px 12px",
                          borderRadius: 6, fontSize: 11, color: "#ccc" }}>
              <div style={{ fontWeight: "bold", marginBottom: 4 }}>Node types:</div>
              <div><span style={{ color: "#4a90d9" }}>■ </span>Chapter</div>
              <div><span style={{ color: "#7cb87e" }}>■ </span>Block</div>
              <div><span style={{ color: "#e8a84a" }}>■ </span>Category</div>
              <hr style={{ borderColor: "#444", margin: "6px 0" }} />
              <div><span style={{ color: "#f1c40f" }}>◈ </span>Search match</div>
            </div>
          )}
        </div>

        {/* Side panel */}
        <div style={{ width: 300, background: "#1a1a1a", borderLeft: "1px solid #333",
                      padding: 16, overflowY: "auto", display: "flex",
                      flexDirection: "column", gap: 16 }}>

          {/* Node details */}
          <div>
            <h4 style={{ color: "#aaa", margin: "0 0 10px 0", fontSize: 13,
                         textTransform: "uppercase", letterSpacing: 1 }}>Node details</h4>
            <div style={{ color: "#ddd", fontSize: 13 }}>{nodeDetails()}</div>
          </div>

          <hr style={{ borderColor: "#333", margin: 0 }} />

          {/* Feature builder */}
          <div>
            <h4 style={{ color: "#aaa", margin: "0 0 10px 0", fontSize: 13,
                         textTransform: "uppercase", letterSpacing: 1 }}>Feature builder</h4>

            <input
              style={inputStyle({ width: "100%", marginBottom: 8, boxSizing: "border-box" })}
              placeholder="Group name…"
              value={groupName}
              onChange={e => setGroupName(e.target.value)}
            />

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button style={btnStyle("#2ecc71")} onClick={addToGroup}>Add selected</button>
              <button style={btnStyle("#e74c3c")} onClick={removeFromGroup}>Remove selected</button>
              <button style={btnStyle("#555")}    onClick={clearGroup}>Clear all</button>
            </div>

            <div style={{ marginTop: 10, color: "#ccc", fontSize: 12 }}>
              {groupCodes.length === 0
                ? "No codes selected."
                : (
                  <>
                    <div style={{ marginBottom: 4, color: "#aaa" }}>{groupCodes.length} code(s):</div>
                    {[...groupCodes].sort().map(code => (
                      <div key={code} style={{ padding: "2px 6px", background: "#2a2a2a",
                                               borderRadius: 3, margin: "2px 0",
                                               fontFamily: "monospace", fontSize: 12 }}>
                        {code}
                      </div>
                    ))}
                  </>
                )
              }
            </div>

            <button style={{ ...btnStyle("#3498db"), marginTop: 8, width: "100%" }}
                    onClick={copySnippet}>
              Copy as Python list
            </button>
            {copyFeedback && (
              <div style={{ color: "#2ecc71", fontSize: 11, marginTop: 4 }}>{copyFeedback}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
