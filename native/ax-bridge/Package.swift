// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "we-ax",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "we-ax", targets: ["weax"])
    ],
    targets: [
        .executableTarget(
            name: "weax",
            path: "Sources/weax"
        )
    ]
)
