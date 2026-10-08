// SPDX-License-Identifier: MIT
/** All the rules: walk, dash, collect twelve butter pats, return to the picnic. */
export const WORLD = { width: 960, height: 540 };
export const PICNIC = { x: 780, y: 405 };
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
  game.elapsed += seconds;
  game.comboTime = Math.max(0, game.comboTime - seconds);
  game.dashTime = Math.max(0, game.dashTime - seconds);
  game.dashCooldown = Math.max(0, game.dashCooldown - seconds);
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
  if (!x && !y && game.dashTime > 0) x = game.facing;
  const distance = Math.hypot(x, y);
  game.moving = distance > 0;
  if (distance) {
    const speed = game.dashTime > 0 ? 560 : 205;
    const travel = game.target ? Math.min(distance, speed * seconds) : speed * seconds;
    game.x = Math.max(85, Math.min(875, game.x + (x / distance) * travel));
    game.y = Math.max(220, Math.min(475, game.y + (y / distance) * travel));
    if (x) game.facing = x > 0 ? 1 : -1;
  }

  BUTTER.forEach(([bx, by], index) => {
    if (game.collected.has(index) || Math.hypot(bx - game.x, by - game.y) > 38) return;
    game.collected.add(index);
    game.combo = Math.min(3, game.combo + 1);
    game.comboTime = 3;
    const points = 100 * game.combo;
    game.score += points;
    events.push({ type: "collect", index, x: bx, y: by, points, combo: game.combo });
    if (game.collected.size === BUTTER.length) events.push({ type: "return" });
  });

  const home = Math.hypot(game.x - PICNIC.x, game.y - PICNIC.y) < 65;
  if (home && game.collected.size === BUTTER.length) {
    game.phase = "won";
    game.moving = false;
    events.push({ type: "win" });
  }
  return events;
}
