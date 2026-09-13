/**
 * Minimal NRRD reader for Allen CCF annotation volumes.
 *
 * Scope is deliberately narrow: the 3D, gzip- or raw-encoded, little-endian
 * scalar volumes the Allen Institute publishes. Anything outside that throws
 * rather than guessing, because a misread volume would silently corrupt every
 * region lookup downstream.
 *
 * Reference: https://teem.sourceforge.net/nrrd/format.html
 */

import { gunzipSync } from 'fflate'

export type NrrdScalarType =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float'
  | 'double'

const TYPE_ALIASES: Record<string, NrrdScalarType> = {
  'signed char': 'int8',
  int8: 'int8',
  int8_t: 'int8',
  uchar: 'uint8',
  'unsigned char': 'uint8',
  uint8: 'uint8',
  uint8_t: 'uint8',
  short: 'int16',
  'short int': 'int16',
  'signed short': 'int16',
  int16: 'int16',
  int16_t: 'int16',
  ushort: 'uint16',
  'unsigned short': 'uint16',
  uint16: 'uint16',
  uint16_t: 'uint16',
  int: 'int32',
  'signed int': 'int32',
  int32: 'int32',
  int32_t: 'int32',
  uint: 'uint32',
  'unsigned int': 'uint32',
  uint32: 'uint32',
  uint32_t: 'uint32',
  float: 'float',
  double: 'double',
}

export interface NrrdVolume {
  readonly shape: readonly [number, number, number]
  readonly type: NrrdScalarType
  /** Voxel size per array axis, in the file's own units (µm for Allen CCF). */
  readonly spacing: readonly [number, number, number]
  readonly data:
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
  readonly header: Readonly<Record<string, string>>
}

function parseHeader(bytes: Uint8Array): {
  header: Record<string, string>
  dataOffset: number
} {
  // The header is ASCII, terminated by a blank line.
  const magic = String.fromCharCode(...bytes.subarray(0, 4))
  if (magic !== 'NRRD') {
    throw new Error(`Not an NRRD file (magic was ${JSON.stringify(magic)})`)
  }

  const header: Record<string, string> = {}
  let lineStart = 0
  let offset = -1

  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x0a) continue // newline

    const line = String.fromCharCode(...bytes.subarray(lineStart, i)).replace(/\r$/, '')
    lineStart = i + 1

    if (line === '') {
      // Blank line ends the header; binary data starts immediately after.
      offset = lineStart
      break
    }
    if (line.startsWith('#') || line.startsWith('NRRD')) continue

    const sep = line.indexOf(':')
    if (sep < 0) continue
    const key = line.slice(0, sep).trim().toLowerCase()
    header[key] = line.slice(sep + 1).replace(/^[=\s]+/, '').trim()
  }

  if (offset < 0) throw new Error('NRRD header has no terminating blank line')
  return { header, dataOffset: offset }
}

function parseSpacing(header: Record<string, string>, dimension: number): number[] {
  // Prefer `space directions`, e.g. "(50,0,0) (0,50,0) (0,0,50)".
  const directions = header['space directions']
  if (directions) {
    const vectors = directions.match(/\(([^)]*)\)/g)
    if (vectors && vectors.length >= dimension) {
      return vectors.slice(0, dimension).map((v) => {
        const parts = v.slice(1, -1).split(',').map(Number)
        return Math.hypot(...parts)
      })
    }
  }

  const spacings = header['spacings']
  if (spacings) {
    return spacings.split(/\s+/).map(Number).slice(0, dimension)
  }

  return new Array(dimension).fill(1)
}

function makeTypedArray(
  type: NrrdScalarType,
  buffer: ArrayBufferLike,
  count: number,
  offset: number,
) {
  switch (type) {
    case 'int8':
      return new Int8Array(buffer, offset, count)
    case 'uint8':
      return new Uint8Array(buffer, offset, count)
    case 'int16':
      return new Int16Array(buffer, offset, count)
    case 'uint16':
      return new Uint16Array(buffer, offset, count)
    case 'int32':
      return new Int32Array(buffer, offset, count)
    case 'uint32':
      return new Uint32Array(buffer, offset, count)
    case 'float':
      return new Float32Array(buffer, offset, count)
    case 'double':
      return new Float64Array(buffer, offset, count)
  }
}

const BYTES_PER_ELEMENT: Record<NrrdScalarType, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float: 4,
  double: 8,
}

