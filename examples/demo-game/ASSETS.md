# Quaso Quest artwork

The game's images are stored in `public/art/`. Running or building the game does not require an
image-generation service or the original source collection. Font files and their license notices
are in `public/fonts/`.

## Images and source grids

The project records these sources for the checked-in images:

| File                                | Size in pixels | Recorded source                                                                       |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `quaso-0.png` through `quaso-3.png` | 40 × 32        | Frames 4–7 from the supplied `quaso-waving` collection.                               |
| `dog.png`                           | 32 × 32        | Supplied `dog/dog-2.png`.                                                             |
| `butter.png`                        | 16 × 16        | Hand-drawn grid in the Quaso palette; editable source in `butter.txt`.                |
| `bee-0.png`, `bee-1.png`            | 16 × 16        | Hand-drawn bee with two wing positions; sources in the matching `.txt` files.         |
| `meadow.png`                        | 240 × 135      | Nano Banana 2.1 candidate 4, reduced to the Quaso palette and edited in `meadow.txt`. |
| `meadow-mobile.png`                 | 120 × 135      | Portrait layout of the meadow, with source in `meadow-mobile.txt`.                    |

The original sprite collection was in the author's local `.quaso/pixel-art` folder. The repository
contains the runtime copies; that ignored folder is not required to use them. The Quaso frames
animate the cat-croissant character. Display pixel art with `image-rendering: pixelated` to keep
sharp edges when scaling it.

The text grids store a palette and one character per pixel. The butter uses five colors; the bee
uses six. The bee's body stays in place while its wings move. The landscape meadow uses 24 colors.
The portrait version rearranges its bakery, pond, trees, and picnic for narrow screens.

The backgrounds contain no game text. Keep visible words in the translation files, and leave the
open center of the scene available for game objects.

## Fonts and interface

The Jersey 25 and Jersey 20 fonts are copied from Quaso's design system and use the SIL Open Font
License. Keep their original notices with the font files. The interface also uses Quaso's plum,
lime, and mint colors, square borders, and shadows. It has no design-system runtime dependency.

## Art workflow

The original workflow used the local `quaso-pixel-art` skill: generate candidates with Nano Banana,
reduce them to the Quaso palette, check them, edit the text grids, and export PNG files. That skill
is not included in this repository. Its original command paths were:

```sh
.agents/skills/quaso-pixel-art/pixel render examples/demo-game/public/art/butter.txt
.agents/skills/quaso-pixel-art/pixel export examples/demo-game/public/art/butter.txt examples/demo-game/public/art --name=butter --title="Butter pat"
```

These commands require the separate skill at that path. They document how the assets were made;
they are not a build step. Generation credentials are not required by the game.

## Meadow generation prompt

The recorded generation prompt is preserved below:

```text
Overhead cozy French picnic meadow game map, no horizon. Tiny cream bakery with orange tiled roof in upper-left corner, tiny turquoise pond upper-right, coral gingham picnic blanket lower-right at x83% y72%. Round leafy trees, white daisies and pink flowers frame the edges. Keep the broad center completely open grass for walking, especially x10–90% y25–85%; sparse grass clusters only. Cute sunny handheld RPG world beside the Quaso mascot, large clear pixels, flat green and warm butter tones. No characters, animals, coins, signs, lettering or UI. The open clearing is the subject.
```

The recorded options were `--size=240x135 --opaque --count=4 --colours=24`. The original skill added
its shared style prompt and a Quaso reference image. The generated image was then edited; the
prompt alone does not reproduce the checked-in background.
