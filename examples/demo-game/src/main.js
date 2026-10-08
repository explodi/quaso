// SPDX-License-Identifier: MIT
import "./style.css";
import { t, i18next, changeLanguage } from "./i18n.js";
import {
  WORLD,
  PICNIC,
  BUTTER,
  BEES,
  TIME_LIMIT,
  COMBO_WINDOW,
  MAX_COMBO,
  GOLD_SCORE,
  hazardsAt,
  newGame,
  step,
  dash,
} from "./game.js";
import { setSound, sound, bounce, burst, floatText, shake } from "./effects.js";

const $ = (id) => document.getElementById(id);
const world = $("world");
const player = $("player");
const playerSprite = player.querySelector("img");
const effects = $("effects");
const keys = new Set();
let game = newGame();
let best = 0;
let soundEnabled = true;
let speechTimer;
let meow = 0;
let lastSecond = TIME_LIMIT;
const beeElements = BEES.map(() => {
  const bee = document.createElement("img");
  bee.className = "actor bee";
  bee.src = "/art/bee-0.png";
  bee.alt = "";
  $("bees").append(bee);
  return bee;
});
try {
  best = Number(localStorage.getItem("quaso-quest-best")) || 0;
  soundEnabled = localStorage.getItem("quaso-sound") !== "false";
} catch {
  /* Playing still works when browser storage is disabled. */
}

function position(element, x, y) {
  element.style.left = `${(x / WORLD.width) * 100}%`;
  element.style.top = `${(y / WORLD.height) * 100}%`;
}

function touchedOutside(actor, event) {
  if (event.pointerType !== "touch") return false;
  const rect = actor.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

function say(key, options = {}) {
  $("speech").textContent = t(key, options);
  $("speech").hidden = false;
  $("announcer").textContent = $("speech").textContent;
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => {
    $("speech").hidden = true;
  }, 3400);
}

function updateText() {
  // This is the entire static translation integration: data-i18n="namespace:key".
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n, {
      seconds: TIME_LIMIT,
      total: BUTTER.length,
      gold: GOLD_SCORE,
    });
  });
  document.documentElement.lang = i18next.language;
  $("language").value = i18next.language;
  world.setAttribute("aria-label", t("game:world"));
  player.setAttribute("aria-label", t("game:pet"));
  $("dog").setAttribute("aria-label", t("game:dog"));
  $("pause").setAttribute("aria-label", t("game:pause.button"));
  $("sound").setAttribute("aria-label", t(soundEnabled ? "soundOff" : "soundOn"));
  $("sound").setAttribute("aria-pressed", String(soundEnabled));
  $("sound").classList.toggle("muted", !soundEnabled);
  $("language-notice").hidden = i18next.language === "fr";
  $("speech").hidden = true;
  updateHud();
  updateRunHud();
}

function updateHud() {
  const count = game.collected.size;
  const objective =
    game.phase === "won"
      ? "done"
      : game.phase === "lost"
        ? "retry"
        : count === BUTTER.length
          ? "return"
          : "collect";
  $("objective").textContent = t(`game:quest.${objective}`);
  $("collected").textContent = t("game:quest.progress", { current: count, total: BUTTER.length });
  $("collected").setAttribute("aria-label", t("game:quest.butter", { count }));
  $("progress-fill").style.width = `${(count / BUTTER.length) * 100}%`;
  $("score").textContent = t("game:score", { score: game.score });
  $("best").textContent = t("game:best", { score: best });
  $("result").textContent = t("game:win.result", {
    score: game.score,
    seconds: Math.ceil(game.elapsed),
  });
  $("medal-stars").textContent = "★".repeat(game.stars) + "☆".repeat(3 - game.stars);
  $("medal-title").textContent = t(`game:win.rank${game.stars || 1}`);
  $("medal-tip").textContent = t(`game:win.tip${game.stars || 1}`, { gold: GOLD_SCORE });
  $("time-bonus").textContent = t("game:win.bonus", { points: game.timeBonus });
  $("loss-reason").textContent = t(`game:lose.${game.lossReason || "time"}`);
  $("dog").classList.toggle("ready", count === BUTTER.length);
}

function updateRunHud() {
  const seconds = Math.ceil(game.timeLeft);
  $("timer").textContent = t("game:time.remaining", { count: seconds });
  $("hearts").textContent = "♥".repeat(game.hearts) + "♡".repeat(3 - game.hearts);
  $("hearts").setAttribute("aria-label", t("game:lives", { count: game.hearts }));
  $("combo-label").textContent = t("game:chain", {
    count: Math.max(1, game.combo),
    max: MAX_COMBO,
  });
  $("combo-fill").style.width = `${(game.comboTime / COMBO_WINDOW) * 100}%`;
  $("dash").disabled = game.dashCooldown > 0;
  $("dash").style.setProperty("--ready", `${100 - (game.dashCooldown / 1.25) * 100}%`);
  $("dash").title = t(game.dashCooldown > 0 ? "game:dashWait" : "game:dashReady");
  world.classList.toggle("dangerworld", game.timeLeft <= 10 && game.phase === "playing");
  if (seconds < lastSecond && seconds <= 10 && seconds > 0 && game.phase === "playing")
    sound("tick");
  lastSecond = seconds;
}

