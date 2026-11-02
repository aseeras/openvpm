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
/// - "Hey Meta, start ZenPaws" on the glasses does the same, hands-free, for
///   the patient that is open in the app.
///
/// The glasses connect through the Meta AI app: the first photo opens Meta AI
/// to allow ZenPaws, then again to allow the camera. Photos go straight to the
/// clinic system; nothing is kept on the phone.
enum MetaGlasses {
    /// Meta AI calls the app back on this scheme after the vet allows it.
    /// Must match `MWDAT > AppLinkURLScheme` and `CFBundleURLTypes` in Info.plist.
    static let urlScheme = "zenpawsstaff"

    /// Posted when the vet says "Hey Meta, start ZenPaws"; the web view asks
    /// the open page to take a glasses photo.
    static let captureRequested = Notification.Name("ZenPawsGlassesCaptureRequested")

    static func configure() {
        do {
            try Wearables.configure()
        } catch {
            NSLog("[glasses] Could not set up the Meta glasses toolkit: \(error)")
            return
        }
        Task { @MainActor in GlassesVoice.shared.begin() }
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

/// Takes one photo with the connected glasses.
@MainActor
final class GlassesCamera {
    static let shared = GlassesCamera()

    private var busy = false
    private static let sessionTimeoutSeconds: UInt64 = 20
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
        try await ensureRegistered(wearables)
        try await ensureCameraAllowed(wearables)

        guard !wearables.devices.isEmpty else {
            throw GlassesFailure(message: "No glasses found. Put them on and check they're connected in the Meta AI app.")
        }

        let session: DeviceSession
        do {
            session = try wearables.createSession(deviceSelector: AutoDeviceSelector(wearables: wearables))
        } catch {
            throw GlassesFailure(message: "Couldn't connect to the glasses: \(MetaGlasses.describe(error))")
        }
        defer { session.stop() }

        // Listen before starting so the change to "started" isn't missed.
        let states = session.stateStream()
        do {
            try session.start()
        } catch {
            throw GlassesFailure(message: "Couldn't connect to the glasses: \(MetaGlasses.describe(error))")
        }
        guard await Self.waitUntilStarted(session, states: states) else {
            throw GlassesFailure(message: "The glasses didn't connect. Check they're on, unfolded and connected in the Meta AI app.")
        }

        let camera: Camera
        do {
            guard let added = try session.addCamera() else {
                throw GlassesFailure(message: "Couldn't open the glasses camera. Try again.")
            }
            camera = added
        } catch let failure as GlassesFailure {
            throw failure
        } catch {
            throw GlassesFailure(message: "Couldn't open the glasses camera: \(MetaGlasses.describe(error))")
        }
        defer { camera.stop() }

        let imageData = try await Self.capture(with: camera.photo)
        return Self.shrunkJPEG(imageData) ?? imageData
    }

    private func ensureRegistered(_ wearables: any WearablesInterface) async throws {
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
        throw GlassesFailure(message: "Allow ZenPaws in the Meta AI app, then come back and take the photo again.")
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
                try? await Task.sleep(nanoseconds: sessionTimeoutSeconds * 1_000_000_000)
                return false
            }
            let started = await group.next() ?? false
            group.cancelAll()
            return started
        }
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
/// vet says it, brings the app forward and asks the open page for a photo.
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
                await MainActor.run {
                    NotificationCenter.default.post(name: MetaGlasses.captureRequested, object: nil)
                }
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
    ]

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
