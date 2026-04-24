/**
 * transitions.js — Year-to-year transition analytics for catalogue codes.
 *
 * Transition edges come from the BfArM Umsteiger tables and describe how a
 * code in year Y maps to one or more codes in year Y+1. We use them to build,
 * for any (catalogue, code) pair:
 *
 *   - a headline tag      ("Stable 2014–2026", "New since 2020", etc.)
 *   - a lifespan strip    (per-year status used by the UI)
 *   - a neighbourhood     (predecessor / successor codes at a given year)
 *
 * Variants (OPS left / right) are intentionally ignored: we collapse them
 * upstream (see scripts/export_data.py) and treat all variants of a code as
 * one logical entity.
 *
 * Record shape (compact — see the export script):
 *   { c: "ICD"|"OPS", sy: int, ty: int, s: code|"UNDEF",
 *     t: code|"UNDEF", af: bool, ab: bool }
 */

// Sentinel used on either side of a transition row to mark a code boundary.
// "UNDEF" on the source side means the target is newly introduced;
// "UNDEF" on the target side means the source is deprecated.
const UNDEF = "UNDEF";

// ── Index ─────────────────────────────────────────────────────────────────────

/**
 * Build two Maps keyed by "CATALOGUE:CODE":
 *   prevEdges  — edges where the code is the target       (→ who mapped INTO this code)
 *   nextEdges  — edges where the code is the source       (→ what this code maps OUT TO)
 *
 * UNDEF boundaries are kept so that birth/death can be detected.
 *
 * @param {Array} rows  records from transitions.json
 * @returns {{ prev: Map<string, object[]>, next: Map<string, object[]> }}
 */
export function buildTransitionIndex(rows) {
  const prev = new Map();
  const next = new Map();

  for (const row of rows) {
    if (row.t !== UNDEF) {
      const key = `${row.c}:${row.t}`;
      if (!prev.has(key)) prev.set(key, []);
      prev.get(key).push(row);
    }
    if (row.s !== UNDEF) {
      const key = `${row.c}:${row.s}`;
      if (!next.has(key)) next.set(key, []);
      next.get(key).push(row);
    }
  }
  return { prev, next };
}

// ── Lifespan (headline tag + per-year status) ────────────────────────────────

/**
 * Compute the lifespan view of a code.
 *
 * The transition table covers src_year ∈ [2012, 2025] and tgt_year ∈ [2013, 2026].
 * A code "exists in year Y" iff it appears as a src in year Y (mapping out to Y+1)
 * OR as a tgt in year Y (mapped to from Y-1), with the opposite end not being UNDEF.
 *
 * @param {object} index             result of buildTransitionIndex
 * @param {string} catalogue         "ICD" | "OPS"
 * @param {string} code
 * @returns {{
 *   statusByYear: Record<number, "absent"|"stable"|"ambiguous">,
 *   bornYear:     number | null,   // first year of appearance if not always present
 *   diedYear:     number | null,   // last year of appearance if later deprecated
 *   yearsPresent: number[]         // sorted list of years the code exists
 * }}
 */
