// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUTTER,
  PICNIC,
  TIME_LIMIT,
  COMBO_WINDOW,
  MAX_COMBO,
  SILVER_SCORE,
  GOLD_SCORE,
  hazardsAt,
  dash,
  newGame,
  step,
} from "../src/game.js";

const still = { x: 0, y: 0 };

function playing() {
  return { ...newGame(), phase: "playing" };
}

function allButter() {
  return new Set(BUTTER.map((_, index) => index));
}

function collect(game, index) {
  [game.x, game.y] = BUTTER[index];
  return step(game, 0, still).find((event) => event.type === "collect");
}

test("each butter pat rewards the player only once", () => {
  const game = playing();
  [game.x, game.y] = BUTTER[0];

  assert.deepEqual(step(game, 0, still), [
    { type: "collect", index: 0, x: 240, y: 315, points: 100, combo: 1 },
  ]);
  assert.deepEqual(step(game, 0.1, still), []);
  assert.equal(game.collected.size, 1);
  assert.equal(game.score, 100);
  assert.equal(newGame().collected.size, 0);
});

test("diagonal movement covers the same distance as straight movement", () => {
  const straight = playing();
  const diagonal = playing();
  const start = { x: straight.x, y: straight.y };

  step(straight, 0.1, { x: 1, y: 0 });
  step(diagonal, 0.1, { x: 1, y: 1 });

  const straightDistance = Math.hypot(straight.x - start.x, straight.y - start.y);
  const diagonalDistance = Math.hypot(diagonal.x - start.x, diagonal.y - start.y);
  assert.ok(Math.abs(straightDistance - diagonalDistance) < 0.000001);
  assert.equal(straightDistance, 20.5);
});

test("click movement stops at its target and keyboard movement takes over", () => {
  const game = playing();
  game.target = { x: game.x + 10, y: game.y };
  step(game, 0.1, still);
  assert.equal(game.x, 170);
  step(game, 0.1, still);
  assert.equal(game.target, null);
  assert.equal(game.moving, false);

  game.target = { x: 500, y: 350 };
  step(game, 0.1, { x: -1, y: 0 });
  assert.equal(game.target, null);
  assert.equal(game.x, 149.5);
  assert.equal(game.facing, -1);
});

test("movement stays inside the meadow", () => {
  const game = { ...playing(), x: 874, y: 474 };
  step(game, 0.1, { x: 1, y: 1 });
  assert.deepEqual([game.x, game.y], [875, 475]);

  game.x = 86;
  game.y = 221;
  step(game, 0.1, { x: -1, y: -1 });
  assert.deepEqual([game.x, game.y], [85, 220]);
});

test("dash boosts movement, expires, and cannot restart until recharged", () => {
  const game = newGame();
  assert.equal(dash(game), false);
  game.phase = "playing";
  assert.equal(dash(game), true);
  assert.equal(dash(game), false);

  const startX = game.x;
  step(game, 0.1, { x: 1, y: 0 });
  assert.equal(game.x - startX, 56);
  step(game, 0.3, still);
  assert.equal(game.dashTime, 0);
  assert.equal(dash(game), false);
  step(game, 1, still);
  assert.equal(game.dashCooldown, 0);
  assert.equal(dash(game), true);
});

test("an idle dash moves forward and stops when its burst finishes", () => {
  const game = playing();
  dash(game);
  const startX = game.x;
  step(game, 0.1, still);
  assert.equal(game.x - startX, 56);
  step(game, 0.3, still);
  assert.ok(Math.abs(game.x - startX - 560 * 0.28) < 0.000001);
  const afterDash = game.x;
  step(game, 0.1, still);
  assert.equal(game.x, afterDash);
});

test("pausing freezes the clock, movement, score, combo, dash, and hit grace", () => {
  const game = {
    ...playing(),
    combo: 2,
    comboTime: 2,
    invulnerableTime: 1,
    target: { x: 400, y: 350 },
  };
  dash(game);
  game.phase = "paused";
  const before = structuredClone(game);

  assert.deepEqual(step(game, 10, { x: 1, y: 1 }), []);
  assert.equal(dash(game), false);
  assert.deepEqual(game, before);
});

test("a chain earns bonus points and waiting resets it", () => {
  const game = playing();
  [game.x, game.y] = BUTTER[0];
  step(game, 0, still);
  [game.x, game.y] = BUTTER[1];
  const second = step(game, 1, still);
  assert.equal(second[0].points, 200);
  assert.equal(game.score, 300);

  step(game, COMBO_WINDOW, still);
  [game.x, game.y] = BUTTER[2];
  const afterWaiting = step(game, 0, still);
  assert.equal(afterWaiting[0].points, 100);
  assert.equal(game.score, 400);
});

test("a quick chain builds up to five times the points and stays capped", () => {
  const game = { ...playing(), invulnerableTime: 1 };
  assert.equal(collect(game, 0).points, 100);
  assert.equal(collect(game, 1).points, 200);
  assert.equal(collect(game, 2).points, 300);
  assert.equal(collect(game, 3).points, 400);
  assert.equal(collect(game, 4).points, 500);
  assert.equal(collect(game, 5).points, 500);
  assert.equal(game.combo, MAX_COMBO);
  assert.equal(game.comboTime, COMBO_WINDOW);
  assert.equal(game.score, 2000);
});

