// SPDX-License-Identifier: MIT
/**
 * How the demo game uses its strings with i18next. `t` is i18next's translation function,
 * set up with the `common`, `menus` and `store` namespaces from `src/locales/{lang}/`.
 */

/** The heads-up display. */
export function hud(t, player) {
  return [
    t("common:greeting", { name: player.name }),
    t("common:level", { current: player.level, total: t("common:maxLevel") }),
    t("common:coins", { count: player.coins }),
    t("common:lives", { count: player.lives }),
    t("common:items", { count: player.items.length }),
    t("common:companion", { context: player.companion }),
  ];
}

/** A random hint for the loading screen. */
export function hint(t) {
  const hints = t("common:hints", { returnObjects: true });
  return hints[Math.floor(Math.random() * hints.length)];
}

/** The end of a run. */
export function gameOver(t, result) {
  return [
    t("menus:gameOver.title"),
    t("menus:gameOver.score", { score: result.score }),
    t("menus:gameOver.place", { count: result.place, ordinal: true }),
    result.record ? t("menus:gameOver.newRecord", { name: result.name }) : "",
    t("menus:main.playAgain"),
  ];
}