export function computeLifespan(index, catalogue, code) {
  const key       = `${catalogue}:${code}`;
  const prevEdges = index.prev.get(key) ?? [];
  const nextEdges = index.next.get(key) ?? [];

  // A transition covers the boundary [sy → ty]; the code "exists" at sy if it is
  // the src (with a real target) and at ty if it is the tgt (with a real source).
  const yearsPresent = new Set();
  for (const e of nextEdges) if (e.t !== UNDEF) yearsPresent.add(e.sy);
  for (const e of prevEdges) if (e.s !== UNDEF) yearsPresent.add(e.ty);

  // A year is ambiguous if any edge touching the code at that year is non-auto.
  const ambiguousYears = new Set();
  for (const e of nextEdges) {
    if (!e.af || !e.ab) {
      if (e.t   !== UNDEF) ambiguousYears.add(e.sy);  // source year
      if (e.s   !== UNDEF) ambiguousYears.add(e.ty);  // also flag the target year
    }
  }
  for (const e of prevEdges) {
    if (!e.af || !e.ab) {
      if (e.t !== UNDEF) ambiguousYears.add(e.sy);
      if (e.s !== UNDEF) ambiguousYears.add(e.ty);
    }
  }

  // Birth: code appears as target of a UNDEF-sourced row → introduced at ty
  let bornYear = null;
  for (const e of prevEdges) {
    if (e.s === UNDEF) {
      if (bornYear === null || e.ty < bornYear) bornYear = e.ty;
    }
  }

  // Death: code appears as source of a UNDEF-targeted row → deprecated after sy
  let diedYear = null;
  for (const e of nextEdges) {
    if (e.t === UNDEF) {
      if (diedYear === null || e.sy > diedYear) diedYear = e.sy;
    }
  }

  // Build per-year status map across the full transition-year range
  const allYears = [...yearsPresent].sort((a, b) => a - b);
  const yMin = allYears.length ? allYears[0]                : null;
  const yMax = allYears.length ? allYears[allYears.length-1]: null;

  const statusByYear = {};
  if (yMin !== null) {
    for (let y = yMin; y <= yMax; y++) {
      if (!yearsPresent.has(y))      statusByYear[y] = "absent";
      else if (ambiguousYears.has(y)) statusByYear[y] = "ambiguous";
      else                            statusByYear[y] = "stable";
    }
  }

  return { statusByYear, bornYear, diedYear, yearsPresent: allYears };
}

/**
 * Build a short headline tag summarising a code's lifespan.
 *
 * Precedence (most specific first):
 *   - Born & died   → "Born YYYY, ended YYYY"
 *   - Born only     → "New since YYYY"
 *   - Died only     → "Deprecated YYYY"
 *   - Has non-auto years but stable bounds → "Reformed: YYYY, YYYY"
 *   - Otherwise     → "Stable YYYY–YYYY"
 *
 * @param {ReturnType<typeof computeLifespan>} lifespan
 * @returns {string}
 */
export function headlineTag(lifespan) {
  const { bornYear, diedYear, statusByYear, yearsPresent } = lifespan;

  if (yearsPresent.length === 0) return "No transition data";

  const first = yearsPresent[0];
  const last  = yearsPresent[yearsPresent.length - 1];
  const reformYears = Object.entries(statusByYear)
    .filter(([_y, s]) => s === "ambiguous")
    .map(([y]) => Number(y))
    .sort((a, b) => a - b);

  if (bornYear !== null && diedYear !== null)
    return `Born ${bornYear}, ended ${diedYear}`;
  if (bornYear !== null) return `New since ${bornYear}`;
  if (diedYear !== null) return `Deprecated ${diedYear}`;
  if (reformYears.length > 0)
    return `Reformed: ${reformYears.join(", ")}`;
  return `Stable ${first}–${last}`;
}

// ── Neighbourhood (single-step, predecessor / successor at year Y) ────────────

/**
 * Collect predecessor and successor codes of `code` at year `year`.
 *
 * Predecessors: codes in year-1 that mapped INTO `code` at year.
 * Successors:   codes in year that `code` maps OUT TO in year+1.
 *
 * UNDEF endpoints are filtered out — they are represented by the born/died
 * markers in the lifespan view, not here.
 *
 * @param {object} index
 * @param {string} catalogue
 * @param {string} code
 * @param {number} year
 * @returns {{ prev: Array<{code:string, auto:boolean}>,
 *             next: Array<{code:string, auto:boolean}> }}
 */
export function computeNeighbourhood(index, catalogue, code, year) {
  const key = `${catalogue}:${code}`;

  const prev = (index.prev.get(key) ?? [])
    .filter(e => e.ty === year && e.s !== UNDEF)
    .map(e => ({ code: e.s, auto: e.ab }));  // backward auto flag

  const next = (index.next.get(key) ?? [])
    .filter(e => e.sy === year && e.t !== UNDEF)
    .map(e => ({ code: e.t, auto: e.af }));  // forward auto flag

  return { prev, next };
}
