import Darwin
import Foundation
import LovartCredentialCore

private func emit(_ response: HelperResponse) {
    let encoder = JSONEncoder()
    let data = (try? encoder.encode(response))
        ?? Data(#"{"status":"error","errorCode":"invalid_payload"}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

let argument = CommandLine.arguments.dropFirst().first
if argument == "--version" {
    print("1")
    exit(EXIT_SUCCESS)
}

guard let raw = argument, let command = HelperCommand(rawValue: raw) else {
    emit(HelperResponse.invalidPayload())
    exit(EXIT_FAILURE)
}

let runner = HelperCommandRunner.production(parentPID: getppid())
let response = runner.run(command)
emit(response)
exit(response.status == "error" ? EXIT_FAILURE : EXIT_SUCCESS)
