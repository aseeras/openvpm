import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = StaffBridgeViewController()
        window?.makeKeyAndVisible()

        for context in connectionOptions.urlContexts where MetaGlasses.isWearablesCallback(context.url) {
            MetaGlasses.handleCallback(context.url)
        }
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // Meta AI returns here after the vet allows ZenPaws or the camera.
        let glasses = URLContexts.filter { MetaGlasses.isWearablesCallback($0.url) }
        for context in glasses {
            MetaGlasses.handleCallback(context.url)
        }
        let others = URLContexts.subtracting(glasses)
        if !others.isEmpty {
            SceneDelegateProxy.shared.scene(scene, openURLContexts: others)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
