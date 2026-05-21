import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var sidecar: SidecarManager
    @StateObject private var store = FinanceStore()

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            content
        }
        .frame(minWidth: 860, idealWidth: 1040, minHeight: 640, idealHeight: 780)
        .preferredColorScheme(.dark)
        .onOpenURL { url in
            // SnapTrade's portal redirects here (hon://snaptrade-linked) once a
            // brokerage is connected — refresh so the new account shows up.
            if url.scheme == "hon" {
                Task { await store.refresh() }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch sidecar.status {
        case .connected:
            DashboardView()
                .environmentObject(store)
                .task {
                    if let client = sidecar.makeClient() {
                        await store.connect(client)
                    }
                }
        case .idle, .starting, .failed:
            EngineStatusView()
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(SidecarManager())
}
