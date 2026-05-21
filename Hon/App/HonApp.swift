import SwiftUI

@main
struct HonApp: App {
    @StateObject private var sidecar = SidecarManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(sidecar)
                .task { await sidecar.start() }
        }
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
