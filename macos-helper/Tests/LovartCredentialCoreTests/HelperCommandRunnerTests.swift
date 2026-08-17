import Foundation
import Security
import Testing
@testable import LovartCredentialCore

private extension LovartCredentials {
    static let fixture = LovartCredentials(accessKey: "ak-fixture", secretKey: "sk-fixture")
}

private struct AlwaysTrustedCaller: CallerValidating {
    func isTrusted() throws -> Bool { true }
}

private struct NeverTrustedCaller: CallerValidating {
    func isTrusted() throws -> Bool { false }
}

private struct UninspectableCaller: CallerValidating {
    func isTrusted() throws -> Bool { throw ProcessInspectionError.processUnavailable(700) }
}

private struct FixedPrompt: CredentialPrompting {
    let result: CredentialPromptResult

    func prompt() -> CredentialPromptResult { result }
}

private final class RecordingCredentialStore: CredentialStoring {
    private(set) var current: LovartCredentials?
    private(set) var saved: [LovartCredentials] = []
    var saveFailure: HelperFailure?
    var loadFailure: HelperFailure?
    var statusFailure: HelperFailure?

    init(existing: LovartCredentials? = nil) {
        current = existing
    }

    func save(_ credentials: LovartCredentials) throws {
        if let saveFailure { throw saveFailure }
        saved.append(credentials)
        current = credentials
    }

    func load() throws -> LovartCredentials {
        if let loadFailure { throw loadFailure }
        guard let current else { throw HelperFailure.notConfigured }
        return current
    }

    func status() throws -> CredentialStatus {
        if let statusFailure { throw statusFailure }
        guard current != nil else { throw HelperFailure.notConfigured }
        return CredentialStatus(
            configured: true,
            synchronizable: false,
            accessibility: "when_unlocked_this_device_only"
        )
    }
}

@Suite struct HelperCommandRunnerTests {
    @Test func configureSavesCompletePairWithoutReturningSecrets() throws {
        let store = RecordingCredentialStore()
        let runner = HelperCommandRunner(
            caller: AlwaysTrustedCaller(),
            store: store,
            prompt: FixedPrompt(result: .credentials(.fixture))
        )

        let response = runner.run(.configure)

        #expect(response.status == "ok")
        #expect(response.configured == true)
        #expect(response.errorCode == nil)
        #expect(response.credentials == nil)
        #expect(store.saved == [.fixture])
        let text = try #require(String(
            data: JSONEncoder().encode(response),
            encoding: .utf8
        ))
        #expect(!text.contains("ak-fixture"))
        #expect(!text.contains("sk-fixture"))
    }

    @Test func cancelledConfigureDoesNotWrite() {
        let store = RecordingCredentialStore(existing: .fixture)
        let runner = HelperCommandRunner(
            caller: AlwaysTrustedCaller(),
            store: store,
            prompt: FixedPrompt(result: .cancelled)
        )

        let response = runner.run(.configure)

        #expect(response.status == "cancelled")
        #expect(response.errorCode == .cancelled)
        #expect(store.saved.isEmpty)
        #expect(store.current == .fixture)
    }

    @Test func invalidPairPreservesExistingCredentials() {
        let store = RecordingCredentialStore(existing: .fixture)
        let invalid = LovartCredentials(accessKey: "ak-new", secretKey: " \n")
        let runner = HelperCommandRunner(
            caller: AlwaysTrustedCaller(),
            store: store,
            prompt: FixedPrompt(result: .credentials(invalid))
        )

        let response = runner.run(.configure)

        #expect(response.status == "error")
        #expect(response.errorCode == .invalidPayload)
        #expect(store.saved.isEmpty)
        #expect(store.current == .fixture)
    }

    @Test func readReturnsCredentialsOnlyForTrustedCaller() {
        let trusted = HelperCommandRunner(
            caller: AlwaysTrustedCaller(),
            store: RecordingCredentialStore(existing: .fixture),
            prompt: FixedPrompt(result: .cancelled)
        )
        #expect(trusted.run(.read).credentials == .fixture)

        let denied = HelperCommandRunner(
            caller: NeverTrustedCaller(),
            store: RecordingCredentialStore(existing: .fixture),
            prompt: FixedPrompt(result: .cancelled)
        )
        let response = denied.run(.read)
        #expect(response.status == "error")
        #expect(response.errorCode == .callerNotTrusted)
        #expect(response.credentials == nil)
    }

    @Test func callerInspectionFailureFailsClosed() {
        let response = HelperCommandRunner(
            caller: UninspectableCaller(),
            store: RecordingCredentialStore(existing: .fixture),
            prompt: FixedPrompt(result: .cancelled)
        ).run(.read)

        #expect(response.status == "error")
        #expect(response.errorCode == .callerNotTrusted)
        #expect(response.credentials == nil)
    }

    @Test func statusReturnsMetadataWithoutSecrets() throws {
        let response = HelperCommandRunner(
            caller: AlwaysTrustedCaller(),
            store: RecordingCredentialStore(existing: .fixture),
            prompt: FixedPrompt(result: .cancelled)
        ).run(.status)

        #expect(response.status == "ok")
        #expect(response.credentials == nil)
        #expect(response.credentialStatus == CredentialStatus(
            configured: true,
            synchronizable: false,
            accessibility: "when_unlocked_this_device_only"
        ))
        let text = try #require(String(
            data: JSONEncoder().encode(response),
            encoding: .utf8
        ))
        #expect(!text.contains("ak-fixture"))
        #expect(!text.contains("sk-fixture"))
    }

    @Test func mapsEveryHelperFailureToStableErrorResponse() {
        let cases: [(HelperFailure, HelperErrorCode, Int32?)] = [
            (.notConfigured, .notConfigured, nil),
            (.keychainLocked, .keychainLocked, nil),
            (.invalidPayload, .invalidPayload, nil),
            (.keychainWriteFailed(errSecParam), .keychainWriteFailed, errSecParam),
            (.keychainReadFailed(errSecDecode), .keychainReadFailed, errSecDecode),
        ]

        for (failure, errorCode, osStatus) in cases {
            let store = RecordingCredentialStore(existing: .fixture)
            store.loadFailure = failure
            let response = HelperCommandRunner(
                caller: AlwaysTrustedCaller(),
                store: store,
                prompt: FixedPrompt(result: .cancelled)
            ).run(.read)

            #expect(response.status == "error")
            #expect(response.errorCode == errorCode)
            #expect(response.osStatus == osStatus)
            #expect(response.credentials == nil)
        }
    }

    @Test func invalidPayloadFactoryContainsNoCredentialFields() throws {
        let response = HelperResponse.invalidPayload()
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        )

        #expect(response.status == "error")
        #expect(response.errorCode == .invalidPayload)
        #expect(object["credentials"] == nil)
        #expect(object["credentialStatus"] == nil)
    }
}
