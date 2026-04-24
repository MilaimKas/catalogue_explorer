/**
 * data.js — Data loading and graph preparation for the catalogue explorer.
 *
 * Mirrors the logic in dash_app/data.py.
 * The catalogue is loaded once from /catalogue.json.gz (gzip-compressed JSON).
 *
 * Record shape (one per unique code × catalogue):
 *   { code, label, parent, kind, is_leaf, catalogue, years, label_by_year? }
 */

// ── Constants ──────────────────────────────────────────────────────────────────

export const MIN_YEAR = 2014;
export const MAX_YEAR = 2026;
export const YEARS = Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => MIN_YEAR + i);

/** Cytoscape colour per node kind */
export const KIND_COLOURS = {
  chapter:  "#4a90d9",
  block:    "#7cb87e",
  category: "#e8a84a",
};

// ── Catalogue loading ──────────────────────────────────────────────────────────

/**
 * Fetch and parse the catalogue.
 *
 * Reads the first two bytes to detect the gzip magic number (0x1f 0x8b).
 * - If present  → decompress manually via DecompressionStream (Vite dev server)
 * - If absent   → the browser already decoded it via Content-Encoding (Netlify prod)
 *
 * @returns {Promise<Array>}
 */
export async function loadCatalogue() {
  const response = await fetch("/catalogue.json.gz");
  if (!response.ok) throw new Error(`Failed to load catalogue: ${response.status}`);

  const buffer = await response.arrayBuffer();
  const bytes  = new Uint8Array(buffer);

  // Gzip magic number: 0x1f 0x8b
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (!isGzip) {
    // Already decompressed by the browser (Content-Encoding: gzip on Netlify)
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // Manual decompression (Vite dev server serves raw bytes)
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(buffer);
  writer.close();

  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const total  = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let offset   = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }

  return JSON.parse(new TextDecoder().decode(merged));
}

// ── Year-span computation ──────────────────────────────────────────────────────

/**
 * From the flat record array, compute a Map<code → {firstYear, lastYear, catalogue}>.
 * Since each record already carries a `years` array, this is a trivial reduction.
 *
 * @param {Array} records
 * @returns {Map<string, {firstYear: number, lastYear: number, catalogue: string}>}
 */
