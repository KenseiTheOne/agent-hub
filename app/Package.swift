// swift-tools-version: 6.0
// The Agent Hub shell: a menu bar icon + a panel. Builds without Xcode: `swift build -c release`,
// the `.app` — via ../scripts/bundle.sh. The connection to the daemon is HTTP/1.1 over a Unix socket (AsyncHTTPClient,
// http+unix:// URLs), because URLSession can't do Unix sockets.
import PackageDescription

let package = Package(
    name: "AgentHub",
    // macOS 26 (Tahoe): the UI follows the approved prototype — glass (`.glassEffect`, `.buttonStyle(.glass)`).
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "AgentHub", targets: ["AgentHub"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.21.0"),
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.100.0"),
    ],
    targets: [
        // Models per docs/api.md, SSE parsing, the socket client, the state store — without AppKit, testable.
        .target(
            name: "AgentHubKit",
            dependencies: [
                .product(name: "AsyncHTTPClient", package: "async-http-client"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
            ]
        ),
        // UI: MenuBarExtra, panel, NSAlert.
        .executableTarget(
            name: "AgentHub",
            dependencies: ["AgentHubKit"]
        ),
        // Tests: models and the store; stream reconnection — on a daemon double (HTTP over a Unix socket, NIO).
        .testTarget(
            name: "AgentHubKitTests",
            dependencies: [
                "AgentHubKit",
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
            ]
        ),
    ]
)
