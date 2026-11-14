# Carrom

A fast, installable (PWA) carrom game: two players, four players (teams), 2 players vs 2 AI, or versus the computer. Plain HTML + canvas, no build step, works offline.

## Run
Serve the folder over HTTP (service worker + the board image need it):

    python3 -m http.server 8000

then open http://localhost:8000. Hosting on GitHub Pages works as is.

## How to play
- **Move the striker**: slide the knob under the board.
- **Shoot**: touch the board anywhere and drag *backwards* (slingshot). Longer drag = harder shot. Drag back to the start to cancel.
- White (P1) shoots from the bottom line, Black (P2 / computer) from the top line.
- Pocket your own coin → shoot again. Opponent's coin you pocket counts for them and ends your turn.
- Pocket the queen, then pocket one of your coins in the same turn or the next shot to *cover* it, otherwise it goes back to the centre.
- Striker pocketed = foul: one of your pocketed coins returns to the centre (or you owe one).
- Win by pocketing all 9 of your coins plus the covered queen.

## Modes
Pick one of the four picture buttons on the menu (images live in `menu/`):
- **Two player** – pass and play, White (bottom) vs Black (top).
- **2 players vs 2 AI** – four seats; the two people (bottom + top, partners) play the two AIs (right + left, partners).
- **Four player** – four seats, partners sit opposite: P1 + P3 (White) vs P2 + P4 (Black). Turns go clockwise.
- **Versus computer** – you are White, the computer is Black.

## Sounds
Optional mp3 files go in `sounds/` (see `sounds/README.txt`). Without them the game uses built-in synth sounds.

## Files
`index.html`, `styles.css`, `game.js`, `board/carrom-board.svg`, `manifest.webmanifest`, `sw.js`, `icons/`. Bump `VERSION` in `sw.js` when you change files so installed copies update.
