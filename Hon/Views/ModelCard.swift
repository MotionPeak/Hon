import SwiftUI

/// Prompts the user to download the on-device AI model and shows download /
/// load progress. Renders nothing once a model is ready.
struct ModelCard: View {
    @EnvironmentObject private var store: FinanceStore

    var body: some View {
        if let status = store.llm, !status.isReady {
            content(status)
                .padding(18)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.hairline))
        }
    }

    @ViewBuilder
    private func content(_ status: LLMStatus) -> some View {
        switch status.state {
        case "downloading":
            downloading(status)
        case "downloaded", "loading":
            loading
        default:
            setup(status)
        }
    }

    // MARK: - Setup (not downloaded, or after an error)

    private func setup(_ status: LLMStatus) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            heading(
                icon: "sparkles",
                title: "On-device AI",
                subtitle: "Categorize transactions and ask questions about your money — "
                    + "with a model that runs entirely on this Mac, fully private.")
            if status.hasError {
                Text(status.message)
                    .font(.caption)
                    .foregroundStyle(Theme.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(status.catalog) { entry in
                modelRow(entry)
            }
        }
    }

    private func modelRow(_ entry: ModelCatalogEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(entry.name).font(.subheadline.weight(.semibold))
                    if entry.recommended {
                        Text("Recommended")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.gold.opacity(0.2), in: Capsule())
                            .foregroundStyle(Theme.gold)
                    }
                }
                Text(entry.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(Format.fileSize(entry.approxSizeBytes)) download")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            Button("Download") {
                Task { await store.downloadModel(entry.id) }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.indigo)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Downloading

    private func downloading(_ status: LLMStatus) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            heading(
                icon: "arrow.down.circle",
                title: "Downloading \(status.modelName ?? "the model")…",
                subtitle: nil)
            if status.totalBytes > 1 {
                ProgressView(value: status.progress).tint(Theme.indigo)
                HStack {
                    Text("\(Format.fileSize(status.downloadedBytes)) of "
                        + "\(Format.fileSize(status.totalBytes))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(Int(status.progress * 100))%")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            } else {
                ProgressView().controlSize(.small)
                Text(status.message).font(.caption).foregroundStyle(.secondary)
            }
            Button("Cancel") {
                Task { await store.cancelModelDownload() }
            }
            .buttonStyle(.borderless)
        }
    }

    // MARK: - Loading into memory

    private var loading: some View {
        HStack(spacing: 12) {
            ProgressView().controlSize(.small)
            Text("Loading the model into memory…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private func heading(icon: String, title: String, subtitle: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(Theme.gold)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
