import SwiftUI

/// Monthly spending vs. budget per category, with Categorize and Edit Budgets.
struct BudgetSection: View {
    @EnvironmentObject private var store: FinanceStore
    @State private var showEditor = false

    private var report: BudgetReport? { store.budget }
    private var lines: [BudgetLine] { report?.lines ?? [] }
    private var currency: String { report?.currency ?? "ILS" }
    private var maxSpent: Double { lines.map(\.spent).max() ?? 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let status = store.categorizeStatus, status.isRunning {
                progressRow(status)
            }
            if lines.isEmpty {
                emptyPrompt
            } else {
                card
            }
        }
        .sheet(isPresented: $showEditor) {
            BudgetEditorView().environmentObject(store)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(report.map { "BUDGET · \($0.month)" } ?? "BUDGET")
                .font(.caption.weight(.semibold))
                .tracking(1.3)
                .foregroundStyle(.tertiary)
            Spacer()
            Button {
                Task { await store.runCategorization() }
            } label: {
                Label("Categorize", systemImage: "sparkles").font(.caption)
            }
            .buttonStyle(.borderless)
            .disabled(store.categorizeStatus?.isRunning == true)
            Button {
                showEditor = true
            } label: {
                Label("Edit budgets", systemImage: "slider.horizontal.3").font(.caption)
            }
            .buttonStyle(.borderless)
        }
    }

    private func progressRow(_ status: CategorizeStatus) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(status.message).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.hairline))
    }

    private var emptyPrompt: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Categorize this month's transactions to track them against a budget.")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let report, report.total > 0 {
                Text("\(report.categorized) of \(report.total) transactions categorized")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.hairline))
    }

    private var card: some View {
        VStack(spacing: 14) {
            if let report {
                summary(report)
                Divider().overlay(Theme.hairline)
            }
            VStack(spacing: 12) {
                ForEach(lines) { line in
                    row(line)
                }
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.hairline))
    }

    private func summary(_ report: BudgetReport) -> some View {
        HStack(spacing: 6) {
            Text("Spent this month").font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Text(Format.amount(report.totalSpent, currency: currency))
                .font(.system(.body, design: .rounded).weight(.semibold))
            if report.totalBudget > 0 {
                Text("of \(Format.amount(report.totalBudget, currency: currency))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ line: BudgetLine) -> some View {
        let color = CategoryStyle.color(line.category)
        let over = (line.ratio ?? 0) > 1
        return HStack(spacing: 12) {
            Image(systemName: CategoryStyle.icon(line.category))
                .font(.callout)
                .foregroundStyle(color)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(line.category).font(.subheadline)
                    Spacer()
                    Text(amountText(line))
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .foregroundStyle(over ? Theme.red : .primary)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.07))
                        Capsule()
                            .fill(barColor(line))
                            .frame(width: max(4, geo.size.width * barFraction(line)))
                    }
                }
                .frame(height: 5)
            }
        }
    }

    private func amountText(_ line: BudgetLine) -> String {
        let spent = Format.amount(line.spent, currency: currency)
        if let budget = line.budget {
            return "\(spent) / \(Format.amount(budget, currency: currency))"
        }
        return spent
    }

    private func barColor(_ line: BudgetLine) -> Color {
        guard let ratio = line.ratio else {
            return CategoryStyle.color(line.category).opacity(0.55)
        }
        if ratio > 1.0 { return Theme.red }
        if ratio > 0.85 { return Theme.amber }
        return Theme.green
    }

    private func barFraction(_ line: BudgetLine) -> Double {
        if let ratio = line.ratio { return min(1, ratio) }
        guard maxSpent > 0 else { return 0 }
        return min(1, line.spent / maxSpent)
    }
}
