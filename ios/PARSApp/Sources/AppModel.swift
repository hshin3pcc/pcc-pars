import SwiftUI
import WebKit

enum Tab { case attendance, pars }

/// File persistence in Application Support/PARSApp.
enum Store {
    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("PARSApp", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    static func read(_ name: String) -> String? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func write(_ name: String, _ text: String) {
        do { try text.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8) }
        catch { print("[store] write \(name) failed: \(error)") }
    }
}

private final class HandlerProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

func jsonString(_ obj: Any) -> String? {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed]) else { return nil }
    return String(data: d, encoding: .utf8)
}

final class AppModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    @Published var tab: Tab = .attendance
    let attendanceWeb: WKWebView
    let parsWeb: WKWebView
    private var marksJSON = "[]"
    static let homeURL = URL(string: "https://csweb-pub.pasadena.edu/pcc_pars/")!

    override init() {
        attendanceWeb = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        // Let the page run under the status bar; it pads itself with the CSS safe-area insets.
        attendanceWeb.scrollView.contentInsetAdjustmentBehavior = .never

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        var bridge = ""
        if let u = Bundle.main.url(forResource: "pars-bridge", withExtension: "js", subdirectory: "www"),
           let s = try? String(contentsOf: u, encoding: .utf8) { bridge = s }
        else { print("[warn] www/pars-bridge.js missing from bundle") }
        cfg.userContentController.addUserScript(
            WKUserScript(source: bridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        parsWeb = WKWebView(frame: .zero, configuration: cfg)
        parsWeb.allowsBackForwardNavigationGestures = true

        super.init()

        for w in [attendanceWeb, parsWeb] {
            w.configuration.userContentController.add(HandlerProxy(self), name: "pars")
            w.navigationDelegate = self
            w.uiDelegate = self
        }

        if let m = Store.read("marks.json"), !m.isEmpty { marksJSON = m }
        #if DEBUG
        // Seed from a FILE: UserDefaults parses launch-argument values as old-style plists, which mangles JSON.
        if let p = UserDefaults.standard.string(forKey: "PARSMarksSeedFile"),
           let s = try? String(contentsOfFile: p, encoding: .utf8) { marksJSON = s }
        if UserDefaults.standard.string(forKey: "PARSTab") == "pars" { tab = .pars }   // simulator screenshots
        #endif

        loadAttendance()
        loadParsHome()
    }

    // MARK: loading

    func loadAttendance() {
        let ucc = attendanceWeb.configuration.userContentController
        ucc.removeAllUserScripts()
        // Only inject state that parses: a corrupt file would throw inside the user script and leave
        // __PARS_STATE__ undefined, which the web app would read as a fresh install.
        var state = Store.read("state.json")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if state.isEmpty || (try? JSONSerialization.jsonObject(with: Data(state.utf8))) == nil {
            if !state.isEmpty { print("[warn] state.json is not valid JSON; starting empty (file left in place)") }
            state = "null"
        }
        ucc.addUserScript(WKUserScript(source: "window.__PARS_STATE__ = \(state);",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") else {
            print("[warn] www/index.html missing from bundle"); return
        }
        attendanceWeb.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    func loadParsHome() {
        var url = Self.homeURL
        #if DEBUG
        if let s = UserDefaults.standard.string(forKey: "PARSURL"), let u = URL(string: s) {
            url = u
            if u.isFileURL {
                parsWeb.loadFileURL(u, allowingReadAccessTo: u.deletingLastPathComponent())
                return
            }
        }
        #endif
        parsWeb.load(URLRequest(url: url))
    }

    // MARK: JS helpers

    private func eval(_ web: WKWebView, _ js: String) {
        DispatchQueue.main.async {
            web.evaluateJavaScript(js) { _, err in if let err = err { print("[eval error] \(err)") } }
        }
    }

    func sendMarksToPars() {
        eval(parsWeb, "if (window.PARSBridge) PARSBridge.setMarks(\(marksJSON));")
    }

    private func saveMarks(_ json: String) {
        marksJSON = json
        Store.write("marks.json", json)
    }

    // MARK: relay

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if message.webView === parsWeb { fromPars(type, body) } else { fromAttendance(type, body) }
    }

    private func fromAttendance(_ type: String, _ body: [String: Any]) {
        switch type {
        case "save":
            if let s = body["state"], let j = jsonString(s) { Store.write("state.json", j) }
        case "push":
            if let b = body["bundle"], let j = jsonString(b) {
                saveMarks(j)
                tab = .pars
                sendMarksToPars()
            }
        case "openPars": tab = .pars
        case "log": print("[attendance] \(body["message"] ?? "")")
        default: break
        }
    }

    private func fromPars(_ type: String, _ body: [String: Any]) {
        switch type {
        case "ready": sendMarksToPars()
        case "roster":
            if let r = body["roster"], let j = jsonString(r) {
                eval(attendanceWeb, "if (window.PARSApp) PARSApp.receiveRoster(\(j));")
            }
        case "filled":
            let label = body["label"] as? String, date = body["meetingDate"] as? String
            if var arr = (try? JSONSerialization.jsonObject(with: Data(marksJSON.utf8))) as? [[String: Any]] {
                let f = DateFormatter(); f.dateFormat = "yyyyMMdd"; f.locale = Locale(identifier: "en_US_POSIX")
                let today = f.string(from: Date())
                for i in arr.indices where arr[i]["label"] as? String == label && arr[i]["meetingDate"] as? String == date {
                    arr[i]["marks"] = [Any]()
                    arr[i]["filledAt"] = today
                }
                if let j = jsonString(arr) { saveMarks(j) }
            }
            sendMarksToPars()
            if let j = jsonString(body) { eval(attendanceWeb, "if (window.PARSApp) PARSApp.markFiled(\(j));") }
        case "log": print("[pars] \(body["message"] ?? "")")
        default: break
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === parsWeb {
            sendMarksToPars()
            #if DEBUG
            // Simulator end-to-end check: tap the bridge's Fill button once the bar is up (`-PARSAutoFill YES`).
            if UserDefaults.standard.bool(forKey: "PARSAutoFill") {
                eval(parsWeb, "setTimeout(function(){var b=document.querySelector('#parsbridge button');if(b)b.click();},1500);")
            }
            #endif
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === parsWeb { webView.reload() } else { loadAttendance() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.allow); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["http", "https", "file", "about"].contains(scheme) { decisionHandler(.allow) }
        else { UIApplication.shared.open(url); decisionHandler(.cancel) }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }

    private func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let win = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var vc = win?.rootViewController
        while let p = vc?.presentedViewController { vc = p }
        return vc
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let vc = topViewController() else { completionHandler(); return }
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        vc.present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let vc = topViewController() else { completionHandler(false); return }
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        vc.present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard let vc = topViewController() else { completionHandler(nil); return }
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        vc.present(a, animated: true)
    }
}
