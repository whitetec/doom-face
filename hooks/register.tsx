import type { EngineInterface, Register, Timer } from 'claude-code'

import { type Face, fromBase64, loadFaces } from './wad'

// Estado base: quieto, trabajando sin herramientas, con una herramienta corriendo, o esperando permiso.
export type Mode = 'idle' | 'work' | 'tool' | 'ask'
// Expresiones temporales encima del estado base: dolor, sonrisa, God Mode, muerto.
export type Flash = 'OUCH' | 'EVL' | 'GOD' | 'DEAD'

const KEY = 'face'
const COLS = 6
const ROWS = 3
const TICK = 150

// Cuánto dura cada expresión como mínimo, para que se llegue a ver.
const TOOL_MIN_MS = 1200
const HEAVY_TOOL_MIN_MS = 2200
const HEAVY_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch'])
const FLASH_MS: Record<Flash, number> = { OUCH: 3000, EVL: 2500, GOD: 3000, DEAD: 3000 }

// Trabajando: rota entre gestos con estos pesos, nunca la cara neutral (ST).
// TL/TR = gira la cabeza, OUCH = sorpresa, KILL = concentrado.
export const WORK_FACES: readonly (readonly [string, number])[] = [
  ['TL', 25],
  ['TR', 25],
  ['KILL', 30],
  ['OUCH', 20],
]

// Estado del módulo, como session-vitals: se pierde en un hot reload y se rearma solo.
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
  // Vista previa de /doom: pisa la cara real hasta `until`.
  preview: null as { mode: Mode; flash: Flash | null; h: number; until: number } | null,
}

// Las animaciones que /doom puede mostrar, con el nombre que usa el operador.
export const ANIMS: Record<string, { mode: Mode; flash: Flash | null; label: string }> = {
  reposo: { mode: 'idle', flash: null, label: 'en reposo: mira alrededor' },
  trabajando: { mode: 'work', flash: null, label: 'pensando o escribiendo: gestos al azar' },
  herramienta: { mode: 'tool', flash: null, label: 'ejecutando una herramienta' },
  permiso: { mode: 'ask', flash: null, label: 'esperando permiso' },
  dolor: { mode: 'idle', flash: 'OUCH', label: 'error' },
  sonrisa: { mode: 'idle', flash: 'EVL', label: 'fin de turno' },
  muerto: { mode: 'idle', flash: 'DEAD', label: 'cortado con Esc' },
  god: { mode: 'idle', flash: 'GOD', label: 'compactación' },
}

const PREVIEW_MS = 6000
const DEMO_MS = 4000

// Nivel de dolor como en DOOM (ST_calcPainOffset): salud = 100 - % de contexto usado.
export const painLevel = (pct: number) => Math.min(4, Math.floor((Math.max(0, Math.min(100, pct)) * 5) / 101))

// Elige un gesto de WORK_FACES según r en [0, 1).
export const pickWork = (r: number) => {
  const total = WORK_FACES.reduce((n, [, w]) => n + w, 0)
  let acc = 0
  for (const [k, w] of WORK_FACES) {
    acc += w / total
    if (r < acc) return k
  }
  return 'KILL'
}

// El nombre del sprite para un gesto: ST0..2, TL, TR, OUCH, KILL, EVL.
export const gesture = (k: string, h: number) =>
  k.startsWith('ST') ? `STFST${h}${k.slice(2)}` : k === 'TL' || k === 'TR' ? `STF${k}${h}0` : `STF${k}${h}`

export const faceName = (h: number, mode: Mode, flash: Flash | null, look: number, work: string, now: number) => {
  if (flash === 'GOD') return 'STFGOD0'
  if (flash === 'DEAD') return 'STFDEAD0'
  if (flash) return `STF${flash}${h}`
  if (mode === 'tool') return `STFKILL${h}`
  // Esperando permiso: mira nervioso a un lado y al otro.
  if (mode === 'ask') return Math.floor(now / 600) % 2 ? `STFTL${h}0` : `STFTR${h}0`
  if (mode === 'work') return gesture(work, h)
  return `STFST${h}${look}`
}

