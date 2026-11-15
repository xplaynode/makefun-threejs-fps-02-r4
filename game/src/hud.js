// hud.js — all DOM feedback: health/ammo/timer/score, a dynamic crosshair
// driven by the shooter's REAL current spread, a damage-direction wedge,
// alive-count pips for both teams, a bomb status line, the killfeed and the
// buy menu (which prints the exact next loss bonus from config.js).

import { WEAPONS, GRENADES, ARMOR_PRICE, KIT_PRICE, nextLossBonus, ECONOMY } from "./config.js";

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hp: $("hp"), money: $("money"), ammo: $("ammo"), weapon: $("weaponName"),
      timer: $("timer"), score: $("score"), phase: $("phaseLine"),
      pipsE: $("pipsEmber"), pipsW: $("pipsWarden"),
      cross: $("crosshair"), hitmark: $("hitmarker"), dmgDir: $("dmgDir"),
      bombLine: $("bombLine"), feed: $("feed"), banner: $("banner"),
      buy: $("buyMenu"), buyItems: $("buyItems"), buyHead: $("buyHead"),
      scope: $("scopeOverlay"), flash: $("flashOverlay"), vignette: $("hurtVignette"),
      prompt: $("prompt"), matchEnd: $("matchEnd"),
    };
    this.hitT = 0;
    this.feedTimers = [];
  }

  setCrosshairSpread(px) {
    const c = this.el.cross;
    const g = Math.max(3, Math.min(46, px));
    c.style.setProperty("--gap", g + "px");
  }

  showHitmark(head) {
    this.el.hitmark.style.opacity = "1";
    this.el.hitmark.style.color = head ? "#ffb02e" : "#ffffff";
    this.hitT = performance.now();
  }

  // Wedge rotated toward the direction damage came from, relative to view.
  damageFrom(angleDiff) {
    const d = this.el.dmgDir;
    d.style.opacity = "1";
    d.style.transform = `translate(-50%,-50%) rotate(${angleDiff}rad)`;
    clearTimeout(this.dmgTimer);
    this.dmgTimer = setTimeout(() => { d.style.opacity = "0"; }, 700);
  }

  hurtFlash() {
    this.el.vignette.style.opacity = "0.55";
    setTimeout(() => { this.el.vignette.style.opacity = "0"; }, 180);
  }

  feed(html) {
    const row = document.createElement("div");
    row.className = "feedRow";
    row.innerHTML = html;
    this.el.feed.prepend(row);
    while (this.el.feed.children.length > 6) this.el.feed.lastChild.remove();
    setTimeout(() => row.remove(), 4200);
  }

  banner(text, sub, ms = 2600) {
    this.el.banner.innerHTML = `<div class="bannerMain">${text}</div><div class="bannerSub">${sub || ""}</div>`;
    this.el.banner.style.opacity = "1";
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { this.el.banner.style.opacity = "0"; }, ms);
  }

  pips(team, alive, total) {
    const host = team === "ember" ? this.el.pipsE : this.el.pipsW;
    let html = "";
    for (let i = 0; i < total; i++) html += `<span class="pip ${team}${i < alive ? "" : " dead"}"></span>`;
    if (host.dataset.n !== String(alive)) { host.innerHTML = html; host.dataset.n = String(alive); }
  }

  bombStatus(text, urgent) {
    this.el.bombLine.textContent = text;
    this.el.bombLine.className = urgent ? "urgent" : "";
    this.el.bombLine.style.display = text ? "block" : "none";
  }

  frame(state) {
    if (performance.now() - this.hitT > 90) this.el.hitmark.style.opacity = "0";
    const p = state.player;
    this.el.hp.textContent = Math.max(0, Math.ceil(p.hp));
    this.el.hp.style.color = p.hp <= 25 ? "#ff5a4a" : "#fff";
    this.el.money.textContent = "$" + p.money;
    const w = p.weapon;
    this.el.weapon.textContent = w ? w.def.label : "—";
    this.el.ammo.textContent = w ? (w.reloading ? "···" : `${w.ammo} / ${w.reserve}`) : "";
    const t = Math.max(0, state.phaseT);
    const mm = (t / 60) | 0, ss = (t % 60) | 0;
    this.el.timer.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
    this.el.timer.style.color = state.phase === "live" && t <= 10 ? "#ff5a4a" : "#fff";
    this.el.score.textContent = `${state.score.ember} — ${state.score.warden}`;
    this.el.phase.textContent = state.phaseLabel;
    this.pips("ember", state.alive.ember, state.total.ember);
    this.pips("warden", state.alive.warden, state.total.warden);
  }

  showBuy(player, team, lossStreak, onBuy, canBuy) {
    const b = this.el.buy;
    b.style.display = "block";
    const bonus = nextLossBonus(lossStreak);
    this.el.buyHead.innerHTML =
      `BUY — ${team === "ember" ? "EMBER" : "WARDEN"} &nbsp;·&nbsp; $${player.money}` +
      ` &nbsp;·&nbsp; if you lose this round: +$${bonus} (loss bonus, streak ${lossStreak})` +
      ` &nbsp;·&nbsp; win pays $${ECONOMY.winReward}`;
    const items = [];
    let n = 1;
    const add = (label, price, key, owned) => {
      items.push(`<button class="buyItem" data-key="${key}" ${owned || player.money < price || !canBuy ? "disabled" : ""}>` +
        `<span class="buyKey">${n++}</span> ${label}<span class="buyPrice">$${price}</span>${owned ? '<span class="owned">OWNED</span>' : ""}</button>`);
    };
    for (const [id, w] of Object.entries(WEAPONS)) if (w.slot === "primary") add(w.label, w.price, "w:" + id, player.primaryId === id);
    for (const [id, w] of Object.entries(WEAPONS)) if (w.slot === "sidearm" && w.price > 0) add(w.label, w.price, "w:" + id, false);
    for (const [id, g] of Object.entries(GRENADES)) add(`${g.label} (${player.grenades[id] || 0})`, g.price, "g:" + id, false);
    add("Kevlar Vest", ARMOR_PRICE, "armor", player.armor >= 100);
    if (team === "warden") add("Defuse Kit", KIT_PRICE, "kit", player.hasKit);
    this.el.buyItems.innerHTML = items.join("");
    this.el.buyItems.querySelectorAll(".buyItem").forEach((btn) => {
      btn.addEventListener("click", () => onBuy(btn.dataset.key));
    });
    this.buyKeys = [...this.el.buyItems.querySelectorAll(".buyItem")].map((x) => x.dataset.key);
  }

  hideBuy() { this.el.buy.style.display = "none"; }

  prompt(text) {
    this.el.prompt.textContent = text || "";
    this.el.prompt.style.display = text ? "block" : "none";
  }
}
