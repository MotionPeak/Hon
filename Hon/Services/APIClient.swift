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

private struct CompaniesResponse: Decodable { let companies: [Company] }
private struct ConnectionsResponse: Decodable { let connections: [Connection] }
private struct ConnectionResponse: Decodable { let connection: Connection }
private struct AccountsResponse: Decodable { let accounts: [Account] }
private struct TransactionsResponse: Decodable { let transactions: [Transaction] }
private struct SummaryResponse: Decodable { let summary: Summary }
private struct RunIdResponse: Decodable { let runId: String }
private struct RunResponse: Decodable { let run: ScrapeRun }
private struct PortalResponse: Decodable { let portal: SnapTradePortal }
private struct BrokeragesResponse: Decodable { let brokerages: [SnapTradeBrokerage] }

private struct PortalRequest: Encodable {
    let credentials: [String: String]
    var broker: String?
    var customRedirect: String?
}

private struct ScrapeRequest: Encodable {
    let credentials: [String: String]
    let monthsBack: Int
    let interactive: Bool
}

private struct BudgetUpdate: Encodable {
    let category: String
    let monthlyAmount: Double
}

private struct TransactionCategoryUpdate: Encodable {
    let category: String
    let applyToMerchant: Bool
}

/// HTTP client for the local sidecar engine on 127.0.0.1.
struct APIClient {
    let port: Int
    let token: String

    private var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// URL of an institution's logo, served (and cached) by the local sidecar.
    func logoURL(companyId: String) -> URL {
        base.appendingPathComponent("logo").appendingPathComponent(companyId)
    }

    enum APIError: LocalizedError {
        case notHTTP
        case badStatus(Int, String?)
        case decoding(String)

        var errorDescription: String? {
            switch self {
            case .notHTTP:
                return "The engine gave an unexpected response."
            case .badStatus(let code, let detail):
                return detail ?? "The engine returned HTTP \(code)."
            case .decoding(let path):
                return "Could not read the engine's response for \(path)."
            }
        }
    }

    // MARK: - Endpoints

    func health() async throws -> HealthResponse {
        try await send("health", as: HealthResponse.self)
    }

    func companies() async throws -> [Company] {
        try await send("companies", as: CompaniesResponse.self).companies
    }

    func connections() async throws -> [Connection] {
        try await send("connections", as: ConnectionsResponse.self).connections
    }

    func createConnection(companyId: String, displayName: String) async throws -> Connection {
        let body = try JSONEncoder().encode(["companyId": companyId, "displayName": displayName])
        return try await send("connections", method: "POST", body: body,
                              as: ConnectionResponse.self).connection
    }

    func deleteConnection(id: String) async throws {
        _ = try await raw("connections/\(id)", method: "DELETE", query: [], body: nil)
    }

    func startScrape(connectionId: String, credentials: [String: String],
                     monthsBack: Int, interactive: Bool) async throws -> String {
        let body = try JSONEncoder().encode(
            ScrapeRequest(
                credentials: credentials, monthsBack: monthsBack, interactive: interactive))
        return try await send("connections/\(connectionId)/scrape", method: "POST", body: body,
                              as: RunIdResponse.self).runId
    }

    func submitOtp(runId: String, code: String) async throws {
        let body = try JSONEncoder().encode(["code": code])
        _ = try await raw("scrape/\(runId)/otp", method: "POST", query: [], body: body)
    }

    func scrapeStatus(runId: String) async throws -> ScrapeRun {
        try await send("scrape/\(runId)", as: RunResponse.self).run
    }

    /// Registers the SnapTrade user (first call) and returns a connection-portal
    /// link. Passing `broker` (a slug) opens the portal straight at that brokerage.
    func snapTradePortal(credentials: [String: String],
                         broker: String? = nil) async throws -> SnapTradePortal {
        // The portal sends the user to this deep link once connected, which
        // brings Hon to the foreground (handled in ContentView.onOpenURL).
        let body = try JSONEncoder().encode(PortalRequest(
            credentials: credentials, broker: broker,
            customRedirect: "hon://snaptrade-linked"))
        return try await send("snaptrade/portal", method: "POST", body: body,
                              as: PortalResponse.self).portal
    }

    /// Lists every brokerage SnapTrade supports, for the Add Account picker.
    func snapTradeBrokerages(credentials: [String: String]) async throws
        -> [SnapTradeBrokerage] {
        let body = try JSONEncoder().encode(PortalRequest(credentials: credentials))
        return try await send("snaptrade/brokerages", method: "POST", body: body,
                              as: BrokeragesResponse.self).brokerages
    }

    func accounts() async throws -> [Account] {
        try await send("accounts", as: AccountsResponse.self).accounts
    }

    func transactions(accountId: String? = nil, limit: Int = 200) async throws -> [Transaction] {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let accountId {
            query.append(URLQueryItem(name: "accountId", value: accountId))
        }
        return try await send("transactions", query: query,
                              as: TransactionsResponse.self).transactions
    }

    func summary() async throws -> Summary {
        try await send("summary", as: SummaryResponse.self).summary
    }

    /// Moves one transaction to a new category. With `applyToMerchant`, the
    /// engine saves it as a rule for every transaction from the same business.
    func setTransactionCategory(
        id: String, category: String, applyToMerchant: Bool
    ) async throws {
        let body = try JSONEncoder().encode(
            TransactionCategoryUpdate(category: category, applyToMerchant: applyToMerchant))
        _ = try await raw("transactions/\(id)/category", method: "PATCH", query: [], body: body)
    }

    func llmStatus() async throws -> LLMStatus {
        try await send("llm", as: LLMStatus.self)
    }

    func downloadModel(modelId: String) async throws {
        let body = try JSONEncoder().encode(["modelId": modelId])
        _ = try await raw("llm/download", method: "POST", query: [], body: body)
    }

    func cancelModelDownload() async throws {
        _ = try await raw("llm/cancel", method: "POST", query: [], body: nil)
    }

    func categorize() async throws {
        _ = try await raw("categorize", method: "POST", query: [], body: nil)
    }

    func categorizeStatus() async throws -> CategorizeStatus {
        try await send("categorize", as: CategorizeStatus.self)
    }

    func budget() async throws -> BudgetReport {
        try await send("budget", as: BudgetReport.self)
    }

    func setBudget(category: String, monthlyAmount: Double) async throws {
        let body = try JSONEncoder().encode(
            BudgetUpdate(category: category, monthlyAmount: monthlyAmount))
        _ = try await raw("budgets", method: "PUT", query: [], body: body)
    }

    func generateInsights() async throws {
        _ = try await raw("insights", method: "POST", query: [], body: nil)
    }

    func insights() async throws -> Insights {
        try await send("insights", as: Insights.self)
    }

    // MARK: - Plumbing

    private func send<T: Decodable>(_ path: String, method: String = "GET",
                                    query: [URLQueryItem] = [], body: Data? = nil,
                                    as type: T.Type) async throws -> T {
        let data = try await raw(path, method: method, query: query, body: body)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(path)
        }
    }

    private func raw(_ path: String, method: String, query: [URLQueryItem],
                     body: Data?) async throws -> Data {
        var components = URLComponents(
            url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }

        var request = URLRequest(url: components.url!)
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
