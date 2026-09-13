/**
 * Allen structure ontology: the tree of brain regions behind search, the
 * structure tree panel, slice colouring, and "which region contains my target".
 *
 * The Allen API serves this as a deeply nested JSON tree (~640 KB). The build
 * script flattens it into a compact array; this module rebuilds the lookups the
 * UI needs and answers parent/child questions.
 */

/** One structure, as stored in the flattened `structures.json` asset. */
export interface Structure {
  readonly id: number
  readonly acronym: string
  readonly name: string
  /** Hex colour without a leading '#', as the Allen ontology provides it. */
  readonly colorHex: string
  /** Parent structure id, or null for the root. */
  readonly parentId: number | null
  /** Root-to-node id path, inclusive of this node. */
  readonly path: readonly number[]
  /** Depth below the root; the root itself is 0. */
  readonly depth: number
}

export interface StructureIndex {
  readonly all: readonly Structure[]
  readonly byId: ReadonlyMap<number, Structure>
  readonly byAcronym: ReadonlyMap<string, Structure>
  readonly childrenOf: ReadonlyMap<number, readonly Structure[]>
  readonly root: Structure | undefined
}

export function buildIndex(structures: readonly Structure[]): StructureIndex {
  const byId = new Map<number, Structure>()
  const byAcronym = new Map<string, Structure>()
  const childrenOf = new Map<number, Structure[]>()

  for (const s of structures) {
    byId.set(s.id, s)
    byAcronym.set(s.acronym.toLowerCase(), s)
  }
  for (const s of structures) {
    if (s.parentId === null) continue
    const siblings = childrenOf.get(s.parentId)
    if (siblings) siblings.push(s)
    else childrenOf.set(s.parentId, [s])
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    all: structures,
    byId,
    byAcronym,
    childrenOf,
    root: structures.find((s) => s.parentId === null),
  }
}

/** Root-to-node chain, useful for the "Isocortex › SSp › SSp-bfd" breadcrumb. */
export function ancestorsOf(index: StructureIndex, id: number): readonly Structure[] {
  const structure = index.byId.get(id)
  if (!structure) return []
  return structure.path
    .map((pid) => index.byId.get(pid))
    .filter((s): s is Structure => s !== undefined)
}

/** Whether `descendantId` lies at or below `ancestorId` in the tree. */
export function isDescendantOf(
  index: StructureIndex,
  descendantId: number,
  ancestorId: number,
): boolean {
  const structure = index.byId.get(descendantId)
  return structure ? structure.path.includes(ancestorId) : false
}

/**
 * Search structures by acronym or name.
 *
 * Ranking puts exact acronym matches first (typing "CA1" should not surface
 * "CA1 stratum lacunosum-moleculare" ahead of CA1 itself), then acronym
 * prefixes, then name matches.
 */
export function searchStructures(
  index: StructureIndex,
  query: string,
  limit = 25,
): readonly Structure[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []

  const scored: { structure: Structure; score: number }[] = []
  for (const s of index.all) {
    const acronym = s.acronym.toLowerCase()
    const name = s.name.toLowerCase()

    let score: number
    if (acronym === q) score = 0
    else if (acronym.startsWith(q)) score = 1
    else if (name === q) score = 2
    else if (name.startsWith(q)) score = 3
    else if (acronym.includes(q)) score = 4
    else if (name.includes(q)) score = 5
    else continue

    scored.push({ structure: s, score })
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.structure.depth - b.structure.depth ||
      a.structure.name.localeCompare(b.structure.name),
  )
  return scored.slice(0, limit).map((entry) => entry.structure)
}

/** Parse the ontology's `RRGGBB` hex into 0-255 components. */
export function colorComponents(structure: Structure): [number, number, number] {
  const hex = structure.colorHex.replace(/^#/, '')
  const value = Number.parseInt(hex, 16)
  if (!Number.isFinite(value) || hex.length !== 6) return [128, 128, 128]
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * Structure id → packed RGBA colour, for painting slice images.
 *
 * Deliberately a Map rather than an array indexed by structure id. Allen
 * structure ids are extremely sparse: the ontology holds ~1,300 structures but
 * ids run as high as 614,454,277, so a dense table would need 2.4 GB. (An
 * earlier dense implementation passed its unit tests — whose fixture ids were
 * all small — and then failed on real data with "Array buffer allocation
 * failed".)
 *
 * Colours are packed into a single little-endian uint32 so `colorizeSlice` can
 * write one word per pixel instead of four bytes.
 */
export type ColorTable = ReadonlyMap<number, number>

export function buildColorTable(index: StructureIndex): ColorTable {
  const table = new Map<number, number>()
  for (const s of index.all) {
    const [r, g, b] = colorComponents(s)
    // Little-endian RGBA with alpha in the high byte. `>>> 0` keeps the value
    // unsigned: `255 << 24` alone is a negative int32 in JavaScript.
    table.set(s.id, ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0)
  }
  return table
}
