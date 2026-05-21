import SwiftUI

/// Sheet for connecting a new institution: pick a company, enter its
/// credentials, and Hon creates the connection and runs a first sync.
struct AddConnectionView: View {
    @EnvironmentObject private var store: FinanceStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var selectedCategory: String?
    @State private var selectedCompanyId = ""
    @State private var displayName = ""
    @State private var fieldValues: [String: String] = [:]
    @State private var isSubmitting = false
    @State private var localError: String?
    @State private var brokerages: [SnapTradeBrokerage] = []
    @State private var brokeragesLoading = false
    @State private var openingPortal = false

    /// The existing SnapTrade connection, if one has been set up.
    private var snapTradeConnection: Connection? {
        store.connections.first { $0.companyId == snapTradeCompanyId }
    }

    private var selectedCompany: Company? {
        store.companies.first { $0.id == selectedCompanyId }
    }

    private var canSubmit: Bool {
        guard let company = selectedCompany else { return false }
        return company.loginFields.allSatisfy { key in
            !(fieldValues[key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if selectedCategory == nil {
                        categoryStep
                    } else if selectedCategory == "brokerage" {
                        brokerageFlow
                    } else if let company = selectedCompany {
                        credentialStep(company)
                    } else {
                        institutionStep
                    }
                    if let localError {
                        Label(localError, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
            }
            Divider().overlay(Theme.hairline)
            footer
        }
        .frame(width: 470, height: 580)
        .background(Theme.bg)
        .onChange(of: selectedCompanyId) { _, _ in
            fieldValues = [:]
            localError = nil
            displayName = selectedCompany?.name ?? ""
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Add an account")
                .font(.headline)
            Text("Connect a bank or credit card to Hon.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    private let categories: [(type: String, label: String, icon: String)] = [
        ("bank", "Banks", "building.columns"),
        ("card", "Credit cards", "creditcard"),
        ("brokerage", "Brokerages", "chart.line.uptrend.xyaxis"),
    ]

    private var institutionsInCategory: [Company] {
        store.companies.filter { $0.type == selectedCategory }
    }

    // Step 1 — pick a kind of account.
    private var categoryStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What kind of account do you want to connect?")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                ForEach(categories, id: \.type) { category in
                    categoryCard(category)
                }
            }
        }
    }

    private func categoryCard(
        _ category: (type: String, label: String, icon: String)
    ) -> some View {
        let count = store.companies.filter { $0.type == category.type }.count
        return Button {
            selectedCompanyId = ""
            fieldValues = [:]
            localError = nil
            if category.type == "brokerage" {
                displayName = store.company(for: snapTradeCompanyId)?.name ?? "SnapTrade"
            }
            selectedCategory = category.type
        } label: {
            VStack(spacing: 6) {
                Image(systemName: category.icon).font(.system(size: 26))
                Text(category.label).font(.subheadline.weight(.semibold))
                Text(category.type == "brokerage"
                    ? "via SnapTrade"
                    : "\(count) option\(count == 1 ? "" : "s")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.hairline))
        }
        .buttonStyle(.plain)
    }

    // Step 2 — pick an institution within the chosen category.
    private var institutionStep: some View {
        VStack(alignment: .leading, spacing: 4) {
            backButton("All categories") { selectedCategory = nil }
            ForEach(institutionsInCategory) { company in
                Button {
                    selectedCompanyId = company.id
                } label: {
                    HStack(spacing: 10) {
                        CompanyLogo(company: company)
                        Text(company.name)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption).foregroundStyle(.tertiary)
                    }
                    .padding(8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // Step 3 — enter the institution's credentials.
    private func credentialStep(_ company: Company) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            backButton("\(company.categoryLabel)s") { selectedCompanyId = "" }
            companyHeader(company)
            credentialForm(company)
            if company.id == snapTradeCompanyId {
                snapTradeNote
            }
            securityNote
        }
    }

    // Brokerage category — collect SnapTrade keys once, then show SnapTrade's
    // live brokerage list. Picking one opens the portal straight at it.
    @ViewBuilder private var brokerageFlow: some View {
        VStack(alignment: .leading, spacing: 18) {
            backButton("All categories") {
                selectedCategory = nil
                brokerages = []
            }
            if let connection = snapTradeConnection {
                brokerageGrid(connection)
            } else {
                snapTradeKeysStep
            }
        }
    }

    @ViewBuilder private var snapTradeKeysStep: some View {
        if let snap = store.company(for: snapTradeCompanyId) {
            companyHeader(snap)
            credentialForm(snap)
            snapTradeNote
            securityNote
            Button {
                Task { await createSnapTradeConnection(snap) }
            } label: {
                if isSubmitting {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Continue").padding(.horizontal, 6)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.indigo)
            .disabled(!snapKeysFilled(snap) || isSubmitting)
        } else {
            Text("SnapTrade is unavailable.").foregroundStyle(.secondary)
        }
    }

    private func brokerageGrid(_ connection: Connection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if brokeragesLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading brokerages…").font(.caption).foregroundStyle(.secondary)
                }
            } else if brokerages.isEmpty {
                Text("No brokerages available right now.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Pick a brokerage to connect.")
                    .font(.subheadline).foregroundStyle(.secondary)
                ForEach(brokerages) { brokerage in
                    Button {
                        Task { await openBrokeragePortal(connection, brokerage) }
                    } label: {
                        HStack(spacing: 10) {
                            LogoTile(url: brokerage.logoURL,
                                     fallbackIcon: "chart.line.uptrend.xyaxis")
                            Text(brokerage.name)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                        .padding(8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(openingPortal)
                }
            }
        }
        .task(id: connection.id) {
            brokeragesLoading = true
            brokerages = await store.loadBrokerages(connection)
            brokeragesLoading = false
        }
    }

    private func snapKeysFilled(_ company: Company) -> Bool {
        company.loginFields.allSatisfy { key in
            !(fieldValues[key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func createSnapTradeConnection(_ snap: Company) async {
        isSubmitting = true
        localError = nil
        let credentials = fieldValues.mapValues { $0.trimmingCharacters(in: .whitespaces) }
        let name = displayName.trimmingCharacters(in: .whitespaces)
        if await store.addConnection(
            company: snap, displayName: name.isEmpty ? snap.name : name,
            credentials: credentials) == nil {
            localError = store.errorMessage ?? "Could not save your SnapTrade keys."
        }
        isSubmitting = false
    }

    private func openBrokeragePortal(
        _ connection: Connection, _ brokerage: SnapTradeBrokerage
    ) async {
        openingPortal = true
        localError = nil
        if let url = await store.linkBrokerage(connection, broker: brokerage.slug) {
            openURL(url)
            dismiss()
        } else {
            localError = store.errorMessage ?? "Could not open the connection portal."
            openingPortal = false
        }
    }

    private func backButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: "chevron.left").font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }

    private func companyHeader(_ company: Company) -> some View {
        HStack(spacing: 10) {
            CompanyLogo(company: company)
            VStack(alignment: .leading, spacing: 1) {
                Text(company.name).font(.subheadline.weight(.semibold))
                Text(company.categoryLabel).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func credentialForm(_ company: Company) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(company.credentialFields) { field in
                VStack(alignment: .leading, spacing: 6) {
                    Text(field.label).font(.subheadline.weight(.medium))
                    Group {
                        if field.isSecure {
                            SecureField(field.label, text: binding(for: field.key))
                        } else {
                            TextField(field.label, text: binding(for: field.key))
                        }
                    }
                    .textFieldStyle(.roundedBorder)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Display name").font(.subheadline.weight(.medium))
                TextField("Display name", text: $displayName)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private var snapTradeNote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(
                "SnapTrade aggregates brokerage accounts through its cloud service. "
                    + "To get a Client ID and Consumer Key:",
                systemImage: "cloud")
            VStack(alignment: .leading, spacing: 3) {
                Text("1. Sign up at dashboard.snaptrade.com")
                Text("2. Open the API Keys page and copy the Client ID")
                Text("3. Click the regenerate icon next to Consumer Key, then copy the revealed key")
                Text("4. Paste both above. After connecting, use “Link a brokerage” on the "
                    + "account card to link up to 5 brokerages.")
            }
            .padding(.leading, 22)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var securityNote: some View {
        Label(
            "Credentials are stored in your Mac's Keychain and used only on this device.",
            systemImage: "lock.fill")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var footer: some View {
        HStack {
            Button("Cancel") { dismiss() }
            Spacer()
            if selectedCompany != nil {
                Button {
                    Task { await submit() }
                } label: {
                    if isSubmitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Connect").padding(.horizontal, 6)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .tint(Theme.indigo)
                .disabled(!canSubmit || isSubmitting)
            }
        }
        .padding(20)
    }

    private func binding(for key: String) -> Binding<String> {
        Binding(
            get: { fieldValues[key] ?? "" },
            set: { fieldValues[key] = $0 })
    }

    private func submit() async {
        guard let company = selectedCompany else { return }
        isSubmitting = true
        localError = nil
        let credentials = fieldValues.mapValues { $0.trimmingCharacters(in: .whitespaces) }

        if let connection = await store.addConnection(
            company: company, displayName: displayName, credentials: credentials) {
            // SnapTrade has nothing to sync until a brokerage is linked via the portal.
            if company.id != snapTradeCompanyId {
                Task { await store.scrape(connection) }
            }
            dismiss()
        } else {
            localError = store.errorMessage ?? "Could not create the connection."
            isSubmitting = false
        }
    }
}

/// A remote logo in a rounded tile, with an SF Symbol shown while it loads or
/// if the image cannot be fetched. Unlike `AsyncImage`, this checks the HTTP
/// status, so a 404 (which some servers answer with a placeholder image body)
/// correctly falls back to the icon.
struct LogoTile: View {
    let url: URL?
    let fallbackIcon: String
    var size: CGFloat = 30

    @State private var image: NSImage?

    var body: some View {
        let corner = size * 0.27
        RoundedRectangle(cornerRadius: corner)
            .fill(Theme.hairline)
            .frame(width: size, height: size)
            .overlay {
                if let image {
                    Image(nsImage: image).resizable().scaledToFit().padding(size * 0.12)
                } else {
                    Image(systemName: fallbackIcon)
                        .font(.system(size: size * 0.5))
                        .foregroundStyle(.secondary)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: corner))
            .task(id: url) { await load() }
    }

    private func load() async {
        image = nil
        guard let url else { return }
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let loaded = NSImage(data: data) else {
            return
        }
        image = loaded
    }
}

/// An institution's logo (served by the local sidecar), with its category
/// icon as the fallback.
struct CompanyLogo: View {
    @EnvironmentObject private var store: FinanceStore
    let company: Company?
    var size: CGFloat = 30

    var body: some View {
        LogoTile(url: company.flatMap { store.logoURL(forCompany: $0.id) },
                 fallbackIcon: company?.categoryIcon ?? "building.columns",
                 size: size)
    }
}
