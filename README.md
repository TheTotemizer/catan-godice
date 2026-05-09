# Catan Companion

A smart-dice-driven companion app for **Settlers of Catan**, designed to sit on a tablet in the middle of the table. It pairs with your **GoDice** over Bluetooth, automatically detects every roll, and helps you with the bookkeeping the game asks of you (the robber, discarding, who built largest army, longest road, VP totals, turn timers, roll statistics, and more).

It's a *companion*, not a replacement — your physical board, cards, pieces, and trading still happen on the table. The app handles the things that are tedious (or that get forgotten).

---

## Features

- **Live GoDice integration.** Pair multiple dice; the app auto-tags rolls with the active player, computes sums, and surfaces special events (7s, hot/cold numbers).
- **Robber / 7 helper.** When a 7 is rolled, all dice flash red, a discard helper modal opens with each player's card count → required-discard math (`floor(n/2)` if `n > 7`). Confirm when the robber has been moved.
- **Turn timer.** Per-turn timer plus accumulated time per player and longest-turn tracking. Auto-starts on first roll (toggle in settings).
- **5–6 player Special Build Phase.** When enabled, end-turn pauses for the SBP before advancing to the next player.
- **Roll statistics.** Live frequency chart 2–12 with the expected probability line overlaid; hot/cold number flagging once enough rolls accumulate.
- **Player aids.** Building costs, dev card distribution + effects, port trade rates, longest road / largest army holders, manual VP tracker.
- **Persistence.** Game state auto-saves to `localStorage` and you can resume after a refresh. Past games are summarized in an archive.
- **Manual entry fallback.** If you don't have your dice connected (or you're on iPad — see below), tap the on-screen dice to enter rolls manually.
- **PWA installable.** Add to home screen on Android tablets for a fullscreen, offline-capable experience.

---

## Browser support — read this first

The GoDice JavaScript API uses **Web Bluetooth**, which works in:

- Chrome / Edge / Opera on **Android, Windows, macOS, ChromeOS, Linux**

It does **not** work in **Safari on iPhone or iPad**. If you primarily use an iPad, you can still play with the manual-entry mode (or look into `Bluefy` browser as a workaround). For the best experience, use an Android tablet or a laptop you can prop on the table.

Web Bluetooth also requires **HTTPS** (or `localhost`) — see "Running it" below.

---

## Running it

### Option A — locally with one command

From this folder:

```sh
# Python 3
python3 -m http.server 8000

# or Node
npx serve .
```

Then open `http://localhost:8000` in Chrome on the device next to your dice. Web Bluetooth permits `localhost` over HTTP, so this works without setting up TLS.

### Option B — host it (so any device on your network can use it)

Drop the folder onto **GitHub Pages**, **Netlify**, **Cloudflare Pages**, or any static host. Web Bluetooth requires HTTPS — all three give you that for free.

### Option C — install as a PWA

Once loaded over HTTPS (or localhost), Chrome will offer "Add to Home Screen" / "Install". Installs as a fullscreen tablet app.

---

## Using the app

1. **Welcome screen.** Tap **Start setup** (or **Resume** if you have a saved game).
2. **Players.** Add 3–6 players, name them, pick colors. Toggle the 5–6 player expansion if applicable. Tap **Next**.
3. **Pair dice.** Tap **Pair a die** → your browser opens a Bluetooth chooser → pick the die that just lit up. Repeat for each die. Need at least 2.
   - Or tap **Skip — manual entry** to use the on-screen dice (tap to enter values).
4. **Assign roles.** Pick which two dice are your production pair (one per role). Tap **Start game**.
5. **Play.** Roll the production dice — values appear immediately, the sum is highlighted, the roll is logged with the active player's name.
   - On a 7, dice LEDs flash red and the discard helper opens.
   - Tap **End turn** to pass the timer to the next player. With 5–6 player mode enabled, you'll be prompted for the Special Build Phase first.
6. **Stats / Aids / Settings** are accessible from the icons in the top bar at any time.

---

## Files

```
index.html              page structure (welcome, setup, game, overlays)
styles.css              clean modern theme, tablet-first
app.js                  state machine, screen routing, game logic
godice-adapter.js       wrapper over GoDice with central event dispatcher
                        + manual-entry fallback
manifest.webmanifest    PWA manifest
sw.js                   minimal offline service worker
README.md               you are here
```

The GoDice library itself (`godice.js`) is loaded from jsDelivr's GitHub mirror at runtime so you don't have to vendor it yourself. If you prefer to host it locally, download `godice.js` from https://github.com/ParticulaCode/GoDiceJavaScriptAPI, drop it next to `index.html`, and change the script src in `index.html` to `godice.js`.

---

## Notes & known limitations

- **First-roll-after-connect:** GoDice does not report a die's current face until you roll it. Expect a `?` next to a freshly paired die until its first roll.
- **Pairing doesn't persist across page refreshes.** Web Bluetooth requires the user gesture each time the page loads. If you refresh mid-game, you'll need to re-pair the dice (game state itself is preserved).
- **Tilt-stable rolls** (die settles on its edge / shell) are counted as real rolls — re-roll if you don't want them.
- **D4 shell** has known mapping issues upstream; the app defaults all dice to D6, which is what Catan needs anyway.
