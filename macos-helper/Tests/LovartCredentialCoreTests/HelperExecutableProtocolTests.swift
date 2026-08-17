import Foundation
import Testing

private struct HelperExecution {
    let exitStatus: Int32
    let stdout: Data
    let stderr: Data
}

private func runHelper(arguments: [String]) throws -> HelperExecution {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let process = Process()
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = packageRoot
        .appendingPathComponent(".build/debug/lovart-credential-helper")
    process.arguments = arguments
    process.standardOutput = stdout
    process.standardError = stderr

    try process.run()
    process.waitUntilExit()
    return HelperExecution(
        exitStatus: process.terminationStatus,
        stdout: stdout.fileHandleForReading.readDataToEndOfFile(),
        stderr: stderr.fileHandleForReading.readDataToEndOfFile()
    )
}

@Suite struct HelperExecutableProtocolTests {
    @Test func versionWritesExactProtocolVersionToStdout() throws {
        let execution = try runHelper(arguments: ["--version"])

        #expect(execution.exitStatus == 0)
        #expect(execution.stdout == Data("1\n".utf8))
        #expect(execution.stderr.isEmpty)
    }

    @Test func invalidCommandWritesOneCompactJSONErrorToStdout() throws {
        let execution = try runHelper(arguments: ["invalid-command"])

        #expect(execution.exitStatus == 1)
        #expect(execution.stderr.isEmpty)
        let text = try #require(String(data: execution.stdout, encoding: .utf8))
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        #expect(lines.count == 2)
        #expect(lines[1].isEmpty)
        #expect(!lines[0].contains(where: { $0.isWhitespace }))
        let object = try #require(
            JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: String]
        )
        #expect(object == [
            "status": "error",
            "errorCode": "invalid_payload",
        ])
    }
}
