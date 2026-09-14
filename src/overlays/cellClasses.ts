/**
 * What cell population a Cre driver labels.
 *
 * This is the question someone reading a projection overlay actually has, and
 * no API answers it. Allen's line descriptions say *where* Cre expression is
 * enriched anatomically — "piriform cortex, thalamus, hippocampus" — which is
 * not the same as *which cells*. For `Kcnc2-Cre` the fact that matters is that
 * Kcnc2 is Kv3.2, expressed in fast-spiking GABAergic interneurons; the
 * anatomical list never says so.
 *
 * So this table is curated, and is kept deliberately separate from Allen's own
 * text in both the data model and the interface. Two rules govern what goes in:
 *
 *  1. Only well-established marker-to-population relationships — the kind
 *     stated plainly in reviews and used to define cell classes.
 *  2. A driver not listed here gets NO cell-class claim. An unfamiliar line
 *     shows its gene identity and Allen's anatomy and nothing more, because
 *     guessing would fabricate a claim about which neurons were traced.
 *
 * Cre lines also label their marker's expression pattern, which is broader and
 * less clean than the idealised class — recombination is not perfectly
 * specific, and specificity varies by region and age. The interface says so.
 */

/** How firmly the marker identifies the population. */
export type ClassConfidence =
  /** A defining marker for the class; used to delineate it in the literature. */
  | 'established'
  /** Strongly enriched in the class, but labels other populations too. */
  | 'enriched'

export interface CellClass {
  /** The population, in the terms a neuroscientist would use. */
  readonly population: string
  /** What the gene is, when the symbol alone is opaque. */
  readonly marker: string
  readonly confidence: ClassConfidence
  /** Anything that changes how the overlay should be read. */
  readonly caveat?: string
}

/**
 * Curated marker → population table, keyed by gene symbol.
 *
 * Grouped by what the marker identifies, because that is how the entries were
 * reasoned about and how their reliability differs.
 */
