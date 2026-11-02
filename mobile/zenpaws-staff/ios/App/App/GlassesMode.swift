import AVFoundation
import Foundation
import Speech
import MWDATCore
import MWDATDisplay
import MWDATInputs

/// Glasses mode: ZenPaws through Meta glasses, hands-free.
///
/// - Capture button, short press: photo for the patient on screen.
/// - Capture button, press and hold (or the action button, or tapping the
///   lens on Meta Ray-Ban Display): listen for a request.
/// - Capture button, double press: stop recording the visit.
/// - Requests: "record visit", "stop recording", "take a photo", "turn off
///   glasses", or any question for the clinic assistant, which already knows
///   the patient or visit that is open in the app.
/// - Replies are spoken in the glasses and, on glasses with a display, shown
///   on the lens.
///
/// Speech is recognized on the phone (on-device when the phone supports it)
/// from the glasses' Bluetooth microphone, and answers come from the same
/// read-only assistant as the Siri actions. Photos and recordings are handed
/// to the open page so they land on the right patient and visit, exactly as
/// if the buttons on screen were used.
@MainActor
final class GlassesMode {
    static let shared = GlassesMode()

    /// What the page and the phone screen show.
    struct State {
        var active = false
        var listening = false
        var busy = false
        var display = false
        var buttons = false
        var heard: String?
        var reply: String?

        var dictionary: [String: Any] {
            [
                "active": active,
                "listening": listening,
                "busy": busy,
                "display": display,
                "buttons": buttons,
                "heard": heard ?? "",
                "reply": reply ?? "",
            ]
        }
    }

    private(set) var state = State() {
        didSet { onChange?(state) }
    }

    /// Set by the web view controller: sends state changes to the page.
    var onChange: ((State) -> Void)?
    /// Set by the web view controller: runs a page action ("photo",
    /// "recordStart", "recordStop") and returns what to say, or nil when the
    /// open page has no such action.
    var runPageAction: ((String) async -> String?)?
    /// Set by the web view controller: the patient or visit on screen.
    var pageContext: (() -> [String: String])?

    private var inputs: Inputs?
    private var inputsTask: Task<Void, Never>?
    private let inputTokens = ListenerTokenBag()
    private var lens: GlassesLens?
    private let speech = GlassesSpeech()
    private var starting = false
    /// Whether Meta's toolkit connected; without it, glasses mode is voice only.
    private var linked = false

    private init() {
        GlassesSession.shared.onEnded = { [weak self] in
            Task { @MainActor in self?.ended() }
        }
    }

    // MARK: On and off

    func start() async throws {
        if state.active || starting { return }
        starting = true
        defer { starting = false }

        try await speech.prepare()
        // Talking to the assistant only needs the glasses as a Bluetooth
        // headset, so glasses mode still starts when Meta's toolkit can't
        // reach them; only the capture button, the lens and glasses photos
        // need the toolkit's connection.
        var session: DeviceSession?
        do {
            session = try await GlassesSession.shared.acquire(.mode)
        } catch let failure as GlassesFailure {
            GlassesLog.add("glasses mode without the toolkit: \(failure.message)")
        } catch {
            GlassesLog.add("glasses mode without the toolkit: \(MetaGlasses.describe(error))")
        }
        linked = session != nil

        if let session {
            attachInputs(to: session)
            if session.device?.supportsDisplay() == true {
                let lens = GlassesLens()
                if await lens.attach(to: session, onTap: { [weak self] in
                    Task { @MainActor in self?.listen() }
                }) {
                    self.lens = lens
                }
            }
        }
        state = State(active: true, display: lens != nil, buttons: inputs != nil)
        let hint: String
        if inputs != nil {
            hint = "Press the capture button for a photo, or hold it to talk."
        } else if linked {
            hint = "Tap Talk on the phone to ask me something."
        } else {
            hint = "Tap Talk on the phone to ask me something. The glasses camera and buttons aren't connected yet."
        }
        await show(reply: "ZenPaws is on. \(hint)", speak: "ZenPaws is on.")
    }

