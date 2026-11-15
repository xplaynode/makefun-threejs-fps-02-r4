// game.js — the SLAGLINE match engine. One Match object holds ALL state:
// fighters, money, the bomb, phase timers and the score. The simulation runs
// on a fixed step (see main.js) and never touches the DOM; the HUD reads a
// snapshot each frame. Rendering data (meshes, tracers) is written here but
// the three.js scene graph is only mutated with pooled objects.

import * as THREE from "three";
import { WEAPONS, GRENADES, ARMOR_PRICE, KIT_PRICE, MATCH, ECONOMY, TEAMS, BOT_NAMES, nextLossBonus } from "./config.js";
import { EYE } from "./world.js";
import { fireShots, currentSpread, NoiseBus, GrenadeSim } from "./combat.js";
import { Bot, createBotMesh } from "./bots.js";
import { PlayerControl } from "./player.js";

function makeWeapon(id) {
  return { id, def: WEAPONS[id], ammo: WEAPONS[id].mag, reserve: WEAPONS[id].reserve, reloading: 0, shotIdx: 0, lastShotAt: -9 };
}

function makeFighter(name, team, isPlayer) {
  return {
    name, team, isPlayer, alive: true,
    x: 0, z: 0, y: 0, vy: 0, vx: 0, vz: 0, speed: 0, moving: false, air: false,
    yaw: 0, pitch: 0, kickPitch: 0, kickYaw: 0, eyeY: EYE, crouch: false, zoomed: false,
    hp: 100, armor: 0, hasKit: false, hasBomb: false,
    money: MATCH.startMoney, kills: 0, deaths: 0,
    weapon: makeWeapon("sidearm"), primaryId: null, sidearmId: "sidearm",
    grenades: { flash: 0, frag: 0, smoke: 0 },
    blindT: 0, deafT: 0, lastHurtAt: -9, lastHurtFrom: 0,
  };
}

