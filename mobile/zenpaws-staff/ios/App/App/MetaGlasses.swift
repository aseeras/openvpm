import Foundation
import UIKit
import Capacitor
import MWDATCore
import MWDATCamera

/// Meta smart glasses (Ray-Ban Meta, Oakley Meta, Meta Ray-Ban Display) in
/// the staff app, through Meta's Wearables Device Access Toolkit.
///
/// - "Take with glasses" on a patient's holistic workup takes a photo with
///   the glasses' camera and adds it to that patient's photos.
/// - Glasses mode (`GlassesMode.swift`): the capture button, voice requests,
///   spoken replies and, on Meta Ray-Ban Display, the lens.
/// - "Hey Meta, start ZenPaws" turns glasses mode on and listens.
///
/// The glasses connect through the Meta AI app: the first photo opens Meta AI
/// to allow ZenPaws, then again to allow the camera. Photos go straight to the
/// clinic system; nothing is kept on the phone.
enum MetaGlasses {
    /// Meta AI calls the app back on this scheme after the vet allows it.
    /// Must match `MWDAT > AppLinkURLScheme` and `CFBundleURLTypes` in Info.plist.
    static let urlScheme = "zenpawsstaff"

    static func configure() {
        do {
            try Wearables.configure()
        } catch {
            NSLog("[glasses] Could not set up the Meta glasses toolkit: \(error)")
            return
        }
        Task { @MainActor in
            GlassesLog.begin()
            GlassesSession.shared.warmUp()
            GlassesVoice.shared.begin()
        }
    }

    /// Links from Meta AI carry a `metaWearablesAction` query item.
    static func isWearablesCallback(_ url: URL) -> Bool {
        guard url.scheme == urlScheme,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            return false
        }
        return items.contains { $0.name == "metaWearablesAction" }
    }

    static func handleCallback(_ url: URL) {
        Task {
            do {
                _ = try await Wearables.shared.handleUrl(url)
            } catch {
                NSLog("[glasses] Meta AI callback failed: \(describe(error))")
            }
        }
    }

    static func describe(_ error: Error) -> String {
        if let datError = error as? DatError { return datError.description }
        return error.localizedDescription
    }
}

/// A problem worth telling the vet about, worded for them.
struct GlassesFailure: Error {
    let message: String
}

/// The one connection to the glasses. The toolkit allows a single session at
/// a time, so the camera and glasses mode share it: it starts when the first
/// of them needs it and stops when the last lets go.
@MainActor
final class GlassesSession {
    enum Holder: Hashable { case camera, mode }

    static let shared = GlassesSession()

    private(set) var session: DeviceSession?
    private var holders = Set<Holder>()
    private var watchTask: Task<Void, Never>?
    private static let startTimeoutSeconds: UInt64 = 20

    /// Called when the glasses disconnect or the session ends on its own.
    var onEnded: (() -> Void)?

    /// One selector for the life of the app, as in Meta's samples: it follows
    /// the glasses' connection from launch, so it already knows which pair is
    /// usable when the vet asks for a photo.
    private var selector: AutoDeviceSelector?

    func warmUp() {
        guard selector == nil else { return }
        selector = AutoDeviceSelector(wearables: Wearables.shared)
    }

