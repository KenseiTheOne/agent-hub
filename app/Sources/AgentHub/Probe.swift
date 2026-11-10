import AgentHubKit
import Foundation

/// Headless diagnostics: the same executable from AgentHub.app talks to the daemon, prints the response and exits.
/// The daemon determines the class from the process path and signature, so this checks who it thinks this exact build is.
///
///   AgentHub.app/Contents/MacOS/AgentHub --probe-peer                  → GET /peer
///   AgentHub.app/Contents/MacOS/AgentHub --probe-action <id> [--args JSON]   (debug build only)
///                                                                      → POST /actions/<id> without a confirmation token
///
/// `--probe-action` exists **only in the debug build** (`swift build`, not `-c release`/bundle.sh). The pinned
/// build doesn't have it: any process of the same user could launch the AgentHub.app binary with this flag
/// and run an "immediate"-level action as the app class (e.g. `session.respond` — approve a card
/// without a human). Besides, the daemon doesn't treat a process with `--probe-action` in argv as app (peer:app-probe).
/// Probe **never gives** confirmation: on 428 it prints the core's text and exits (consent comes only from a human in an NSAlert).
enum Probe {
    static var wanted: Bool {
        let a = CommandLine.arguments
        #if DEBUG
        return a.contains("--probe-peer") || a.contains("--probe-action")
        #else
        return a.contains("--probe-peer")
        #endif
    }

    static func run() -> Never {
        let a = CommandLine.arguments
        Task.detached {
            let client = HubClient(socketPath: HubPaths.socketPath())
            var code: Int32 = 0
            do {
                if a.contains("--probe-peer") {
                    let p = try await client.peer()
                    print("peer class=\(p.class) reason=\(p.reason ?? "null")")
                    code = p.isApp ? 0 : 3
                }
                #if DEBUG
                if let i = a.firstIndex(of: "--probe-action"), i + 1 < a.count {
                    var args: [String: JSONValue]?
                    if let j = a.firstIndex(of: "--args"), j + 1 < a.count,
                       case .object(let o)? = try? JSONDecoder().decode(JSONValue.self, from: Data(a[j + 1].utf8)) { args = o }
                    switch try await client.invoke(a[i + 1], args: args) {
                    case .done(let ok, let result):
                        print("action status=200 ok=\(ok) result=\(result?.display ?? "null")")
                        code = ok ? 0 : 1
                    case .needsConfirm(let r):
                        print("action status=428 level=\(r.level.rawValue) text=\(r.text) cost=\(r.cost ?? "null") (confirmation not sent)")
                        code = 4
                    case .denied(let status, let c):
                        print("action status=\(status) error=\(c)")
                        code = 2
                    }
                }
                #endif
            } catch {
                print("error=\((error as? LocalizedError)?.errorDescription ?? String(describing: error))")
                code = 5
            }
            fflush(stdout)
            exit(code)
        }
        dispatchMain()
    }
}
