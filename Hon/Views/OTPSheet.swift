import SwiftUI

/// Collects the bank's one-time 2FA code during an interactive sync.
struct OTPSheet: View {
    @EnvironmentObject private var store: FinanceStore
    @Environment(\.dismiss) private var dismiss
    let request: OtpRequest

    @State private var code = ""
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Label("Verification code", systemImage: "lock.shield")
                    .font(.headline)
                Text("\(request.connectionName) sent a one-time code to your phone. "
                    + "Enter it to finish signing in.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextField("Code", text: $code)
                .textFieldStyle(.roundedBorder)
                .font(.system(.title3, design: .monospaced))
                .onSubmit(submit)
            HStack {
                Button("Cancel") { dismiss() }
                Spacer()
                Button(action: submit) {
                    if submitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Submit").padding(.horizontal, 6)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .tint(Theme.indigo)
                .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || submitting)
            }
        }
        .padding(22)
        .frame(width: 380)
        .background(Theme.bg)
    }

    private func submit() {
        let trimmed = code.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !submitting else { return }
        submitting = true
        Task { await store.submitOtp(trimmed) }
    }
}