/**
 * Decompress a gzip payload using the platform's streaming decompressor.
 *
 * Preferred over fflate's synchronous path for the annotation volume: at
 * 38.5 MB, `gunzipSync` allocates its output in one shot and was observed
 * throwing "Array buffer allocation failed" in the browser, while the
 * streaming decoder handles the same data comfortably. fflate remains the
 * fallback for any environment without DecompressionStream.
 */
async function gunzipStreaming(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return gunzipSync(compressed)

  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Parse a NRRD file, decompressing with the streaming decoder when the payload
 * is gzipped. Prefer this over {@link parseNrrd} for large volumes.
 */
export async function parseNrrdAsync(
  buffer: ArrayBuffer | Uint8Array,
): Promise<NrrdVolume> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const { header, dataOffset } = parseHeader(bytes)
  const meta = readMetadata(header)

  const encoding = (header['encoding'] ?? 'raw').toLowerCase()
  const payload =
    encoding === 'gzip' || encoding === 'gz'
      ? await gunzipStreaming(bytes.subarray(dataOffset))
      : bytes.subarray(dataOffset)

  return assemble(header, meta, payload)
}

/**
 * Parse a NRRD file synchronously.
 *
 * @param buffer Raw file bytes.
 * @throws on multi-byte big-endian data, unsupported encodings, or a
 *   dimension other than 3 — all cases BrainCAD would otherwise misread.
 */
export function parseNrrd(buffer: ArrayBuffer | Uint8Array): NrrdVolume {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const { header, dataOffset } = parseHeader(bytes)
  const meta = readMetadata(header)

  const encoding = (header['encoding'] ?? 'raw').toLowerCase()
  const payload =
    encoding === 'gzip' || encoding === 'gz'
      ? gunzipSync(bytes.subarray(dataOffset))
      : bytes.subarray(dataOffset)

  return assemble(header, meta, payload)
}

interface NrrdMetadata {
  readonly type: NrrdScalarType
  readonly sizes: readonly [number, number, number]
}

/** Validate and extract the header fields that determine how to read the data. */
function readMetadata(header: Record<string, string>): NrrdMetadata {
  const dimension = Number(header['dimension'])
  if (dimension !== 3) {
    throw new Error(`BrainCAD supports 3D NRRD volumes only, got dimension ${dimension}`)
  }

  const rawType = (header['type'] ?? '').toLowerCase()
  const type = TYPE_ALIASES[rawType]
  if (!type) throw new Error(`Unsupported NRRD type: ${JSON.stringify(rawType)}`)

  const sizes = (header['sizes'] ?? '').split(/\s+/).filter(Boolean).map(Number)
  if (sizes.length !== 3 || sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`Invalid NRRD sizes: ${JSON.stringify(header['sizes'])}`)
  }

  const endian = (header['endian'] ?? 'little').toLowerCase()
  if (BYTES_PER_ELEMENT[type] > 1 && endian !== 'little') {
    throw new Error(`Only little-endian NRRD data is supported, got ${endian}`)
  }

  const encoding = (header['encoding'] ?? 'raw').toLowerCase()
  if (encoding !== 'raw' && encoding !== 'gzip' && encoding !== 'gz') {
    throw new Error(`Unsupported NRRD encoding: ${encoding} (expected raw or gzip)`)
  }

  return { type, sizes: [sizes[0]!, sizes[1]!, sizes[2]!] }
}

/** Wrap a decoded payload in the typed array the header describes. */
function assemble(
  header: Record<string, string>,
  meta: NrrdMetadata,
  payload: Uint8Array,
): NrrdVolume {
  const { type, sizes } = meta
  const count = sizes[0] * sizes[1] * sizes[2]
  const expectedBytes = count * BYTES_PER_ELEMENT[type]

  if (payload.byteLength < expectedBytes) {
    throw new Error(
      `NRRD payload is short: expected ${expectedBytes} bytes for ` +
        `${sizes.join('x')} ${type}, got ${payload.byteLength}`,
    )
  }

  // The decoded volume is large — 38.5 MB for the 50 µm Allen annotation — so
  // the typed array is layered directly over the decompressed buffer rather
  // than copied out of it. Copy only when the payload does not start on the
  // element alignment a typed-array view requires.
  const aligned =
    payload.byteOffset % BYTES_PER_ELEMENT[type] === 0 ? payload : payload.slice()

  const spacing = parseSpacing(header, 3)

  return {
    shape: sizes,
    type,
    spacing: [spacing[0] ?? 1, spacing[1] ?? 1, spacing[2] ?? 1],
    data: makeTypedArray(type, aligned.buffer, count, aligned.byteOffset),
    header,
  }
}
