# ZenPaws VPM staff app (iPhone and iPad)

A native shell around the clinic's OpenVPM system (`https://app.zenpawsdvm.com`)
for veterinarians and staff: schedule, patients and records, SOAP notes,
billing, inbox, video visits, inventory, reports and settings. It loads the
live system, so every feature and improvement reaches the app without a new
build. The client-facing app is separate (`../zenpaws-client`).

What the native layer adds (`ios/App/App/StaffBridgeViewController.swift`):

- **Safe area:** pages sit clear of the notch and home indicator.
- **Downloads:** reports, exports and documents open the share sheet, so they
  can be saved to Files, printed, AirDropped or sent.
- **Staying signed in:** links that open a new tab on the clinic's own site
  stay in the app; other sites open in Safari.
- **Pull to refresh**, swipe back and forward, and iPad support.
- **Camera and microphone** for video visits, visit recordings and photos.
- **Saved passwords:** iOS offers the staff login from Passwords/iCloud
  Keychain once the server publishes the app under `webcredentials`
  (`APPLE_WEB_CREDENTIAL_APP_IDS`; the ZenPaws updater sets it).
- **Sign in with Apple:** a native plugin (`StaffAppleSignInPlugin`) shows
  Apple's sheet on the sign-in page. It only opens staff logins that already
  exist: staff turn it on from the menu after signing in once, or it connects
  on first use when the Apple ID's verified email is listed for that login in
  `APPLE_STAFF_APPLE_IDS` (`deploy/zenpaws/allow-apple-id.sh`). The server needs
  `APPLE_STAFF_SIGN_IN_CLIENT_IDS=com.zenpawsdvm.staff` (the ZenPaws updater
  sets it), and the bundle id needs the Sign in with Apple capability
  (`scripts/register-bundle-id.mjs` turns it on before each build).

- **Meta smart glasses** (`ios/App/App/MetaGlasses.swift`, Ray-Ban Meta,
  Oakley Meta, Meta Ray-Ban Display) through Meta's Wearables Device Access
  Toolkit 1.0.1 (Swift package `facebook/meta-wearables-dat-ios`). "Take with
  glasses" on a patient's holistic workup takes a photo with the glasses and
  adds it to that patient's clinical photos. **Glasses mode**
  (`ios/App/App/GlassesMode.swift`, the "Glasses" button in the app) keeps the
  glasses connected: a short press of the capture button saves a photo to the
  patient or visit on screen, press and hold (or "Hey Meta, start ZenPaws")
  listens for a request, and a double press stops a visit recording. Spoken
  requests are recognized on the phone from the glasses' microphone: "record
  visit", "stop recording", "take a photo", "turn off glasses", or any
  question for the read-only clinic assistant, which knows the patient or
  visit on screen. Replies play in the glasses and, on Meta Ray-Ban Display,
  show on the lens. Photos and recordings go through the open page
  (`apps/web/lib/glasses/page-actions.ts`), so the usual consent and patient
  rules apply. The capture button needs Inputs enabled for the app in the
  Developer Center; without it, use the phone's microphone button or "Hey
  Meta". The first photo opens the Meta AI app twice:
  once to allow the app, once to allow the camera. Until the app has a Meta
  Wearables Developer Center ID, each phone needs Meta AI's Developer Mode
  (Settings > App Info, tap the version 5 times). With an ID, add the
  `META_WEARABLES_APP_ID` and `META_WEARABLES_CLIENT_TOKEN` repository secrets
  (the build passes them as `META_APP_ID` and `META_CLIENT_TOKEN`) and invite
  staff to the integration's release channel. The toolkit needs iOS 17.2, so the app does
  too. Meta does not yet allow toolkit apps in the App Store, so the
  app stays on TestFlight internal testing, which has no App Review.
- **Offline:** `www/offline.html` is shown when the system cannot be reached.
- **Builds:** `.github/workflows/zenpaws-staff-ios-testflight.yml` archives
  the app on a GitHub macOS runner and uploads it to TestFlight whenever this
  folder changes on the `zenpaws` branch, or when run by hand from the Actions
  tab. It uses the same App Store Connect API key secrets as the client app.
  The App Store Connect app record (bundle id `com.zenpawsdvm.staff`) must
  exist before the first upload.

## Changing the app

```sh
npm install
npx cap sync ios            # after changing capacitor.config.json or plugins
```

Icon and launch-screen sources are in `assets/`.
