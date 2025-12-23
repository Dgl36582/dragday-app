# DragDay (iPhone 13 Pro Max) — Ready-to-build iOS App

Master, this package is a **native iOS app project** (Capacitor + an offline-first web UI) that:
- Logs **1/8-mile bracket race-day data** you listed (tire pressure, temps, delay box, shock clicks, launch/shift RPM, etc.)
- Parses **ET slips** (paste or type) and stores them per pass
- Produces organized **runs tables** (your “spreadsheet” view) + dial/package/stripe analysis
- Stores **track weather** with each pass (Temp/RH/Pressure) and normalizes ET for air density
- Generates **next-round ET prediction** using only auditable math (density-normalized ET + conservative weighted estimator + 95% band)
- Generates **dial-in guidance** based on a chosen breakout-risk (normal quantile)

Included:
- `www/` — the full app (PWA UI)
- `ios/` — the generated Xcode project (open and run)
- `backtest_math.js` + `BACKTEST_RESULTS.json` — a deterministic math backtest you can run on any computer with Node

## Tracks preloaded
These tracks are already loaded on first launch (and editable inside the app):
- Gulfport Dragway
- Montgomery International Dragway (Montgomery Raceway Park / Capital City Motorsports Park)
- Mobile Dragway
- Holiday Raceway
- Cottonwood Dragway
- Atmore Dragway
- No Problem Raceway Park
- Bristol Dragway (Bristol Motor Speedway & Dragway)
- GALOT Motorsports Park
- North Florida Motorsports Complex (North Florida Motorplex / Powerhouse Motorsports Park)

## What I cannot do inside this chat
Apple requires **your** Apple Developer signing identity (certificate/team) to create a signed .ipa. I can’t access that from here.

What you *do* have right now is the next best thing: a complete, correct Xcode project that will compile and sign the moment you choose your Apple Team in Xcode.

Apple confirms you can install apps on your personal device using Xcode, and you only need to enroll if you want distribution features (TestFlight / App Store).

---

# Install on your iPhone 13 Pro Max (the simplest way)

## You need
1) **A Mac** (MacBook/iMac) with **Xcode** installed.
2) Your iPhone 13 Pro Max + a charging cable.
3) An Apple ID signed into Xcode.

> If you don’t own a Mac: ask a friend/family member with a Mac, or use a local computer shop. You only need the Mac for the first install (and future updates).

## Steps
1) **Unzip** this folder onto the Mac.
2) Open the iOS project:
   - Go to: `ios/App/`
   - Double-click: **`App.xcodeproj`**
3) In Xcode, set signing:
   - In the left sidebar, click **App** (blue project icon)
   - Click **Target: App**
   - Click **Signing & Capabilities**
   - Check **Automatically manage signing**
   - Set **Team** to your Apple ID / developer team
   - Bundle ID is: `com.wprs.dragday` (you can change it if Xcode asks)

   Apple’s automatic signing workflow is documented here.
4) Plug your iPhone into the Mac.
5) At the top of Xcode (next to the Play ▶ button), choose your device: **your iPhone**.
6) Press **Play ▶**.

If your iPhone asks to “Trust This Computer”, tap **Trust**.

---

# Distribute to yourself via TestFlight (no cable installs)
This is how you install updates easily and keep the app in TestFlight.

## You need
- Apple Developer Program membership (required for TestFlight/App Store distribution).

## Steps
1) In Xcode: **Product → Archive**
2) In Organizer: select the archive → **Distribute App**
3) Choose **TestFlight / App Store Connect** and follow prompts.

Apple’s distribution steps are documented in Xcode help.

---

# App basics (how you’ll use it on race day)
1) Open app → **Race Day** tab → choose track → create/select a race day.
2) Enter weather (or use the **Fetch Weather** button when available) and your setup numbers.
3) After each pass: **Enter Pass** → paste timeslip text (or type numbers) → save.
4) **Runs Table** becomes your organized “spreadsheet.”
5) **Bracket** tab = dial-in, package, breakout, winner + stripe logic.
6) **Analysis** tab = patterns (scatter, correlations, consistency notes).
7) **Export/Backup** = share/download CSV.

---

# Backtest (math verification)
On any computer with Node installed:
```bash
cd dragday_ios
node backtest_math.js
```
It prints a JSON PASS/FAIL and key numeric sanity checks.

A sample run output is already saved as `BACKTEST_RESULTS.json`.

## Sources used for preloaded track coordinates
- Gulfport Dragway coordinates: AirDensityOnline track page
- Mobile Dragway coordinates: AirDensityOnline track page
- Atmore Dragway coordinates: AirDensityOnline track page
- Holiday Raceway coordinates: findlatitudeandlongitude.com entry
- Cottonwood Dragway coordinates: findlatitudeandlongitude.com entry
- No Problem Raceway Park coordinates: AirDensityOnline track page
- Bristol Dragway coordinates: FactoryToursUSA lat/long list (Bristol Motor Speedway & Dragway)
- GALOT Motorsports Park coordinates: IHRA track page
- North Florida (Powerhouse) coordinates: AirDensityOnline track page / NA-Motorsports Breakaway Dragstrip entry
- Montgomery drag strip coordinates: AirDensityOnline “Capital City Motorsports Park” map entry

## Sources used for iOS signing/distribution steps
- Apple: Program enrollment / installing on a personal device with Xcode
- Apple: Distributing your app for beta testing and releases (Xcode)
- Apple: TestFlight overview

(If you want, I can add a “Sources” screen inside the app itself.)