function start() {
  game = newGame();
  game.phase = "playing";
  keys.clear();
  $("pickups").replaceChildren();
  BUTTER.forEach(([x, y], index) => {
    const item = document.createElement("img");
    item.src = "/art/butter.png";
    item.alt = "";
    item.className = "butter";
    item.id = `butter-${index}`;
    item.style.animationDelay = `${index * -0.19}s`;
    position(item, x, y);
    $("pickups").append(item);
  });
  $("welcome").hidden = true;
  $("win-panel").hidden = true;
  $("lose-panel").hidden = true;
  $("pause-panel").hidden = true;
  $("pause").hidden = false;
  $("dash").hidden = false;
  $("speech").hidden = true;
  $("run-stats").hidden = false;
  $("combo-meter").hidden = false;
  lastSecond = TIME_LIMIT;
  effects.replaceChildren();
  setSound(soundEnabled);
  sound("start");
  updateHud();
  updateRunHud();
  world.focus({ preventScroll: true });
}

function pause() {
  if (!["playing", "paused"].includes(game.phase)) return;
  game.phase = game.phase === "playing" ? "paused" : "playing";
  keys.clear();
  game.target = null;
  game.moving = false;
  $("pause-panel").hidden = game.phase !== "paused";
  $("pause").hidden = game.phase === "paused";
  $("dash").hidden = game.phase === "paused";
  if (game.phase === "paused") $("resume").focus({ preventScroll: true });
  else world.focus({ preventScroll: true });
}

function doDash() {
  if (!dash(game)) return;
  updateRunHud();
  sound("dash");
  bounce(player);
  burst(effects, (game.x / WORLD.width) * 100, (game.y / WORLD.height) * 100, { count: 8 });
  world.focus({ preventScroll: true });
}

function handleEvent(event) {
  if (event.type === "collect") {
    $(`butter-${event.index}`).remove();
    sound("collect", 1 + (event.combo - 1) * 0.15);
    bounce(player);
    bounce($("collected"));
    burst(effects, (event.x / WORLD.width) * 100, (event.y / WORLD.height) * 100);
    const label =
      event.combo > 1
        ? t("game:combo", { count: event.combo })
        : t("game:pickup", { points: event.points });
    floatText(effects, label, (event.x / WORLD.width) * 100, (event.y / WORLD.height) * 100);
    $("announcer").textContent = t("game:quest.butter", { count: game.collected.size });
  }
  if (event.type === "return") say("game:return");
  if (event.type === "hit") {
    sound("hit");
    shake(world);
    bounce($("hearts"));
    burst(effects, (game.x / WORLD.width) * 100, (game.y / WORLD.height) * 100, {
      count: 12,
      colors: ["#ec7895", "#ffffff"],
    });
    say("game:hit");
  }
  if (event.type === "lose") {
    sound("lose");
    $("lose-panel").hidden = false;
    $("pause").hidden = true;
    $("dash").hidden = true;
    $("speech").hidden = true;
    $("announcer").textContent = t("game:lose.title");
    $("retry").focus({ preventScroll: true });
  }
  if (event.type === "win") {
    best = Math.max(best, game.score);
    try {
      localStorage.setItem("quaso-quest-best", String(best));
    } catch {
      /* Optional record. */
    }
    sound("win");
    burst(effects, 50, 40, { count: 45, colors: ["#ffe59a", "#ec7895", "#80e5dc", "#ffffff"] });
    $("win-panel").hidden = false;
    $("pause").hidden = true;
    $("dash").hidden = true;
    $("speech").hidden = true;
    $("announcer").textContent = t(`game:win.rank${game.stars}`);
    $("again").focus({ preventScroll: true });
  }
  updateHud();
}

