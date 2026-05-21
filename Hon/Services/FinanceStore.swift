import Combine
import Foundation

struct ScrapeProgress: Equatable {
    enum Phase { case running, succeeded, failed }
    var message: String
    var phase: Phase
}

/// Holds Hon's financial data and drives the engine API: loading the
/// dashboard, adding connections, and running scrapes with progress polling.
@MainActor
final class FinanceStore: ObservableObject {
    @Published private(set) var companies: [Company] = []
    @Published private(set) var connections: [Connection] = []
    @Published private(set) var accounts: [Account] = []
    @Published private(set) var transactions: [Transaction] = []
    @Published private(set) var summary: Summary?
    @Published private(set) var llm: LLMStatus?
    @Published private(set) var budget: BudgetReport?
    @Published private(set) var insights: Insights?
    @Published private(set) var categorizeStatus: CategorizeStatus?
    @Published var otpRequest: OtpRequest?
    @Published private(set) var isLoading = false
    @Published private(set) var scrapeStatus: [String: ScrapeProgress] = [:]
    @Published var errorMessage: String?

    private var client: APIClient?

    var isReady: Bool { client != nil }

    func connect(_ client: APIClient) async {
        self.client = client
        do {
            companies = try await client.companies()
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
        await refreshLLM()
        if llm?.isWorking == true {
            await pollLLM()
        }
    }

    /// Reloads connections, accounts, transactions and the summary.
    func refresh() async {
        guard let client else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let connections = client.connections()
            async let accounts = client.accounts()
            async let transactions = client.transactions(limit: 120)
            async let summary = client.summary()
            async let budget = client.budget()
            async let insights = client.insights()
            self.connections = try await connections
            self.accounts = try await accounts
            self.transactions = try await transactions
            self.summary = try await summary
            self.budget = try await budget
            self.insights = try await insights
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func company(for companyId: String) -> Company? {
        companies.first { $0.id == companyId }
    }

    /// URL of an institution's logo, served by the local sidecar.
    func logoURL(forCompany companyId: String) -> URL? {
        client?.logoURL(companyId: companyId)
    }

    func accounts(for connectionId: String) -> [Account] {
        accounts.filter { $0.connectionId == connectionId }
    }

    @discardableResult
    func addConnection(company: Company, displayName: String,
                       credentials: [String: String]) async -> Connection? {
        guard let client else { return nil }
        do {
            let name = displayName.trimmingCharacters(in: .whitespaces)
            let connection = try await client.createConnection(
                companyId: company.id, displayName: name.isEmpty ? company.name : name)
            try KeychainStore.save(credentials, for: connection.id)
            connections.append(connection)
            errorMessage = nil
            return connection
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func deleteConnection(_ connection: Connection) async {
        guard let client else { return }
        do {
            try await client.deleteConnection(id: connection.id)
            KeychainStore.delete(for: connection.id)
            scrapeStatus[connection.id] = nil
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Starts a scrape and polls until it finishes, publishing live progress.
    /// Always runs the 2FA-aware path: if the bank asks for a one-time code,
    /// the OTP flow starts automatically.
    func scrape(_ connection: Connection) async {
        guard let client else { return }
        if scrapeStatus[connection.id]?.phase == .running { return }

        guard let credentials = KeychainStore.load(for: connection.id), !credentials.isEmpty else {
            scrapeStatus[connection.id] = ScrapeProgress(
                message: "No saved credentials for this connection.", phase: .failed)
            return
        }

        scrapeStatus[connection.id] = ScrapeProgress(
            message: "Signing in — you may be asked for a verification code.",
            phase: .running)
        do {
            let runId = try await client.startScrape(
                connectionId: connection.id, credentials: credentials,
                monthsBack: 3, interactive: true)
            while true {
                try await Task.sleep(for: .milliseconds(1500))
                let run = try await client.scrapeStatus(runId: runId)
                scrapeStatus[connection.id] = ScrapeProgress(message: run.message, phase: .running)

                if run.needsOtp {
                    if otpRequest?.runId != runId {
                        otpRequest = OtpRequest(
                            connectionId: connection.id,
                            connectionName: connection.displayName,
                            runId: runId)
                    }
                } else {
                    if otpRequest?.runId == runId { otpRequest = nil }
                    if !run.isInProgress {
                        scrapeStatus[connection.id] = ScrapeProgress(
                            message: run.message, phase: run.didSucceed ? .succeeded : .failed)
                        break
                    }
                }
            }
            await refresh()
        } catch {
            if otpRequest?.connectionId == connection.id { otpRequest = nil }
            scrapeStatus[connection.id] = ScrapeProgress(
                message: error.localizedDescription, phase: .failed)
        }
    }

    /// Supplies a 2FA code for the scrape currently waiting on one.
    func submitOtp(_ code: String) async {
        guard let client, let request = otpRequest else { return }
        do {
            try await client.submitOtp(runId: request.runId, code: code)
        } catch {
            errorMessage = error.localizedDescription
        }
        otpRequest = nil
    }

    func scrapeAll() async {
        for connection in connections {
            await scrape(connection)
        }
    }

    // MARK: - SnapTrade

    /// Opens SnapTrade's connection portal so the user can link a brokerage.
    /// Persists the SnapTrade user identifiers for future syncs and returns the
    /// portal URL (valid for ~5 minutes) for the caller to open.
    func linkBrokerage(_ connection: Connection, broker: String? = nil) async -> URL? {
        guard let client else { return nil }
        guard var credentials = KeychainStore.load(for: connection.id), !credentials.isEmpty else {
            errorMessage = "No SnapTrade credentials for this connection."
            return nil
        }
        do {
            let portal = try await client.snapTradePortal(
                credentials: credentials, broker: broker)
            // Persist the SnapTrade user immediately — even if the portal step
            // failed. A personal key allows only one user, so a lost secret
            // orphans the key permanently.
            if !portal.userId.isEmpty, !portal.userSecret.isEmpty {
                credentials["userId"] = portal.userId
                credentials["userSecret"] = portal.userSecret
                try KeychainStore.save(credentials, for: connection.id)
            }
            if let portalError = portal.error, !portalError.isEmpty {
                errorMessage = portalError
                return nil
            }
            errorMessage = portal.atLimit
                ? "SnapTrade's free tier links up to 5 brokerages — you've reached the limit."
                : nil
            return URL(string: portal.redirectURI)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Fetches SnapTrade's full brokerage list using a connection's stored keys.
    func loadBrokerages(_ connection: Connection) async -> [SnapTradeBrokerage] {
        guard let client else { return [] }
        guard let credentials = KeychainStore.load(for: connection.id),
              !credentials.isEmpty else {
            errorMessage = "No SnapTrade credentials for this connection."
            return []
        }
        do {
            return try await client.snapTradeBrokerages(credentials: credentials)
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    // MARK: - Local AI model

    func refreshLLM() async {
        guard let client else { return }
        llm = try? await client.llmStatus()
    }

    func downloadModel(_ modelId: String) async {
        guard let client else { return }
        do {
            try await client.downloadModel(modelId: modelId)
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        await pollLLM()
    }

    func cancelModelDownload() async {
        guard let client else { return }
        try? await client.cancelModelDownload()
        await refreshLLM()
    }

    /// Polls model status (~1s) while a download or load is in progress.
    private func pollLLM() async {
        for _ in 0 ..< 6000 {
            try? await Task.sleep(for: .seconds(1))
            await refreshLLM()
            if llm?.isWorking != true { return }
        }
    }

    // MARK: - Categorization

    /// Starts categorization and polls until it finishes, then reloads data.
    func runCategorization() async {
        guard let client else { return }
        if categorizeStatus?.isRunning == true { return }
        do {
            try await client.categorize()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        categorizeStatus = CategorizeStatus(
            state: "running", total: 0, done: 0, message: "Starting…")
        for _ in 0 ..< 3000 {
            try? await Task.sleep(for: .seconds(1))
            categorizeStatus = try? await client.categorizeStatus()
            if categorizeStatus?.isRunning != true { break }
        }
        await refresh()
    }

    /// Moves a transaction to a different category. When `applyToMerchant` is
    /// set, every transaction from the same business is moved too — and future
    /// ones will categorize there automatically.
    func recategorize(
        _ transaction: Transaction, to category: String, applyToMerchant: Bool
    ) async {
        guard let client else { return }
        do {
            try await client.setTransactionCategory(
                id: transaction.id, category: category, applyToMerchant: applyToMerchant)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Budgets & insights

    func reloadBudget() async {
        guard let client else { return }
        budget = try? await client.budget()
    }

    /// Saves a monthly budget per category (0 removes it), then reloads.
    func saveBudgets(_ amounts: [String: Double]) async {
        guard let client else { return }
        for (category, amount) in amounts {
            try? await client.setBudget(category: category, monthlyAmount: amount)
        }
        await reloadBudget()
    }

    func generateInsights() async {
        guard let client else { return }
        if insights?.isGenerating == true { return }
        do {
            try await client.generateInsights()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        insights = Insights(
            state: "generating", text: "", generatedAt: nil, message: "Generating…")
        for _ in 0 ..< 600 {
            try? await Task.sleep(for: .seconds(1))
            insights = try? await client.insights()
            if insights?.isGenerating != true { break }
        }
    }
}
