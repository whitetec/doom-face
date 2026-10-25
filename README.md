# doom-face

The Doomguy from DOOM's status bar, living in the bottom-right corner of Claude Code. He reacts to what your session is doing, works harder when the model thinks harder, and gets bloodier as the context window fills up.

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

**No extra tokens.** The mod never calls the model and adds nothing to the context: no system prompt, no tool output, nothing in the conversation. It only watches the session's events and draws in your terminal. The one exception is the `/doom` preview command: like any local command (`/cost`, `/context`), its one-line reply stays in the conversation, a few dozen tokens each time you run it.

## What he does

Almost nothing is a still frame: like in the game, every state is a short animation.

| The session | His face |
|---|---|
| Idle | looks around, mostly ahead with a glance aside now and then |
| Thinking, low or medium effort | glances side to side and focuses |
| Thinking, high, xhigh or max effort | strains: gritted teeth and pain take over, and he changes faster |
| Thinking at max effort for over 20 s | the same, with a flash of golden God Mode eyes every 6 to 10 s |
| Writing the answer | focused, with a grin |
| Reading or searching (Read, Grep, Glob, web) | scans left, ahead and right |
| Running Bash | the rampage face with a flicker, like holding the trigger |
| Editing files | focused, with an evil grin now and then |
| Launching an agent | grins, rages, looks around |
| Waiting for your permission | glances aside and back at you |
| A tool fails | takes a hit: pain, head snapping side to side |
| The context jumps 3 points or more | a hit from one side, as DOOM turns the face toward the damage |
| Health drops a level | a big hit |
| Turn finished | a look, then the evil grin |
| You press Esc | pain, then dead |
| Context gets compacted | God Mode eyes and a grin, back to full health |

Even a tool that takes milliseconds holds its face for one full pass of its animation, so you can see it. Subagents' tools and turns do not move the face; only the main conversation does.

**Health is your context window.** Health = 100 minus the context used, in DOOM's own five pain levels: up to 20% used he is healthy, past 80% he is a bloody mess.

## Options

Set them in `/config` (the rows **Motion** and **Size**), or on the screen Claude Code shows while installing. A change applies at once, with no restart.

| Option | Values |
|---|---|
| Motion | `full` (default): every animation. `calm`: no flickers or jolts, animations 2.5 times slower, fewer glances, no reaction to small context jumps and no golden flashes. `still`: one face per state, no animation |
| Size | `small` (4x2 cells), `medium` (6x3, default) or `large` (8x4) |

## Preview

`/doom` shows any face on demand, following your Motion option:

| Command | Shows |
|---|---|
| `/doom demo` | every animation in a row, 3.5 s each |
| `/doom demo 3` | the same at health level 3 (0 healthy, 4 bloody) |
| `/doom health` | the five health levels |
| `/doom <name> [level]` | one animation for 6 s: `idle`, `thinking`, `deep`, `max`, `writing`, `read`, `edit`, `bash`, `agent`, `permission`, `hit`, `wound`, `pain`, `grin`, `dead`, `god` |

## How it works

It is a Claude Code mod (a plugin of function hooks, `hooks/register.tsx`). It draws in the footer's `SessionMode` slot with an `Image` element and swaps frames with `$.ui.blit`. It follows the session through `turn.start`, `turn.step` (the effort of each request, and whether the model is streaming thinking or text; every chunk is passed on untouched), `tool.check`, `tool.call`, `session.measure` and `turn.complete`.

When the session starts it reads only what it needs from `assets/doom1.wad` (the header, the directory, the palette and the 42 face patches, about 66 KB) and decodes the patches in `hooks/wad.ts`. Any IWAD with a status bar works, `doom.wad`, `doom2.wad` or Freedoom included.

## License

The code is MIT. `assets/doom1.wad` is id Software's DOOM shareware, included unmodified: see [NOTICE](NOTICE).
