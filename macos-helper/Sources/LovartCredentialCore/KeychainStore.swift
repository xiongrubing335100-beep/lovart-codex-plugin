import Foundation
import Security
import Darwin

public typealias SecurityAttributes = [String: Any]

public protocol SecurityCalling {
    func add(_ attributes: SecurityAttributes) -> OSStatus
    func update(_ query: SecurityAttributes, attributes: SecurityAttributes) -> OSStatus
    func copyMatching(_ query: SecurityAttributes) -> (OSStatus, Any?)
}

public final class SystemSecurityClient: SecurityCalling {
    public init() {}

    public func add(_ attributes: SecurityAttributes) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    public func update(_ query: SecurityAttributes, attributes: SecurityAttributes) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    public func copyMatching(_ query: SecurityAttributes) -> (OSStatus, Any?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }
}

public final class SystemKeychainStore: CredentialStoring {
    public static let defaultService = "com.lovart.codex.local"

    private let service: String
    private let account: String
    private let security: any SecurityCalling

    public init(
        service: String = SystemKeychainStore.defaultService,
        account: String = String(getuid()),
        security: any SecurityCalling = SystemSecurityClient()
    ) {
        self.service = service
        self.account = account
        self.security = security
    }

    public func save(_ credentials: LovartCredentials) throws {
        guard credentials.isValid else {
            throw HelperFailure.invalidPayload
        }

        let encodedCredentials = try JSONEncoder().encode(credentials)
        let attributes: SecurityAttributes = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: encodedCredentials,
        ]

        let addStatus = security.add(attributes)
        if addStatus == errSecSuccess {
            return
        }
        if addStatus == errSecDuplicateItem {
            let updateStatus = security.update(
                matchingAttributes(),
                attributes: [kSecValueData as String: encodedCredentials]
            )
            guard updateStatus == errSecSuccess else {
                throw failure(for: updateStatus, during: .write)
            }
            return
        }
        throw failure(for: addStatus, during: .write)
    }

    public func load() throws -> LovartCredentials {
        var query = matchingAttributes()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let (status, result) = security.copyMatching(query)
        guard status == errSecSuccess else {
            throw failure(for: status, during: .read)
        }
        guard let data = result as? Data,
              let credentials = try? JSONDecoder().decode(LovartCredentials.self, from: data)
        else {
            throw HelperFailure.invalidPayload
        }
        return credentials
    }

    public func status() throws -> CredentialStatus {
        var query = matchingAttributes()
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let (status, result) = security.copyMatching(query)
        guard status == errSecSuccess else {
            throw failure(for: status, during: .read)
        }
        guard let attributes = result as? SecurityAttributes else {
            throw HelperFailure.invalidPayload
        }

        let synchronizable = attributes[kSecAttrSynchronizable as String] as? Bool ?? false
        let accessible = attributes[kSecAttrAccessible as String] as? String
        return CredentialStatus(
            configured: true,
            synchronizable: synchronizable,
            accessibility: accessible == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
                ? "when_unlocked_this_device_only"
                : "unknown"
        )
    }

    private func matchingAttributes() -> SecurityAttributes {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private enum Operation {
        case read
        case write
    }

    private func failure(for status: OSStatus, during operation: Operation) -> HelperFailure {
        switch status {
        case errSecItemNotFound:
            .notConfigured
        case errSecInteractionNotAllowed, errSecAuthFailed:
            .keychainLocked
        default:
            switch operation {
            case .read:
                .keychainReadFailed(status)
            case .write:
                .keychainWriteFailed(status)
            }
        }
    }
}
