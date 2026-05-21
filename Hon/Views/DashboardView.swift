import SwiftUI

/// A pending category move awaiting the user's confirmation.
struct PendingRecategorize: Identifiable {
    let transaction: Transaction
    let category: String
    var id: String { transaction.id }
}

struct DashboardView: View {
    @EnvironmentObject private var store: FinanceStore
    @State private var showAddConnection = false
    @State private var pendingRecategorize: PendingRecategorize?

    private enum Tab: String, CaseIterable, Identifiable {
        case overview = "Overview", accounts = "Accounts", activity = "Activity"
        var id: String { rawValue }
    }
    @State private var tab: Tab = .overview

    var body: some View {
        VStack(spacing: 0) {
            topBar
            navBar
            Divider().overlay(Theme.hairline)
            if store.connections.isEmpty && !store.isLoading {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        switch tab {
                        case .overview:
                            ModelCard()
                            NetWorthCard(summary: store.summary)
                            BudgetSection()
                            InsightsCard()
                        case .accounts:
                            connectionsSection
                        case .activity:
                            activitySection
                        }
                    }
                    .padding(24)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showAddConnection) {
            AddConnectionView().environmentObject(store)
        }
        .sheet(item: $store.otpRequest) { request in
            OTPSheet(request: request).environmentObject(store)
        }
        .confirmationDialog(
            "Move to “\(pendingRecategorize?.category ?? "")”",
            isPresented: Binding(
                get: { pendingRecategorize != nil },
                set: { if !$0 { pendingRecategorize = nil } }),
            presenting: pendingRecategorize
        ) { pending in
            Button("Always use “\(pending.category)” for this business") {
                Task {
                    await store.recategorize(
                        pending.transaction, to: pending.category, applyToMerchant: true)
                }
            }
            Button("Just this transaction") {
                Task {
                    await store.recategorize(
                        pending.transaction, to: pending.category, applyToMerchant: false)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { pending in
            Text("“\(pending.transaction.description)”")
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Text("Hon")
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.gold)
            if store.isLoading {
                ProgressView().controlSize(.small)
            }
            Spacer()
            if let error = store.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.red)
                    .lineLimit(1)
            }
            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Reload from the local database")
            Button {
                Task { await store.scrapeAll() }
            } label: {
                Label("Sync all", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(store.connections.isEmpty)
            Button {
                showAddConnection = true
            } label: {
                Label("Add account", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.indigo)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    private var navBar: some View {
        Picker("Section", selection: $tab) {
            ForEach(Tab.allCases) { tab in
                Text(tab.rawValue).tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, 24)
        .padding(.bottom, 10)
    }

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("ACCOUNTS")
            ForEach(store.connections) { connection in
                ConnectionCard(connection: connection)
            }
        }
    }

    @ViewBuilder
    private var activitySection: some View {
        if !store.transactions.isEmpty {
            let accountsById = Dictionary(
                store.accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            ForEach(groupedTransactions, id: \.category) { group in
                VStack(alignment: .leading, spacing: 12) {
                    categoryGroupHeader(group.category, count: group.transactions.count)
                    VStack(spacing: 0) {
                        ForEach(group.transactions) { txn in
                            TransactionRow(transaction: txn, account: accountsById[txn.accountId])
                                .contextMenu { recategorizeMenu(for: txn) }
                            if txn.id != group.transactions.last?.id {
                                Divider().overlay(Theme.hairline)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.hairline))
                }
            }
        }
    }

    /// Transactions grouped under their spending category, groups ordered by the
    /// fixed taxonomy and each group sorted newest-first.
    private var groupedTransactions: [(category: String, transactions: [Transaction])] {
        let grouped = Dictionary(grouping: store.transactions) { $0.category ?? "Uncategorized" }
        let order = Categories.all + ["Uncategorized"]
        return grouped.keys.sorted { a, b in
            let ia = order.firstIndex(of: a) ?? order.count
            let ib = order.firstIndex(of: b) ?? order.count
            return ia != ib ? ia < ib : a < b
        }.map { category in
            let txns = (grouped[category] ?? []).sorted {
                (Format.parseDate($0.date) ?? .distantPast)
                    > (Format.parseDate($1.date) ?? .distantPast)
            }
            return (category, txns)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "building.columns")
                .font(.system(size: 48))
                .foregroundStyle(Theme.gold.opacity(0.8))
            Text("No accounts yet")
                .font(.title2.weight(.semibold))
            Text("Connect a bank or credit card to pull your\nbalances and transactions into Hon.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                showAddConnection = true
            } label: {
                Label("Add your first account", systemImage: "plus")
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.indigo)
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .tracking(1.3)
            .foregroundStyle(.tertiary)
    }

    private func categoryGroupHeader(_ category: String, count: Int) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 3)
                .fill(CategoryStyle.color(category))
                .frame(width: 11, height: 11)
            Text(category.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.3)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(count) \(count == 1 ? "transaction" : "transactions")")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func recategorizeMenu(for transaction: Transaction) -> some View {
        Menu("Move to category") {
            ForEach(Categories.all, id: \.self) { category in
                Button {
                    pendingRecategorize = PendingRecategorize(
                        transaction: transaction, category: category)
                } label: {
                    Label(category, systemImage: CategoryStyle.icon(category))
                }
            }
        }
    }
}

// MARK: - Net worth

struct NetWorthCard: View {
    let summary: Summary?

    private var totals: [Summary.CurrencyTotal] {
        (summary?.byCurrency ?? []).sorted { a, b in
            if a.currency == "ILS" { return true }
            if b.currency == "ILS" { return false }
            return a.total > b.total
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("NET WORTH")
                .font(.caption.weight(.semibold))
                .tracking(1.4)
                .foregroundStyle(.white.opacity(0.7))

            headlineAndChips

            Text("\(summary?.accountCount ?? 0) accounts · \(summary?.connectionCount ?? 0) connections")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.65))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22)
        .background(
            LinearGradient(
                colors: [Theme.indigo, Color(red: 0.23, green: 0.19, blue: 0.52)],
                startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 18))
    }

    /// One combined ILS figure when the FX total is available, otherwise the
    /// largest single-currency total; foreign balances follow as chips.
    @ViewBuilder
    private var headlineAndChips: some View {
        if let ils = summary?.netWorthILS {
            amountText(Format.amount(ils, currency: "ILS"))
            if totals.count > 1 { chips(totals) }
        } else if let primary = totals.first {
            amountText(Format.amount(primary.total, currency: primary.currency))
            if totals.count > 1 { chips(Array(totals.dropFirst())) }
        } else {
            Text("—")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
        }
    }

    private func amountText(_ value: String) -> some View {
        Text(value)
            .font(.system(size: 44, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
    }

    private func chips(_ items: [Summary.CurrencyTotal]) -> some View {
        HStack(spacing: 8) {
            ForEach(items) { total in
                Text(Format.amount(total.total, currency: total.currency))
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.white.opacity(0.9))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.14), in: Capsule())
            }
        }
    }
}

// MARK: - Connection card

struct ConnectionCard: View {
    let connection: Connection
    @EnvironmentObject private var store: FinanceStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        let accounts = store.accounts(for: connection.id)
        let progress = store.scrapeStatus[connection.id]

        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                CompanyLogo(company: store.company(for: connection.companyId))
                VStack(alignment: .leading, spacing: 2) {
                    Text(connection.displayName).font(.headline)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                syncButton(progress)
            }

