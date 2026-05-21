import AppKit
import Combine
import Foundation

enum SidecarStatus: Equatable {
    case idle
    case starting
    case connected(version: String)
    case failed(String)
}

/// Launches and supervises the Node "sidecar" — the local engine that does the
/// scraping, storage and (later) on-device LLM work. The sidecar speaks HTTP on
/// a loopback port; this class owns its lifecycle and a per-launch auth token.
@MainActor
final class SidecarManager: ObservableObject {
    @Published private(set) var status: SidecarStatus = .idle
    @Published private(set) var logLines: [String] = []
    @Published private(set) var port: Int?

    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutBuffer = Data()

    /// Random secret regenerated every launch; every request to the engine
    /// must present it, so other local processes cannot reach it.
    private let token = UUID().uuidString

    init() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    // MARK: - Lifecycle

    func start() async {
        guard process == nil else { return }
        status = .starting
        appendLog("Starting local engine…")

        guard let nodePath = Self.resolveNodePath() else {
            fail("Node.js was not found. Install it, then restart: brew install node")
            return
        }
        appendLog("node: \(nodePath)")

        let sidecarDir = Self.resolveSidecarDir()
        let serverScript = sidecarDir.appendingPathComponent("src/server.ts")
        guard FileManager.default.fileExists(atPath: serverScript.path) else {
            fail("Engine code not found at \(sidecarDir.path)")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["--import", "tsx", serverScript.path]
        proc.currentDirectoryURL = sidecarDir

        var env = ProcessInfo.processInfo.environment
        env["HON_TOKEN"] = token
        env["HON_PARENT_PIPE"] = "1"
        env["HON_DATA_DIR"] = Self.dataDir().path
        env["NODE_NO_WARNINGS"] = "1"
        proc.environment = env

        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr
        proc.standardInput = stdin
        stdinPipe = stdin

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.ingestStdout(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty,
                  let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in
                for line in text.split(separator: "\n") {
                    self?.appendLog("stderr: \(line)")
                }
            }
        }
        proc.terminationHandler = { [weak self] finished in
            let code = finished.terminationStatus
            Task { @MainActor in self?.handleTermination(code: code) }
        }

        do {
            try proc.run()
            process = proc
            appendLog("Engine process launched (pid \(proc.processIdentifier)).")
        } catch {
            fail("Could not launch the engine: \(error.localizedDescription)")
        }
    }

    func stop() {
        stdinPipe?.fileHandleForWriting.closeFile()
        stdinPipe = nil
        process?.terminate()
        process = nil
    }

    func restart() {
        stop()
        status = .idle
        port = nil
        logLines.removeAll()
        stdoutBuffer.removeAll()
        Task { await start() }
    }

    /// An API client for the running engine, or nil if it is not connected.
    func makeClient() -> APIClient? {
        guard let port else { return nil }
        return APIClient(port: port, token: token)
    }

    // MARK: - stdout handling

    private func ingestStdout(_ data: Data) {
        stdoutBuffer.append(data)
        while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<newline)
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...newline)
            if let line = String(data: lineData, encoding: .utf8) {
                handleLine(line)
            }
        }
    }

    private func handleLine(_ raw: String) {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }

        if line.hasPrefix("{"),
           let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
           let event = object["event"] as? String {
            handleEvent(event, object)
        } else {
            appendLog(line)
        }
    }

    private func handleEvent(_ event: String, _ object: [String: Any]) {
        switch event {
        case "ready":
            guard let p = object["port"] as? Int else { return }
            port = p
            appendLog("Engine listening on 127.0.0.1:\(p).")
            Task { await verifyHealth(port: p) }
        case "error":
            fail(object["message"] as? String ?? "unknown engine error")
        default:
            appendLog("event: \(event)")
        }
    }

    private func verifyHealth(port: Int) async {
        do {
            let health = try await APIClient(port: port, token: token).health()
            status = .connected(version: health.version)
            appendLog("Health check OK — db \(health.db).")
        } catch {
            fail("Health check failed: \(error.localizedDescription)")
        }
    }

    private func handleTermination(code: Int32) {
        appendLog("Engine exited (code \(code)).")
        process = nil
        switch status {
        case .connected:
            status = .failed("The engine stopped unexpectedly (code \(code)).")
        case .starting:
            status = .failed("The engine exited during startup (code \(code)).")
        case .idle, .failed:
            break
        }
    }

    // MARK: - Helpers

    private func fail(_ message: String) {
        status = .failed(message)
        appendLog("ERROR: \(message)")
    }

    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 200 {
            logLines.removeFirst(logLines.count - 200)
        }
    }

    /// Locates `node`. A launched .app has a minimal PATH, so we ask a login
    /// shell first (covers Homebrew, nvm, asdf) then fall back to known paths.
    static func resolveNodePath() -> String? {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        shell.standardOutput = pipe
        shell.standardError = Pipe()
        do {
            try shell.run()
            shell.waitUntilExit()
            let data = (try pipe.fileHandleForReading.readToEnd()) ?? Data()
            if let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !path.isEmpty,
               FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        } catch {
            // fall through to known install locations
        }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Resolves the sidecar directory: scheme env var (dev), bundled Resources
    /// (release), then a dev checkout fallback.
    static func resolveSidecarDir() -> URL {
        if let env = ProcessInfo.processInfo.environment["HON_SIDECAR_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("sidecar"),
           FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/Code/Hon/sidecar", isDirectory: true)
    }

    /// Per-user data directory; the engine stores the SQLite database here.
    static func dataDir() -> URL {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Hon", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
