import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var sidecar: SidecarManager

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            content
        }
        .frame(minWidth: 960, idealWidth: 1240, minHeight: 680, idealHeight: 820)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        // Once the engine is up, the whole UI is the web dashboard in a
        // WKWebView; the native screen is only the engine bring-up state.
        if case .connected = sidecar.status, let url = sidecar.dashboardURL() {
            WebDashboardView(url: url)
        } else {
            EngineStatusView()
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(SidecarManager())
}
