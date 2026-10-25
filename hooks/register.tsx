import type { EngineInterface, Register, Timer } from 'claude-code'

import { type Face, fromBase64, loadFaces } from './wad'

// A gesture names a sprite without its health digit: ST0..ST2 (looking left, ahead, right),
// TL/TR (head turned), OUCH, EVL (grin), KILL (rampage), and the health-less GOD and DEAD.
// A sequence is a list of [gesture, ms] frames.
export type Seq = readonly (readonly [string, number])[]

// Base state: idle, working without tools, running a tool, or waiting for permission.
export type Mode = 'idle' | 'work' | 'tool' | 'ask'
export type ToolKind = 'read' | 'edit' | 'bash' | 'agent' | 'other'

const KEY = 'face'
const TICK = 100

// How much he moves, from the motion option: full animation, calm (slower, no flickers or
// jolts), or still (one face per state).
export type Motion = 'full' | 'calm' | 'still'
export const motionOf = (v: unknown): Motion => (v === 'calm' || v === 'still' ? v : 'full')

// The face's box in terminal cells, from the size option; each keeps the 2:1 cell ratio square.
const SIZES: Record<string, { columns: number; rows: number }> = {
  small: { columns: 4, rows: 2 },
  medium: { columns: 6, rows: 3 },
  large: { columns: 8, rows: 4 },
}

const cfg = { motion: 'full' as Motion, size: SIZES.medium! }

// How a tool's name maps to the way he reacts to it.
export const toolKind = (tool: string): ToolKind =>
  /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|NotebookRead)$/.test(tool)
    ? 'read'
    : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)
      ? 'edit'
      : tool === 'Bash'
        ? 'bash'
        : /^(Agent|Task)$/.test(tool)
          ? 'agent'
          : 'other'

// Looping faces while a tool runs. Reading scans side to side; Bash is the rampage face
// with a flicker, like holding the trigger; editing alternates focus and a grin; agents grin
// as they are summoned.
export const TOOL_SEQ: Record<ToolKind, Seq> = {
  read: [['TL', 380], ['ST1', 160], ['TR', 380], ['ST1', 160]],
  edit: [['KILL', 700], ['ST1', 150], ['KILL', 500], ['EVL', 450]],
  bash: [['KILL', 650], ['ST1', 90], ['KILL', 400], ['ST1', 90]],
  agent: [['EVL', 700], ['KILL', 500], ['TL', 250], ['TR', 250]],
  other: [['KILL', 600], ['ST1', 150]],
}

// Waiting for permission: glances from side to side, checking back at you.
export const ASK_SEQ: Seq = [['TL', 500], ['ST1', 250], ['TR', 500], ['ST1', 250]]

// One-shot reactions, played once over the base state.
export const FLASH_SEQ = {
  // A tool failed: hit, the head snaps to one side, then the other.
  pain: [['OUCH', 650], ['TL', 280], ['TR', 280], ['OUCH', 650], ['ST1', 300], ['OUCH', 500]],
  // The context jumped: a hit from one side, as DOOM turns the face toward the damage.
  hit: [['TR', 350], ['OUCH', 450], ['ST1', 200]],
  // The health level just dropped a step: a big hit.
  wound: [['OUCH', 900], ['TL', 300], ['OUCH', 700], ['TR', 300]],
  // Turn finished: a look, then the evil grin.
  grin: [['ST1', 250], ['EVL', 1600], ['ST2', 250], ['EVL', 700]],
  // Interrupted with Esc.
  dead: [['OUCH', 400], ['DEAD', 2800]],
  // Context compacted: back to full health with God Mode eyes, then a grin.
  god: [['GOD', 1800], ['EVL', 900], ['GOD', 900]],
} satisfies Record<string, Seq>
export type Flash = keyof typeof FLASH_SEQ

// Working without tools: the gestures he rotates through, with weights, by what the model is
// doing; never the neutral face. Thinking glances and focuses; at high effort and above he
// strains and changes faster; writing the answer is focus and a grin.
export type WorkSet = 'think' | 'deep' | 'write'
export const WORK_SETS: Record<WorkSet, Seq> = {
  think: [['TL', 30], ['TR', 30], ['KILL', 28], ['OUCH', 12]],
  deep: [['KILL', 34], ['OUCH', 26], ['TL', 15], ['TR', 15], ['EVL', 10]],
  write: [['KILL', 45], ['EVL', 35], ['TL', 10], ['TR', 10]],
}
// Milliseconds between gesture changes, as [least, random spread]; calm stretches them 2.7 times.
const WORK_PACE: Record<WorkSet, readonly [number, number]> = { think: [1500, 1000], deep: [900, 700], write: [1500, 1000] }

