#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

/// v5-a-final `.in`: "Start a project…" at the top of the panel (⌘K). Return starts a run on the goal (POST /v1/runs);
/// Esc clears, then leaves the field.
struct StartProjectField: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @FocusState private var focused: Bool
  @State private var goal = ""

  var body: some View {
    let state = model.startState
    let starting = state == .starting
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: Theme.Composer.panelGap) {
        Image(systemName: "plus").font(Theme.Composer.plusIcon).foregroundStyle(Theme.Composer.plusText)
          .accessibilityHidden(true)
        // macOS draws a TextField prompt in its own tertiary grey; the mockup's placeholder is white 40 %.
        TextField("", text: $goal)
          .textFieldStyle(.plain).font(Theme.Composer.panelFont).foregroundStyle(Theme.Composer.text)
          .background(alignment: .leading) {
            if goal.isEmpty { Text("Start a project…").font(Theme.Composer.panelFont).foregroundStyle(Theme.Composer.placeholder).allowsHitTesting(false) }
          }
          .focused($focused).disabled(starting)
          .onSubmit(submit)
          .onKeyPress(.escape) {
            if !goal.isEmpty { goal = ""; model.clearStart(); return .handled }
            focused = false; return .handled
          }
          .accessibilityLabel("Start a project")
        if starting {
          ProgressView().controlSize(.small).accessibilityLabel("Starting")
        } else if !focused {
          Text(verbatim: "⌘K").font(Theme.Composer.kbdFont).foregroundStyle(Theme.Composer.kbdText)
            .padding(Theme.Composer.kbdPadding)
            .overlay(RoundedRectangle(cornerRadius: Theme.Composer.kbdRadius, style: .continuous).strokeBorder(Theme.Composer.kbdStroke, lineWidth: 0.5))
            .accessibilityHidden(true)
        }
      }
      .padding(.horizontal, Theme.Composer.panelPadding)
      .frame(height: Theme.Composer.panelHeight)
      .background {
        let shape = RoundedRectangle(cornerRadius: Theme.Composer.panelRadius, style: .continuous)
        ControlSurface(shape: shape, fallback: focused ? Theme.Composer.focusedFill : Theme.Composer.fill)
          .overlay(shape.strokeBorder(Theme.Composer.focusedStroke, lineWidth: Theme.Composer.focusedStrokeWidth).opacity(focused ? 1 : 0))
          .background(shape.stroke(Theme.Composer.ring, lineWidth: Theme.Composer.ringWidth).padding(-Theme.Composer.ringWidth / 2).opacity(focused ? 1 : 0))
      }
      .contentShape(Rectangle())
      .onTapGesture { focused = true }
      .background { keyboardOnly("k") { focused = true } }
      .animation(Theme.Motion.fast, value: focused)
      // The panel opens with nothing focused (idle look, ⌘K hint); ⌘K or a click focuses the field.
      .defaultFocus($focused, false)
      // AppKit makes the first text field first responder whenever the panel window becomes key; undo that on open.
      .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
        DispatchQueue.main.async { if goal.isEmpty { focused = false; NSApp.keyWindow?.makeFirstResponder(nil) } }
      }
      line(state)
    }
  }

  @ViewBuilder private func line(_ state: StartState) -> some View {
    switch state {
    case .failed(let m), .needsRepo(let m):
      Text(verbatim: m).font(Theme.Composer.errorFont).foregroundStyle(Theme.red).lineLimit(2)
        .padding(.horizontal, Theme.Composer.panelPadding).padding(.top, 6)
        .transition(.opacity)
    case .started:
      Text("Started. It shows up below in a moment.").font(Theme.Composer.errorFont).foregroundStyle(Theme.Composer.kbdText)
        .padding(.horizontal, Theme.Composer.panelPadding).padding(.top, 6)
        .transition(.opacity)
        .task { try? await Task.sleep(for: .seconds(4)); model.clearStart() }
    default: EmptyView()
    }
  }

  private func submit() {
    let g = goal
    guard !g.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    Task { if await model.startRun(g) { goal = ""; focused = false } }
  }
}

/// Asks for a project checkout (a folder `capcomd setup project` ran in) when the daemon has no default repository.
enum ProjectFolderPicker {
  @MainActor static func choose() -> String? {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
    p.prompt = "Use This Project"; p.message = "capcomd has no default repository. Choose the project's checkout."
    NSApp.activate(ignoringOtherApps: true)
    return p.runModal() == .OK ? p.url?.path : nil
  }
}
#endif