$("start").addEventListener("click", start);
$("again").addEventListener("click", start);
$("retry").addEventListener("click", start);
$("pause").addEventListener("click", pause);
$("resume").addEventListener("click", pause);
$("dash").addEventListener("click", doDash);
$("sound").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  setSound(soundEnabled);
  sound("pet");
  try {
    localStorage.setItem("quaso-sound", String(soundEnabled));
  } catch {
    /* Optional setting. */
  }
  updateText();
});
$("language").addEventListener("change", async (event) => {
  await changeLanguage(event.target.value);
  updateText();
});
player.addEventListener("click", (event) => {
  if (touchedOutside(player, event)) return;
  const lines = t("game:meows", { returnObjects: true });
  say(`game:meows.${meow++ % lines.length}`);
  bounce(player);
  sound("pet");
  burst(effects, (game.x / WORLD.width) * 100, (game.y / WORLD.height) * 100, {
    count: 6,
    colors: ["#ec7895", "#ffe59a"],
  });
});
$("dog").addEventListener("click", (event) => {
  if (touchedOutside($("dog"), event)) return;
  const remaining = BUTTER.length - game.collected.size;
  const greeting = remaining === BUTTER.length ? "waiting" : remaining ? "almost" : "ready";
  say(`game:biscotte.${game.phase === "won" ? "thanks" : greeting}`, { count: remaining });
  bounce($("dog"));
  if (game.phase === "playing") game.target = { ...PICNIC };
  world.focus({ preventScroll: true });
});
world.addEventListener("pointerdown", (event) => {
  if (game.phase !== "playing") return;
  const control = event.target.closest("button, .dialog");
  // Mobile browsers may snap a meadow tap to a nearby mascot button.
  // Keep those taps as movement; petting still works directly on the mascot.
  if (control && !([player, $("dog")].includes(control) && touchedOutside(control, event))) return;
  const rect = world.getBoundingClientRect();
  game.target = {
    x: Math.max(85, Math.min(875, ((event.clientX - rect.left) / rect.width) * WORLD.width)),
    y: Math.max(220, Math.min(475, ((event.clientY - rect.top) / rect.height) * WORLD.height)),
  };
  position($("destination"), game.target.x, game.target.y);
  $("destination").hidden = false;
  world.focus({ preventScroll: true });
});
const movementKeys = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "w",
  "a",
  "s",
  "d",
  "z",
  "q",
];
world.addEventListener("keydown", (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "Escape") {
    event.preventDefault();
    pause();
    return;
  }
  if (game.phase !== "playing") return;
  // Space keeps native button activation; on the meadow it triggers the dash.
  if (key === " " && event.target === world) {
    event.preventDefault();
    if (!event.repeat) doDash();
  }
  if (movementKeys.includes(key)) {
    event.preventDefault();
    keys.add(key);
  }
});
window.addEventListener("keyup", (event) =>
  keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key),
);
window.addEventListener("blur", () => {
  keys.clear();
  if (game.phase === "playing") pause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.phase === "playing") pause();
});

let previous = performance.now();
let lastTrail = 0;
let lastSprite = -1;
function frame(now) {
  const seconds = Math.min((now - previous) / 1000, 0.04);
  previous = now;
  const pressed = (...values) => values.some((value) => keys.has(value));
  const direction = {
    x: Number(pressed("ArrowRight", "d")) - Number(pressed("ArrowLeft", "a", "q")),
    y: Number(pressed("ArrowDown", "s")) - Number(pressed("ArrowUp", "w", "z")),
  };
  step(game, seconds, direction).forEach(handleEvent);
  updateRunHud();
  hazardsAt(game.elapsed).forEach(({ x, y }, index) => position(beeElements[index], x, y));
  position(player, game.x, game.y);
  player.classList.toggle("walking", game.phase === "playing" && game.moving);
  player.classList.toggle("dashing", game.phase === "playing" && game.dashTime > 0);
  player.classList.toggle("hit", game.phase === "playing" && game.invulnerableTime > 0);
  player.style.setProperty("--facing", game.facing);
  const sprite =
    game.moving && game.phase === "playing" ? Math.floor(now / 110) % 4 : Math.floor(now / 650) % 4;
  if (sprite !== lastSprite) {
    playerSprite.src = `/art/quaso-${sprite}.png`;
    lastSprite = sprite;
  }
  const beeFrame = game.phase === "playing" ? Math.floor(now / 150) % 2 : 0;
  for (const bee of beeElements) {
    if (bee.dataset.frame !== String(beeFrame)) {
      bee.src = `/art/bee-${beeFrame}.png`;
      bee.dataset.frame = String(beeFrame);
    }
  }
  $("destination").hidden = !game.target || game.phase !== "playing";
  if (game.dashTime > 0 && game.moving && game.phase === "playing" && now - lastTrail > 60) {
    burst(effects, (game.x / WORLD.width) * 100, (game.y / WORLD.height) * 100, { count: 3 });
    lastTrail = now;
  }
  requestAnimationFrame(frame);
}
position($("dog"), PICNIC.x, PICNIC.y);
position(player, game.x, game.y);
updateText();
requestAnimationFrame(frame);
