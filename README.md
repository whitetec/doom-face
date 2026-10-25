# doom-face

The Doomguy from DOOM's status bar, living in the bottom-right corner of Claude Code. He reacts to what your session is doing, and he gets bloodier as the context window fills up.

## Install

At the prompt of a Claude Code session in the terminal:

```
/plugin install doom-face --marketplace whitetec/doom-face
```

Answer `y` to add the marketplace, then pick a scope (user scope puts him in every session).

From a shell:

```
claude plugin install doom-face --marketplace whitetec/doom-face
```

**Requirements:** Claude Code v2.1.287 or later (the first version with mods), and a terminal that shows images through the kitty graphics protocol: **kitty** or **Ghostty**. In any other terminal the corner stays as Claude Code draws it. It also needs `sh`, `tail`, `head` and `base64`, which Linux and macOS already have.

## What he does

| The session | His face |
|---|---|
| Idle | looks around, like in the game |
| Thinking or writing (no tools) | rotates between turning his head, gritting his teeth and surprise, every 1.5 to 2.5 s; never the neutral face |
| Running a tool | the gritted-teeth rampage face, held at least 1.2 s (2.2 s for Bash, Edit, Write, Agent and web tools) |
| Waiting for your permission | glances left and right |
| A tool fails | pain, 3 s |
| Turn finished | evil grin |
| You press Esc | dead |
| Context gets compacted | golden God Mode eyes, back to full health |

**Health is your context window.** Health = 100 minus the context used, in DOOM's own five pain levels: up to 20% used he is healthy, past 80% he is a bloody mess.

## Preview

`/doom` shows any face on demand (the animation names are in Spanish):

| Command | Shows |
|---|---|
| `/doom demo` | every animation in a row, 4 s each |
| `/doom demo 3` | the same at health level 3 (0 healthy, 4 bloody) |
| `/doom salud` | the five health levels |
| `/doom <name> [level]` | one animation for 6 s: `reposo`, `trabajando`, `herramienta`, `permiso`, `dolor`, `sonrisa`, `muerto`, `god` |

## How it works

It is a Claude Code mod (a plugin of function hooks, `hooks/register.tsx`). It draws in the footer's `SessionMode` slot with an `Image` element, and swaps frames with `$.ui.blit`. When the session starts it reads only what it needs from `assets/doom1.wad` (the header, the directory, the palette and the 42 face patches, about 66 KB) and decodes the patches in `hooks/wad.ts`. Any IWAD with a status bar works, `doom.wad`, `doom2.wad` or Freedoom included.

## License

The code is MIT. `assets/doom1.wad` is id Software's DOOM shareware, included unmodified: see [NOTICE](NOTICE).

---

**En español:** la cara del Doomguy en la esquina inferior derecha de Claude Code. Reacciona a lo que hace la sesión y su salud sigue el uso de contexto. Se instala con la línea de arriba y necesita kitty o Ghostty.
