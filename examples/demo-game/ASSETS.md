# Quaso Quest artwork

All runtime art is checked in under `public/art/`. Running or building the game does not require an image-generation service or the original asset collection.

| File                     | Size      | Source                                                                                  |
| ------------------------ | --------- | --------------------------------------------------------------------------------------- |
| `quaso-0.png`            | 40 × 32   | Supplied `quaso-waving/quaso-waving-4.png`                                              |
| `quaso-1.png`            | 40 × 32   | Supplied `quaso-waving/quaso-waving-5.png`                                              |
| `quaso-2.png`            | 40 × 32   | Supplied `quaso-waving/quaso-waving-6.png`                                              |
| `quaso-3.png`            | 40 × 32   | Supplied `quaso-waving/quaso-waving-7.png`                                              |
| `dog.png`                | 32 × 32   | Supplied `dog/dog-2.png`                                                                |
| `butter.png`             | 16 × 16   | Hand-authored Quaso-palette grid, rendered and exported with the pixel-art skill        |
| `bee-0.png`, `bee-1.png` | 16 × 16   | Hand-authored Quaso-palette bee with two wing-flap poses                                |
| `meadow.png`             | 240 × 135 | Nano Banana 2.1 candidate 4, snapped to the Quaso palette and finished on its text grid |
| `meadow-mobile.png`      | 120 × 135 | Portrait arrangement of the meadow's existing pixel-grid regions; no resampling         |

The supplied sprites came from the project's `.quaso/pixel-art` source collection. They are copied without modification and retain their original transparency. The four Quaso frames animate the cat-croissant mascot inspired by the reference meme. Display sprites with `image-rendering: pixelated` to retain their crisp edges. The meadow fits a 960 × 540 game area at exactly 4× its native grid.

`butter.txt` and `meadow.txt` contain editable source grids. The butter uses five palette colours and passes the skill's pixel lint. The meadow uses 24 colours; the scene's foliage and flowers produce sprite-oriented lint hints, so it was checked visually at 1× and on the review sheet. Three small cream-and-amber stepping stones were added to the meadow grid after selection.

`bee-0.txt` and `bee-1.txt` keep the bee's body and feet in the same position while its wings flap. The six-colour sprite uses a butter-and-amber body, cocoa stripes, plum outline, white eye glint and ice-blue wings. Its deliberate wing joints and large eye are marked in the grids for pixel lint. The game displays the frames at 48 × 48 on desktop and 32 × 32 on phones, exact 3× and 2× scales.

`meadow-mobile.txt` rearranges the same bakery, pond, trees and picnic on a 120 × 135 portrait grid. It keeps each feature's native pixels and palette while preserving the picnic's relative position, so the mobile layout shows the complete scene and Biscotte stays on the blanket. The portrait art displays at exactly 3× in a 360 × 405 play area.

The self-hosted Jersey 25 and Jersey 20 fonts are copied from Quaso’s design system and use the SIL Open Font License. The font files and original notices ship together in `public/fonts/`. The interface also shares Quaso’s plum, lime, mint, square borders, and offset shadows; it stays standalone with no design-system runtime dependency.

## Art workflow

The new art uses `.agents/skills/quaso-pixel-art/SKILL.md`: generate candidates with Nano Banana, snap to the fixed Quaso palette, inspect the review sheet, edit the text grid, and export. There is no image-generation dependency at runtime. The `GEMINI_API_KEY` used for generation stays outside this example and is never shipped with its assets.

From the repository root, with that skill installed:

```sh
.agents/skills/quaso-pixel-art/pixel render examples/demo-game/public/art/butter.txt
.agents/skills/quaso-pixel-art/pixel export examples/demo-game/public/art/butter.txt examples/demo-game/public/art --name=butter --title="Butter pat"
```

## Meadow generation prompt

```text
Overhead cozy French picnic meadow game map, no horizon. Tiny cream bakery with orange tiled roof in upper-left corner, tiny turquoise pond upper-right, coral gingham picnic blanket lower-right at x83% y72%. Round leafy trees, white daisies and pink flowers frame the edges. Keep the broad center completely open grass for walking, especially x10–90% y25–85%; sparse grass clusters only. Cute sunny handheld RPG world beside the Quaso mascot, large clear pixels, flat green and warm butter tones. No characters, animals, coins, signs, lettering or UI. The open clearing is the subject.
```

Generation options: `--size=240x135 --opaque --count=4 --colours=24`. The skill wraps this brief in its shared style prompt and includes the Quaso mascot as a scale-and-style reference.

The background contains no embedded text, so all visible game language stays in the translation catalog. Keep important interactive objects in the open clearing; the cottage and pond are decorative border scenery.
