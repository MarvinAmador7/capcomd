#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit

/// The goal branch in a composer (capability runs.goal_branch): no naming step. A quiet line with the name the run's
/// reviewed work will land on (the daemon's suggestion for the goal, in the repository's own branch convention, until the
/// person renames it); a click turns it into a field. Return keeps the edit, Escape puts it back, leaving the field keeps
/// it too; an emptied name goes back to the suggestion (`onCommit("")`). Nothing shows before there is a name (no goal
/// yet). Orange when the daemon refused the name.
package struct GoalBranchChip: View {
  /// The name Start will use; nil: none yet, nothing shows.
  let name: String?
  /// What an emptied field goes back to: the field's placeholder while editing.
  let suggestion: String?
  /// The daemon said this name can't be used (its sentence is under the row).
  let refused: Bool
  /// The glyph before the name: the branch mark, or the desk's → after its base chip.
  let icon: String
  let onCommit: (String) -> Void

  @State private var editing = false
  @State private var draft = ""
  @State private var hovering = false
  @FocusState private var focused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  package init(name: String?, suggestion: String?, refused: Bool, icon: String = "arrow.triangle.branch", onCommit: @escaping (String) -> Void) {
    self.name = name; self.suggestion = suggestion; self.refused = refused; self.icon = icon; self.onCommit = onCommit
  }

  package var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Goal.nameRadius, style: .continuous)
    Group {
      if editing { field(shape).transition(.opacity) }
      else if let name { label(name, shape).transition(.opacity) }
    }
    .animation(reduceMotion ? Theme.Motion.reduced : Theme.Motion.fast, value: editing)
    .onChange(of: name == nil) { _, gone in if gone { editing = false } }
  }

  private func label(_ name: String, _ shape: RoundedRectangle) -> some View {
    Button(action: begin) {
      HStack(spacing: Theme.Goal.nameGap) {
        Image(systemName: icon).font(Theme.Goal.nameIcon).accessibilityHidden(true)
        Text(verbatim: name).font(Theme.Goal.nameFont).lineLimit(1).truncationMode(.middle)
      }
      .foregroundStyle(refused ? Theme.Setup.orange : Theme.Goal.nameText)
      .padding(.horizontal, Theme.Goal.namePadding).frame(height: Theme.Goal.nameHeight)
      .background(shape.fill(Theme.Goal.nameHover).opacity(hovering ? 1 : 0))
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .onHover { h in withAnimation(Theme.Motion.fast) { hovering = h } }
    .help("Reviewed work lands on \(name). Click to rename it.")
    .accessibilityLabel("Goal branch").accessibilityValue(name).accessibilityHint("Renames the branch the work lands on")
  }

  private func field(_ shape: RoundedRectangle) -> some View {
    HStack(spacing: Theme.Goal.nameGap) {
      Image(systemName: icon).font(Theme.Goal.nameIcon).foregroundStyle(Theme.Goal.nameText).accessibilityHidden(true)
      TextField("", text: $draft, prompt: suggestion.map { Text(verbatim: $0).foregroundStyle(Theme.Setup.noteText) })
        .textFieldStyle(.plain).font(Theme.Goal.nameFont).foregroundStyle(Theme.Setup.valueText)
        .focused($focused)
        .onSubmit(commit)
        .onKeyPress(.escape) { cancel(); return .handled }
        .onChange(of: focused) { _, f in if !f && editing { commit() } }
        .accessibilityLabel("Goal branch")
    }
    .padding(.horizontal, Theme.Goal.namePadding).frame(height: Theme.Goal.nameHeight)
    .frame(minWidth: Theme.Goal.fieldMinWidth, maxWidth: Theme.Goal.fieldMaxWidth, alignment: .leading)
    .background(shape.fill(Theme.Setup.fieldFill))
    .overlay(shape.strokeBorder(refused ? Theme.Setup.orange : Theme.Setup.fieldStroke, lineWidth: 0.5))
    .onAppear { DispatchQueue.main.async { focused = true } }
  }

  private func begin() { draft = name ?? ""; editing = true }
  /// Return or leaving the field: a changed name is the person's (empty: the suggestion again); an unchanged one stays
  /// whatever it was, so a name that follows the suggestion keeps following it.
  private func commit() {
    guard editing else { return }
    editing = false
    let t = draft.trimmingCharacters(in: .whitespaces)
    if t != (name ?? "") { onCommit(t) }
  }
  private func cancel() { editing = false }
}
#endif
