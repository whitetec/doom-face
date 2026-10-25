// Lector mínimo de WAD: saca de la paleta y los parches del status bar las caras del Doomguy,
// listas para un Image como píxeles RGBA. Lee por rangos, nunca el archivo entero.

export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>
export type Face = { rgba: string; width: number; height: number }

// Las caras de DOOM caben en 32x32 una vez ubicadas con sus offsets; se escalan sin suavizado.
const CANVAS = 32
export const SCALE = 4

const name8 = (b: Uint8Array, at: number) => {
  let s = ''
  for (let i = 0; i < 8 && b[at + i]; i++) s += String.fromCharCode(b[at + i]!)
  return s.toUpperCase()
}

// base64 con atob/btoa: los tipos de este build no declaran Uint8Array.toBase64/fromBase64.
export function toBase64(b: Uint8Array) {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text: string) {
  const s = atob(text)
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}

export const isFaceLump = (name: string) => name.startsWith('STF') && !name.startsWith('STFB')

// Dibuja un parche (formato picture de DOOM) en un lienzo de 32x32, RGBA.
export function drawPatch(patch: Uint8Array, palette: Uint8Array) {
  const v = new DataView(patch.buffer, patch.byteOffset, patch.byteLength)
  const w = v.getInt16(0, true)
  const left = v.getInt16(4, true)
  const top = v.getInt16(6, true)
  const px = new Uint8Array(CANVAS * CANVAS * 4)
  for (let x = 0; x < w; x++) {
    let p = v.getUint32(8 + 4 * x, true)
    while (patch[p] !== 255 && p < patch.length) {
      const row = patch[p]!
      const len = patch[p + 1]!
      for (let j = 0; j < len; j++) {
        const cx = x - left
        const cy = row + j - top
        if (cx < 0 || cy < 0 || cx >= CANVAS || cy >= CANVAS) continue
        const c = patch[p + 3 + j]!
        const o = (cy * CANVAS + cx) * 4
        px[o] = palette[3 * c]!
        px[o + 1] = palette[3 * c + 1]!
        px[o + 2] = palette[3 * c + 2]!
        px[o + 3] = 255
      }
      p += len + 4
    }
  }
  return px
}

export function upscale(px: Uint8Array, size = CANVAS, k = SCALE) {
  const out = new Uint8Array(size * k * size * k * 4)
  const row = size * k
  for (let y = 0; y < size * k; y++) {
    for (let x = 0; x < row; x++) {
      const s = (Math.floor(y / k) * size + Math.floor(x / k)) * 4
      out.set(px.subarray(s, s + 4), (y * row + x) * 4)
    }
  }
  return out
}

export async function loadFaces(read: ReadRange): Promise<Record<string, Face>> {
  const head = await read(0, 12)
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const kind = String.fromCharCode(...head.subarray(0, 4))
  if (kind !== 'IWAD' && kind !== 'PWAD') throw new Error('no es un WAD')
  const count = hv.getInt32(4, true)
  const dirAt = hv.getInt32(8, true)
  const dir = await read(dirAt, count * 16)
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)

  let palette: { at: number; size: number } | null = null
  const lumps: { name: string; at: number; size: number }[] = []
  for (let i = 0; i < count; i++) {
    const at = dv.getInt32(16 * i, true)
    const size = dv.getInt32(16 * i + 4, true)
    const name = name8(dir, 16 * i + 8)
    if (name === 'PLAYPAL') palette ??= { at, size }
    else if (isFaceLump(name)) lumps.push({ name, at, size })
  }
  if (!palette || lumps.length === 0) throw new Error('el WAD no trae las caras del status bar')

  const pal = await read(palette.at, 768)
  // Las caras van juntas en el WAD: un solo rango las trae a todas.
  const from = Math.min(...lumps.map(l => l.at))
  const to = Math.max(...lumps.map(l => l.at + l.size))
  const block = await read(from, to - from)

  const faces: Record<string, Face> = {}
  for (const l of lumps) {
    const px = upscale(drawPatch(block.subarray(l.at - from, l.at - from + l.size), pal))
    faces[l.name] = { rgba: toBase64(px), width: CANVAS * SCALE, height: CANVAS * SCALE }
  }
  return faces
}