// The model's effort as a rank, 0 (low) to 4 (max); -1 when the model takes none.
export const effortRank = (e: unknown) => ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(String(e))
export const workSet = (phase: Phase, effort: number): WorkSet => (phase === 'write' ? 'write' : effort >= 2 ? 'deep' : 'think')
export type Phase = 'think' | 'write'

// At max effort, after this long thinking, his eyes flash gold now and then.
const GLIMPSE_AFTER_MS = 20000
const GLIMPSE_MS = 650

// A rise in context of this many points in one measure counts as a hit.
const HIT_POINTS = 3

type Anim = { mode: Mode; kind?: ToolKind; flash?: Flash; work?: { phase: Phase; effort: number }; label: string }

// Module state: a hot reload drops it and it rebuilds itself.
const s = {
  pct: 0,
  working: false,
  asking: false,
  tools: 0,
  kind: 'other' as ToolKind,
  toolSince: 0,
  toolUntil: 0,
  flash: null as Flash | null,
  flashSince: 0,
  look: 1,
  nextLook: 0,
  work: 'KILL',
  nextWork: 0,
  workSet: 'think' as WorkSet,
  // What the model streams now (thinking or the answer's text), at what effort, and since when.
  phase: 'think' as Phase,
  effort: -1,
  thinkSince: 0,
  glimpseUntil: 0,
  nextGlimpse: 0,
  requestId: null as string | null,
  shown: '',
  // /doom preview: overrides the live face until `until`.
  preview: null as { anim: Anim; h: number; since: number; until: number } | null,
}

// The animations /doom can show, by the name the command takes.
export const ANIMS: Record<string, Anim> = {
  idle: { mode: 'idle', label: 'idle: looks around' },
  thinking: { mode: 'work', work: { phase: 'think', effort: 1 }, label: 'thinking, low or medium effort' },
  deep: { mode: 'work', work: { phase: 'think', effort: 3 }, label: 'thinking, high or xhigh effort' },
  max: { mode: 'work', work: { phase: 'think', effort: 4 }, label: 'thinking, max effort, past 20 s' },
  writing: { mode: 'work', work: { phase: 'write', effort: 1 }, label: 'writing the answer' },
  read: { mode: 'tool', kind: 'read', label: 'reading or searching' },
  edit: { mode: 'tool', kind: 'edit', label: 'editing files' },
  bash: { mode: 'tool', kind: 'bash', label: 'running Bash' },
  agent: { mode: 'tool', kind: 'agent', label: 'launching an agent' },
  permission: { mode: 'ask', label: 'waiting for permission' },
  hit: { mode: 'idle', flash: 'hit', label: 'context jumped' },
  wound: { mode: 'idle', flash: 'wound', label: 'health dropped a level' },
  pain: { mode: 'idle', flash: 'pain', label: 'a tool failed' },
  grin: { mode: 'idle', flash: 'grin', label: 'turn finished' },
  dead: { mode: 'idle', flash: 'dead', label: 'interrupted with Esc' },
  god: { mode: 'idle', flash: 'god', label: 'context compacted' },
}

const PREVIEW_MS = 6000
const DEMO_MS = 3500

// Pain level as in DOOM (ST_calcPainOffset): health = 100 - % of context used.
export const painLevel = (pct: number) => Math.min(4, Math.floor((Math.max(0, Math.min(100, pct)) * 5) / 101))

export const seqLength = (seq: Seq) => seq.reduce((n, [, ms]) => n + ms, 0)

// The gesture a sequence spends the most time on.
const dominant = (seq: Seq) => {
  const time = new Map<string, number>()
  for (const [g, ms] of seq) time.set(g, (time.get(g) ?? 0) + ms)
  return [...time].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'ST1'
}

// A sequence as the motion option plays it. Calm drops the frames under 200 ms (the flickers)
// and plays loops 2.5 times slower; still holds the dominant gesture, a one-shot for at most 2.5 s.
export function shape(seq: Seq, motion: Motion, loop: boolean): Seq {
  if (motion === 'full') return seq
  if (motion === 'still') return [[dominant(seq), loop ? 1000 : Math.min(2500, seqLength(seq))]]
  const kept = seq.filter(([, ms]) => ms >= 200)
  const base = kept.length > 0 ? kept : seq
  return loop ? base.map(([g, ms]) => [g, ms * 2.5] as const) : base
}

