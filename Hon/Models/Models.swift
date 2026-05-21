import Foundation

// MARK: - API models

struct Company: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let loginFields: [String]
    let type: String
    let domain: String?

    var credentialFields: [CredentialField] {
        loginFields.map(CredentialField.init(key:))
    }

    var categoryIcon: String {
        switch type {
        case "card": return "creditcard"
        case "brokerage": return "chart.line.uptrend.xyaxis"
        default: return "building.columns"
        }
    }

    var categoryLabel: String {
        switch type {
        case "card": return "Credit card"
        case "brokerage": return "Brokerage"
        default: return "Bank"
        }
    }
}

struct CredentialField: Identifiable, Hashable {
    let key: String
    var id: String { key }

    var label: String {
        switch key {
        case "username": return "Username"
        case "password": return "Password"
        case "userCode": return "User code"
        case "id": return "ID number"
        case "card6Digits": return "Card — last 6 digits"
        case "nationalID": return "National ID"
        case "num": return "Account number"
        case "clientId": return "SnapTrade Client ID"
        case "consumerKey": return "SnapTrade Consumer Key"
        default: return key.prefix(1).uppercased() + key.dropFirst()
        }
    }

    var isSecure: Bool { key == "password" || key == "consumerKey" }
}

/// Marker companyId for the SnapTrade brokerage-aggregation connector.
let snapTradeCompanyId = "snaptrade"

struct Connection: Codable, Identifiable, Hashable {
    let id: String
    let companyId: String
    let displayName: String
    let createdAt: String
    let lastScrapeAt: String?
    let lastStatus: String?

    var isSnapTrade: Bool { companyId == snapTradeCompanyId }
}

/// Connection-portal link returned by the sidecar's `/snaptrade/portal`.
/// A brokerage SnapTrade can connect, shown in the Add Account brokerage picker.
struct SnapTradeBrokerage: Codable, Identifiable, Hashable {
    let slug: String
    let name: String
    let logoUrl: String?

    var id: String { slug }
    var logoURL: URL? { logoUrl.flatMap { URL(string: $0) } }
}

struct SnapTradePortal: Codable, Hashable {
    let userId: String
    let userSecret: String
    let redirectURI: String
    let connectionCount: Int
    let atLimit: Bool
    /// Set when the user registered but the portal step failed; userId/userSecret
    /// are still valid and must be persisted.
    let error: String?
}

struct Account: Codable, Identifiable, Hashable {
    let id: String
    let connectionId: String
    let companyId: String
    let connectionName: String
    let accountNumber: String
    let label: String?
    let balance: Double?
    let currency: String
    let updatedAt: String
}

struct Transaction: Codable, Identifiable, Hashable {
    let id: String
    let accountId: String
    let externalId: String
    let date: String
    let processedDate: String?
    let amount: Double
    let currency: String
    let description: String
    let memo: String?
    let kind: String?
    let status: String?
    let category: String?
    let createdAt: String

    var isPending: Bool { status == "pending" }
}

struct Summary: Codable, Hashable {
    let connectionCount: Int
    let accountCount: Int
    let byCurrency: [CurrencyTotal]
    /// Every account combined into one ILS figure; nil if the FX lookup failed.
    let netWorthILS: Double?

    struct CurrencyTotal: Codable, Hashable, Identifiable {
        var id: String { currency }
        let currency: String
        let total: Double
        let accountCount: Int
    }
}

struct ScrapeRun: Codable, Hashable {
    let status: String
    let message: String
    let accountsCount: Int
    let transactionsCount: Int

    var isRunning: Bool { status == "running" }
    var needsOtp: Bool { status == "needs-otp" }
    var isInProgress: Bool { status == "running" || status == "needs-otp" }
    var didSucceed: Bool { status == "success" }
}

/// An in-progress scrape waiting for the user's 2FA code.
struct OtpRequest: Identifiable, Hashable {
    var id: String { runId }
    let connectionId: String
    let connectionName: String
    let runId: String
}

struct ModelCatalogEntry: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let uri: String
    let approxSizeBytes: Int
    let recommended: Bool
}

struct LLMStatus: Codable, Hashable {
    let state: String
    let modelId: String?
    let modelName: String?
    let message: String
    let downloadedBytes: Int
    let totalBytes: Int
    let catalog: [ModelCatalogEntry]

    var isReady: Bool { state == "ready" }
    var isWorking: Bool { state == "downloading" || state == "downloaded" || state == "loading" }
    var needsSetup: Bool { state == "not-downloaded" || state == "error" }
    var hasError: Bool { state == "error" }

    var progress: Double {
        guard totalBytes > 0 else { return 0 }
        return min(1, max(0, Double(downloadedBytes) / Double(totalBytes)))
    }
}

struct CategorizeStatus: Codable, Hashable {
    let state: String
    let total: Int
    let done: Int
    let message: String

    var isRunning: Bool { state == "running" }

    var progress: Double {
        guard total > 0 else { return 0 }
        return min(1, max(0, Double(done) / Double(total)))
    }
}

struct BudgetLine: Codable, Identifiable, Hashable {
    var id: String { category }
    let category: String
    let budget: Double?
    let spent: Double

    /// 0...n ratio of spend to budget; nil when no budget is set.
    var ratio: Double? {
        guard let budget, budget > 0 else { return nil }
        return spent / budget
    }
}

struct BudgetReport: Codable, Hashable {
    let month: String
    let currency: String
    let lines: [BudgetLine]
    let totalBudget: Double
    let totalSpent: Double
    let categorized: Int
    let total: Int
}

struct Insights: Codable, Hashable {
    let state: String
    let text: String
    let generatedAt: String?
    let message: String

    var isGenerating: Bool { state == "generating" }
    var isReady: Bool { state == "ready" }
    var hasError: Bool { state == "error" }
}

/// The fixed spending taxonomy (mirrors the sidecar's categorizer).
enum Categories {
    static let all: [String] = [
        "Groceries", "Dining", "Transport", "Fuel", "Shopping", "Utilities",
        "Housing", "Health", "Entertainment", "Subscriptions", "Travel",
        "Education", "Income", "Transfers", "Fees", "Other",
    ]
}

// MARK: - Display formatting

enum Format {
    private static let decimal: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return formatter
    }()

    static func symbol(for currency: String) -> String {
        switch currency.uppercased() {
        case "ILS", "NIS": return "₪"
        case "USD": return "$"
        case "EUR": return "€"
        case "GBP": return "£"
        default: return currency.uppercased() + " "
        }
    }

    static func amount(_ value: Double, currency: String, showsSign: Bool = false) -> String {
        let magnitude = decimal.string(from: NSNumber(value: abs(value)))
            ?? String(format: "%.2f", abs(value))
        let sign = value < 0 ? "−" : (showsSign && value > 0 ? "+" : "")
        return "\(sign)\(symbol(for: currency))\(magnitude)"
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    private static let plainDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()
    private static let display: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    static func parseDate(_ string: String) -> Date? {
        isoWithFraction.date(from: string)
            ?? iso.date(from: string)
            ?? plainDate.date(from: String(string.prefix(10)))
    }

    static func date(_ string: String) -> String {
        guard let date = parseDate(string) else { return string }
        return display.string(from: date)
    }

    static func relativeDate(_ string: String?) -> String {
        guard let string, let date = parseDate(string) else { return "never" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    static func fileSize(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowedUnits = [.useGB, .useMB]
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
