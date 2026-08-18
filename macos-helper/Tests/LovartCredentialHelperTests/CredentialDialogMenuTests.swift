@preconcurrency import AppKit
import Testing
@testable import LovartCredentialHelper

@MainActor
@Suite(.serialized)
struct CredentialDialogMenuTests {
    @Test
    func promptDispatchesCommandVToSecureFirstResponderAndRestoresMainMenu() {
        let application = NSApplication.shared
        let previousActivationPolicy = application.activationPolicy()
        let previousMenu = application.mainMenu
        let sentinelMenu = NSMenu(title: "Sentinel")
        let pasteboard = NSPasteboard.general
        let previousPasteboard = snapshot(pasteboard)
        application.mainMenu = sentinelMenu

        defer {
            restore(previousPasteboard, to: pasteboard)
            application.mainMenu = previousMenu
            application.setActivationPolicy(previousActivationPolicy)
        }

        pasteboard.clearContents()
        #expect(pasteboard.setString("synthetic-ak-value", forType: .string))

        var hadSecureFirstResponder = false
        var commandHandled = false
        var editorValue: String?
        let timer = Timer(timeInterval: 0.01, repeats: false) { _ in
            MainActor.assumeIsolated {
                if let window = application.modalWindow,
                   let contentView = window.contentView,
                   let fieldEditor = window.firstResponder as? NSText
                {
                    hadSecureFirstResponder = Self.secureTextFields(in: contentView)
                        .contains { $0.currentEditor() === fieldEditor }
                    if let event = NSEvent.keyEvent(
                        with: .keyDown,
                        location: .zero,
                        modifierFlags: .command,
                        timestamp: 0,
                        windowNumber: window.windowNumber,
                        context: nil,
                        characters: "v",
                        charactersIgnoringModifiers: "v",
                        isARepeat: false,
                        keyCode: 9
                    ) {
                        commandHandled = application.mainMenu?.performKeyEquivalent(with: event) == true
                    }
                    editorValue = fieldEditor.string
                }
                application.abortModal()
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)

        let result = CredentialDialog().prompt()

        #expect(result == .cancelled)
        #expect(hadSecureFirstResponder)
        #expect(commandHandled)
        #expect(editorValue == "synthetic-ak-value")
        #expect(application.mainMenu === sentinelMenu)
    }

    private static func secureTextFields(in view: NSView) -> [NSSecureTextField] {
        let current = (view as? NSSecureTextField).map { [$0] } ?? []
        return current + view.subviews.flatMap(secureTextFields(in:))
    }

    private func snapshot(_ pasteboard: NSPasteboard) -> [[NSPasteboard.PasteboardType: Data]] {
        pasteboard.pasteboardItems?.map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type, $0) }
            })
        } ?? []
    }

    private func restore(
        _ snapshot: [[NSPasteboard.PasteboardType: Data]],
        to pasteboard: NSPasteboard
    ) {
        pasteboard.clearContents()
        let items = snapshot.map { values in
            let item = NSPasteboardItem()
            for (type, data) in values {
                item.setData(data, forType: type)
            }
            return item
        }
        if !items.isEmpty {
            pasteboard.writeObjects(items)
        }
    }
}