export function buildYearSpan(records) {
  const map = new Map();
  for (const rec of records) {
    map.set(rec.code, {
      firstYear: rec.years[0],
      lastYear:  rec.years[rec.years.length - 1],
      catalogue: rec.catalogue,
    });
  }
  return map;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Build per-catalogue lookup structures from the flat record array.
 * Filtered to `year` and `catalogueType`.
 *
 * @param {Array}  records
 * @param {number} year
 * @param {string} catalogueType  "ICD" | "OPS"
 * @returns {{ childrenMap: Map, codeRow: Map }}
 */
function buildLookups(records, year, catalogueType) {
  /** @type {Map<string|null, string[]>} parent → [child codes] */
  const childrenMap = new Map();
  /** @type {Map<string, object>} code → record */
  const codeRow = new Map();

  for (const rec of records) {
    if (rec.catalogue !== catalogueType) continue;
    if (!rec.years.includes(year)) continue;

    // Resolve the label for this specific year (may differ from latest)
    const label = rec.label_by_year?.[String(year)] ?? rec.label;
    const row = { ...rec, label };

    codeRow.set(rec.code, row);
    const parentKey = rec.parent || null;
    if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
    childrenMap.get(parentKey).push(rec.code);
  }

  return { childrenMap, codeRow };
}

/**
 * Build a single cytoscape node element dict.
 *
 * @param {object} row         - catalogue record
 * @param {Set}    expandedSet - set of expanded node codes
 * @returns {object}
 */
function makeNode(row, expandedSet) {
  const { code, label, kind, is_leaf, parent } = row;
  const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
  const expanded  = expandedSet.has(code);
  return {
    data: {
      id:          code,
      label:       `${code}\n${truncated}`,
      full_label:  label,
      kind,
      is_leaf,
      parent_code: parent || null,
      colour:      KIND_COLOURS[kind] ?? "#aaa",
      expanded,
    },
    classes: kind + (expanded ? " expanded" : ""),
  };
}

// ── Graph element builders ─────────────────────────────────────────────────────

/**
 * Build cytoscape elements for the hierarchy browse view.
 *
 * Visibility rules:
 *   - Root nodes are always visible
 *   - A non-root node is visible iff its parent is in `expandedNodes`
 *
 * That is, "expanding" node X reveals X's direct children — nothing more.
 *
 * @param {Array}         records
 * @param {number}        year
 * @param {string}        catalogueType
 * @param {string[]|null} rootCodes      null = top-level chapters
 * @param {Set<string>}   expandedNodes
 * @returns {object[]}    cytoscape element list
 */
export function buildElements(
  records,
  year,
  catalogueType,
  rootCodes = null,
  expandedNodes = new Set(),
) {
  const { childrenMap, codeRow } = buildLookups(records, year, catalogueType);
  if (codeRow.size === 0) return [];

  const roots = rootCodes
    ? rootCodes.filter(c => codeRow.has(c))
    : (childrenMap.get(null) ?? []);

  // BFS from roots, descending only through expanded nodes
  const visited = new Set(roots);
  const queue   = [...roots];
  while (queue.length > 0) {
    const code = queue.shift();
    if (!expandedNodes.has(code)) continue;
    for (const child of childrenMap.get(code) ?? []) {
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }

  // Materialise nodes and the single parent edge per node (tree: one parent max)
  const elements = [];
  for (const code of visited) {
    const row = codeRow.get(code);
    if (!row) continue;
    elements.push(makeNode(row, expandedNodes));
    const parent = row.parent || null;
    if (parent && visited.has(parent)) {
      elements.push({ data: { source: parent, target: code, id: `${parent}->${code}` } });
    }
  }

  return elements;
}

/**
 * Build cytoscape elements for search results, including ancestor chains.
 *
 * @param {Array}       records
 * @param {number}      year
 * @param {string}      catalogueType
 * @param {string}      query          comma-separated include terms
 * @param {string}      searchMode     "label" | "code"
 * @param {string|null} exclude        comma-separated exclude terms
 * @returns {object[]}  cytoscape element list
 */
export function buildSearchElements(
  records,
  year,
  catalogueType,
  query,
  searchMode = "label",
  exclude = null,
) {
  const { childrenMap: _cm, codeRow } = buildLookups(records, year, catalogueType);

  const includeTerms = query.split(",").map(t => t.trim()).filter(Boolean);
  const excludeTerms = exclude
    ? exclude.split(",").map(t => t.trim()).filter(Boolean)
    : [];

  // Build parent map for ancestor walking
  /** @type {Map<string, string|null>} */
  const parentMap = new Map();
  for (const [code, row] of codeRow) parentMap.set(code, row.parent || null);

  // Filter: OR across include terms
  let matched = [];
  for (const [code, row] of codeRow) {
    let hit = false;
    if (searchMode === "code") {
      hit = includeTerms.some(t => code.toUpperCase().startsWith(t.toUpperCase()));
    } else {
      hit = includeTerms.some(t => row.label.toLowerCase().includes(t.toLowerCase()));
    }
    if (hit) matched.push(row);
  }

  // AND-NOT: drop rows matching any exclude term (label search only)
  for (const term of excludeTerms) {
    const lower = term.toLowerCase();
    matched = matched.filter(row => !row.label.toLowerCase().includes(lower));
  }

  if (matched.length === 0) return [];
  matched = matched.slice(0, 200); // cap to avoid browser overload

  // Collect ancestors
  const matchedCodes = new Set(matched.map(r => r.code));
  const allCodes     = new Set(matchedCodes);

  for (const code of matchedCodes) {
    let current = parentMap.get(code);
    while (current && !allCodes.has(current)) {
      allCodes.add(current);
      current = parentMap.get(current) ?? null;
    }
  }

  const elements  = [];
  const seenEdges = new Set();

  for (const code of allCodes) {
    const row = codeRow.get(code);
    if (!row) continue;

    const isMatch = matchedCodes.has(code);
    const truncated = row.label.length > 40 ? row.label.slice(0, 40) + "…" : row.label;

    elements.push({
      data: {
        id:          code,
        label:       `${code}\n${truncated}`,
        full_label:  row.label,
        kind:        row.kind,
        is_leaf:     row.is_leaf,
        parent_code: row.parent || null,
        colour:      KIND_COLOURS[row.kind] ?? "#aaa",
        is_match:    isMatch,
      },
      classes: `${row.kind} ${isMatch ? "match" : "ancestor"}`,
    });

    const parent = row.parent || null;
    if (parent && allCodes.has(parent)) {
      const edgeId = `${parent}->${code}`;
      if (!seenEdges.has(edgeId)) {
        seenEdges.add(edgeId);
        elements.push({ data: { source: parent, target: code, id: edgeId } });
      }
    }
  }

  return elements;
}