export const CELL_CLASSES: Readonly<Record<string, CellClass>> = {
  /* ---- Neurotransmitter identity: the most reliable class of marker ---- */
  Gad1: {
    population: 'GABAergic inhibitory neurons',
    marker: 'GAD67, a GABA-synthesising enzyme',
    confidence: 'established',
  },
  Gad2: {
    population: 'GABAergic inhibitory neurons',
    marker: 'GAD65, a GABA-synthesising enzyme',
    confidence: 'established',
  },
  Slc32a1: {
    population: 'GABAergic and glycinergic inhibitory neurons',
    marker: 'VGAT, the vesicular inhibitory amino acid transporter',
    confidence: 'established',
  },
  Slc17a7: {
    population: 'Glutamatergic excitatory neurons — cortex and hippocampus',
    marker: 'VGLUT1, a vesicular glutamate transporter',
    confidence: 'established',
  },
  Slc17a6: {
    population: 'Glutamatergic excitatory neurons — largely subcortical',
    marker: 'VGLUT2, a vesicular glutamate transporter',
    confidence: 'established',
  },
  Slc17a8: {
    population: 'Glutamatergic neurons, sparse and often co-releasing',
    marker: 'VGLUT3, a vesicular glutamate transporter',
    confidence: 'enriched',
    caveat: 'VGLUT3 neurons frequently co-release GABA, acetylcholine or serotonin.',
  },
  Chat: {
    population: 'Cholinergic neurons',
    marker: 'Choline acetyltransferase',
    confidence: 'established',
  },
  Th: {
    population: 'Catecholaminergic neurons — dopaminergic and noradrenergic',
    marker: 'Tyrosine hydroxylase',
    confidence: 'established',
    caveat: 'Does not separate dopamine from noradrenaline; the region decides which.',
  },
  Slc6a3: {
    population: 'Dopaminergic neurons',
    marker: 'DAT, the dopamine transporter',
    confidence: 'established',
  },
  Dbh: {
    population: 'Noradrenergic neurons',
    marker: 'Dopamine beta-hydroxylase',
    confidence: 'established',
  },
  Slc6a4: {
    population: 'Serotonergic neurons',
    marker: 'SERT, the serotonin transporter',
    confidence: 'established',
  },
  Fev: {
    population: 'Serotonergic neurons',
    marker: 'Pet1, a serotonergic-lineage transcription factor',
    confidence: 'established',
  },
  Hdc: {
    population: 'Histaminergic neurons',
    marker: 'Histidine decarboxylase',
    confidence: 'established',
  },

  /* ---- Interneuron subclasses ---- */
  Pvalb: {
    population: 'Parvalbumin-positive fast-spiking GABAergic interneurons',
    marker: 'Parvalbumin, a calcium-binding protein',
    confidence: 'established',
  },
  Sst: {
    population: 'Somatostatin-positive GABAergic interneurons',
    marker: 'Somatostatin, a neuropeptide',
    confidence: 'established',
  },
  Vip: {
    population: 'VIP-positive GABAergic interneurons',
    marker: 'Vasoactive intestinal peptide',
    confidence: 'established',
  },
  Htr3a: {
    population: 'Serotonin-3A-receptor GABAergic interneurons — includes VIP and neurogliaform',
    marker: '5-HT3A receptor',
    confidence: 'enriched',
  },
  Ndnf: {
    population: 'Neurogliaform and layer 1 GABAergic interneurons',
    marker: 'Neuron-derived neurotrophic factor',
    confidence: 'enriched',
  },
  Lamp5: {
    population: 'Neurogliaform-type GABAergic interneurons, layer 1 enriched',
    marker: 'LAMP5, a transcriptomic class marker',
    confidence: 'enriched',
  },
  Kcnc2: {
    population: 'Fast-spiking GABAergic interneurons, largely parvalbumin-positive',
    marker: 'Kv3.2, a voltage-gated potassium channel that enables fast spiking',
    confidence: 'enriched',
    caveat:
      'Kv3 channels also appear in some fast-firing excitatory and subcortical neurons.',
  },
  Kcnc1: {
    population: 'Fast-spiking neurons, largely parvalbumin-positive interneurons',
    marker: 'Kv3.1, a voltage-gated potassium channel that enables fast spiking',
    confidence: 'enriched',
  },
  Nos1: {
    population: 'Nitric-oxide-synthase GABAergic interneurons',
    marker: 'Neuronal nitric oxide synthase',
    confidence: 'enriched',
  },
  Calb1: {
    population: 'Calbindin-positive neurons — inhibitory and excitatory',
    marker: 'Calbindin D-28k, a calcium-binding protein',
    confidence: 'enriched',
    caveat: 'Calbindin is not restricted to interneurons.',
  },
  Calb2: {
    population: 'Calretinin-positive neurons, largely GABAergic',
    marker: 'Calretinin, a calcium-binding protein',
    confidence: 'enriched',
  },

  /* ---- Cortical layers and projection classes ---- */
  Cux2: {
    population: 'Upper-layer (2/3 and 4) intratelencephalic excitatory neurons',
    marker: 'CUX2, an upper-layer transcription factor',
    confidence: 'enriched',
  },
  Rasgrf2: {
    population: 'Layer 2/3 excitatory neurons',
    marker: 'RasGRF2, a Ras guanine-nucleotide exchange factor',
    confidence: 'enriched',
  },
  Scnn1a: {
    population: 'Layer 4 excitatory neurons',
    marker: 'ENaC alpha subunit',
    confidence: 'enriched',
  },
  Nr5a1: {
    population: 'Layer 4 excitatory neurons',
    marker: 'SF-1, a nuclear receptor',
    confidence: 'enriched',
  },
  Rorb: {
    population: 'Layer 4 and upper layer 5 excitatory neurons',
    marker: 'RORβ, a layer-4 transcription factor',
    confidence: 'enriched',
  },
  Rbp4: {
    population: 'Layer 5 excitatory neurons',
    marker: 'Retinol-binding protein 4',
    confidence: 'enriched',
    caveat: 'Covers both intratelencephalic and pyramidal-tract layer 5 types.',
  },
  Tlx3: {
    population: 'Layer 5 intratelencephalic excitatory neurons',
    marker: 'TLX3, a transcription factor',
    confidence: 'enriched',
  },
  Sim1: {
    population: 'Layer 5 pyramidal-tract excitatory neurons',
    marker: 'SIM1, a transcription factor',
    confidence: 'enriched',
  },
  Fezf2: {
    population: 'Layer 5 pyramidal-tract excitatory neurons',
    marker: 'FEZF2, a corticofugal-identity transcription factor',
    confidence: 'established',
  },
  Ntsr1: {
    population: 'Layer 6 corticothalamic excitatory neurons',
    marker: 'Neurotensin receptor 1',
    confidence: 'enriched',
  },
  Syt6: {
    population: 'Layer 6 corticothalamic excitatory neurons',
    marker: 'Synaptotagmin 6',
    confidence: 'enriched',
  },

  /* ---- Striatal pathways ---- */
  Drd1: {
    population: 'Direct-pathway (D1) striatal projection neurons',
    marker: 'Dopamine D1 receptor',
    confidence: 'established',
  },
  Drd2: {
    population: 'Indirect-pathway (D2) striatal projection neurons',
    marker: 'Dopamine D2 receptor',
    confidence: 'established',
    caveat: 'D2 is also expressed by cholinergic interneurons and dopaminergic terminals.',
  },
  Adora2a: {
    population: 'Indirect-pathway (D2) striatal projection neurons',
    marker: 'Adenosine A2A receptor',
    confidence: 'established',
  },
  Pdyn: {
    population: 'Dynorphin neurons — in striatum, largely direct-pathway',
    marker: 'Prodynorphin, an opioid peptide precursor',
    confidence: 'enriched',
  },
  Penk: {
    population: 'Enkephalin neurons — in striatum, largely indirect-pathway',
    marker: 'Proenkephalin, an opioid peptide precursor',
    confidence: 'enriched',
  },
  Tac1: {
    population: 'Substance P neurons — in striatum, largely direct-pathway',
    marker: 'Tachykinin 1, the substance P precursor',
    confidence: 'enriched',
  },

  /* ---- Hypothalamic and neuropeptide populations ---- */
  Agrp: {
    population: 'AgRP/NPY arcuate neurons — hunger-promoting',
    marker: 'Agouti-related peptide',
    confidence: 'established',
  },
  Pomc: {
    population: 'POMC arcuate neurons — satiety-promoting',
    marker: 'Pro-opiomelanocortin',
    confidence: 'established',
  },
  Crh: {
    population: 'Corticotropin-releasing-hormone neurons',
    marker: 'CRH, a stress-axis neuropeptide',
    confidence: 'established',
  },
  Oxt: {
    population: 'Oxytocin neurons',
    marker: 'Oxytocin',
    confidence: 'established',
  },
  Avp: {
    population: 'Vasopressin neurons',
    marker: 'Arginine vasopressin',
    confidence: 'established',
  },

  /* ---- Regional identity ---- */
  Grik4: {
    population: 'CA3 pyramidal neurons',
    marker: 'Kainate receptor subunit GluK4',
    confidence: 'enriched',
  },
}

