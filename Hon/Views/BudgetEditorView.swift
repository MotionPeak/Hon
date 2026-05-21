import SwiftUI

/// Sheet for setting a monthly budget per category.
struct BudgetEditorView: View {
    @EnvironmentObject private var store: FinanceStore
    @Environment(\.dismiss) private var dismiss

    @State private var amounts: [String: String] = [:]
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.hairline)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(Categories.all, id: \.self) { category in
                        row(category)
                    }
                }
                .padding(20)
            }
            Divider().overlay(Theme.hairline)
            footer
        }
        .frame(width: 440, height: 580)
        .background(Theme.bg)
        .onAppear(perform: load)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Monthly budgets").font(.headline)
            Text("Set a monthly limit per category. Leave blank for no budget.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    private func row(_ category: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: CategoryStyle.icon(category))
                .font(.callout)
                .foregroundStyle(CategoryStyle.color(category))
                .frame(width: 22)
            Text(category).font(.subheadline)
            Spacer()
            Text("₪").foregroundStyle(.secondary)
            TextField("0", text: binding(for: category))
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.trailing)
                .frame(width: 92)
        }
    }

    private var footer: some View {
        HStack {
            Button("Cancel") { dismiss() }
            Spacer()
            Button {
                Task { await save() }
            } label: {
                if saving {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Save").padding(.horizontal, 6)
                }
            }
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
            .tint(Theme.indigo)
            .disabled(saving)
        }
        .padding(20)
    }

    private func binding(for category: String) -> Binding<String> {
        Binding(
            get: { amounts[category] ?? "" },
            set: { amounts[category] = $0 })
    }

    private func load() {
        for line in store.budget?.lines ?? [] {
            if let budget = line.budget {
                amounts[line.category] =
                    budget == budget.rounded() ? String(Int(budget)) : String(budget)
            }
        }
    }

    private func save() async {
        saving = true
        var result: [String: Double] = [:]
        for category in Categories.all {
            let raw = (amounts[category] ?? "").trimmingCharacters(in: .whitespaces)
            result[category] = Double(raw) ?? 0
        }
        await store.saveBudgets(result)
        dismiss()
    }
}