    /// "Hey Meta, start ZenPaws": turn on if needed, then listen.
    func startFromVoice() async {
        do {
            if !state.active { try await start() }
            listen()
        } catch let failure as GlassesFailure {
            await speech.say(failure.message)
        } catch {
            await speech.say("I couldn't start glasses mode. Open ZenPaws on the phone.")
        }
    }

    func stop() {
        guard state.active else { return }
        speech.cancel()
        detachInputs()
        lens?.detach()
        lens = nil
        if linked { GlassesSession.shared.release(.mode) }
        linked = false
        speech.finish()
        state = State()
    }

    /// The glasses disconnected or were folded.
    private func ended() {
        guard state.active, linked else { return }
        linked = false
        speech.cancel()
        inputsTask?.cancel()
        inputsTask = nil
        inputTokens.clear()
        inputs = nil
        lens = nil
        speech.finish()
        state = State()
    }

    // MARK: Buttons

    private func attachInputs(to session: DeviceSession) {
        do {
            guard let added = try session.addInputs(configuration: InputsConfiguration(consumeBack: false)) else { return }
            inputs = added
            added.errorPublisher.listen { error in
                NSLog("[glasses] Glasses buttons unavailable: \(error.description)")
                Task { @MainActor [weak self] in
                    guard let self, self.state.active else { return }
                    self.state.buttons = false
                }
            }.store(in: inputTokens)
            let events = added.events
            inputsTask = Task { @MainActor [weak self] in
                for await event in events {
                    self?.handle(event)
                }
            }
        } catch {
            // Needs Inputs enabled for ZenPaws in Meta's Wearables Developer
            // Center; voice and the phone's Talk button still work without it.
            NSLog("[glasses] Glasses buttons unavailable: \(MetaGlasses.describe(error))")
        }
    }

    private func detachInputs() {
        inputsTask?.cancel()
        inputsTask = nil
        inputTokens.clear()
        if inputs != nil, let session = GlassesSession.shared.session {
            try? session.removeInputs()
        }
        inputs = nil
    }

    private func handle(_ event: InputEvent) {
        switch event {
        case .capture(.shortPress, _, _):
            perform(.photo)
        case .capture(.hold, _, _), .button(.action, _, _):
            listen()
        case .capture(.doublePress, _, _):
            perform(.recordStop)
        case .select, .nav, .back, .drag:
            // Taps on the lens arrive through the display's own handler.
            break
        @unknown default:
            break
        }
    }

    // MARK: Requests

    /// Listens through the glasses microphone for one request.
    func listen() {
        guard state.active, !state.listening, !state.busy else { return }
        state.listening = true
        state.heard = nil
        Task { @MainActor in
            await lens?.show(title: "Listening...", body: nil)
            let heard = await speech.transcribeOnce()
            state.listening = false
            guard let heard, !heard.isEmpty else {
                await show(reply: "I didn't catch that. Hold the capture button and try again.",
                           speak: "I didn't catch that.")
                return
            }
            state.heard = heard
            perform(GlassesCommand(heard))
        }
    }

    private func perform(_ command: GlassesCommand) {
        guard state.active, !state.busy else { return }
        if case .turnOff = command {
            Task { @MainActor in
                await speech.say("ZenPaws is off.")
                stop()
            }
            return
        }
        Task { @MainActor in
            state.busy = true
            await lens?.show(title: command.workingTitle, body: state.heard)
            let reply = await answer(command)
            state.busy = false
            await show(reply: reply, speak: reply)
        }
    }

    private func answer(_ command: GlassesCommand) async -> String {
        switch command {
        case .photo:
            return await runPageAction?("photo")
                ?? "Open ZenPaws on the phone to take a photo."
        case .recordStart:
            return await runPageAction?("recordStart")
                ?? "Open the visit in ZenPaws on the phone to record it."
        case .recordStop:
            return await runPageAction?("recordStop")
                ?? "Nothing is recording on the open page."
        case .ask(let question):
            return await ClinicAssistant.ask(question, context: pageContext?() ?? [:])
        case .turnOff:
            return "ZenPaws is off."
        }
    }

