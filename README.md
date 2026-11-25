# BG Play vs Open Sage (offline app)

Backgammon against the [Open Sage](https://github.com/markbgsage/bgsage) engine, running entirely on your device: the
engine is compiled to WebAssembly and every calculation happens in the browser.

## Install (once, with a connection)

1. Open the app's GitHub Pages address in Chrome on your phone.
2. Wait for the engine to load (about 14 MB), then use Chrome's menu → **Install app** (or **Add to Home screen**).

After that the home-screen icon opens the app with no connection at all: a service worker keeps every file on the device.
When you're online it checks for a new version in the background.

## What it does

- Cash games (Jacoby rule and beavers by default) with a running session tally, or matches with the Crawford rule.
- Open Sage plays at 1, 2, 3 or 4 ply; you can see the plays it compared after each of its moves.
- Your checker plays and cube decisions are analysed at 4-ply while you play; your ER (eXtreme Gammon's PR formula and
  decision counting) is shown when the game ends.
- **Review** (end of a game, or any saved game): step through your errors, or every move of both sides, each shown as
  the BG Position Analyzer shows it: 2-, 3-, then 4-ply, the ranked plays with your move marked, and a rollout on
  request. The written explanations need Claude, so they're in the tile only.
- Finished games can be saved as `.mat` files for a full review in Claude: **Send to the tile** copies them and opens
  the BG Play tile, where you tap the box and Paste (you need a connection for that step).

Your games stay in this browser's storage on the device; nothing is sent anywhere.

## Licences

The review page (`review.html`, `review.js`, `pa-worker.js`) is the BG Position Analyzer's page and engine worker.
The engine files (`engine.js`, `engine.wasm`, `weights-bundle.wasm`, `manifest.json`) are a WebAssembly build of
Open Sage by Mark Higgins, under the Mozilla Public License 2.0 (`LICENSE-OpenSage.txt`). The source of the build's
entry point is in `src/tile_engine.cpp`, with the build steps in `src/build.sh`; the rest of the engine's source is at
https://github.com/markbgsage/bgsage.