const shapedCache = new Map<Seq, Map<string, Seq>>()
const shaped = (seq: Seq, motion: Motion, loop: boolean) => {
  const byMotion = shapedCache.get(seq) ?? new Map<string, Seq>()
  shapedCache.set(seq, byMotion)
  const key = `${motion}:${loop}`
  const out = byMotion.get(key) ?? shape(seq, motion, loop)
  byMotion.set(key, out)
  return out
}

// The gesture a sequence shows `elapsed` ms after it started; null once a one-shot is over.
export const frameAt = (seq: Seq, elapsed: number, loop: boolean) => {
  const total = seqLength(seq)
  if (!loop && elapsed >= total) return null
  let t = loop ? elapsed % total : elapsed
  for (const [g, ms] of seq) {
    if (t < ms) return g
    t -= ms
  }
  return seq[seq.length - 1]?.[0] ?? 'ST1'
}

// Picks a gesture from a working set for r in [0, 1).
export const pickWork = (r: number, set: Seq = WORK_SETS.think) => {
  const total = set.reduce((n, [, w]) => n + w, 0)
  let acc = 0
  for (const [k, w] of set) {
    acc += w / total
    if (r < acc) return k
  }
  return 'KILL'
}

// The sprite name for a gesture at health level h.
export const gesture = (k: string, h: number) =>
  k === 'GOD' || k === 'DEAD'
    ? `STF${k}0`
    : k.startsWith('ST')
      ? `STFST${h}${k.slice(2)}`
      : k === 'TL' || k === 'TR'
        ? `STF${k}${h}0`
        : `STF${k}${h}`

export type Live = { mode: Mode; kind: ToolKind; flash: Flash | null; flashSince: number; toolSince: number }

export const faceName = (h: number, live: Live, look: number, work: string, now: number, motion: Motion = 'full') => {
  if (live.flash) {
    const g = frameAt(shaped(FLASH_SEQ[live.flash], motion, false), now - live.flashSince, false)
    if (g) return gesture(g, h)
  }
  if (live.mode === 'tool') return gesture(frameAt(shaped(TOOL_SEQ[live.kind], motion, true), now - live.toolSince, true) ?? 'KILL', h)
  if (live.mode === 'ask') return gesture(frameAt(shaped(ASK_SEQ, motion, true), now, true) ?? 'ST1', h)
  if (live.mode === 'work') return gesture(motion === 'still' ? 'KILL' : work, h)
  return gesture(motion === 'still' ? 'ST1' : `ST${look}`, h)
}

// How long a one-shot runs under the current motion option.
const flashLength = (f: Flash) => seqLength(shaped(FLASH_SEQ[f], cfg.motion, false))

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
  const calm = cfg.motion === 'calm'
  if (s.flash && now - s.flashSince >= flashLength(s.flash)) s.flash = null
  // Idle, he looks around as in DOOM: mostly ahead, a glance aside every half second to two
  // (every 3 to 8 s when calm).
  if (now >= s.nextLook) {
    const r = Math.random()
    s.look = r < 0.5 ? 1 : r < 0.75 ? 0 : 2
    s.nextLook = now + (calm ? 3000 + Math.random() * 5000 : 500 + Math.random() * 1500)
  }
  const p = s.preview && now < s.preview.until ? s.preview : null
  // Working, the set follows what the model does and how hard it thinks; a new set picks at once.
  const w = p?.anim.work ?? { phase: s.phase, effort: s.effort }
  const set = workSet(w.phase, w.effort)
  if (set !== s.workSet) {
    s.workSet = set
    s.nextWork = 0
  }
  if (now >= s.nextWork) {
    let k = s.work
    while (k === s.work) k = pickWork(Math.random(), WORK_SETS[set])
    s.work = k
    const [least, spread] = WORK_PACE[set]
    s.nextWork = now + (least + Math.random() * spread) * (calm ? 2.7 : 1)
  }
  // Max effort, thinking past 20 s: a glimpse of God Mode eyes every 6 to 10 s (full motion only).
  const thinking = p ? p.anim.mode === 'work' && w.phase === 'think' : mode(now) === 'work' && s.phase === 'think' && !s.flash
  const thoughtFor = p ? GLIMPSE_AFTER_MS + now - p.since : now - s.thinkSince
  if (cfg.motion === 'full' && thinking && w.effort === 4 && thoughtFor >= GLIMPSE_AFTER_MS && now >= s.nextGlimpse) {
    s.glimpseUntil = now + GLIMPSE_MS
    s.nextGlimpse = now + 6000 + Math.random() * 4000
  }
  if (thinking && now < s.glimpseUntil) return 'STFGOD0'
  if (p) {
    const live: Live = { mode: p.anim.mode, kind: p.anim.kind ?? 'other', flash: p.anim.flash ?? null, flashSince: p.since, toolSince: p.since }
    return faceName(p.h, live, s.look, s.work, now, cfg.motion)
  }
  s.preview = null
  const live: Live = { mode: mode(now), kind: s.kind, flash: s.flash, flashSince: s.flashSince, toolSince: s.toolSince }
  return faceName(painLevel(s.pct), live, s.look, s.work, now, cfg.motion)
}

