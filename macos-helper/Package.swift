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
            dependencies: ["LovartCredentialCore"],
            swiftSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                ])
            ],
            linkerSettings: [
                .linkedFramework("Testing"),
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/usr/lib",
                ]),
            ]
        ),
    ]
)