    func acquire(_ holder: Holder) async throws -> DeviceSession {
        let wearables = Wearables.shared
        try await Self.ensureRegistered(wearables)
        if let session, session.state == .started || session.state == .paused {
            holders.insert(holder)
            return session
        }
        guard !wearables.devices.isEmpty else {
            throw GlassesFailure(message: "No glasses found. Put them on and check they're connected in the Meta AI app.")
        }
        end()

        // The selector learns which glasses are usable from a stream, so a
        // session created straight away finds no eligible device. Wait for it.
        warmUp()
        guard let selector, await Self.waitForActiveDevice(selector) else {
            GlassesLog.add("no active device after \(Self.deviceTimeoutSeconds)s")
            GlassesLog.offerToShare()
            throw GlassesFailure(message: Self.notReadyMessage(wearables))
        }

        let created: DeviceSession
        do {
            created = try wearables.createSession(deviceSelector: selector)
        } catch DeviceSessionError.noEligibleDevice {
            GlassesLog.add("createSession: no eligible device")
            GlassesLog.offerToShare()
            throw GlassesFailure(message: Self.notReadyMessage(wearables))
        } catch DeviceSessionError.datAppOnTheGlassesUpdateRequired {
            throw GlassesFailure(message: "The glasses need a software update. Update them in the Meta AI app, then try again.")
        } catch {
            throw GlassesFailure(message: "Couldn't connect to the glasses: \(MetaGlasses.describe(error))")
        }
        // Listen before starting so the change to "started" isn't missed.
        let states = created.stateStream()
        do {
            try created.start()
        } catch {
            created.stop()
            throw GlassesFailure(message: "Couldn't connect to the glasses: \(MetaGlasses.describe(error))")
        }
        guard await Self.waitUntilStarted(created, states: states) else {
            created.stop()
            throw GlassesFailure(message: "The glasses didn't connect. Check they're on, unfolded and connected in the Meta AI app.")
        }
        session = created
        holders.insert(holder)
        watchTask = Task { @MainActor [weak self] in
            for await state in created.stateStream() where state == .stopped {
                guard let self, self.session === created else { return }
                self.session = nil
                self.holders.removeAll()
                self.onEnded?()
                return
            }
        }
        return created
    }

    func release(_ holder: Holder) {
        holders.remove(holder)
        if holders.isEmpty { end() }
    }

    private func end() {
        watchTask?.cancel()
        watchTask = nil
        session?.stop()
        session = nil
        holders.removeAll()
    }

    static func ensureRegistered(_ wearables: any WearablesInterface) async throws {
        switch wearables.registrationState {
        case .registered:
            return
        case .registering:
            throw GlassesFailure(message: "Finish allowing ZenPaws in the Meta AI app, then try again.")
        case .unavailable:
            throw GlassesFailure(message: "Install the Meta AI app and pair your glasses first.")
        case .available:
            break
        }
        do {
            try await wearables.startRegistration()
        } catch {
            throw GlassesFailure(message: "Couldn't open the Meta AI app: \(MetaGlasses.describe(error))")
        }
        throw GlassesFailure(message: "Allow ZenPaws in the Meta AI app, then come back and try again.")
    }

    private static let deviceTimeoutSeconds: UInt64 = 25

    private static func waitForActiveDevice(_ selector: AutoDeviceSelector) async -> Bool {
        if selector.activeDevice != nil { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await device in selector.activeDeviceStream() where device != nil {
                    return true
                }
                return false
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: deviceTimeoutSeconds * 1_000_000_000)
                return false
            }
            let found = await group.next() ?? false
            group.cancelAll()
            return found
        }
    }

    /// Why paired glasses can't be used right now, in the vet's words.
    private static func notReadyMessage(_ wearables: any WearablesInterface) -> String {
        let devices = wearables.devices.compactMap { wearables.deviceForIdentifier($0) }
        for device in devices {
            GlassesLog.describe(device)
        }
        // Short enough for the page to show in full (it hides long messages).
        let summary = devices.isEmpty
            ? "no glasses listed"
            : devices.map { "\($0.nameOrId()) \($0.linkState)" }.joined(separator: ", ")
        let details = summary.count > 70 ? String(summary.prefix(67)) + "..." : summary
        if devices.contains(where: { $0.compatibility() == .deviceUpdateRequired }) {
            return "Your glasses need a software update. Update them in the Meta AI app, then try again."
        }
        if devices.contains(where: { $0.compatibility() == .sdkUpdateRequired }) {
            return "Your glasses' software is newer than this ZenPaws build supports. ZenPaws needs an update."
        }
        if !devices.contains(where: { $0.linkState == .connected }) {
            return "Glasses not connected (\(details)). Open Meta AI until they show connected, then try again."
        }
        return "Glasses not ready (\(details)). Check Developer Mode is on in Meta AI, then try again."
    }

    private static func waitUntilStarted(
        _ session: DeviceSession,
        states: AsyncStream<DeviceSessionState>
    ) async -> Bool {
        if session.state == .started { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await state in states {
                    if state == .started { return true }
                    if state == .stopped { return false }
                }
                return false
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: startTimeoutSeconds * 1_000_000_000)
                return false
            }
            let started = await group.next() ?? false
            group.cancelAll()
            return started
        }
    }
}

