/**
 * Core document types.
 *
 * Split out of the store so modules that describe the document — the undo
 * history, chiefly — can name these types without importing the store and
 * creating a cycle.
 */

import type { Stereotaxic } from '../atlas/coords.ts'

export interface Target {
  readonly id: string
  name: string
  coord: Stereotaxic
  notes: string
  visible: boolean
}

export type Selection =
  | { kind: 'target'; id: string }
  | { kind: 'object'; id: string }
  | null