export class Match {
  constructor(scene, world, sounds, hud, canvas, opts = {}) {
    this.scene = scene; this.world = world; this.sounds = sounds; this.hud = hud;
    this.demo = !!opts.demo;
    this.fast = !!opts.fast;
    this.timeScale = this.fast ? 3 : 1;
    this.now = 0;
    this.noise = new NoiseBus();
    this.grenades = new GrenadeSim(scene);
    this.grenadeEvents = [];
    this.fighters = [];
    this.bots = new Map();

    for (const team of ["ember", "warden"]) {
      for (let i = 0; i < MATCH.teamSize; i++) {
        const isPlayer = team === "ember" && i === 0 && !this.demo;
        const f = makeFighter(isPlayer ? "You" : BOT_NAMES[team][i], team, isPlayer);
        this.fighters.push(f);
        if (!isPlayer) {
          f.mesh = createBotMesh(TEAMS[team].color);
          scene.add(f.mesh);
          this.bots.set(f, new Bot(f, world));
        }
      }
    }
    this.player = this.fighters.find((f) => f.isPlayer) || this.fighters[0];
    // In demo mode every fighter (the camera fighter included) already got a
    // bot and a mesh in the loop above, so the game plays itself hands-free.
    this.control = this.demo ? null : new PlayerControl(this.player, world, canvas);
    this.controlEnv = {
      phase: "buy",
      onStep: (f) => this.noise.emit(f.x, f.z, 9, "step"),
      onLand: () => this.noise.emit(this.player.x, this.player.z, 7, "land"),
    };

    // Bomb prop: a charge case with a blinking lamp.
    this.bombMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.24, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.6 })
    );
    this.bombLamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    this.bombMesh.add(this.bombLamp);
    this.bombLamp.position.set(0, 0.16, 0);
    scene.add(this.bombMesh);

    // Tracer pool: one LineSegments, 48 segments, positions rewritten in place.
    this.tracerCount = 48;
    this.tracerPos = new Float32Array(this.tracerCount * 6);
    this.tracerLife = new Float32Array(this.tracerCount);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.75 }));
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    this.tracerIdx = 0;

    this.score = { ember: 0, warden: 0 };
    this.lossStreak = { ember: 0, warden: 0 };
    this.round = 0;
    this.phase = "buy";
    this.phaseT = 0;
    this.bomb = { state: "carried", x: 0, z: 0, site: null, carrier: null, timer: 0 };
    this.planting = null;
    this.defusing = null;
    this.targetSite = world.sites.A;
    this.matchOver = false;
    this.winner = null;
    this.mouseDown = false;
    this.nextPlayerShot = 0;

    this.env = this.buildBotEnv();
    this.startRound();
  }

  // ---- bot environment -----------------------------------------------------
  buildBotEnv() {
    const m = this;
    return {
      fighters: this.fighters,
      noise: this.noise,
      get phase() { return m.bomb.state === "planted" ? "planted" : m.phase; },
      get bomb() { return m.bomb; },
      get targetSite() { return m.targetSite; },
      smokeBlocks: (a, b, c, d, e, f) => m.grenades.smokeBlocks(a, b, c, d, e, f),
      shoot: (f, yaw, pitch, heat) => m.shoot(f, yaw, pitch, heat),
      reload: (f) => m.startReload(f),
      throwGrenade: (f, kind, tx, tz) => m.throwGrenade(f, kind, tx, tz),
      plant: (f, site) => m.tryPlant(f, site),
      defuse: (f) => m.tryDefuse(f),
      fallbackPost: (team, id) => {
        const posts = team === "ember" ? m.world.emberPosts : m.world.wardenPosts;
        return posts[id % posts.length];
      },
      postPlantPost: (id, site) => {
        const ring = [[-4, -3], [4, -3], [-4, 3], [4, 3], [0, -5.5]];
        const p = ring[id % ring.length];
        return { x: site.x + p[0], z: site.z + p[1] };
      },
      retakeRole: (bot, bomb) => {
        const wardens = m.fighters.filter((f) => f.team === "warden" && f.alive)
          .sort((a, b) => (Math.hypot(a.x - bomb.x, a.z - bomb.z) - Math.hypot(b.x - bomb.x, b.z - bomb.z)));
        if (wardens[0] === bot.f) return "defuse";
        if (wardens[1] === bot.f) return "cover";
        return "push";
      },
    };
  }

  // ---- round flow ------------------------------------------------------------
  startRound() {
    this.round++;
    const w = this.world;
    this.phase = "buy";
    this.phaseT = MATCH.buySeconds / this.timeScale;
    this.bomb = { state: "carried", x: 0, z: 0, site: null, carrier: null, timer: 0 };
    this.planting = null; this.defusing = null;
    this.targetSite = Math.random() < 0.5 ? w.sites.A : w.sites.B;
    w.setBarrier(true);

    const embers = this.fighters.filter((f) => f.team === "ember");
    const wardens = this.fighters.filter((f) => f.team === "warden");
    embers.forEach((f, i) => {
      const s = w.emberSpawn[i];
      this.resetFighter(f, s[0], s[1], 0);
      const post = w.emberPosts[i];
      this.bots.get(f)?.resetForRound({ x: post[0], z: post[1] });
      if (this.demo && f === this.player) this.bots.get(f)?.resetForRound({ x: post[0], z: post[1] });
    });
    wardens.forEach((f, i) => {
      const s = w.wardenSpawn[i];
      this.resetFighter(f, s[0], s[1], Math.PI);
      const post = w.wardenPosts[i];
      const bot = this.bots.get(f);
      if (bot) {
        bot.resetForRound({ x: post[0], z: post[1] });
        bot.role = i === 0 ? "siteA" : i === 1 ? "siteB" : i === 2 ? "mid" : "rotate";
      }
    });
    // Assign roles and the bomb among attackers.
    const carrier = embers[1 + (this.round % 3)]; // a bot carries, not the human
    carrier.hasBomb = true;
    this.bomb.carrier = carrier;
    embers.forEach((f, i) => {
      const bot = this.bots.get(f);
      if (bot) bot.role = f.hasBomb ? "carrier" : i === 4 ? "lurk" : i % 2 ? "support" : "entry";
    });
    for (const f of this.fighters) if (!f.isPlayer || this.demo) this.botBuy(f);
    if (!this.demo) {
      this.hud.showBuy(this.player, "ember", this.lossStreak.ember, (key) => this.playerBuy(key), true);
    }
    this.hud.banner(`ROUND ${this.round}`, `First to ${MATCH.roundTarget} · ${this.targetSite.key} is the Ember target`, 2200);
    this.syncMeshes();
  }

  resetFighter(f, x, z, yaw) {
    const keepPrimary = f.alive && f.primaryId;
    f.x = x; f.z = z; f.y = 0; f.vx = 0; f.vz = 0; f.vy = 0;
    f.yaw = yaw; f.pitch = 0; f.kickPitch = 0; f.kickYaw = 0;
    f.hp = 100; f.alive = true; f.crouch = false; f.zoomed = false; f.air = false;
    f.blindT = 0; f.hasBomb = false;
    f.grenades = { flash: 0, frag: 0, smoke: 0 };
    if (!keepPrimary) {
      f.primaryId = null;
      f.weapon = makeWeapon("sidearm");
      f.armor = 0; f.hasKit = false;
    } else {
      f.weapon = makeWeapon(f.primaryId);
    }
    if (f.mesh) f.mesh.visible = true;
  }

  botBuy(f) {
    const spend = (price) => { if (f.money >= price) { f.money -= price; return true; } return false; };
    if (!f.primaryId) {
      if (spend(WEAPONS.vk.price)) f.primaryId = "vk";
      else if (f.money >= WEAPONS.wasp.price && spend(WEAPONS.wasp.price)) f.primaryId = "wasp";
      else if (spend(WEAPONS.scatter.price)) f.primaryId = "scatter";
      if (f.primaryId) f.weapon = makeWeapon(f.primaryId);
    }
    if (f.armor < 100 && spend(ARMOR_PRICE)) f.armor = 100;
    if (f.team === "warden" && !f.hasKit && spend(KIT_PRICE)) f.hasKit = true;
    if (spend(GRENADES.flash.price)) f.grenades.flash++;
    if (Math.random() < 0.6 && spend(GRENADES.frag.price)) f.grenades.frag++;
    if (Math.random() < 0.5 && spend(GRENADES.smoke.price)) f.grenades.smoke++;
  }

  playerBuy(key) {
    const p = this.player;
    if (this.phase !== "buy") return;
    const [kind, id] = key.split(":");
    let ok = false;
    if (kind === "w") {
      const w = WEAPONS[id];
      if (p.money >= w.price && p.primaryId !== id) {
        p.money -= w.price; p.primaryId = id; p.weapon = makeWeapon(id); ok = true;
      }
    } else if (kind === "g") {
      if (p.money >= GRENADES[id].price) { p.money -= GRENADES[id].price; p.grenades[id]++; ok = true; }
    } else if (key === "armor") {
      if (p.money >= ARMOR_PRICE && p.armor < 100) { p.money -= ARMOR_PRICE; p.armor = 100; ok = true; }
    } else if (key === "kit") {
      if (p.money >= KIT_PRICE && !p.hasKit) { p.money -= KIT_PRICE; p.hasKit = true; ok = true; }
    }
    if (ok) this.sounds.buy(); else this.sounds.denied();
    this.hud.showBuy(p, "ember", this.lossStreak.ember, (k) => this.playerBuy(k), true);
  }

  goLive() {
    this.phase = "live";
    this.phaseT = MATCH.liveSeconds / this.timeScale;
    this.world.setBarrier(false);
    this.hud.hideBuy();
    this.hud.banner("ROUND LIVE", this.bomb.carrier ? `${this.bomb.carrier.name} has the charge` : "", 1500);
  }

  endRound(winner, reason, objective) {
    if (this.phase === "end" || this.matchOver) return;
    this.phase = "end";
    this.phaseT = MATCH.endSeconds / this.timeScale;
    this.score[winner]++;
    const loser = winner === "ember" ? "warden" : "ember";
    const winPay = objective ? ECONOMY.winObjective : ECONOMY.winReward;
    for (const f of this.fighters) {
      if (f.team === winner) f.money = Math.min(MATCH.maxMoney, f.money + winPay);
      else f.money = Math.min(MATCH.maxMoney, f.money + nextLossBonus(this.lossStreak[loser]));
    }
    this.lossStreak[winner] = 0;
    this.lossStreak[loser] = Math.min(4, this.lossStreak[loser] + 1);
    const mine = winner === "ember";
    this.hud.banner(mine ? "ROUND WON" : "ROUND LOST", reason, 3000);
    if (!this.demo) (mine ? this.sounds.roundWin() : this.sounds.roundLose());
    if (this.score[winner] >= MATCH.roundTarget) {
      this.matchOver = true;
      this.winner = winner;
    }
  }

  // ---- combat ---------------------------------------------------------------
  startReload(f) {
    const w = f.weapon;
    if (!w || w.reloading > 0 || w.ammo >= w.def.mag || w.reserve <= 0) return;
    w.reloading = w.def.reloadMs / 1000;
    if (f.isPlayer) this.sounds.reload();
  }

  shoot(f, yaw, pitch, heat) {
    if (this.phase !== "live") return false;      // weapons silent until go-live
    if (!f.alive || f.blindT > 1.2) return false;
    const w = f.weapon;
    if (!w || w.reloading > 0) return false;
    if (w.ammo <= 0) { if (f.isPlayer) this.sounds.dryFire(); this.startReload(f); return false; }
    const now = this.now;
    if (now - w.lastShotAt > 0.4) w.shotIdx = 0;
    w.lastShotAt = now;
    w.ammo--;
    // fixed learnable recoil: pattern kick, only partly recovered (see update)
    const pat = w.def.pattern[Math.min(w.shotIdx, w.def.pattern.length - 1)];
    w.shotIdx++;
    f.kickPitch += pat[0];
    f.kickYaw += pat[1];
    const spread = currentSpread(w, f.moving, f.air, f.crouch, f.zoomed, heat || 0) + (f === this.player && this.control ? this.control.landingBloom : 0);
    const distToPlayer = Math.hypot(f.x - this.player.x, f.z - this.player.z);
    if (f !== this.player || !this.demo) this.sounds.shot(w.id, f === this.player ? 1 : Math.max(0.08, 1 - distToPlayer / 46));
    this.noise.emit(f.x, f.z, 32, "shot");
    const self = this;
    fireShots(this.world, f, this.fighters, yaw + f.kickYaw, pitch + f.kickPitch, spread, w.def.range, {
      pellets: w.def.pellets,
      onTrace: (o, h) => self.addTracer(o, h),
      onHit: (target, head, dist) => self.applyHit(f, target, head, dist),
    });
    return true;
  }

  applyHit(attacker, target, head, dist) {
    const w = attacker.weapon;
    let dmg = w.def.damage * (head ? w.def.headMult : 1);
    const over = Math.max(0, dist - w.def.range * 0.6) / (w.def.range * 0.4);
    dmg *= 1 - Math.min(0.5, over * 0.5);
    if (target.armor > 0) { const absorbed = dmg * 0.5; target.armor = Math.max(0, target.armor - absorbed); dmg -= absorbed; }
    target.hp -= dmg;
    target.lastHurtAt = this.now;
    target.lastHurtFrom = Math.atan2(-(attacker.x - target.x), -(attacker.z - target.z));
    const bot = this.bots.get(target);
    if (bot) bot.lastContactAt = this.now;
    if (attacker.isPlayer && !this.demo) {
      this.hud.showHitmark(head);
      head ? this.sounds.headshot() : this.sounds.hitmark();
    }
    if (target.isPlayer && !this.demo) {
      this.sounds.hurt();
      this.hud.hurtFlash();
      this.hud.damageFrom(((target.lastHurtFrom - target.yaw) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    }
    if (target.hp <= 0 && target.alive) this.kill(attacker, target, head);
  }

  kill(attacker, target, head) {
    target.alive = false;
    target.hp = 0;
    target.deaths++;
    // A frag death passes the victim as its own attacker: no kill credit,
    // no kill reward — only a genuine opponent kill pays out.
    if (attacker !== target) {
      attacker.kills++;
      attacker.money = Math.min(MATCH.maxMoney, attacker.money + ECONOMY.killReward);
    }
    if (target.hasBomb) {
      target.hasBomb = false;
      this.bomb.state = "dropped";
      this.bomb.x = target.x; this.bomb.z = target.z;
      this.bomb.carrier = null;
    }
    if (target.mesh) target.mesh.visible = false;
    this.hud.feed(`<b style="color:${TEAMS[attacker.team].css}">${attacker.name}</b> ▸ ${head ? "⌖ " : ""}<b style="color:${TEAMS[target.team].css}">${target.name}</b>`);
    if (attacker.isPlayer && !this.demo) this.sounds.kill();   // the kill sound, wired
    if (target.isPlayer && !this.demo) this.sounds.roundLose();
  }

  throwGrenade(f, kind, tx, tz) {
    const dir = new THREE.Vector3(tx - f.x, 0.4, tz - f.z);
    const d = dir.length() || 1;
    dir.normalize();
    const from = new THREE.Vector3(f.x, f.eyeY, f.z);
    this.grenades.throwGrenade(kind, from, dir, Math.min(15, 6 + d * 0.7));
    if (kind === "smoke") this.sounds.smokeHiss();
  }

  tryPlant(f, site) {
    if (this.phase !== "live" || this.bomb.state !== "carried" || !f.hasBomb) return;
    if (this.planting) return;
    this.planting = { fighter: f, site, t: 0 };
    if (f.isPlayer || f === this.bomb.carrier) this.sounds.plantStart();
  }

  tryDefuse(f) {
    if (this.bomb.state !== "planted" || this.defusing) return;
    this.defusing = { fighter: f, t: 0, need: f.hasKit ? MATCH.defuseSeconds : MATCH.defuseNoKitSeconds };
  }

  addTracer(o, h) {
    const i = this.tracerIdx;
    this.tracerIdx = (this.tracerIdx + 1) % this.tracerCount;
    const p = this.tracerPos, o6 = i * 6;
    p[o6] = o.x; p[o6 + 1] = o.y - 0.12; p[o6 + 2] = o.z;
    p[o6 + 3] = h.x; p[o6 + 4] = h.y; p[o6 + 5] = h.z;
    this.tracerLife[i] = 0.06;
    this.tracers.geometry.attributes.position.needsUpdate = true;
  }

  // ---- fixed-step simulation --------------------------------------------------
  update(dt) {
    this.now += dt;
    const w = this.world;
    w.update(dt);
    this.phaseT -= dt;

    // reloads + recoil recovery (partial: kicks decay, never fully vanish
    // inside a burst — that is what makes the pattern learnable)
    for (const f of this.fighters) {
      if (f.weapon && f.weapon.reloading > 0) {
        f.weapon.reloading -= dt;
        if (f.weapon.reloading <= 0) {
          const wdef = f.weapon;
          const take = Math.min(wdef.def.mag - wdef.ammo, wdef.reserve);
          wdef.ammo += take; wdef.reserve -= take;
        }
      }
      const rec = Math.exp(-dt * 3.2);
      f.kickPitch *= rec; f.kickYaw *= rec;
      f.blindT = Math.max(0, f.blindT - dt);
      f.eyeY = f.y + (f.crouch ? 1.12 : EYE);
    }

    if (this.phase === "buy") {
      for (const bot of this.bots.values()) bot.update(dt, this.now, this.env);
      if (this.control) { this.controlEnv.phase = "buy"; this.control.update(dt, this.controlEnv); }
      if (this.phaseT <= 0) this.goLive();
    } else if (this.phase === "live") {
      for (const bot of this.bots.values()) bot.update(dt, this.now, this.env);
      if (this.demo) { /* camera fighter already in bots map? no — drive below */ }
      if (this.control) { this.controlEnv.phase = "live"; this.control.update(dt, this.controlEnv); }
      this.updateBomb(dt);
      this.updateGrenades(dt);
      this.checkRoundEnd();
      if (this.phase === "live" && this.phaseT <= 0 && this.bomb.state !== "planted") {
        this.endRound("warden", "Time expired — the Wardens held the foundry", false);
      }
    } else if (this.phase === "end") {
      if (this.phaseT <= 0) {
        if (this.matchOver) { this.phase = "over"; this.hud.banner(
          this.winner === "ember" ? "EMBER TAKES THE MATCH" : "WARDENS TAKE THE MATCH",
          `Final score ${this.score.ember} — ${this.score.warden} · refresh to play again`, 60000); }
        else this.startRound();
      }
    }

    // bomb prop follows carrier / drop / plant site; lamp blinks faster late
    const b = this.bomb;
    if (b.state === "carried" && b.carrier) { this.bombMesh.position.set(b.carrier.x, 1.05, b.carrier.z); this.bombMesh.visible = b.carrier.alive; }
    else if (b.state === "dropped") { this.bombMesh.position.set(b.x, 0.14, b.z); this.bombMesh.visible = true; }
    else if (b.state === "planted") {
      this.bombMesh.position.set(b.x, 0.14, b.z); this.bombMesh.visible = true;
      const urgent = b.timer <= 10;
      this.bombLamp.material.color.setHex(Math.sin(this.now * (urgent ? 18 : 6)) > 0 ? 0xff2222 : 0x551111);
      if (!this.demo) this.sounds.bombBeep(b.timer, performance.now());
      this.hud.bombStatus(`CHARGE PLANTED — SITE ${b.site.key} · ${b.timer.toFixed(1)}s${urgent ? " · DETONATION IMMINENT" : ""}`, urgent);
    } else this.hud.bombStatus("", false);

    // tracers fade
    let anyTracer = false;
    for (let i = 0; i < this.tracerCount; i++) {
      if (this.tracerLife[i] > 0) { this.tracerLife[i] -= dt; if (this.tracerLife[i] <= 0) { this.tracerPos.fill(0, i * 6, i * 6 + 6); } anyTracer = true; }
    }
    if (anyTracer) this.tracers.geometry.attributes.position.needsUpdate = true;
    this.syncMeshes();
  }

  updateBomb(dt) {
    const b = this.bomb;
    // dropped charge: an attacker walking over it picks it up
    if (b.state === "dropped") {
      for (const f of this.fighters) {
        if (f.alive && f.team === "ember" && Math.hypot(f.x - b.x, f.z - b.z) < 1.1) {
          f.hasBomb = true; b.state = "carried"; b.carrier = f;
          const bot = this.bots.get(f); if (bot) bot.role = "carrier";
          break;
        }
      }
    }
    if (this.planting) {
      const p = this.planting;
      const inSite = Math.hypot(p.fighter.x - p.site.x, p.fighter.z - p.site.z) < p.site.r;
      if (!p.fighter.alive || !inSite) this.planting = null;
      else {
        p.t += dt;
        if (p.t >= MATCH.plantSeconds / this.timeScale) {
          p.fighter.hasBomb = false;
          b.state = "planted"; b.x = p.fighter.x; b.z = p.fighter.z; b.site = p.site;
          b.timer = MATCH.bombSeconds / this.timeScale;
          b.carrier = null;
          // Planter bonuses are paid NOW, at the plant — so a round later won
          // by post-plant elimination still pays them in full.
          for (const f of this.fighters) if (f.team === "ember") f.money = Math.min(MATCH.maxMoney, f.money + ECONOMY.plantTeamBonus);
          p.fighter.money = Math.min(MATCH.maxMoney, p.fighter.money + ECONOMY.planterBonus);
          this.planting = null;
          this.sounds.planted();
          this.hud.banner("CHARGE PLANTED", `Site ${b.site.key} · ${MATCH.bombSeconds} seconds to detonation`, 2000);
        }
      }
    }
    if (b.state === "planted") {
      b.timer -= dt;
      if (this.defusing) {
        const d = this.defusing;
        if (!d.fighter.alive || Math.hypot(d.fighter.x - b.x, d.fighter.z - b.z) > 1.8) this.defusing = null;
        else {
          d.t += dt;
          if ((d.t * 4 | 0) !== ((d.t - dt) * 4 | 0)) this.sounds.defuseTick();
          if (d.t >= d.need / this.timeScale) {
            b.state = "defused";
            d.fighter.money = Math.min(MATCH.maxMoney, d.fighter.money + ECONOMY.defuserBonus);
            this.defusing = null;
            this.endRound("warden", `Charge defused on site ${b.site.key}`, true);
            return;
          }
        }
      }
      if (b.timer <= 0) {
        b.state = "exploded";
        this.sounds.explosion();
        this.endRound("ember", `Site ${b.site.key} detonated`, true);
      }
    }
  }

  updateGrenades(dt) {
    const events = this.grenades.update(dt, this.world, this.grenadeEvents);
    for (const ev of events) {
      if (ev.kind === "frag") {
        this.sounds.fragPop();
        this.noise.emit(ev.x, ev.z, 20, "frag");
        for (const f of this.fighters) {
          if (!f.alive) continue;
          const d = Math.hypot(f.x - ev.x, f.z - ev.z);
          if (d < 5.5) {
            const dmg = 85 * (1 - d / 5.5);
            f.hp -= dmg;
            if (f.hp <= 0) this.kill(f, f, false); // frag deaths credit no one here
          }
        }
      } else if (ev.kind === "flash") {
        this.sounds.flashPop();
        for (const f of this.fighters) {
          if (!f.alive) continue;
          const dx = ev.x - f.x, dz = ev.z - f.z;
          const d = Math.hypot(dx, dz);
          if (d > 19) continue;
          const facing = Math.cos(Math.atan2(-dx, -dz) - f.yaw);
          if (facing > 0.25) {
            f.blindT = Math.max(f.blindT, (1 - d / 19) * 2.6 * facing);
            if (f.isPlayer && !this.demo) {
              this.hud.el.flash.style.opacity = String(Math.min(0.95, f.blindT * 0.5));
              setTimeout(() => { this.hud.el.flash.style.opacity = "0"; }, 500 + f.blindT * 600);
            }
          }
        }
      } else if (ev.kind === "smoke") {
        this.noise.emit(ev.x, ev.z, 8, "smoke");
      }
    }
  }

  checkRoundEnd() {
    const emberAlive = this.fighters.some((f) => f.team === "ember" && f.alive);
    const wardenAlive = this.fighters.some((f) => f.team === "warden" && f.alive);
    if (!wardenAlive) { this.endRound("ember", "Wardens eliminated", false); return; }
    if (!emberAlive) {
      // With the charge planted the round runs on: Wardens must still defuse.
      if (this.bomb.state === "planted") return;
      this.endRound("warden", "Ember eliminated", false);
    }
  }

  syncMeshes() {
    for (const f of this.fighters) {
      if (!f.mesh) continue;
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.rotation.y = -f.yaw + Math.PI;
      f.mesh.scale.y = f.crouch ? 0.78 : 1;
    }
  }

  hudState() {
    const alive = { ember: 0, warden: 0 };
    for (const f of this.fighters) if (f.alive) alive[f.team]++;
    return {
      player: this.player,
      phaseT: this.bomb.state === "planted" ? this.bomb.timer : this.phaseT * this.timeScale,
      phase: this.phase,
      phaseLabel: this.phase === "buy" ? "BUY PHASE — B to shop, weapons silent" :
        this.phase === "live" ? (this.bomb.state === "planted" ? "CHARGE PLANTED" : `ROUND ${this.round} · LIVE`) :
        this.phase === "end" ? "ROUND OVER" : this.phase === "over" ? "MATCH OVER" : "",
      score: this.score,
      alive,
      total: { ember: MATCH.teamSize, warden: MATCH.teamSize },
    };
  }
}
