import Foundation

/// Response shape of the sidecar's `GET /health` endpoint.
struct HealthResponse: Decodable {
    let ok: Bool
    let name: String
    let version: String
    let uptimeMs: Int
    let db: String
    let pid: Int
}

/// Minimal HTTP client for the local sidecar engine on 127.0.0.1. The web
/// dashboard (loaded in a WKWebView) makes every other API call itself; the
/// native shell only needs the health check and the vault unlock.
struct APIClient {
    let port: Int
    let token: String

    private var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    enum APIError: LocalizedError {
        case notHTTP
        case badStatus(Int, String?)
        case decoding

        var errorDescription: String? {
            switch self {
            case .notHTTP:
                return "The engine gave an unexpected response."
            case .badStatus(let code, let detail):
                return detail ?? "The engine returned HTTP \(code)."
            case .decoding:
                return "Could not read the engine's response."
            }
        }
    }

    func health() async throws -> HealthResponse {
        let data = try await raw("health", method: "GET", body: nil)
        guard let value = try? JSONDecoder().decode(HealthResponse.self, from: data) else {
            throw APIError.decoding
        }
        return value
    }

    /// Unlocks (or, on first use, creates) the engine's credential vault.
    func unlockVault(passphrase: String) async throws {
        let body = try JSONEncoder().encode(["passphrase": passphrase])
        _ = try await raw("vault/unlock", method: "POST", body: body)
    }

    private func raw(_ path: String, method: String, body: Data?) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.notHTTP }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw APIError.badStatus(http.statusCode, detail)
        }
        return data
    }
}
