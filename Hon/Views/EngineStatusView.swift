import SwiftUI

/// Shown until the local engine is connected — bring-up state and engine log.
struct EngineStatusView: View {
    @EnvironmentObject private var sidecar: SidecarManager

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            VStack(spacing: 8) {
                Text("Hon")
                    .font(.system(size: 46, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.gold)
                Text("Your assets and budget — private, on your Mac.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            statusCard
            logPanel
            Spacer()
        }
        .frame(maxWidth: 580)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var statusCard: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(statusColor)
                .frame(width: 12, height: 12)
                .shadow(color: statusColor.opacity(0.7), radius: 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusTitle).font(.headline)
                Text(statusDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button {
                sidecar.restart()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Restart the local engine")
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.hairline))
    }

    private var logPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ENGINE LOG")
                .font(.caption2.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(.tertiary)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(sidecar.logLines.enumerated()), id: \.offset) { index, line in
                            Text(line)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(index)
                        }
                    }
                    .padding(10)
                }
                .onChange(of: sidecar.logLines.count) { _, count in
                    guard count > 0 else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(count - 1, anchor: .bottom)
                    }
                }
            }
            .frame(height: 180)
            .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.hairline))
        }
    }

    private var statusColor: Color {
        switch sidecar.status {
        case .idle: return .gray
        case .starting: return Theme.amber
        case .connected: return Theme.green
        case .failed: return Theme.red
        }
    }

    private var statusTitle: String {
        switch sidecar.status {
        case .idle: return "Idle"
        case .starting: return "Starting local engine…"
        case .connected: return "Local engine connected"
        case .failed: return "Engine problem"
        }
    }

    private var statusDetail: String {
        switch sidecar.status {
        case .idle:
            return "Waiting to launch."
        case .starting:
            return "Launching the Node sidecar."
        case .connected(let version):
            let portText = sidecar.port.map(String.init) ?? "?"
            return "hon-sidecar v\(version) · 127.0.0.1:\(portText)"
        case .failed(let message):
            return message
        }
    }
}
