import type { EngineInterface, Register, Timer } from 'claude-code'

import { type Face, fromBase64, loadFaces } from './wad'

// Base state: idle, working without tools, running a tool, or waiting for permission.
export type Mode = 'idle' | 'work' | 'tool' | 'ask'
// Short-lived expressions over the base state: pain, grin, God Mode, dead.
export type Flash = 'OUCH' | 'EVL' | 'GOD' | 'DEAD'

const KEY = 'face'
const COLS = 6
const ROWS = 3
const TICK = 150

// The least each expression lasts, so it can be seen.
const TOOL_MIN_MS = 1200
const HEAVY_TOOL_MIN_MS = 2200
const HEAVY_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch'])
const FLASH_MS: Record<Flash, number> = { OUCH: 3000, EVL: 2500, GOD: 3000, DEAD: 3000 }

// Working: rotates between gestures with these weights, never the neutral face (ST).
// TL/TR = turns his head, OUCH = surprise, KILL = focused.
export const WORK_FACES: readonly (readonly [string, number])[] = [
  ['TL', 25],
  ['TR', 25],
  ['KILL', 30],
  ['OUCH', 20],
]

// Module state: a hot reload drops it and it rebuilds itself.
const s = {
  pct: 0,
  working: false,
  asking: false,
  tools: 0,
  toolUntil: 0,
  flash: null as Flash | null,
  flashUntil: 0,
  look: 1,
  nextLook: 0,
  work: 'KILL',
  nextWork: 0,
  requestId: null as string | null,
  shown: '',
  // /doom preview: overrides the live face until `until`.
  preview: null as { mode: Mode; flash: Flash | null; h: number; until: number } | null,
}

// The animations /doom can show, by the name the command takes.
export const ANIMS: Record<string, { mode: Mode; flash: Flash | null; label: string }> = {
  idle: { mode: 'idle', flash: null, label: 'idle: looks around' },
  working: { mode: 'work', flash: null, label: 'thinking or writing: random gestures' },
  tool: { mode: 'tool', flash: null, label: 'running a tool' },
  permission: { mode: 'ask', flash: null, label: 'waiting for permission' },
  pain: { mode: 'idle', flash: 'OUCH', label: 'error' },
  grin: { mode: 'idle', flash: 'EVL', label: 'turn finished' },
  dead: { mode: 'idle', flash: 'DEAD', label: 'interrupted with Esc' },
  god: { mode: 'idle', flash: 'GOD', label: 'context compacted' },
}

const PREVIEW_MS = 6000
const DEMO_MS = 4000

// Pain level as in DOOM (ST_calcPainOffset): health = 100 - % of context used.
export const painLevel = (pct: number) => Math.min(4, Math.floor((Math.max(0, Math.min(100, pct)) * 5) / 101))

// Picks a gesture from WORK_FACES for r in [0, 1).
export const pickWork = (r: number) => {
  const total = WORK_FACES.reduce((n, [, w]) => n + w, 0)
  let acc = 0
  for (const [k, w] of WORK_FACES) {
    acc += w / total
    if (r < acc) return k
  }
  return 'KILL'
}

// The sprite name for a gesture: ST0..2, TL, TR, OUCH, KILL, EVL.
export const gesture = (k: string, h: number) =>
  k.startsWith('ST') ? `STFST${h}${k.slice(2)}` : k === 'TL' || k === 'TR' ? `STF${k}${h}0` : `STF${k}${h}`

export const faceName = (h: number, mode: Mode, flash: Flash | null, look: number, work: string, now: number) => {
  if (flash === 'GOD') return 'STFGOD0'
  if (flash === 'DEAD') return 'STFDEAD0'
  if (flash) return `STF${flash}${h}`
  if (mode === 'tool') return `STFKILL${h}`
  // Waiting for permission: glances nervously from side to side.
  if (mode === 'ask') return Math.floor(now / 600) % 2 ? `STFTL${h}0` : `STFTR${h}0`
  if (mode === 'work') return gesture(work, h)
  return `STFST${h}${look}`
}

// The WAD that ships with the mod: doom1.wad shareware v1.9, unmodified.
const WAD = 'assets/doom1.wad'

// The faces are read from the WAD at start; until then the corner stays as Claude Code draws it.
let faces: Record<string, Face> | null = null

const source = (name: string) => faces?.[name] ?? faces?.STFST01 ?? { rgba: '', width: 1, height: 1 }

// Reads one range of the WAD with tail and head: $.fs.read stops at 4 MiB and the whole WAD is larger.
async function wadFaces($: EngineInterface) {
  const path = `${$.plugin.root}/${WAD}`
  return loadFaces(async (offset, length) => {
    const r = await $.process.run(['sh', '-c', 'tail -c +"$2" "$1" | head -c "$3" | base64', 'sh', path, String(offset + 1), String(length)])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `could not read ${path}`)
    return fromBase64(r.stdout.replace(/\s+/g, ''))
  })
}

function mode(now: number): Mode {
  if (s.tools > 0 || now < s.toolUntil) return 'tool'
  if (s.asking) return 'ask'
  return s.working ? 'work' : 'idle'
}