    private func show(reply: String, speak spoken: String) async {
        state.reply = reply
        await lens?.show(title: nil, body: reply)
        await speech.say(spoken)
    }
}

/// What the vet asked for.
enum GlassesCommand {
    case photo
    case recordStart
    case recordStop
    case turnOff
    case ask(String)

    init(_ heard: String) {
        let text = heard.lowercased()
            .components(separatedBy: CharacterSet.letters.union(.whitespaces).inverted).joined()
            .split(separator: " ").joined(separator: " ")
        func has(_ phrases: String...) -> Bool { phrases.contains { text.contains($0) } }

        if has("stop recording", "end recording", "stop the recording", "end the recording", "finish recording") {
            self = .recordStop
        } else if has("record visit", "record the visit", "record this visit", "start recording", "begin recording") {
            self = .recordStart
        } else if has("take a photo", "take photo", "take a picture", "take picture", "snap a photo") || text == "photo" {
            self = .photo
        } else if has("turn off glasses", "stop glasses", "exit glasses", "glasses off", "turn off zenpaws", "stop zenpaws") {
            self = .turnOff
        } else {
            self = .ask(heard)
        }
    }

    var workingTitle: String {
        switch self {
        case .photo: return "Taking a photo..."
        case .recordStart: return "Starting the recording..."
        case .recordStop: return "Stopping the recording..."
        case .turnOff: return "Turning off..."
        case .ask: return "Thinking..."
        }
    }
}

/// The lens on Meta Ray-Ban Display glasses. Only attached when the
/// connected glasses have a display; everything else works without it.
@MainActor
final class GlassesLens {
    private var display: Display?
    private let tokens = ListenerTokenBag()
    private var onTap: (@Sendable () -> Void)?
    private static let startTimeoutSeconds: UInt64 = 10

    /// Returns whether the lens is ready to show text.
    func attach(to session: DeviceSession, onTap: @escaping @Sendable () -> Void) async -> Bool {
        let display: Display
        do {
            display = try session.addDisplay()
        } catch {
            NSLog("[glasses] Lens display unavailable: \(MetaGlasses.describe(error))")
            return false
        }
        self.onTap = onTap
        let started: Bool = await withCheckedContinuation { continuation in
            let once = OnceBool(continuation)
            display.statePublisher.listen { state in
                if state == .started { once.finish(true) }
                if state == .stopped { once.finish(false) }
            }.store(in: tokens)
            display.start()
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(Int(Self.startTimeoutSeconds))) {
                once.finish(false)
            }
        }
        guard started else {
            display.stop()
            tokens.clear()
            return false
        }
        self.display = display
        return true
    }

    func detach() {
        display?.stop()
        display = nil
        tokens.clear()
    }

    /// Replaces what the lens shows. Tapping the card starts listening.
    func show(title: String?, body: String?) async {
        guard let display else { return }
        let heading = title ?? "ZenPaws"
        let text = body.map { $0.count > 400 ? String($0.prefix(397)) + "..." : $0 }
        let tap = onTap ?? {}
        do {
            try await display.send(
                FlexBox(direction: .column, spacing: 8) {
                    Text(heading, style: .heading)
                    if let text {
                        Text(text, style: .body)
                    }
                    Text("Tap to talk", style: .meta, color: .secondary)
                }
                .padding(20)
                .background(.card)
                .onTap(tap)
            )
        } catch {
            NSLog("[glasses] Lens update failed: \(MetaGlasses.describe(error))")
        }
    }
}

/// Resumes a Bool continuation exactly once.
private final class OnceBool: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
    }

    func finish(_ value: Bool) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}

