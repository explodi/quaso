// SPDX-License-Identifier: MIT
/** Collect butter, dodge predictable bees, and bring the picnic home before time runs out. */
export const WORLD = { width: 960, height: 540 };
export const PICNIC = { x: 780, y: 405 };
export const TIME_LIMIT = 35;
export const COMBO_WINDOW = 2;
export const MAX_COMBO = 5;
export const SILVER_SCORE = 4500;
export const GOLD_SCORE = 6500;
export const BEES = [
  { x: 350, y: 340, rangeX: 130, rangeY: 0, speed: 1.8, phase: 0 },
  { x: 515, y: 365, rangeX: 0, rangeY: 105, speed: 1.5, phase: 1.4 },
  { x: 685, y: 325, rangeX: 95, rangeY: 55, speed: 1.9, phase: 3.1 },
];
export const BUTTER = [
  [240, 315],
  [325, 275],
  [410, 310],
  [495, 265],
  [570, 320],
  [665, 285],
  [730, 335],
  [655, 410],
  [545, 435],
  [445, 395],
  [345, 450],
  [245, 410],
];

/** Rendering and collisions share these patrols; each replay follows the same paths. */
export function hazardsAt(elapsed) {
  return BEES.map((bee) => ({
    x: bee.x + Math.sin(elapsed * bee.speed + bee.phase) * bee.rangeX,
    y: bee.y + Math.cos(elapsed * bee.speed + bee.phase) * bee.rangeY,
  }));
}

export function newGame() {
  return {
    phase: "ready",
    x: 160,
    y: 350,
    facing: 1,
    moving: false,
    target: null,
    collected: new Set(),
    score: 0,
    combo: 0,
    comboTime: 0,
    dashTime: 0,
    dashCooldown: 0,
    elapsed: 0,
    timeLeft: TIME_LIMIT,
    hearts: 3,
    hits: 0,
    invulnerableTime: 0,
    timeBonus: 0,
    stars: 0,
    lossReason: null,
  };
}

export function dash(game) {
  if (game.phase !== "playing" || game.dashCooldown > 0) return false;
  game.dashTime = 0.28;
  game.dashCooldown = 1.25;
  return true;
}

/** Events keep sound, animation and translated text out of the movement rules. */
export function step(game, seconds, direction) {
  if (game.phase !== "playing") return [];
  const events = [];
  game.elapsed = Math.min(TIME_LIMIT, game.elapsed + seconds);
  game.timeLeft = TIME_LIMIT - game.elapsed;
  if (game.timeLeft === 0) {
    game.phase = "lost";
    game.lossReason = "time";
    game.moving = false;
    return [{ type: "lose", reason: "time" }];
  }
  const dashSeconds = Math.min(game.dashTime, seconds);
  game.comboTime = Math.max(0, game.comboTime - seconds);
  game.dashTime = Math.max(0, game.dashTime - seconds);
  game.dashCooldown = Math.max(0, game.dashCooldown - seconds);
  game.invulnerableTime = Math.max(0, game.invulnerableTime - seconds);
  if (game.comboTime === 0) game.combo = 0;

  let { x, y } = direction;
  if (x || y) game.target = null;
  if (game.target) {
    x = game.target.x - game.x;
    y = game.target.y - game.y;
    if (Math.hypot(x, y) < 5) {
      game.target = null;
      x = 0;
      y = 0;
    }
  }
  const walking = Boolean(x || y);
  if (!walking && dashSeconds > 0) x = game.facing;
  const distance = Math.hypot(x, y);
  game.moving = distance > 0;
  if (distance) {
    const walkingSeconds = walking ? seconds - dashSeconds : 0;
    const movement = 560 * dashSeconds + 205 * walkingSeconds;
    const travel = game.target ? Math.min(distance, movement) : movement;
    game.x = Math.max(85, Math.min(875, game.x + (x / distance) * travel));
    game.y = Math.max(220, Math.min(475, game.y + (y / distance) * travel));
    if (x) game.facing = x > 0 ? 1 : -1;
  }

  const protectedFromBees = game.dashTime > 0 || game.invulnerableTime > 0;
  const touchingBee = hazardsAt(game.elapsed).some(
    (bee) => Math.hypot(bee.x - game.x, bee.y - game.y) < 30,
  );
  if (touchingBee && !protectedFromBees) {
    game.hearts--;
    game.hits++;
    game.combo = 0;
    game.comboTime = 0;
    game.invulnerableTime = 1.5;
    events.push({ type: "hit", x: game.x, y: game.y });
    if (game.hearts === 0) {
      game.phase = "lost";
      game.lossReason = "hearts";
      game.moving = false;
      return [...events, { type: "lose", reason: "hearts" }];
    }
  }

  BUTTER.forEach(([bx, by], index) => {
    if (game.collected.has(index) || Math.hypot(bx - game.x, by - game.y) > 38) return;
    game.collected.add(index);
    game.combo = Math.min(MAX_COMBO, game.combo + 1);
    game.comboTime = COMBO_WINDOW;
    const points = 100 * game.combo;
    game.score += points;
    events.push({ type: "collect", index, x: bx, y: by, points, combo: game.combo });
    if (game.collected.size === BUTTER.length) events.push({ type: "return" });
  });

  const home = Math.hypot(game.x - PICNIC.x, game.y - PICNIC.y) < 65;
  if (home && game.collected.size === BUTTER.length) {
    game.phase = "won";
    game.moving = false;
    game.timeBonus = Math.ceil(game.timeLeft) * 50;
    game.score += game.timeBonus;
    const gold = game.score >= GOLD_SCORE && game.hits === 0;
    game.stars = gold ? 3 : game.score >= SILVER_SCORE ? 2 : 1;
    events.push({ type: "win" });
  }
  return events;
}
