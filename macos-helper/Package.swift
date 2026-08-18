// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LovartCredentialHelper",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "LovartCredentialCore", targets: ["LovartCredentialCore"]),
        .executable(name: "lovart-credential-helper", targets: ["LovartCredentialHelper"]),
    ],
    targets: [
        .target(
            name: "LovartCredentialCore",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "LovartCredentialHelper",
            dependencies: ["LovartCredentialCore"],
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("Security")]
        ),
        .testTarget(
            name: "LovartCredentialCoreTests",
            dependencies: ["LovartCredentialCore"]
        ),
        .testTarget(
            name: "LovartCredentialHelperTests",
            dependencies: ["LovartCredentialHelper"]
        ),
    ]
)
