import Darwin
import Testing
@testable import LovartCredentialCore

private enum FakeInspectionFailure: Error {
    case unavailable
}

private struct FakeProcessInspector: ProcessInspecting {
    let parents: [pid_t: pid_t]
    let identities: [pid_t: CodeSignatureIdentity]
    let failingPIDs: Set<pid_t>

    init(
        parents: [pid_t: pid_t] = [:],
        identities: [pid_t: CodeSignatureIdentity] = [:],
        failingPIDs: Set<pid_t> = []
    ) {
        self.parents = parents
        self.identities = identities
        self.failingPIDs = failingPIDs
    }

    static let failing = FakeProcessInspector(failingPIDs: [700])

    func parentPID(of pid: pid_t) throws -> pid_t {
        guard !failingPIDs.contains(pid), let parent = parents[pid] else {
            throw FakeInspectionFailure.unavailable
        }
        return parent
    }

    func signatureIdentity(of pid: pid_t) throws -> CodeSignatureIdentity {
        guard !failingPIDs.contains(pid) else {
            throw FakeInspectionFailure.unavailable
        }
        return identities[pid, default: .unsigned]
    }
}

@Suite struct CallerValidatorTests {
    @Test func trustsOpenAICodexAncestor() throws {
        let processes = FakeProcessInspector(
            parents: [700: 600, 600: 500, 500: 1],
            identities: [
                700: .unsigned,
                600: CodeSignatureIdentity(identifier: "codex", teamIdentifier: "2DC432GLL2"),
            ]
        )

        #expect(try CallerValidator(processes: processes).isTrusted(startingAt: 700))
    }

    @Test func trustsOpenAICodexBundleIdentifier() throws {
        let processes = FakeProcessInspector(
            parents: [700: 1],
            identities: [
                700: CodeSignatureIdentity(
                    identifier: "com.openai.codex",
                    teamIdentifier: "2DC432GLL2"
                ),
            ]
        )

        #expect(try CallerValidator(processes: processes).isTrusted(startingAt: 700))
    }

    @Test func rejectsWrongTeamPathMatchAndInspectionFailure() throws {
        let wrongTeam = FakeProcessInspector(
            parents: [700: 600, 600: 1],
            identities: [
                600: CodeSignatureIdentity(identifier: "codex", teamIdentifier: "OTHERTEAM"),
            ]
        )
        #expect(try !CallerValidator(processes: wrongTeam).isTrusted(startingAt: 700))
        #expect(throws: FakeInspectionFailure.self) {
            try CallerValidator(processes: FakeProcessInspector.failing)
                .isTrusted(startingAt: 700)
        }
    }

    @Test func rejectsCorrectTeamWithUnapprovedIdentifier() throws {
        let processes = FakeProcessInspector(
            parents: [700: 1],
            identities: [
                700: CodeSignatureIdentity(
                    identifier: "com.example.codex",
                    teamIdentifier: "2DC432GLL2"
                ),
            ]
        )

        #expect(try !CallerValidator(processes: processes).isTrusted(startingAt: 700))
    }

    @Test func cyclicAncestryFailsClosed() throws {
        let processes = FakeProcessInspector(parents: [700: 600, 600: 700])

        #expect(try !CallerValidator(processes: processes).isTrusted(startingAt: 700))
    }
}
