import UIKit
import WebKit
import Capacitor

/// The staff app's web view controller. The whole clinic system runs as the
/// live website; this adds what a phone needs around it:
/// - the page sits inside the safe area, clear of the notch and home bar;
/// - files the system offers (reports, exports, documents) are downloaded and
///   handed to the share sheet, so they can be saved, printed or sent;
/// - links that open a new tab on the clinic's own site stay in the app, so
///   staff stay signed in;
/// - pull down to reload.
class StaffBridgeViewController: CAPBridgeViewController {
    private var webDelegate: StaffWebViewDelegate?
    private let refresh = UIRefreshControl()

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let webView = webView else { return }

        // Put the web view in a container pinned to the safe area.
        let container = UIView(frame: view.frame)
        container.backgroundColor = .white
        view = container
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor),
        ])
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = true

        refresh.addTarget(self, action: #selector(reloadPage), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        if let capacitorHandler = webView.navigationDelegate as? WebViewDelegationHandler {
            let delegate = StaffWebViewDelegate(forwardingTo: capacitorHandler, controller: self)
            webDelegate = delegate
            webView.navigationDelegate = delegate
            webView.uiDelegate = delegate
        }
    }

    @objc private func reloadPage() {
        webView?.reload()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.refresh.endRefreshing()
        }
    }

    /// Match the bars around the page to the page's own background.
    func adoptPageBackground() {
        webView?.evaluateJavaScript("getComputedStyle(document.body).backgroundColor") { [weak self] value, _ in
            guard let css = value as? String, let color = UIColor(cssRGB: css) else { return }
            self?.view.backgroundColor = color
        }
    }

    /// Offer a downloaded file to save, print, AirDrop or send.
    func share(fileAt url: URL) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        (presentedViewController ?? self).present(sheet, animated: true)
    }
}

/// Sits in front of Capacitor's web view delegate: handles downloads and
/// new-tab links, and passes everything else through unchanged.
final class StaffWebViewDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let capacitor: WebViewDelegationHandler
    private weak var controller: StaffBridgeViewController?
    private var destinations: [ObjectIdentifier: URL] = [:]

    init(forwardingTo capacitor: WebViewDelegationHandler, controller: StaffBridgeViewController) {
        self.capacitor = capacitor
        self.controller = controller
    }

    // Anything not handled here goes to Capacitor.
    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || capacitor.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        capacitor.responds(to: aSelector) ? capacitor : super.forwardingTarget(for: aSelector)
    }

    private static func isClinicSite(_ url: URL?) -> Bool {
        url?.host == "app.zenpawsdvm.com"
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // <a download> links, including files the page builds itself (blob:).
        if navigationAction.shouldPerformDownload || navigationAction.request.url?.scheme == "blob" {
            decisionHandler(.download)
            return
        }
        capacitor.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if disposition.hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        capacitor.webView(webView, didFinish: navigation)
        controller?.adoptPageBackground()
    }

    // MARK: New tabs

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // The clinic's own pages open here, where staff are signed in; other
        // sites open in Safari.
        if Self.isClinicSite(navigationAction.request.url) {
            webView.load(navigationAction.request)
            return nil
        }
        return capacitor.webView(webView, createWebViewWith: configuration, for: navigationAction, windowFeatures: windowFeatures)
    }

    // MARK: Downloads

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("downloads-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let destination = folder.appendingPathComponent(name)
        destinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        DispatchQueue.main.async { self.controller?.share(fileAt: url) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        destinations.removeValue(forKey: ObjectIdentifier(download))
        DispatchQueue.main.async {
            let alert = UIAlertController(title: "Download failed", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            self.controller?.present(alert, animated: true)
        }
    }
}

private extension UIColor {
    /// Parses "rgb(r, g, b)" or "rgba(r, g, b, a)"; nil for transparent.
    convenience init?(cssRGB css: String) {
        let numbers = css
            .components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
            .compactMap { Double($0) }
        guard numbers.count >= 3 else { return nil }
        if numbers.count >= 4 && numbers[3] == 0 { return nil }
        self.init(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: 1)
    }
}
