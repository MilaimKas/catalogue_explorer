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
  buildYearSpan,
  buildElements,
  buildSearchElements,
  MIN_YEAR,
  MAX_YEAR,
} from "./data.js";

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

// ── Main component ─────────────────────────────────────────────────────────────

export default function App() {
  // ── Data ──────────────────────────────────────────────────────────────────
  const [records,  setRecords]  = useState(null);
  const [yearSpan, setYearSpan] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [loadErr,  setLoadErr]  = useState(null);

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

  // ── Load catalogue on mount ───────────────────────────────────────────────
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
  }, []);

  // ── Debounce search inputs ────────────────────────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(searchInput);
      setExpandedNodes(new Set()); // reset expansion on new search
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
    if (!records || !cy) return;

    const includeTerms = query.split(",").map(t => t.trim()).filter(Boolean);
    let elements = includeTerms.length > 0
      ? buildSearchElements(records, year, catalogue, query, searchMode, exclude || null)
      : buildElements(records, year, catalogue, null, 1, expandedNodes);

    const layout = includeTerms.length > 0
      ? { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 }
      : { name: "breadthfirst", directed: true, spacingFactor: 1.5, animate: false };

    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    cy.layout(layout).run();
  }, [records, year, catalogue, query, exclude, searchMode, expandedNodes]);

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

    const span    = yearSpan.get(selectedNode);
    const spanStr = span
      ? (span.firstYear !== span.lastYear
          ? `${span.firstYear}–${span.lastYear}`
          : String(span.firstYear))
      : "—";

    const cyNode  = cyInstance.current?.getElementById(selectedNode);
    const kind    = cyNode?.data("kind")       ?? "—";
    const isLeaf  = cyNode?.data("is_leaf")    ?? false;
    const label   = cyNode?.data("full_label") ?? "—";

    const inSearchMode = query.trim().length > 0;
    const isExpanded   = expandedNodes.has(selectedNode);

    return (
      <>
        <Field label="Code"        value={selectedNode} />
        <Field label="Catalogue"   value={span?.catalogue ?? "—"} />
        <Field label="Kind"        value={kind} />
        <Field label="Leaf"        value={isLeaf ? "Yes" : "No"} />
        <Field label="Valid years" value={spanStr} />
        <div style={{ marginTop: 6 }}>
          <span style={{ color: "#888", fontSize: 11 }}>Label: </span>
          <span style={{ color: "#eee", fontStyle: "italic", fontSize: 12 }}>{label}</span>
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
  }, [selectedNode, yearSpan, query, expandedNodes, toggleExpand]);

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

          {/* Floating legend */}
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