/// Hearing and speaking through the glasses. While glasses mode is on, the
/// phone's audio goes to the glasses over Bluetooth, so the vet hears replies
/// in the glasses' speakers and the glasses' microphones pick up requests.
@MainActor
final class GlassesSpeech: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    /// Who is waiting for which utterance to finish.
    private var speaking: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]
    private var engine: AVAudioEngine?
    private var finishListening: (@MainActor () -> Void)?

    /// Silence after speech that ends a request.
    private static let silenceSeconds = 1.5
    /// Longest wait for the vet to start talking.
    private static let waitForSpeechSeconds = 6.0
    /// Longest single request.
    private static let maxSeconds = 15.0

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Asks for microphone and speech recognition access and routes audio to
    /// the glasses.
    func prepare() async throws {
        let speechAllowed = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speechAllowed else {
            throw GlassesFailure(message: "Allow Speech Recognition for ZenPaws in the iPhone's Settings, then try again.")
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            throw GlassesFailure(message: "Allow the microphone for ZenPaws in the iPhone's Settings, then try again.")
        }
        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.playAndRecord, mode: .default,
                                  options: [.allowBluetooth, .allowBluetoothA2DP, .duckOthers])
            try audio.setActive(true)
            // Prefer the glasses' microphone over the phone's.
            if let glasses = audio.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
                try? audio.setPreferredInput(glasses)
            }
        } catch {
            throw GlassesFailure(message: "Couldn't use the glasses' audio. Check they're connected to the phone over Bluetooth.")
        }
    }

    /// Lets other apps' audio return to normal.
    func finish() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func say(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        await withCheckedContinuation { continuation in
            speaking[ObjectIdentifier(utterance)] = continuation
            synthesizer.speak(utterance)
        }
    }

    func cancel() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        finishListening?()
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.doneSpeaking(id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.doneSpeaking(id) }
    }

    private func doneSpeaking(_ id: ObjectIdentifier) {
        speaking.removeValue(forKey: id)?.resume()
    }

    /// Listens for one request and returns what was said, or nil.
    func transcribeOnce() async -> String? {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else { return nil }
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .search
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return nil }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return nil
        }
        self.engine = engine

        let listening = Listening(engine: engine, request: request)
        finishListening = { listening.finish() }
        defer { finishListening = nil }
        let heard: String? = await withCheckedContinuation { continuation in
            listening.begin(
                continuation: continuation,
                waitForSpeech: Self.waitForSpeechSeconds,
                maxSeconds: Self.maxSeconds
            )
            listening.task = recognizer.recognitionTask(with: request) { result, error in
                let text = result?.bestTranscription.formattedString
                let isFinal = result?.isFinal ?? false
                let failed = error != nil
                Task { @MainActor in
                    if let text, !text.isEmpty { listening.heard(text, silence: Self.silenceSeconds) }
                    if isFinal || failed { listening.finish() }
                }
            }
        }
        self.engine = nil
        return heard
    }
}

/// One request being listened to: ends after a pause in speech, when nothing
/// is said, or at the length limit, whichever comes first.
@MainActor
private final class Listening {
    private let engine: AVAudioEngine
    private let request: SFSpeechAudioBufferRecognitionRequest
    var task: SFSpeechRecognitionTask?
    private var continuation: CheckedContinuation<String?, Never>?
    private var latest: String?
    private var silenceTimer: Timer?
    private var deadline: Timer?

    init(engine: AVAudioEngine, request: SFSpeechAudioBufferRecognitionRequest) {
        self.engine = engine
        self.request = request
    }

    func begin(continuation: CheckedContinuation<String?, Never>, waitForSpeech: TimeInterval, maxSeconds: TimeInterval) {
        self.continuation = continuation
        armSilence(waitForSpeech)
        deadline = Timer.scheduledTimer(withTimeInterval: maxSeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finish() }
        }
    }

    func heard(_ text: String, silence: TimeInterval) {
        guard continuation != nil else { return }
        latest = text
        armSilence(silence)
    }

    func finish() {
        guard let continuation else { return }
        self.continuation = nil
        silenceTimer?.invalidate()
        deadline?.invalidate()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request.endAudio()
        task?.cancel()
        task = nil
        continuation.resume(returning: latest?.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func armSilence(_ seconds: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finish() }
        }
    }
}
