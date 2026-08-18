@preconcurrency import AppKit
import Darwin
import Foundation
import LovartCredentialCore

final class CredentialDialog: NSObject, CredentialPrompting {
    func prompt() -> CredentialPromptResult {
        dispatchPrecondition(condition: .onQueue(.main))
        return MainActor.assumeIsolated {
            CredentialDialogController().run()
        }
    }
}

@MainActor
private final class CredentialDialogMainMenu {
    private let application: NSApplication
    private let previousMainMenu: NSMenu?

    private init(application: NSApplication, previousMainMenu: NSMenu?) {
        self.application = application
        self.previousMainMenu = previousMainMenu
    }

    static func install(on application: NSApplication) -> CredentialDialogMainMenu {
        let previousMainMenu = application.mainMenu
        let mainMenu = NSMenu()
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        let pasteItem = NSMenuItem(
            title: "Paste",
            action: #selector(NSText.paste(_:)),
            keyEquivalent: "v"
        )
        pasteItem.keyEquivalentModifierMask = .command
        pasteItem.target = nil
        editMenu.addItem(pasteItem)
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        application.mainMenu = mainMenu
        return CredentialDialogMainMenu(
            application: application,
            previousMainMenu: previousMainMenu
        )
    }

    func restore() {
        application.mainMenu = previousMainMenu
    }
}

@MainActor
private final class CredentialDialogController: NSObject, NSWindowDelegate {
    private let accessKeyField = NSSecureTextField()
    private let secretKeyField = NSSecureTextField()
    private let errorLabel = NSTextField(labelWithString: "")
    private var result: CredentialPromptResult = .cancelled

    func run() -> CredentialPromptResult {
        let window = makeWindow()
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let installedMenu = CredentialDialogMainMenu.install(on: application)
        defer { installedMenu.restore() }
        application.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(accessKeyField)
        application.runModal(for: window)
        window.orderOut(nil)
        return result
    }

    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 230),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Configure Lovart Credentials"
        window.isReleasedWhenClosed = false
        window.delegate = self

        accessKeyField.placeholderString = "AK"
        secretKeyField.placeholderString = "SK"

        errorLabel.textColor = .systemRed
        errorLabel.maximumNumberOfLines = 2
        errorLabel.isHidden = true

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.keyEquivalent = "\u{1b}"
        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        saveButton.keyEquivalent = "\r"

        let buttonRow = NSStackView(views: [cancelButton, saveButton])
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .centerY
        buttonRow.distribution = .gravityAreas
        buttonRow.spacing = 10

        let form = NSGridView(views: [
            [NSTextField(labelWithString: "Access key (AK)"), accessKeyField],
            [NSTextField(labelWithString: "Secret key (SK)"), secretKeyField],
        ])
        form.column(at: 0).xPlacement = .trailing
        form.column(at: 1).xPlacement = .fill
        form.column(at: 1).width = 310
        form.rowSpacing = 12
        form.columnSpacing = 12

        let content = NSStackView(views: [form, errorLabel, buttonRow])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 16
        content.translatesAutoresizingMaskIntoConstraints = false

        let contentView = NSView()
        contentView.addSubview(content)
        window.contentView = contentView
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
            content.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),
            content.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -24),
            buttonRow.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            errorLabel.widthAnchor.constraint(equalTo: content.widthAnchor),
        ])
        return window
    }

    @objc private func cancel() {
        result = .cancelled
        NSApplication.shared.abortModal()
    }

    @objc private func save() {
        let accessKey = accessKeyField.stringValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let secretKey = secretKeyField.stringValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let credentials = LovartCredentials(accessKey: accessKey, secretKey: secretKey)
        guard credentials.isValid else {
            errorLabel.stringValue = "Enter both AK and SK before saving."
            errorLabel.isHidden = false
            return
        }

        errorLabel.isHidden = true
        result = .credentials(credentials)
        NSApplication.shared.stopModal()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        result = .cancelled
        NSApplication.shared.abortModal()
        return true
    }
}

extension HelperCommandRunner {
    static func production(parentPID: pid_t) -> HelperCommandRunner {
        HelperCommandRunner(
            caller: CallerValidator(
                processes: SystemProcessInspector(),
                startingPID: parentPID
            ),
            store: SystemKeychainStore(),
            prompt: CredentialDialog()
        )
    }
}