            if let progress {
                progressRow(progress)
            }

            if accounts.isEmpty {
                Text(emptyAccountsText)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(accounts) { account in
                        accountRow(account)
                        if account.id != accounts.last?.id {
                            Divider().overlay(Theme.hairline)
                        }
                    }
                }
            }

            if hasScreenshot {
                screenshotButton
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.hairline))
        .contextMenu {
            Button(role: .destructive) {
                Task { await store.deleteConnection(connection) }
            } label: {
                Label("Remove connection", systemImage: "trash")
            }
        }
    }

    private var emptyAccountsText: String {
        if connection.isSnapTrade && connection.lastScrapeAt == nil {
            return "No brokerage linked yet — use “Link a brokerage” to connect one."
        }
        return connection.lastScrapeAt == nil ? "Not synced yet." : "No accounts found."
    }

    private var subtitle: String {
        let company = store.company(for: connection.companyId)?.name ?? connection.companyId
        guard connection.lastScrapeAt != nil else { return company }
        let when = Format.relativeDate(connection.lastScrapeAt)
        let verb = connection.lastStatus == "error" ? "sync failed" : "synced"
        return "\(company) · \(verb) \(when)"
    }

    private var screenshotURL: URL {
        SidecarManager.dataDir().appendingPathComponent("debug/\(connection.companyId).png")
    }

    private var hasScreenshot: Bool {
        FileManager.default.fileExists(atPath: screenshotURL.path)
    }

    private var screenshotButton: some View {
        Button {
            openURL(screenshotURL)
        } label: {
            Label("Show what happened", systemImage: "photo").font(.caption)
        }
        .buttonStyle(.borderless)
        .help("Open a screenshot of the page where the last sync got stuck")
    }

    @ViewBuilder
    private func syncButton(_ progress: ScrapeProgress?) -> some View {
        let running = progress?.phase == .running
        if connection.isSnapTrade {
            // SnapTrade keeps a menu — Sync plus "Link a brokerage".
            Menu {
                Button {
                    Task {
                        if let url = await store.linkBrokerage(connection) {
                            openURL(url)
                        }
                    }
                } label: {
                    Label("Link a brokerage…", systemImage: "link")
                }
            } label: {
                syncLabel(running)
            } primaryAction: {
                Task { await store.scrape(connection) }
            }
            .fixedSize()
            .disabled(running)
        } else {
            // One Sync button — it starts the 2FA flow itself if the bank asks.
            Button {
                Task { await store.scrape(connection) }
            } label: {
                syncLabel(running)
            }
            .fixedSize()
            .disabled(running)
        }
    }

    @ViewBuilder
    private func syncLabel(_ running: Bool) -> some View {
        if running {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Syncing")
            }
        } else {
            Label("Sync", systemImage: "arrow.clockwise")
        }
    }

    private func progressRow(_ progress: ScrapeProgress) -> some View {
        HStack(spacing: 8) {
            Image(systemName: progressIcon(progress.phase))
                .foregroundStyle(progressColor(progress.phase))
            Text(progress.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 9))
    }

    private func accountRow(_ account: Account) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.label ?? "Account \(account.accountNumber)")
                    .font(.subheadline)
                if account.label != nil {
                    Text(account.accountNumber).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Text(account.balance.map { Format.amount($0, currency: account.currency) } ?? "—")
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.vertical, 9)
    }

    private func progressIcon(_ phase: ScrapeProgress.Phase) -> String {
        switch phase {
        case .running: return "arrow.triangle.2.circlepath"
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }

    private func progressColor(_ phase: ScrapeProgress.Phase) -> Color {
        switch phase {
        case .running: return Theme.amber
        case .succeeded: return Theme.green
        case .failed: return Theme.red
        }
    }
}

// MARK: - Transaction row

struct TransactionRow: View {
    let transaction: Transaction
    let account: Account?

    var body: some View {
        HStack(spacing: 12) {
            categoryIcon
            VStack(alignment: .leading, spacing: 3) {
                Text(transaction.description)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Text(secondaryLine)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.amount(transaction.amount, currency: transaction.currency, showsSign: true))
                    .font(.system(size: 15, design: .rounded).weight(.bold))
                    .foregroundStyle(transaction.amount < 0 ? .primary : Theme.green)
                if transaction.isPending {
                    Text("pending")
                        .font(.caption2)
                        .foregroundStyle(Theme.amber)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var categoryIcon: some View {
        let category = transaction.category ?? "Other"
        let color = CategoryStyle.color(category)
        return Image(systemName: CategoryStyle.icon(category))
            .font(.system(size: 14))
            .foregroundStyle(color)
            .frame(width: 36, height: 36)
            .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: 10))
    }

    private var secondaryLine: String {
        var parts = [Format.date(transaction.date)]
        if let account {
            parts.append(account.label ?? account.connectionName)
        }
        return parts.joined(separator: " · ")
    }
}
