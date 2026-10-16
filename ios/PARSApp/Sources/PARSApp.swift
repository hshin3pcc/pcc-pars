import SwiftUI

@main
struct PARSAppMain: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup { RootView().environmentObject(model) }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        TabView(selection: $model.tab) {
            WebViewContainer(webView: model.attendanceWeb)
                .ignoresSafeArea(edges: .top)
                .tabItem { Label("Attendance", systemImage: "checklist") }
                .tag(Tab.attendance)

            NavigationStack {
                WebViewContainer(webView: model.parsWeb)
                    .navigationTitle("PARS")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItemGroup(placement: .navigationBarLeading) {
                            Button { model.parsWeb.goBack() } label: { Image(systemName: "chevron.left") }
                            Button { model.parsWeb.reload() } label: { Image(systemName: "arrow.clockwise") }
                        }
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button { model.loadParsHome() } label: { Image(systemName: "house") }
                        }
                    }
            }
            .tabItem { Label("PARS", systemImage: "globe") }
            .tag(Tab.pars)
        }
    }
}
