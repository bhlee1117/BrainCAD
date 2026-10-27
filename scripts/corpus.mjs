/**
 * The set of Allen experiments both hub maps are built from.
 *
 * Shared by `fetch-connectivity-matrix.mjs` and `fetch-voxel-convergence.mjs`
 * because the two maps are read side by side — the structure grain and the
 * voxel grain of one question — and a reader comparing them is entitled to
 * assume they describe the same animals. They did not, for a while: the voxel
 * map listed product 5 and the matrix enumerated through
 * `service::mouse_connectivity_injection_structure`, which quietly also returns
 * products 35, 36, 44 and 45. Two maps, two corpora, one caption.
 *
 * ## Which products, and why these
 *
 * Allen files connectivity data under twenty-odd products. Seven of them are
 * the anterograde wild-type and Cre-line survey of the normal adult mouse:
 *
 *   5   Mouse Connectivity Projection                      2331
 *   6   Mouse Connectivity BDA/AAV Comparison               140
 *   35  Mouse Connectivity anterograde Cre-defined EGFP     183
 *   36  Mouse Connectivity anterograde Cre-defined SypEGFP  173
 *   42  target-defined anterograde projectome (visual)       62
 *   44  target-defined anterograde projectome (cortical)    119
 *   45  projection mapping for cell type characterization    47
 *
 * 3,055 experiments, of which 2,915 have usable grid and unionize data.
 *
 * Left out deliberately: the Alzheimer and aged-cohort studies, the retina
 * projections, and the reference/characterisation sets. Those are different
 * animals asking different questions, and pooling them into one number called
 * "the mouse connectome" would be a quiet lie rather than more data.
 *
 * ## Why this list is not derived from the search service
 *
 * It would be tempting to define the corpus as "whatever the back-trace's
 * spatial search covers", so the two tabs could never disagree. Allen does not
 * document what that service covers, and it is not stable enough to build an
 * asset on. An explicit list of product ids is checkable; "whatever the service
 * returned that day" is not.
 */

/** Allen product ids making up the corpus. */
export const PRODUCTS = [5, 6, 35, 36, 42, 44, 45]

/** RMA fragment selecting them. */
export const PRODUCT_FILTER = `products[id$in${PRODUCTS.join(',')}]`

/**
 * Every experiment in the corpus, with the structure it was injected into.
 *
 * One query, a few seconds, against `model::SectionDataSet` — rather than the
 * 293 per-structure service calls an earlier version used, which took a
 * quarter of an hour and silently defined the corpus by what that service
 * happened to cover.
 *
 * `primary_injection_structure` is at full ontology depth; the caller maps it
 * up to the summary structure containing it. The two routes were checked
 * against each other over six summary structures and agreed on all 184
 * experiments they share.
 */
export const CORPUS_CRITERIA =
  `model::SectionDataSet,rma::criteria,[failed$eqfalse],${PRODUCT_FILTER},` +
  'rma::include,specimen(stereotaxic_injections(primary_injection_structure)),' +
  "rma::options[num_rows$eq'all']"

/** Carried into both assets so the file says what it was built from. */
export const CORPUS_NOTE =
  `Allen products ${PRODUCTS.join(', ')} — the anterograde wild-type and ` +
  'Cre-line survey of the normal adult mouse. The Alzheimer, aged-cohort, ' +
  'retina and reference cohorts are left out rather than pooled into one ' +
  'connectome. Both hub maps are built from this same set.'

/**
 * Which hemisphere each experiment was injected into.
 *
 * Two queries for the whole corpus: Allen's injection unionize rows for `root`
 * exist only where there is injection signal, so an experiment appearing under
 * hemisphere 2 and not 1 was injected on the right. Where a needle straddled
 * the midline and both rows exist, the larger volume wins.
 *
 * This replaces reading the sign of the reported injection coordinate, which
 * needed the 293-query service and is worse where it differs: over 742
 * experiments the two agreed on 691, and every one of the 51 disagreements was
 * an injection within 0.4 mm of the midline — exactly where a single reported
 * coordinate is least able to say which side the tracer went.
 *
 * Returns a `Map<experimentId, 1 | 2>`; 140 of the 3,055 experiments appear in
 * neither hemisphere, and all 140 also have no projection data at all, so
 * nothing is lost by leaving them out.
 */
export async function fetchInjectionHemispheres(query) {
  const volume = new Map()

  for (const hemisphere of [1, 2]) {
    const rows = await query(
      'model::ProjectionStructureUnionize,rma::criteria,' +
        `[is_injection$eqtrue][structure_id$eq997][hemisphere_id$eq${hemisphere}],` +
        "rma::options[num_rows$eq'all'][only$eq'projection_volume,section_data_set_id']",
    )
    for (const row of rows) {
      const id = row?.section_data_set_id
      if (typeof id !== 'number') continue
      const entry = volume.get(id) ?? {}
      entry[hemisphere] = row.projection_volume ?? 0
      volume.set(id, entry)
    }
  }

  const hemisphere = new Map()
  for (const [id, sides] of volume) {
    const left = sides[1]
    const right = sides[2]
    if (left !== undefined && right !== undefined) {
      hemisphere.set(id, right > left ? 2 : 1)
    } else {
      hemisphere.set(id, right !== undefined ? 2 : 1)
    }
  }
  return hemisphere
}

/**
 * The summary structure containing a full-depth structure, or null.
 *
 * Allen's 293-region summary set is a flat partition — no summary structure
 * contains another — so walking the root-to-leaf path from the leaf end finds
 * the one containing region and there is never a choice to make.
 */
export function summaryAncestor(pathById, summaryIds, structureId) {
  const path = pathById.get(structureId) ?? [structureId]
  for (let i = path.length - 1; i >= 0; i--) {
    if (summaryIds.has(path[i])) return path[i]
  }
  return null
}