async function flash($: EngineInterface, f: Flash) {
  s.flash = f
  s.flashSince = Date.now()
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

export const register: Register = (on, options) => {
  cfg.motion = motionOf(options.motion)
  cfg.size = SIZES[String(options.size)] ?? SIZES.medium!
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

  // No toasts while previewing: a toast takes a row of the footer and makes the face jump.
  on('command.run', { command: 'doom' }, async ($, e) => {
    const [what = '', lvl] = e.args.trim().toLowerCase().split(/\s+/)
    const n = lvl === undefined ? painLevel(s.pct) : Number(lvl)
    if (!Number.isInteger(n) || n < 0 || n > 4) return { text: USAGE }
    demo?.cancel()
    demo = null

    // Health: walks the 5 idle levels, from healthy to bloody.
    const steps =
      what === 'demo'
        ? Object.values(ANIMS).map(a => ({ anim: a, h: n }))
        : what === 'health'
          ? [0, 1, 2, 3, 4].map(h => ({ anim: ANIMS.idle!, h }))
          : ANIMS[what]
            ? [{ anim: ANIMS[what]!, h: n }]
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
      const now = Date.now()
      s.preview = { anim: st.anim, h: st.h, since: now, until: now + ms }
      void paint($)
      i += 1
    }
    show()
    if (steps.length > 1) demo = $.clock.every(ms, show)
    const secs = Math.round((ms * steps.length) / 1000)
    const list = what === 'demo' ? Object.keys(ANIMS).join(', ') : what === 'health' ? 'levels 0 to 4' : steps[0]!.anim.label
    return { text: `Showing ${list} for ${secs} s.` }
  })

  on('session.measure', async ($, e, next) => {
    const before = s.pct
    s.pct = e.context.percent ?? s.pct
    // A big drop in context is a compaction: back to full health, with God Mode for a while.
    // A rise is damage: a hit, or a wound when it costs a health level.
    if (before - s.pct >= 30) await flash($, 'god')
    else if (painLevel(s.pct) > painLevel(before)) await flash($, 'wound')
    else if (s.pct - before >= HIT_POINTS && !s.flash && cfg.motion === 'full') await flash($, 'hit')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      s.working = true
      s.asking = false
      s.phase = 'think'
      s.thinkSince = Date.now()
      await paint($)
    }
    return next(e)
  })

  // Each request to the model: its effort, and whether what streams back is thinking or the
  // answer's text. Every chunk is passed on untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    s.effort = effortRank(e.effort)
    s.phase = 'think'
    s.thinkSince = Date.now()
    for await (const c of next(e)) {
      if (c.kind === 'text' && s.phase !== 'write') s.phase = 'write'
      else if (c.kind === 'thinking' && s.phase !== 'think') {
        s.phase = 'think'
        s.thinkSince = Date.now()
      }
      yield c
    }
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
      const now = Date.now()
      const kind = toolKind(e.tool)
      s.asking = false
      s.tools += 1
      if (kind !== s.kind || now >= s.toolUntil) s.toolSince = now
      s.kind = kind
      // Even a tool that takes milliseconds holds its face for one full pass of its sequence.
      s.toolUntil = Math.max(s.toolUntil, now + Math.max(1200, seqLength(shaped(TOOL_SEQ[kind], cfg.motion, true))))
      await paint($)
    }
    try {
      const r = await next(e)
      if (main && (('deny' in r && r.deny) || r.isError)) await flash($, 'pain')
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
      await flash($, e.isAborted ? 'dead' : e.reason === 'error' ? 'pain' : 'grin')
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
          <Image key={KEY} source={source(s.shown)} columns={cfg.size.columns} rows={cfg.size.rows} alt=" " />
        </Box>
      </Box>
    )
  })
}