/**
 * Extract the driver gene symbol from an Allen transgenic line name.
 *
 * Names follow a loose convention — `Kcnc2-Cre`, `Slc17a7-IRES2-Cre`,
 * `Pvalb-T2A-FlpO`, `Gpr26-Cre_KO250` — where the gene comes first and is
 * followed by the recombinase and construct details.
 */
export function geneFromLineName(lineName: string): string | null {
  if (!lineName) return null
  const head = lineName.split(/[-_]/)[0]?.trim()
  if (!head) return null
  // Reporter and effector lines are not driver lines and name no gene.
  if (/^(Ai\d+|CAG|TIT|ROSA|LSL)$/i.test(head)) return null
  return head
}

/** The curated entry for a line, or null when none is established. */
export function cellClassForLine(lineName: string): CellClass | null {
  const gene = geneFromLineName(lineName)
  if (!gene) return null
  return CELL_CLASSES[gene] ?? null
}

export const CONFIDENCE_LABEL: Record<ClassConfidence, string> = {
  established: 'defining marker',
  enriched: 'enriched in',
}

/**
 * The standing caveat shown wherever a curated class appears.
 *
 * A Cre line labels its marker's expression pattern, not an idealised cell
 * class, and recombination is neither complete nor perfectly specific.
 */
export const CELL_CLASS_CAVEAT =
  'Curated summary of the driver gene, not Allen data. A Cre line labels its ' +
  'marker’s expression pattern — specificity and completeness vary by region, ' +
  'age and construct. Verify against the line’s characterisation before relying on it.'
