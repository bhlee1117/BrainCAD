/**
 * Marks its children as helper decoration rather than physical geometry.
 *
 * The flag goes on this one wrapper group, not on each descendant. Tagging
 * descendants individually looked tidier but raced: drei's `Text` and `Line`
 * finish mounting asynchronously (a font has to load), so children that
 * appeared after the tagging pass stayed classified as physical and turned up
 * in the objective view anyway. Hiding one ancestor takes its whole subtree
 * with it, whenever those children arrive.
 */

import type { ReactNode } from 'react'

/** Set on the wrapper group's `userData` so a capture can find and hide it. */
export const HELPER_FLAG = 'braincadHelper'

export function Helper({ children }: { children: ReactNode }) {
  return <group userData={{ [HELPER_FLAG]: true }}>{children}</group>
}

/**
 * Set on the anatomy group so a capture can frame on the brain.
 *
 * An overview framed on everything is dominated by hardware: a real objective
 * barrel is tens of millimetres long against a 13 mm brain, so including it
 * whole renders the anatomy a few pixels across. Framing on the anatomy and
 * letting distant hardware run out of frame is how a surgical plan is drawn.
 */
export const ANATOMY_FLAG = 'braincadAnatomy'
