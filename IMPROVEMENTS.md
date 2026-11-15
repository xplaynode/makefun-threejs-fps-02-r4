# SLAGLINE r3 — design and improvements

Round 3 is a clean-room rebuild of our threejs-fps entry. Round 1 scored a
770k dev win-rate against a top-10 field of polished tactical FPS entries at
881k–945k; this round keeps the proven SLAGLINE identity (foundry map, Ember
vs Wardens, charge plant/defuse) and rebuilds every system the judge's rubric
rewards, with the improvement spec implemented as follows.

## Bots (bots.js)
- **Turn-rate-limited aim** — yaw/pitch chase the target at a capped
  2.7 rad/s; no snap turns, ever.
- **Aim error grows with target speed** (0.011 rad per m/s) plus the bot's own
  recoil heat, so strafing targets are genuinely harder to hit.
- **Settle window** — a bot plants its feet for 0.28 s before the first burst
  of each engagement; the window resets when the engagement ends.
- **Bursts with decaying recoil** — 3–5 round bursts, 0.22–0.47 s pauses,
  recoil heat decays between bursts and inflates spread while hot.
- **Hearing window** — the noise bus is only investigated when an event is
  0.15–2.2 s old: fresh enough to matter, old enough to have "arrived".

## Bot tactics (bots.js + game.js)
- **Utility** — attackers flash before a site entry; defenders smoke or frag
  a retake, once per bot per round, from approach range.
- **Retake roles** — on a plant, Wardens are sorted by distance: nearest
  defuses, second covers, the rest advance.
- **Post-plant spread** — Ember bots fan out on a ring around the planted site.
- **Low-health fallback** at ≤22 hp to a defensive post.
- **Stuck detection** — <4 cm of displacement in 0.7 s while ordered to move
  triggers a re-path plus a sidestep, rate-limited.
- **Reloads only in lulls** (no fresh target for 2.5 s, or empty at 1 s).
- **Carrier discipline** — the bomb carrier refuses to start a plant within
  1.2 s of a fresh contact.
- **Buy-phase staging** — bots take posts behind translucent barriers and all
  weapons stay silent until the round goes live (enforced in `shoot()`).

## Gunplay (combat.js + config.js)
- **Fixed learnable recoil patterns** per weapon with **partial view
  recovery** (kicks decay exponentially, never fully inside a burst).
- **Longshot discipline** — hip fire multiplies spread ×14; scoped movement
  is capped at 0.38× speed; scoped spread is near-zero.
- **Small landing bloom** (0.028 rad, ~200 ms) on top of air spread.
- **Kill sound** — a distinct thock+tick on every player kill, separate from
  the hitmarker blip; headshots get their own ping.

## Economy (config.js + game.js + hud.js)
- **Single source of truth** — `WEAPONS`/`ECONOMY` in config.js are read by
  the buy menu, bot shopping and damage code alike.
- **Planter bonus paid at plant time**, so post-plant elimination wins still
  pay the team bonus and the planter's personal bonus in full.
- **Buy menu prints the exact next loss bonus** using the same
  `nextLossBonus()` the payout code calls.

## HUD and feedback (hud.js + world.js + audio.js)
- **Dynamic crosshair** sized from the real `currentSpread()` every frame.
- **Damage-direction wedge**, hurt vignette, hitmarkers.
- **Bomb status line** with accelerating beeps (1 s → 0.18 s intervals) and a
  rising two-tone warning under 10 s, mirrored in the HUD text.
- **Alive-count pips** for both teams, round timer, score, money, ammo.
- **Big A/B signage** — canvas-textured 4.6 m signs on two faces per site,
  plus coloured site pads that read at a glance.

## Performance (combat.js + main.js)
- **Allocation-free hot path** — slab ray tests against colliders and
  fighters with module-level scratch vectors; tracer pool of 48 segments
  rewritten in place; BFS pathfinding into caller-provided buffers.
- **Pixel ratio capped at 1.75**, stepping down (1.5 → 1.25 → 1) when the
  frame-time EMA exceeds ~21 ms, with a cooldown between steps.
- Fixed 1/60 simulation step, decoupled from rendering.

## Verification
- `node main.ts` with `MAKEFUN_OUTPUT_DIR` produces `game/`, `screenshots/`
  and `dossier.json`; two consecutive runs are byte-identical.
- A headless-Chrome demo run (`?demo=1&test=1`) plays full rounds hands-free:
  buy → live → plant/elimination resolutions → score changes, with real
  renders captured as the entry's screenshots.
