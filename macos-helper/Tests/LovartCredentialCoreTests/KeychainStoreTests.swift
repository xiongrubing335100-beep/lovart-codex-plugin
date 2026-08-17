import Foundation
import Security
import Testing
@testable import LovartCredentialCore

private final class RecordingSecurityClient: SecurityCalling {
    var added: [SecurityAttributes] = []
    var updated: [(SecurityAttributes, SecurityAttributes)] = []
    var deleted: [SecurityAttributes] = []
    let addStatus: OSStatus
    let copyStatus: OSStatus
    let copyResult: Any?

    init(
        addStatus: OSStatus = errSecSuccess,
        copyStatus: OSStatus = errSecSuccess,
        copyResult: Any? = nil
    ) {
        self.addStatus = addStatus
        self.copyStatus = copyStatus
        self.copyResult = copyResult
    }

    func add(_ attributes: SecurityAttributes) -> OSStatus {
        added.append(attributes)
        return addStatus
    }

    func update(_ query: SecurityAttributes, attributes: SecurityAttributes) -> OSStatus {
        updated.append((query, attributes))
        return errSecSuccess
    }

    func copyMatching(_ query: SecurityAttributes) -> (OSStatus, Any?) {
        (copyStatus, copyResult)
    }
}

@Suite struct KeychainStoreTests {
    @Test func saveAddsOneLocalOnlyAtomicPayload() throws {
        let security = RecordingSecurityClient(addStatus: errSecSuccess)
        let store = SystemKeychainStore(account: "501", security: security)

        try store.save(LovartCredentials(accessKey: "ak-test", secretKey: "sk-test"))

        #expect(security.added.count == 1)
        let attributes = security.added[0]
        #expect(attributes[kSecAttrService as String] as? String == "com.lovart.codex.local")
        #expect(attributes[kSecAttrAccount as String] as? String == "501")
        #expect(attributes[kSecAttrSynchronizable as String] as? Bool == false)
        #expect(
            attributes[kSecAttrAccessible as String] as? String
                == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        )
        let data = try #require(attributes[kSecValueData as String] as? Data)
        #expect(try JSONDecoder().decode(LovartCredentials.self, from: data)
            == LovartCredentials(accessKey: "ak-test", secretKey: "sk-test"))
    }

    @Test func duplicateSaveUpdatesOneCombinedValue() throws {
        let security = RecordingSecurityClient(addStatus: errSecDuplicateItem)
        let store = SystemKeychainStore(account: "501", security: security)

        try store.save(LovartCredentials(accessKey: "ak-new", secretKey: "sk-new"))

        #expect(security.updated.count == 1)
        #expect(security.deleted.isEmpty)
    }

    @Test func loadMapsMissingAndLockedStatuses() {
        #expect(throws: HelperFailure.notConfigured) {
            try SystemKeychainStore(
                account: "501",
                security: RecordingSecurityClient(copyStatus: errSecItemNotFound)
            ).load()
        }
        #expect(throws: HelperFailure.keychainLocked) {
            try SystemKeychainStore(
                account: "501",
                security: RecordingSecurityClient(copyStatus: errSecInteractionNotAllowed)
            ).load()
        }
    }

    @Test func statusReportsNonSynchronizingThisDeviceOnlyAttributes() throws {
        let security = RecordingSecurityClient(
            copyStatus: errSecSuccess,
            copyResult: [
                kSecAttrSynchronizable as String: false,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
        )
        let status = try SystemKeychainStore(account: "501", security: security).status()
        #expect(status == CredentialStatus(
            configured: true,
            synchronizable: false,
            accessibility: "when_unlocked_this_device_only"
        ))
    }
}
