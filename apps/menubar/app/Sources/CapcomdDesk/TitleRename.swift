#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdUI

/// Renaming an agent in place (capability agents.title): a double-click on its crew tab or its column header turns the
/// title into this field, with the title selected. Return saves, Esc cancels (as does clicking elsewhere); an emptied
/// field clears the person's own name, so the agent's (or the derived) title shows again. A name the daemon would
/// refuse (more than 4 words or 32 characters) keeps the field open, outlined, and says why in its tooltip.
struct InlineTitleField: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  let font: Font
  let width: CGFloat
  @State private var edit: TitleEdit?
  @State private var refused = false
  @FocusState private var focused: Bool
  var body: some View {
    let draft = Binding(get: { edit?.draft ?? "" }, set: { edit?.draft = $0; refused = false })
    TextField("Name", text: draft, prompt: Text(verbatim: edit?.userTitled == true ? "Clear your name" : "Name"))
      .textFieldStyle(.plain).font(font).lineLimit(1)
      .focused($focused)
      .onSubmit { if let e = edit, !model.commitRename(agentId, e) { refused = true; focused = true } }
      .onExitCommand { model.endRename(agentId) }
      .onAppear { edit = model.titleEdit(agentId); focused = true }
      .onChange(of: focused) { _, f in if !f { model.endRename(agentId) } }
      .padding(.horizontal, 4)
      .frame(width: width, height: 20)
      .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.black.opacity(0.35)))
      .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous)
        .strokeBorder(refused || edit?.error != nil ? Theme.Desk.renameRefused : Theme.Desk.renameStroke, lineWidth: 1))
      .help(edit?.error ?? "Return saves · Esc cancels · empty clears your name")
      .accessibilityLabel("Rename agent")
  }
}
#endif
