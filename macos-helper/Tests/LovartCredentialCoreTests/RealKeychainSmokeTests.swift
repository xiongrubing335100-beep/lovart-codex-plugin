import Foundation
import Security
import Testing
import Darwin
@testable import LovartCredentialCore

@Test(.enabled(if: ProcessInfo.processInfo.environment["LOVART_RUN_KEYCHAIN_SMOKE"] == "1"))
func realKeychainRoundTripUsesIsolatedLocalOnlyItem() throws {
    let service = "com.lovart.codex.local.test.\(UUID().uuidString)"
    let account = String(getuid())
    defer {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    let store = SystemKeychainStore(service: service, account: account)
    let dummy = LovartCredentials(accessKey: "ak-dummy-smoke", secretKey: "sk-dummy-smoke")
    try store.save(dummy)
    #expect(try store.load() == dummy)
    #expect(try store.status() == CredentialStatus(
        configured: true,
        synchronizable: false,
        accessibility: "when_unlocked_this_device_only"
    ))
}
