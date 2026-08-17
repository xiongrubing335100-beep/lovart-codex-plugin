import Darwin
import Foundation
import Security

public struct CodeSignatureIdentity: Equatable, Sendable {
    public let identifier: String
    public let teamIdentifier: String

    public init(identifier: String, teamIdentifier: String) {
        self.identifier = identifier
        self.teamIdentifier = teamIdentifier
    }

    public static let unsigned = CodeSignatureIdentity(identifier: "", teamIdentifier: "")
}

public enum ProcessInspectionError: Error, Equatable {
    case processUnavailable(pid_t)
    case signatureInspectionFailed(pid_t, OSStatus)
}

public protocol ProcessInspecting {
    func parentPID(of pid: pid_t) throws -> pid_t
    func signatureIdentity(of pid: pid_t) throws -> CodeSignatureIdentity
}

public protocol CallerValidating {
    func isTrusted() throws -> Bool
}

public struct CallerValidator: CallerValidating {
    private static let team = "2DC432GLL2"
    private static let identifiers = Set(["com.openai.codex", "codex"])

    private let processes: any ProcessInspecting
    private let startingPID: pid_t

    public init(
        processes: any ProcessInspecting,
        startingPID: pid_t = getppid()
    ) {
        self.processes = processes
        self.startingPID = startingPID
    }

    public func isTrusted() throws -> Bool {
        try isTrusted(startingAt: startingPID)
    }

    public func isTrusted(startingAt pid: pid_t) throws -> Bool {
        var current = pid
        var visited = Set<pid_t>()
        while current > 1 && visited.insert(current).inserted {
            let identity = try processes.signatureIdentity(of: current)
            if identity.teamIdentifier == Self.team
                && Self.identifiers.contains(identity.identifier) {
                return true
            }
            current = try processes.parentPID(of: current)
        }
        return false
    }
}

public struct SystemProcessInspector: ProcessInspecting {
    public init() {}

    public func parentPID(of pid: pid_t) throws -> pid_t {
        var info = proc_bsdinfo()
        let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
        let copiedSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedSize)
        guard copiedSize == expectedSize else {
            throw ProcessInspectionError.processUnavailable(pid)
        }
        return pid_t(info.pbi_ppid)
    }

    public func signatureIdentity(of pid: pid_t) throws -> CodeSignatureIdentity {
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        var code: SecCode?
        let guestStatus = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
        if guestStatus == errSecCSUnsigned {
            return .unsigned
        }
        guard guestStatus == errSecSuccess, let code else {
            throw ProcessInspectionError.signatureInspectionFailed(pid, guestStatus)
        }

        var staticCode: SecStaticCode?
        let staticCodeStatus = SecCodeCopyStaticCode(code, [], &staticCode)
        if staticCodeStatus == errSecCSUnsigned {
            return .unsigned
        }
        guard staticCodeStatus == errSecSuccess, let staticCode else {
            throw ProcessInspectionError.signatureInspectionFailed(pid, staticCodeStatus)
        }

        var signingInformation: CFDictionary?
        let informationStatus = SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &signingInformation
        )
        if informationStatus == errSecCSUnsigned {
            return .unsigned
        }
        guard informationStatus == errSecSuccess,
              let information = signingInformation as? [String: Any]
        else {
            throw ProcessInspectionError.signatureInspectionFailed(pid, informationStatus)
        }

        guard let identifier = information[kSecCodeInfoIdentifier as String] as? String,
              let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String
        else {
            return .unsigned
        }
        return CodeSignatureIdentity(identifier: identifier, teamIdentifier: teamIdentifier)
    }
}