/// What the toolkit reports about the glasses from launch on: registration,
/// each pair's link and compatibility. When the glasses won't connect, the
/// vet can share it (with the toolkit's own log) with whoever is helping.
/// It stays on the phone unless shared.
@MainActor
enum GlassesLog {
    private static var lines: [String] = []
    private static let tokens = ListenerTokenBag()
    private static var watched = Set<DeviceIdentifier>()
    private static var started = false
    private static var offering = false
    private static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func add(_ line: String) {
        lines.append("\(stamp.string(from: Date())) \(line)")
        if lines.count > 500 { lines.removeFirst(lines.count - 500) }
        NSLog("[glasses] \(line)")
    }

    static func begin() {
        guard !started else { return }
        started = true
        let info = Bundle.main.infoDictionary ?? [:]
        let wearables = Wearables.shared
        add("ZenPaws \(info["CFBundleShortVersionString"] ?? "?") (\(info["CFBundleVersion"] ?? "?")), iOS \(UIDevice.current.systemVersion)")
        add("registration \(name(wearables.registrationState)), devices \(wearables.devices.count)")
        Task { @MainActor in
            for await state in wearables.registrationStateStream() {
                add("registration -> \(name(state))")
            }
        }
        Task { @MainActor in
            for await ids in wearables.devicesStream() {
                add("devices -> \(ids.count)")
                ids.forEach(watch)
            }
        }
    }

    private static func name(_ state: RegistrationState) -> String {
        switch state {
        case .unavailable: return "unavailable"
        case .available: return "available"
        case .registering: return "registering"
        case .registered: return "registered"
        }
    }

    private static func watch(_ id: DeviceIdentifier) {
        guard let device = Wearables.shared.deviceForIdentifier(id) else {
            add("device \(id): no details")
            return
        }
        describe(device)
        guard !watched.contains(id) else { return }
        watched.insert(id)
        let label = device.nameOrId()
        device.addLinkStateListener { state in
            Task { @MainActor in add("\(label) link -> \(state)") }
        }.store(in: tokens)
        device.addCompatibilityListener { compatibility in
            Task { @MainActor in add("\(label) compatibility -> \(compatibility)") }
        }.store(in: tokens)
    }

    static func describe(_ device: Device) {
        add("\(device.nameOrId()): type \(device.deviceType()), link \(device.linkState), compatibility \(device.compatibility()), display \(device.supportsDisplay())")
    }

    /// Asks once per failure whether to share the log.
    static func offerToShare() {
        guard !offering, let top = topViewController() else { return }
        offering = true
        let alert = UIAlertController(
            title: "Glasses didn't connect",
            message: "Share the glasses log so the problem can be found? It lists the glasses and what Meta's toolkit reported, no patient information.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in offering = false })
        alert.addAction(UIAlertAction(title: "Share log", style: .default) { _ in
            Task { @MainActor in
                await share()
                offering = false
            }
        })
        top.present(alert, animated: true)
    }

    private static func share() async {
        let wearables = Wearables.shared
        add("--- shared: registration \(name(wearables.registrationState)), devices \(wearables.devices.count)")
        for id in wearables.devices {
            if let device = wearables.deviceForIdentifier(id) { describe(device) }
        }
        if let camera = try? await wearables.checkPermissionStatus(.camera) {
            add("camera permission \(camera)")
        }
        var text = lines.joined(separator: "\n")
        for url in toolkitLogFiles() {
            guard let data = try? Data(contentsOf: url) else { continue }
            let tail = data.suffix(400_000)
            text += "\n\n===== \(url.lastPathComponent) (\(data.count) bytes, last \(tail.count)) =====\n"
            text += String(decoding: tail, as: UTF8.self)
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let file = folder.appendingPathComponent("zenpaws-glasses-log.txt")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try text.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            add("couldn't write log: \(error.localizedDescription)")
            return
        }
        guard let top = topViewController() else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: folder)
        }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        top.present(sheet, animated: true)
    }

    /// The toolkit writes its own log under a MetaWearablesDAT folder in the
    /// app's container.
    private static func toolkitLogFiles() -> [URL] {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        guard let walker = FileManager.default.enumerator(at: home, includingPropertiesForKeys: nil) else { return [] }
        var found: [URL] = []
        for case let url as URL in walker where url.path.contains("MetaWearablesDAT") {
            let ext = url.pathExtension.lowercased()
            if ext == "log" || ext == "txt" { found.append(url) }
            if found.count >= 5 { break }
        }
        return found
    }

    private static func topViewController() -> UIViewController? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.windows.first(where: \.isKeyWindow) }
            .first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