// El WAD que viaja con el mod: doom1.wad shareware v1.9, sin modificar.
const WAD = 'assets/doom1.wad'

// Las caras salen del WAD al arrancar; hasta entonces la esquina queda como la dibuja Claude Code.
let faces: Record<string, Face> | null = null

const source = (name: string) => faces?.[name] ?? faces?.STFST01 ?? { rgba: '', width: 1, height: 1 }

// Lee un rango del WAD con tail y head: $.fs.read no pasa de 4 MiB y el WAD entero es más grande.
async function wadFaces($: EngineInterface) {
  const path = `${$.plugin.root}/${WAD}`
  return loadFaces(async (offset, length) => {
    const r = await $.process.run(['sh', '-c', 'tail -c +"$2" "$1" | head -c "$3" | base64', 'sh', path, String(offset + 1), String(length)])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `no pude leer ${path}`)
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
  // En reposo mira alrededor: cambia la mirada cada medio segundo a dos, al azar.
  if (now >= s.nextLook) {
    s.look = Math.floor(Math.random() * 3)
    s.nextLook = now + 500 + Math.random() * 1500
  }
  // Trabajando cambia de gesto cada 1,5 a 2,5 s, sin repetir el anterior.
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

// Nunca tira: corre dentro de tool.call y tool.check, donde un error no debe tocar la herramienta.
async function paint($: EngineInterface) {
  try {
    const name = current(Date.now())
    if (name === s.shown || !s.requestId) return
    s.shown = name
    await $.ui.blit({ requestId: s.requestId, key: KEY, source: source(name) })
  } catch {
    // Sin imagen montada todavía: el próximo dibujo la pone.
    s.shown = ''
  }
}

const USAGE = `Uso: /doom <animación> [nivel 0-4] | /doom demo [nivel] | /doom salud\nAnimaciones: ${Object.keys(ANIMS).join(', ')}`

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
        $.ui.toast(`doom-face: no pude sacar las caras del WAD (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    tick?.cancel()
    tick = $.clock.every(TICK, () => void paint($))
    await $.command.register({ name: 'doom', description: 'Previsualizar las animaciones de la cara de DOOM', argumentHint: '<animación|demo|salud> [nivel 0-4]' })
    return next(e)
  })

  on('command.run', { command: 'doom' }, async ($, e) => {
    const [what = '', lvl] = e.args.trim().toLowerCase().split(/\s+/)
    const n = lvl === undefined ? painLevel(s.pct) : Number(lvl)
    if (!Number.isInteger(n) || n < 0 || n > 4) return { text: USAGE }
    demo?.cancel()
    demo = null

    // Salud: recorre los 5 niveles de reposo, de sano a ensangrentado.
    const steps =
      what === 'demo'
        ? Object.entries(ANIMS).map(([k, a]) => ({ ...a, h: n, label: `${k} (${a.label})` }))
        : what === 'salud'
          ? [0, 1, 2, 3, 4].map(h => ({ ...ANIMS.reposo!, h, label: `salud nivel ${h}` }))
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
      $.ui.toast(`doom: ${st.label}, nivel ${st.h}`)
      void paint($)
      i += 1
    }
    show()
    if (steps.length > 1) demo = $.clock.every(ms, show)
    const secs = Math.round((ms * steps.length) / 1000)
    return { text: `Mostrando ${steps.length === 1 ? steps[0]!.label : `${steps.length} animaciones`} durante ${secs} s.` }
  })

  on('session.measure', async ($, e, next) => {
    const before = s.pct
    s.pct = e.context.percent ?? s.pct
    // Una caída grande del contexto es una compactación: vuelve sano y con God Mode un rato.
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
      // La cara de herramienta se sostiene un mínimo aunque la herramienta tarde milisegundos.
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

  // La esquina derecha del pie: las etiquetas de modo de Claude Code y la cara al lado.
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
