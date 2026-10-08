// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUTTER, PICNIC, dash, newGame, step } from "../src/game.js";

const still = { x: 0, y: 0 };

function playing() {
  return { ...newGame(), phase: "playing" };
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

test("pausing freezes movement, score, combo, and dash timers", () => {
  const game = { ...playing(), combo: 2, comboTime: 2, target: { x: 400, y: 350 } };
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

  step(game, 3.1, still);
  [game.x, game.y] = BUTTER[2];
  const afterWaiting = step(game, 0, still);
  assert.equal(afterWaiting[0].points, 100);
  assert.equal(game.score, 400);
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