/// Takes one photo with the connected glasses.
@MainActor
final class GlassesCamera {
    static let shared = GlassesCamera()

    private var busy = false
    private static let photoTimeoutSeconds: Double = 45
    /// Photos are shrunk before they leave the phone; the chart and the AI
    /// workup read them at up to 1600 px anyway.
    private static let maxEdge: CGFloat = 2048

    func takePhoto() async throws -> Data {
        guard !busy else {
            throw GlassesFailure(message: "The glasses are already taking a photo.")
        }
        busy = true
        defer { busy = false }

        let wearables = Wearables.shared
        try await GlassesSession.ensureRegistered(wearables)
        try await ensureCameraAllowed(wearables)

        let session = try await GlassesSession.shared.acquire(.camera)
        defer { GlassesSession.shared.release(.camera) }

        let camera = try attachedCamera(on: session)
        let imageData = try await Self.capture(with: camera.photo)
        return Self.shrunkJPEG(imageData) ?? imageData
    }

    /// The camera on the current connection. It stays attached while glasses
    /// mode keeps the connection open, so later photos reuse it, and stops
    /// with the connection.
    private var cachedCamera: Camera?
    private weak var cameraSession: DeviceSession?

    private func attachedCamera(on session: DeviceSession) throws -> Camera {
        if let cachedCamera, cameraSession === session { return cachedCamera }
        do {
            guard let added = try session.addCamera() else {
                throw GlassesFailure(message: "Couldn't open the glasses camera. Try again.")
            }
            cachedCamera = added
            cameraSession = session
            return added
        } catch let failure as GlassesFailure {
            throw failure
        } catch {
            throw GlassesFailure(message: "Couldn't open the glasses camera: \(MetaGlasses.describe(error))")
        }
    }

    private func ensureCameraAllowed(_ wearables: any WearablesInterface) async throws {
        do {
            if try await wearables.checkPermissionStatus(.camera) == .granted { return }
            // Opens Meta AI, where the vet allows the camera, and returns here.
            if try await wearables.requestPermission(.camera) == .granted { return }
        } catch {
            throw GlassesFailure(message: "Couldn't check camera access in the Meta AI app: \(MetaGlasses.describe(error))")
        }
        throw GlassesFailure(message: "Camera access for ZenPaws wasn't allowed in the Meta AI app.")
    }

    /// Starts the camera's photo mode, takes one full-size photo when it is
    /// ready, and waits for it to arrive from the glasses.
    private static func capture(with photo: Photo) async throws -> Data {
        let tokens = ListenerTokenBag()
        defer {
            tokens.clear()
            photo.stop()
        }
        let outcome: Result<Data, GlassesFailure> = await withCheckedContinuation { continuation in
            let once = Once(continuation)
            photo.statePublisher.listen { state in
                if case .started = state, once.markShutter() {
                    photo.capturePhoto(resolution: .full, quality: .high)
                }
            }.store(in: tokens)
            photo.photoDataPublisher.listen { capture in
                once.finish(.success(capture.imageData))
            }.store(in: tokens)
            photo.errorPublisher.listen { error in
                once.finish(.failure(GlassesFailure(message: "The glasses couldn't take the photo: \(error.description)")))
            }.store(in: tokens)
            photo.start()
            DispatchQueue.main.asyncAfter(deadline: .now() + photoTimeoutSeconds) {
                once.finish(.failure(GlassesFailure(message: "The photo took too long to arrive from the glasses. Try again.")))
            }
        }
        return try outcome.get()
    }

    private static func shrunkJPEG(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width, image.size.height)
        let scale = longest > maxEdge ? maxEdge / longest : 1
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return resized.jpegData(compressionQuality: 0.85)
    }
}

