import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // A portal sign-in link tapped while the app was closed.
        if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.openPortalLink(activity.webpageURL)
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb {
            openPortalLink(userActivity.webpageURL)
        }
    }

    /// Open a ZenPaws portal link (for example a one-time sign-in link from
    /// the clinic) inside the app instead of Safari, so the session lands here.
    private func openPortalLink(_ url: URL?) {
        guard let url = url,
              url.scheme == "https",
              url.host == "app.zenpawsdvm.com",
              url.path.hasPrefix("/portal"),
              let bridge = window?.rootViewController as? CAPBridgeViewController,
              let webView = bridge.webView else { return }
        webView.load(URLRequest(url: url))
    }
}
