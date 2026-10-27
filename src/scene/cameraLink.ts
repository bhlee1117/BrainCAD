/**
 * Sharing one camera pose between two canvases.
 *
 * The heat-map view exists to be compared against the main view: the same
 * brain, the same angle, one showing the hardware and one showing where the
 * inputs come from. That comparison only works if the two are locked — a
 * second view the user has to orbit into alignment by hand is worse than no
 * second view, because the misalignment is invisible until it has already
 * misled someone.
 *
 * A module-level slot rather than React state, and deliberately so: the pose
 * changes every frame while the user orbits, and routing that through a store
 * would re-render the panel sixty times a second to move a camera that React
 * is not drawing anyway. The publisher writes, the follower reads, and neither
 * causes a render.
 */

import { Quaternion, Vector3 } from 'three'

export interface CameraPose {
  readonly position: Vector3
  readonly quaternion: Quaternion
  /** Where the controls are pointing, so a follower can match the framing. */
  readonly target: Vector3
  readonly fov: number
  readonly zoom: number
  /** Bumped on every publish, so a follower can skip untouched frames. */
  readonly version: number
}

const pose = {
  position: new Vector3(14, 9, 16),
  quaternion: new Quaternion(),
  target: new Vector3(0, -2, 0),
  fov: 40,
  zoom: 1,
  version: 0,
}

/** Record the main viewport's camera. Called from its render loop. */
export function publishCameraPose(next: {
  position: Vector3
  quaternion: Quaternion
  target: Vector3
  fov: number
  zoom: number
}): void {
  // Written in place rather than replaced: this runs every frame and the
  // allocation would be the only garbage the render loop produces.
  pose.position.copy(next.position)
  pose.quaternion.copy(next.quaternion)
  pose.target.copy(next.target)
  pose.fov = next.fov
  pose.zoom = next.zoom
  pose.version += 1
}

/** The latest pose. The returned vectors are live and must not be mutated. */
export function readCameraPose(): CameraPose {
  return pose
}
