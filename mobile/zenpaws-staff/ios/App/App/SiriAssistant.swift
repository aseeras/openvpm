import AppIntents
import Foundation
import WebKit

/// Siri and Shortcuts actions for the clinic assistant.
///
/// "Hey Siri, ask ZenPaws" (or "ask ZenPaws VPM") asks for a question, sends it to the clinic
/// system with the sign-in the app already holds, and Siri reads the answer
/// aloud. Answers are read-only: nothing in the chart can be changed by
/// voice. If nobody is signed in on this phone, Siri says to open the app.
@available(iOS 17.0, *)
enum ClinicAssistant {
    static let baseURL = URL(string: "https://app.zenpawsdvm.com")!

    /// `context` names what is open in the app (`patientId`,
    /// `appointmentId`) so "this patient" works from the glasses.
    static func ask(_ question: String, context: [String: String] = [:]) async -> String {
        let cookies = await signInCookies()
        guard !cookies.isEmpty else {
            return "Open ZenPaws VPM and sign in first, then ask again."
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("api/assistant/ask"))
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                         forHTTPHeaderField: "Origin")
        request.setValue("staff-ios-siri", forHTTPHeaderField: "X-OpenVPM-Client")
        for (name, value) in HTTPCookie.requestHeaderFields(with: cookies) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        var body: [String: Any] = ["question": question]
        if !context.isEmpty { body["context"] = context }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let answer = body["answer"] as? String,
               !answer.isEmpty {
                return answer
            }
            return "I couldn't get an answer. Try again in the app."
        } catch {
            return "I couldn't reach the clinic system. Check your connection and try again."
        }
    }

    /// The clinic site's cookies from the app's web view, which hold the
    /// staff member's sign-in.
    @MainActor
    private static func signInCookies() async -> [HTTPCookie] {
        let all = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        let host = baseURL.host ?? ""
        return all.filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return host == domain || host.hasSuffix("." + domain)
        }
    }
}

@available(iOS 17.0, *)
struct AskClinicAssistantIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask the Assistant"
    static var description = IntentDescription(
        "Ask the clinic assistant about your day, a patient or what needs your attention. Answers are read-only."
    )
    static var openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What would you like to know?")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let answer = await ClinicAssistant.ask(question)
        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

@available(iOS 17.0, *)
struct MyDayIntent: AppIntent {
    static var title: LocalizedStringResource = "My Day"
    static var description = IntentDescription("Hear today's visits in order.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let answer = await ClinicAssistant.ask(
            "What does my day look like? List my visits in order with the time, pet, client and town."
        )
        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

@available(iOS 17.0, *)
struct NeedsAttentionIntent: AppIntent {
    static var title: LocalizedStringResource = "What Needs My Attention"
    static var description = IntentDescription(
        "Hear unread messages, replies to approve, labs to review and unsigned notes."
    )
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let answer = await ClinicAssistant.ask("What needs my attention?")
        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

/// Phrases Siri recognizes with no setup. Each must include the app name.
@available(iOS 17.0, *)
struct ClinicAssistantShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskClinicAssistantIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask the \(.applicationName) assistant",
                "Ask \(.applicationName) a question",
            ],
            shortTitle: "Ask the Assistant",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: MyDayIntent(),
            phrases: [
                "My day in \(.applicationName)",
                "What's my day in \(.applicationName)",
            ],
            shortTitle: "My Day",
            systemImageName: "calendar"
        )
        AppShortcut(
            intent: NeedsAttentionIntent(),
            phrases: [
                "What needs my attention in \(.applicationName)",
            ],
            shortTitle: "Needs My Attention",
            systemImageName: "tray"
        )
    }
}
