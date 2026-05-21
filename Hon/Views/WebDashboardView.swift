import AppKit
import SwiftUI
import WebKit

/// Hosts Hon's web dashboard (served by the local engine) inside a WKWebView,
/// so the macOS app and the browser app share exactly one UI.
struct WebDashboardView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Tell the web app it runs inside the native shell — it then hides the
        // vault "Lock" action, which would lock the user out of an auto-managed
        // passphrase they never see.
        config.userContentController.addUserScript(WKUserScript(
            source: "window.honNative = true;",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(context.coordinator, name: "honVault")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        // Match the dashboard's dark background so there is no white flash
        // before the page paints.
        webView.underPageBackgroundColor = NSColor(
            red: 0.075, green: 0.067, blue: 0.125, alpha: 1)
        context.coordinator.loadedURL = url
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Reload only when the engine restarts on a fresh port.
        guard context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate,
                             WKScriptMessageHandler {
        var loadedURL: URL?

        // SnapTrade's connection portal is opened with window.open(); send such
        // links to the user's real browser instead of a dead in-app popup.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
            return nil
        }

        // The web app hands the vault passphrase back after a manual unlock so
        // the next launch can unlock silently.
        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "honVault",
                  let passphrase = message.body as? String,
                  !passphrase.isEmpty else { return }
            try? KeychainStore.setVaultPassphrase(passphrase)
        }
    }
}
