import Foundation

public enum CredentialPromptResult: Equatable, Sendable {
    case cancelled
    case credentials(LovartCredentials)
}

public protocol CredentialPrompting {
    func prompt() -> CredentialPromptResult
}

public enum HelperCommand: String, Sendable {
    case configure
    case read
    case status
}

public struct HelperResponse: Codable, Sendable {
    public let status: String
    public let configured: Bool?
    public let errorCode: HelperErrorCode?
    public let osStatus: Int32?
    public let credentials: LovartCredentials?
    public let credentialStatus: CredentialStatus?

    public init(
        status: String,
        configured: Bool? = nil,
        errorCode: HelperErrorCode? = nil,
        osStatus: Int32? = nil,
        credentials: LovartCredentials? = nil,
        credentialStatus: CredentialStatus? = nil
    ) {
        self.status = status
        self.configured = configured
        self.errorCode = errorCode
        self.osStatus = osStatus
        self.credentials = credentials
        self.credentialStatus = credentialStatus
    }

    public static func invalidPayload() -> HelperResponse {
        HelperResponse(status: "error", errorCode: .invalidPayload)
    }
}

public struct HelperCommandRunner {
    private let caller: any CallerValidating
    private let store: any CredentialStoring
    private let prompt: any CredentialPrompting

    public init(
        caller: any CallerValidating,
        store: any CredentialStoring,
        prompt: any CredentialPrompting
    ) {
        self.caller = caller
        self.store = store
        self.prompt = prompt
    }

    public func run(_ command: HelperCommand) -> HelperResponse {
        do {
            guard try caller.isTrusted() else {
                return HelperResponse(status: "error", errorCode: .callerNotTrusted)
            }
        } catch {
            return HelperResponse(status: "error", errorCode: .callerNotTrusted)
        }

        switch command {
        case .configure:
            return configure()
        case .read:
            return read()
        case .status:
            return status()
        }
    }

    private func configure() -> HelperResponse {
        switch prompt.prompt() {
        case .cancelled:
            return HelperResponse(status: "cancelled", errorCode: .cancelled)
        case .credentials(let credentials):
            guard credentials.isValid else {
                return .invalidPayload()
            }
            do {
                try store.save(credentials)
                return HelperResponse(status: "ok", configured: true)
            } catch {
                return response(for: error)
            }
        }
    }

    private func read() -> HelperResponse {
        do {
            let credentials = try store.load()
            return HelperResponse(
                status: "ok",
                configured: true,
                credentials: credentials
            )
        } catch {
            return response(for: error)
        }
    }

    private func status() -> HelperResponse {
        do {
            let credentialStatus = try store.status()
            return HelperResponse(status: "ok", credentialStatus: credentialStatus)
        } catch {
            return response(for: error)
        }
    }

    private func response(for error: any Error) -> HelperResponse {
        guard let failure = error as? HelperFailure else {
            return .invalidPayload()
        }
        switch failure {
        case .notConfigured:
            return HelperResponse(
                status: "error",
                configured: false,
                errorCode: .notConfigured
            )
        case .keychainLocked:
            return HelperResponse(status: "error", errorCode: .keychainLocked)
        case .invalidPayload:
            return .invalidPayload()
        case .keychainWriteFailed(let status):
            return HelperResponse(
                status: "error",
                errorCode: .keychainWriteFailed,
                osStatus: status
            )
        case .keychainReadFailed(let status):
            return HelperResponse(
                status: "error",
                errorCode: .keychainReadFailed,
                osStatus: status
            )
        }
    }
}
