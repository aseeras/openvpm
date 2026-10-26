# ZenPaws client app (iPhone)

A native iPhone shell around the ZenPaws client portal
(`https://app.zenpawsdvm.com/portal`). Pet owners see their pets, upcoming
visits, invoices and messages, and can book a house call. Because the app
loads the live portal, portal improvements reach the app without a new build.

- **Sign-in:** the clinic sends a one-time portal link. With app links turned
  on (`deploy/zenpaws/enable-ios-app-links.sh <TEAM_ID>` on the server), the
  link opens straight into the app and the session stays there.
- **Offline:** `www/offline.html` is shown when the portal cannot be reached.
- **Builds:** `.github/workflows/zenpaws-ios-testflight.yml` archives the app
  on a GitHub macOS runner and uploads it to TestFlight whenever this folder
  changes on the `zenpaws` branch, or when run by hand from the Actions tab.

## Changing the app

```sh
npm install
npx cap sync ios            # after changing capacitor.config.json or plugins
npx capacitor-assets generate --ios --iconBackgroundColor '#E8E4D6' --splashBackgroundColor '#E8E4D6'
```

Icon and launch-screen sources are in `assets/`. Native code lives in
`ios/App/App` (`SceneDelegate.swift` opens portal links inside the app).
