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
