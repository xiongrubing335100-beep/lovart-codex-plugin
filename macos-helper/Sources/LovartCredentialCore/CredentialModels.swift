import Foundation

public struct LovartCredentials: Codable, Equatable, Sendable {
    public let accessKey: String
    public let secretKey: String

    public init(accessKey: String, secretKey: String) {
        self.accessKey = accessKey
        self.secretKey = secretKey
    }

    public var isValid: Bool {
        !accessKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !secretKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public enum HelperErrorCode: String, Codable, Sendable {
    case notConfigured = "not_configured"
    case cancelled
    case keychainLocked = "keychain_locked"
    case callerNotTrusted = "caller_not_trusted"
    case helperMissingOrInvalid = "helper_missing_or_invalid"
    case keychainWriteFailed = "keychain_write_failed"
    case keychainReadFailed = "keychain_read_failed"
    case invalidPayload = "invalid_payload"
}

public enum HelperFailure: Error, Equatable {
    case notConfigured
    case keychainLocked
    case invalidPayload
    case keychainWriteFailed(OSStatus)
    case keychainReadFailed(OSStatus)
}

public struct CredentialStatus: Codable, Equatable, Sendable {
    public let configured: Bool
    public let synchronizable: Bool
    public let accessibility: String

    public init(configured: Bool, synchronizable: Bool, accessibility: String) {
        self.configured = configured
        self.synchronizable = synchronizable
        self.accessibility = accessibility
    }
}

public protocol CredentialStoring {
    func save(_ credentials: LovartCredentials) throws
    func load() throws -> LovartCredentials
    func status() throws -> CredentialStatus
}