/// Resumes a continuation exactly once, whichever of photo, error or timeout
/// comes first, and fires the shutter only once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Result<Data, GlassesFailure>, Never>?
    private var shutterFired = false

    init(_ continuation: CheckedContinuation<Result<Data, GlassesFailure>, Never>) {
        self.continuation = continuation
    }

    func markShutter() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !shutterFired, continuation != nil else { return false }
        shutterFired = true
        return true
    }

    func finish(_ result: Result<Data, GlassesFailure>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: result)
    }
}

/// "Hey Meta, start ZenPaws". Listens on the connected glasses and, when the
/// vet says it, turns glasses mode on and listens for a request.
@MainActor
final class GlassesVoice {
    static let shared = GlassesVoice()

    private var stream: VoiceInvocationsStream?
    private var listeningOn: DeviceIdentifier?
    private let tokens = ListenerTokenBag()
    private var devicesTask: Task<Void, Never>?

    func begin() {
        guard devicesTask == nil else { return }
        devicesTask = Task { @MainActor [weak self] in
            for await devices in Wearables.shared.devicesStream() {
                self?.listen(on: devices.first)
            }
        }
    }

    private func listen(on device: DeviceIdentifier?) {
        guard device != listeningOn || stream == nil else { return }
        stream?.stop()
        listeningOn = nil
        guard let device else { return }
        do {
            let voice = try stream ?? makeStream()
            stream = voice
            try voice.start(deviceIdentifier: device)
            listeningOn = device
        } catch {
            NSLog("[glasses] Voice launch not available: \(MetaGlasses.describe(error))")
        }
    }

    private func makeStream() throws -> VoiceInvocationsStream {
        let voice = try VoiceInvocationsStream(wearables: Wearables.shared)
        voice.invocationsPublisher.listen { invocation in
            guard let launch = invocation as? LaunchApp else { return }
            Task {
                _ = await launch.responseHandle.sendSuccess(actionOutput: nil)
                await GlassesMode.shared.startFromVoice()
            }
        }.store(in: tokens)
        voice.errorPublisher.listen { [weak self] error in
            NSLog("[glasses] Voice launch stopped: \(error.description)")
            // Start again on the next device change.
            Task { @MainActor in self?.listeningOn = nil }
        }.store(in: tokens)
        return voice
    }
}

/// The page's way to the glasses. The JavaScript name is what
/// `apps/web/lib/glasses/native-glasses.ts` looks for.
@objc(ZenPawsGlassesPlugin)
public class ZenPawsGlassesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ZenPawsGlassesPlugin"
    public let jsName = "ZenPawsGlasses"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capturePhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "modeStatus", returnType: CAPPluginReturnPromise),
    ]

    @objc func startMode(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                try await GlassesMode.shared.start()
                call.resolve(GlassesMode.shared.state.dictionary)
            } catch let failure as GlassesFailure {
                call.reject(failure.message, "GLASSES")
            } catch {
                call.reject("Couldn't start glasses mode. Check the glasses are on and connected.", "GLASSES")
            }
        }
    }

    @objc func stopMode(_ call: CAPPluginCall) {
        Task { @MainActor in
            GlassesMode.shared.stop()
            call.resolve(GlassesMode.shared.state.dictionary)
        }
    }

    @objc func listen(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard GlassesMode.shared.state.active else {
                call.reject("Turn on glasses mode first.", "GLASSES")
                return
            }
            GlassesMode.shared.listen()
            call.resolve(GlassesMode.shared.state.dictionary)
        }
    }

    @objc func modeStatus(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(GlassesMode.shared.state.dictionary)
        }
    }

    @objc func capturePhoto(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                let jpeg = try await GlassesCamera.shared.takePhoto()
                call.resolve(["base64": jpeg.base64EncodedString(), "mimeType": "image/jpeg"])
            } catch let failure as GlassesFailure {
                call.reject(failure.message, "GLASSES")
            } catch {
                call.reject("The glasses didn't take a photo. Try again.", "GLASSES")
            }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        Task { @MainActor in
            let wearables = Wearables.shared
            call.resolve([
                "registered": wearables.registrationState == .registered,
                "devices": wearables.devices.count,
            ])
        }
    }
}