test("a bee breaks the chain without removing points or stunning movement", () => {
  const game = { ...playing(), collected: allButter(), score: 700, combo: 4, comboTime: 2 };
  Object.assign(game, hazardsAt(0)[0]);
  assert.deepEqual(step(game, 0, still), [{ type: "hit", x: game.x, y: game.y }]);
  assert.equal(game.hearts, 2);
  assert.equal(game.hits, 1);
  assert.equal(game.combo, 0);
  assert.equal(game.comboTime, 0);
  assert.equal(game.score, 700);

  const startX = game.x;
  step(game, 0.1, { x: 1, y: 0 });
  assert.equal(game.x - startX, 20.5);
  assert.equal(game.moving, true);
});

test("hit grace prevents repeated damage for a full second and a half", () => {
  const game = { ...playing(), collected: allButter() };
  Object.assign(game, hazardsAt(0)[0]);
  step(game, 0, still);

  Object.assign(game, hazardsAt(1)[0]);
  assert.deepEqual(step(game, 1, still), []);
  assert.equal(game.hearts, 2);
  assert.equal(game.invulnerableTime, 0.5);

  Object.assign(game, hazardsAt(1.5)[0]);
  assert.equal(step(game, 0.5, still)[0].type, "hit");
  assert.equal(game.hearts, 1);
  assert.equal(game.hits, 2);
});

test("a dash can pass through a bee without losing a heart or breaking a chain", () => {
  const game = { ...playing(), collected: allButter(), combo: 5, comboTime: 2 };
  const bee = hazardsAt(0.1)[0];
  game.x = bee.x - 56;
  game.y = bee.y;
  dash(game);
  assert.deepEqual(step(game, 0.1, still), []);
  assert.ok(Math.abs(game.x - bee.x) < 0.000001);
  assert.equal(game.hearts, 3);
  assert.equal(game.hits, 0);
  assert.equal(game.combo, 5);
});

test("the third bee hit ends the run once", () => {
  const game = { ...playing(), collected: allButter() };
  Object.assign(game, hazardsAt(0)[0]);
  step(game, 0, still);
  Object.assign(game, hazardsAt(1.5)[0]);
  step(game, 1.5, still);
  Object.assign(game, hazardsAt(3)[0]);
  assert.deepEqual(step(game, 1.5, still), [
    { type: "hit", x: game.x, y: game.y },
    { type: "lose", reason: "hearts" },
  ]);
  assert.equal(game.phase, "lost");
  assert.equal(game.lossReason, "hearts");
  assert.equal(game.hearts, 0);
  assert.equal(game.hits, 3);
  assert.deepEqual(step(game, 1, still), []);
  assert.equal(dash(game), false);
});

test("time expires before a late arrival can win, and the clock stops at zero", () => {
  const game = { ...playing(), ...PICNIC, collected: allButter(), elapsed: TIME_LIMIT - 1 };
  assert.deepEqual(step(game, 1, still), [{ type: "lose", reason: "time" }]);
  assert.equal(game.phase, "lost");
  assert.equal(game.lossReason, "time");
  assert.equal(game.timeLeft, 0);
  assert.equal(game.elapsed, TIME_LIMIT);
  assert.equal(game.timeBonus, 0);
  assert.equal(game.stars, 0);
  assert.deepEqual(step(game, 5, { x: 1, y: 0 }), []);
  assert.equal(game.elapsed, TIME_LIMIT);
});

test("a fast flawless finish earns its time bonus and three stars only once", () => {
  const game = { ...playing(), ...PICNIC, collected: allButter(), elapsed: 5.25, score: 5000 };
  assert.deepEqual(step(game, 0, still), [{ type: "win" }]);
  assert.equal(game.timeLeft, 29.75);
  assert.equal(game.timeBonus, 1500);
  assert.equal(game.score, GOLD_SCORE);
  assert.equal(game.stars, 3);
  step(game, 10, still);
  assert.equal(game.score, GOLD_SCORE);
  assert.equal(game.timeLeft, 29.75);
});

test("the silver score threshold earns two stars", () => {
  const game = { ...playing(), ...PICNIC, collected: allButter(), elapsed: 5.25, score: 3000 };
  step(game, 0, still);
  assert.equal(game.score, SILVER_SCORE);
  assert.equal(game.stars, 2);
});

test("every successful delivery earns a star even with a lower score", () => {
  const game = { ...playing(), ...PICNIC, collected: allButter(), elapsed: 10.25, score: 3000 };
  step(game, 0, still);
  assert.equal(game.score, 4250);
  assert.equal(game.stars, 1);
});

test("gold requires avoiding every bee as well as beating the score target", () => {
  const game = {
    ...playing(),
    ...PICNIC,
    collected: allButter(),
    elapsed: 5.25,
    score: 5000,
    hits: 1,
  };
  step(game, 0, still);
  assert.equal(game.score, GOLD_SCORE);
  assert.equal(game.stars, 2);
});

test("the final pickup asks for a return; winning requires reaching Biscotte", () => {
  const game = {
    ...playing(),
    ...PICNIC,
    collected: new Set(BUTTER.map((_, index) => index).slice(0, -1)),
  };
  assert.deepEqual(step(game, 0, still), []);
  assert.equal(game.phase, "playing");

  [game.x, game.y] = BUTTER.at(-1);
  assert.deepEqual(
    step(game, 0, still).map((event) => event.type),
    ["collect", "return"],
  );
  assert.equal(game.phase, "playing");

  Object.assign(game, PICNIC);
  assert.deepEqual(step(game, 0, still), [{ type: "win" }]);
  assert.equal(game.phase, "won");
  assert.equal(game.moving, false);
  assert.deepEqual(step(game, 1, { x: 1, y: 0 }), []);
  assert.equal(dash(game), false);
});
