import { expect, test } from 'claude-code/testing'

import { faceName, gesture, painLevel, pickWork } from '../hooks/register'
import { fromBase64, loadFaces } from '../hooks/wad'

test('health follows the context like DOOM\'s pain level', () => {
  expect(painLevel(0)).toBe(0)
  expect(painLevel(20)).toBe(0)
  expect(painLevel(21)).toBe(1)
  expect(painLevel(85)).toBe(4)
  expect(painLevel(100)).toBe(4)
  expect(faceName(2, 'tool', null, 1, 'ST1', 0)).toBe('STFKILL2')
  expect(faceName(3, 'idle', 'OUCH', 1, 'ST1', 0)).toBe('STFOUCH3')
  expect(faceName(1, 'idle', null, 2, 'ST1', 0)).toBe('STFST12')
  expect(faceName(2, 'work', null, 1, 'TL', 0)).toBe('STFTL20')
})

test('working gestures are real sprites and never the neutral face', () => {
  for (const r of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.999]) {
    const k = pickWork(r)
    for (const h of [0, 1, 2, 3, 4]) expect(gesture(k, h)).toMatch(/^STF(T[LR][0-4]0|OUCH[0-4]|KILL[0-4])$/)
  }
})

// A minimal WAD: PLAYPAL with color 7 in red, and a 1x2 pixel face at offset (-5, -2).
function tinyWad() {
  const pal = new Uint8Array(768)
  pal.set([255, 0, 0], 21)
  const patch = new Uint8Array([1, 0, 2, 0, 0xfb, 0xff, 0xfe, 0xff, 12, 0, 0, 0, 0, 2, 0, 7, 7, 0, 255])
  const lumps = [
    { name: 'PLAYPAL', data: pal },
    { name: 'STFST01', data: patch },
  ]
  let at = 12
  const dir: number[] = []
  const body: number[] = []
  for (const l of lumps) {
    const entry = new Uint8Array(16)
    const v = new DataView(entry.buffer)
    v.setInt32(0, at, true)
    v.setInt32(4, l.data.length, true)
    for (let i = 0; i < l.name.length; i++) entry[8 + i] = l.name.charCodeAt(i)
    dir.push(...entry)
    body.push(...l.data)
    at += l.data.length
  }
  const head = new Uint8Array(12)
  const hv = new DataView(head.buffer)
  head.set([73, 87, 65, 68])
  hv.setInt32(4, lumps.length, true)
  hv.setInt32(8, at, true)
  return new Uint8Array([...head, ...body, ...dir])
}

test('the WAD reader places each patch by its offsets and scales it', async () => {
  const wad = tinyWad()
  const faces = await loadFaces(async (o, n) => wad.slice(o, o + n))
  const face = faces.STFST01!
  expect(face.width).toBe(128)
  const px = fromBase64(face.rgba)
  // The patch's pixel (0, 0) lands on (5, 2) of the 32 canvas, and on (20..23, 8..11) at 4x.
  const at = (x: number, y: number) => Array.from(px.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4))
  expect(at(20, 8)).toEqual([255, 0, 0, 255])
  expect(at(23, 15)).toEqual([255, 0, 0, 255])
  expect(at(19, 8)).toEqual([0, 0, 0, 0])
  expect(at(20, 16)).toEqual([0, 0, 0, 0])
})

test('without faces loaded the footer stays as Claude Code draws it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>/rc</Text>
  })

  const ui = await $.ui.mount({ plugin: 'doom-face', component: 'SessionMode', requestId: 'mode', surface: 'terminal', props: { modes: ['/rc'] } })
  expect(await ui.find({ type: 'Image', key: 'face' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /\/rc/ }))?.text).toBe('/rc')
  await ui.unmount()
})
