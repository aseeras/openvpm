import UIKit
import Capacitor
import AuthenticationServices

/// The app's web view controller. It registers the app's own native plugins
/// with the Capacitor bridge so the client portal can call them.
class ZenPawsBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ZenPawsAppleSignInPlugin())
    }
}

/// Sign in with Apple for the client portal. The portal passes a one-time
/// nonce from the server; Apple returns an identity token carrying it, which
/// the portal sends back to the server to check and sign the client in.
@objc(ZenPawsAppleSignInPlugin)
public class ZenPawsAppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ZenPawsAppleSignInPlugin"
    public let jsName = "ZenPawsAppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?

    @objc func authorize(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("A nonce is required")
            return
        }
        DispatchQueue.main.async {
            if let previous = self.pendingCall {
                previous.reject("Superseded by a new sign-in request", "1001")
            }
            self.pendingCall = call

            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email, .fullName]
            request.nonce = nonce

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }
}

extension ZenPawsAppleSignInPlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            call.reject("Apple did not return an identity token")
            return
        }
        call.resolve([
            "identityToken": identityToken,
            "user": credential.user,
            "email": credential.email ?? NSNull(),
            "givenName": credential.fullName?.givenName ?? NSNull(),
            "familyName": credential.fullName?.familyName ?? NSNull(),
        ])
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        let code = (error as? ASAuthorizationError)?.code
        if code == .canceled {
            call.reject("Sign in with Apple was cancelled", "1001")
        } else {
            call.reject(error.localizedDescription, String((error as NSError).code))
        }
    }
}

extension ZenPawsAppleSignInPlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