function current(now: number) {
  if (s.flash && now >= s.flashUntil) s.flash = null
  // Idle, he looks around: a new glance every half second to two, at random.
  if (now >= s.nextLook) {
    s.look = Math.floor(Math.random() * 3)
    s.nextLook = now + 500 + Math.random() * 1500
  }
  // Working, he changes gesture every 1.5 to 2.5 s, never repeating the last one.
  if (now >= s.nextWork) {
    let k = s.work
    while (k === s.work) k = pickWork(Math.random())
    s.work = k
    s.nextWork = now + 1500 + Math.random() * 1000
  }
  const p = s.preview
  if (p && now < p.until) return faceName(p.h, p.mode, p.flash, s.look, s.work, now)
  s.preview = null
  return faceName(painLevel(s.pct), mode(now), s.flash, s.look, s.work, now)
}

async function flash($: EngineInterface, f: Flash) {
  s.flash = f
  s.flashUntil = Date.now() + FLASH_MS[f]
  await paint($)
}

// Never throws: it runs inside tool.call and tool.check, where an error must not touch the tool.
async function paint($: EngineInterface) {
  try {
    const name = current(Date.now())
    if (name === s.shown || !s.requestId) return
    s.shown = name
    await $.ui.blit({ requestId: s.requestId, key: KEY, source: source(name) })
  } catch {
    // No image mounted yet: the next draw puts it there.
    s.shown = ''
  }
}

const USAGE = `Usage: /doom <animation> [level 0-4] | /doom demo [level] | /doom health\nAnimations: ${Object.keys(ANIMS).join(', ')}`

export const register: Register = on => {
  let tick: Timer | null = null
  let demo: Timer | null = null

  on('session.start', async ($, e, next) => {
    const { context } = await $.session.usage()
    s.pct = context.percent ?? 0
    if (!faces) {
      try {
        faces = await wadFaces($)
        $.ui.invalidate('ui.render')
      } catch (err) {
        $.ui.toast(`doom-face: could not read the faces from the WAD (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    tick?.cancel()
    tick = $.clock.every(TICK, () => void paint($))
    await $.command.register({ name: 'doom', description: 'Preview the DOOM face animations', argumentHint: '<animation|demo|health> [level 0-4]' })
    return next(e)
  })

  on('command.run', { command: 'doom' }, async ($, e) => {
    const [what = '', lvl] = e.args.trim().toLowerCase().split(/\s+/)
    const n = lvl === undefined ? painLevel(s.pct) : Number(lvl)
    if (!Number.isInteger(n) || n < 0 || n > 4) return { text: USAGE }
    demo?.cancel()
    demo = null

    // Health: walks the 5 idle levels, from healthy to bloody.
    const steps =
      what === 'demo'
        ? Object.entries(ANIMS).map(([k, a]) => ({ ...a, h: n, label: `${k} (${a.label})` }))
        : what === 'health'
          ? [0, 1, 2, 3, 4].map(h => ({ ...ANIMS.idle!, h, label: `health level ${h}` }))
          : ANIMS[what]
            ? [{ ...ANIMS[what]!, h: n, label: `${what} (${ANIMS[what]!.label})` }]
            : null
    if (!steps) return { text: USAGE }

    const ms = steps.length > 1 ? DEMO_MS : PREVIEW_MS
    let i = 0
    const show = () => {
      const st = steps[i]
      if (!st) {
        demo?.cancel()
        demo = null
        return
      }
      s.preview = { mode: st.mode, flash: st.flash, h: st.h, until: Date.now() + ms }
      $.ui.toast(`doom: ${st.label}, level ${st.h}`)
      void paint($)
      i += 1
    }
    show()
    if (steps.length > 1) demo = $.clock.every(ms, show)
    const secs = Math.round((ms * steps.length) / 1000)
    return { text: `Showing ${steps.length === 1 ? steps[0]!.label : `${steps.length} animations`} for ${secs} s.` }
  })

  on('session.measure', async ($, e, next) => {
    const before = s.pct
    s.pct = e.context.percent ?? s.pct
    // A big drop in context is a compaction: back to full health, with God Mode for a while.
    if (before - s.pct >= 30) await flash($, 'GOD')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      s.working = true
      s.asking = false
      await paint($)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'ask' && !e.agentId) {
      s.asking = true
      await paint($)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const main = !e.agentId
    if (main) {
      s.asking = false
      s.tools += 1
      // The tool face holds for a minimum even when the tool takes milliseconds.
      s.toolUntil = Math.max(s.toolUntil, Date.now() + (HEAVY_TOOLS.has(e.tool) ? HEAVY_TOOL_MIN_MS : TOOL_MIN_MS))
      await paint($)
    }
    try {
      const r = await next(e)
      if (main && (('deny' in r && r.deny) || r.isError)) await flash($, 'OUCH')
      return r
    } finally {
      if (main) {
        s.tools = Math.max(0, s.tools - 1)
        await paint($)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      s.working = false
      s.asking = false
      s.tools = 0
      s.toolUntil = 0
      await flash($, e.isAborted ? 'DEAD' : e.reason === 'error' ? 'OUCH' : 'EVL')
    }
    return next(e)
  })

  // The footer's right corner: Claude Code's mode labels, with the face beside them.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !faces) return next(e)
    const { Box, Image } = $.ui.resolve(e)
    const own = await next(e)
    s.requestId = e.requestId
    s.shown = current(Date.now())

    return (
      <Box flexDirection="row" alignItems="flex-end">
        {own}
        <Box marginLeft={1}>
          <Image key={KEY} source={source(s.shown)} columns={COLS} rows={ROWS} alt=" " />
        </Box>
      </Box>
    )
  })
}
