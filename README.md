# RideCom — bike-to-bike intercom in your browser

Two riders, two phones, any earphones (AirPods work). Open the same link, type
the same room code, and talk. It works on iPhone (Safari) and Android (Chrome).
There's nothing to install from an app store.

```
iPhone + AirPods  ⇄  mobile data  ⇄  Android + earphones
```

- **Voice:** goes directly phone-to-phone over WebRTC, encrypted end to end.
- **Reconnecting:** if the signal drops, the app reconnects by itself. You hear a
  falling two-tone when the line drops and a rising two-tone when it's back.
- **Data:** about 10–15 MB per hour each way while connected.

---

## 1. Put it online with GitHub Pages (about 10 minutes, no coding)

Microphones only work on `https://` pages, so the app needs real hosting.
GitHub Pages is free and you don't need git installed for this.

1. On github.com, click **+ → New repository**.
   - Name: `ridecom` (or anything you like)
   - **Public** (free GitHub Pages needs a public repo)
   - Click **Create repository**
2. On the new repo page, click **uploading an existing file**.
3. Drag in **everything inside** the `ridecom` folder: `index.html`, `app.js`,
   `style.css`, `config.js`, `sw.js`, `manifest.webmanifest`, `README.md`, and
   the `icons` and `vendor` folders. Then click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment*, choose
   **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. Wait 1–2 minutes and refresh that page. It shows your link, something like
   `https://YOUR-USERNAME.github.io/ridecom/`.

To share a room directly, add the code after `#`:
`https://YOUR-USERNAME.github.io/ridecom/#RIDE42`

## 2. Add a free relay (TURN) server: strongly recommended

Phones on mobile data (Jio, Airtel, Vi…) often can't reach each other
directly. A TURN server relays the (still encrypted) audio when that happens.
**Without one, the app may work on Wi-Fi but fail on 4G.**

1. Sign up for a free account at **metered.ca** and create a TURN server app.
2. In its dashboard, find the **credentials API URL**. It looks like
   `https://YOUR-APP.metered.live/api/v1/turn/credentials?apiKey=XXXX`.
3. On GitHub, open `config.js` → click the ✏️ pencil → paste the URL between the
   quotes of `turnCredentialsUrl: ""` → **Commit changes**.

Free TURN plans have a monthly data limit. Check yours against your trip: the
relay is only used when a direct connection isn't possible.

## 3. Install it on both phones

- **iPhone (Safari):** open the link → Share button → **Add to Home Screen**.
- **Android (Chrome):** open the link → ⋮ menu → **Add to Home screen** / **Install app**.

Open it from the home-screen icon from then on.

## 4. Test before the trip (important!)

Do these in order. If something fails, open **Connection details → Copy log**
and keep the log.

| # | Test | What to look for |
|---|------|------------------|
| 1 | Both at home on Wi-Fi, same room code | Both screens turn green, "Connected". You hear each other. |
| 2 | Both switch to **mobile data** (Wi-Fi off) | Still connects. *Connection details → Route* shows how. |
| 3 | **iPhone: lock the screen** while talking | Can your friend still hear you? Can you hear them? |
| 4 | **iPhone: switch to Google Maps** while talking | Same question. |
| 5 | Same two tests on the Android | Same question. |
| 6 | Walk/ride apart, go through a dead zone | After signal returns, it says "Connected" again by itself (allow ~10–20 s). |
| 7 | 1-hour ride around town with helmets on | Wind noise, volume, battery drain, data used. |

**Tests 3 and 4 decide how you ride.** iPhone Safari is strict about pages
running in the background:

- **Audio continues when locked:** phone can go in your pocket or tank bag.
- **Audio stops when locked:** mount the iPhone with the screen on. The app keeps
  the screen awake on its own, and the dark screen saves battery. Use the
  Android for navigation and follow your friend, or let the iPhone rider
  follow voice directions from the friend.

## Riding tips

- **Wind noise:** a helmet with a chin curtain helps a lot. Mute the mic when
  you're not talking on noisy stretches (the giant button is glove-friendly).
- **Earphone buttons (experimental):** pressing pause on your earphones mutes
  your mic, and play unmutes it. Taking an AirPod out may also mute you. Watch
  for "Mic MUTED" on screen.
- **AirPods battery:** about 4–5 h of calls. Wear one bud and swap at breaks, or
  charge the case from a power bank.
- **Phone battery:** keep the phone on a charger while riding if the screen is on.
- Keep the volume low enough to hear horns and traffic.

## What the status means

| Status | Meaning |
|--------|---------|
| 🟢 Connected | Talking. The timer shows how long. |
| 🟡 Waiting for friend | You're in the room; your friend hasn't joined yet. |
| 🟡 Weak signal | Audio is struggling; the app holds the line for a few seconds. |
| 🟡 Reconnecting… | The line dropped; the app is reconnecting by itself. Do nothing. |
| 🔴 No internet | Your phone has no data. It reconnects when signal returns. |
| 🔴 Room is full | Two other phones are using this code. Pick a different code. |

## Troubleshooting

- **Stuck on "Connecting… / Reaching the server…"**: the phone can't reach the
  free PeerJS server that introduces the two phones. Check internet. If it
  never works on any network, that server may be down. See *Advanced* below.
- **"Can't connect directly on this network"**: add a TURN server (step 2).
- **No sound but "Connected"**: tap the yellow *Tap to turn on sound* button if
  shown, check the volume, and check the earphones are the selected output.
- **Mic blocked**: iPhone: Settings → Safari → Microphone → Allow.
  Android: tap the icon left of the address bar → Permissions → Microphone.
- **Pick an unusual room code** (e.g. `BLUEFALCON77`, not `TEST`). The room
  code is the only thing that keeps strangers out, and only two phones fit in a room.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page layout (join screen and call screen) |
| `style.css` | Dark, high-contrast styling with big touch targets |
| `app.js` | Everything else: microphone, connection, auto-reconnect, meters, mute |
| `config.js` | **Your settings**: TURN server and signalling server |
| `sw.js` | Saves the app on the phone so it opens even on weak signal |
| `manifest.webmanifest`, `icons/` | Home-screen app name and icon |
| `vendor/peerjs-1.5.5.min.js` | [PeerJS](https://peerjs.com) library (MIT licence) for WebRTC signalling |

## Advanced: how it works

- Room code `RIDE42` becomes two IDs on the signalling server:
  `ridecom-v1-ride42-a` and `…-b`. Each phone takes whichever is free.
- Phone **B** calls phone **A**, and keeps calling every few seconds until A
  answers, and again whenever the line drops. Only B ever calls, so the two
  phones never call each other at the same time.
- A supervisor checks the connection every second and repairs it. A weak
  signal gets a 6 s grace period, then B redials. A lost server link is
  retried with backoff (1 s → 8 s); the voice call keeps going without it.
- To run your own signalling server instead of PeerJS's free one, run the
  [`peer`](https://www.npmjs.com/package/peer) npm package somewhere with
  HTTPS and set `peerServer: { host, port, path, secure: true }` in `config.js`.
