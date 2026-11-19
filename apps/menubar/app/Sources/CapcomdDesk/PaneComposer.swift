#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

/// The opened pane's message box: Home's composer card at the pane's reading width (720 pt), for talking to this agent.
/// Built from the shared composer parts (CapcomdUI/ComposerToolRow.swift, ComposerParts.swift): the round + (attach a
/// skill), the model chip (the agent's harness mark, its model, the effort's bars) and its menu, the mic, the send
/// circle. What it shows is the agent's `PaneComposerState` (CapcomdStore/AgentComposer.swift): the placeholder, working
/// (empty box: the send circle is Stop), archived (a line instead of the box), the model chip read-only on a daemon
/// that can't take a model with a message. The draft is the field's own state; nothing else re-renders while you type.
struct PaneComposer: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.slotMemory) private var memory
  @Environment(\.paneState) private var pane
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let agentId: String
  let name: String
  @State private var draft = ""
  @State private var skills: [String] = []
  @FocusState private var focused: Bool

  var body: some View {
    DeskProbe.body("PaneComposer", id: agentId)
    let slice = model.agent(agentId)
    let state = slice?.composer ?? PaneComposerState(placeholder: "Tell \(name)…")
    let shape = RoundedRectangle(cornerRadius: Theme.Desk.Home.cardRadius, style: .continuous)
    return Group {
      if state.isArchived {
        archived(state)
      } else {
        VStack(alignment: .leading, spacing: Theme.Desk.Home.cardGap) {
          if !skills.isEmpty {
            HStack(spacing: Theme.Composer2.chipGap) {
              ForEach(skills, id: \.self) { s in Chip2(icon: "sparkles", text: s) { skills.removeAll { $0 == s } }.fixedSize() }
            }
          }
          TextField(state.placeholder, text: $draft, axis: .vertical)
            .textFieldStyle(.plain).font(Theme.Desk.Home.goalFont).lineLimit(1...8)
            .padding(.horizontal, Theme.Composer2.textInset).padding(.top, 2)
            .focused($focused)
            .onSubmit { send(state) }
            .onChange(of: focused) { _, f in model.typing(in: agentId, f) }
            .task(id: slice?.boxFocus ?? 0) { if model.nav.sidebarOpen, model.takeBoxFocus(agentId) { focused = true } }
          toolRow(state, menuOpen: slice?.modelMenuOpen == true)
        }
        .padding(Theme.Desk.Home.cardPadding)
        .background {
          ZStack {
            RoundedRectangle(cornerRadius: Theme.Desk.Home.cardRadius + Theme.Desk.Home.focusWidth, style: .continuous)
              .fill(Theme.Desk.Home.focusRing).padding(-Theme.Desk.Home.focusWidth).opacity(focused ? 1 : 0)
            shape.fill(Theme.Desk.Home.cardFill).shadow(color: .black.opacity(0.5), radius: 16, x: 0, y: 14)
          }
        }
        .overlay(shape.strokeBorder(Theme.Desk.Home.cardRing, lineWidth: 0.5))
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: focused)
        // The model menu opens above the card, at its right edge, over the thread.
        .overlay(alignment: .topTrailing) {
          if slice?.modelMenuOpen == true, let choice = state.model {
            // A zero-high frame on the card's top edge, the menu on its bottom: it rises from there over the thread.
            AgentModelMenu(agentId: agentId, choice: choice)
              .fixedSize()
              .padding(.bottom, Theme.Desk.Home.menuGap)
              .frame(height: 0, alignment: .bottom)
              .padding(.trailing, Theme.Desk.Home.cardPadding.trailing)
          }
        }
      }
    }
    .frame(maxWidth: pane?.expanded == true ? PaneMetrics.reading : Theme.Desk.paneReading)
    .padding([.horizontal, .bottom], pane?.expanded == true ? 20 : 12)
    .frame(maxWidth: .infinity)
    .modifier(SlotDraft(memory: memory, agentId: agentId, draft: $draft))
  }

  /// + , the model chip by the send circle, the mic, then send (Stop while the agent works and the box is empty).
  private func toolRow(_ state: PaneComposerState, menuOpen: Bool) -> some View {
    let stop = state.isWorking && state.canStop && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return HStack(spacing: Theme.Composer2.chipGap) {
      ComposerAddMenu(label: "Attach a skill") {
        if state.skills.isEmpty {
          Button("No skills to attach") {}.disabled(true)
        } else {
          Section("Attach a skill") {
            ForEach(state.skills, id: \.self) { s in
              Button { if !skills.contains(s) { skills.append(s) } } label: { Text(verbatim: s) }
            }
          }
        }
      }
      Spacer(minLength: 0)
      if let m = state.model { AgentModelChip(agentId: agentId, choice: m, open: menuOpen) }
      ComposerMicButton { focused = true }
      SendCircle(ready: state.canSend && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, stop: stop,
                 label: stop ? "Stop \(name)" : "Send to \(name)") {
        if stop { model.stopAgent(agentId: agentId) } else { send(state) }
      }
      .help(stop ? "Stop: pauses it, its work committed and pushed (Resume continues it)" : state.isWorking ? "Send now (Return): it reads it as it works" : "Send (Return)")
    }
    .frame(height: Theme.Desk.Home.toolRow)
  }

  private func archived(_ state: PaneComposerState) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "archivebox").font(.system(size: 12)).foregroundStyle(Theme.Desk.tertiary)
      Text("This run is archived.").font(.system(size: 13)).foregroundStyle(Theme.Desk.secondary)
      Spacer(minLength: 0)
      if state.canRestore {
        Button("Restore") { model.restoreRun(agentId: agentId) }.buttonStyle(DeskButton(kind: .outline))
      }
    }
    .padding(.horizontal, 14).frame(height: Theme.Desk.composerHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.Home.cardRadius, style: .continuous).fill(Theme.Desk.Home.cardFill))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.Home.cardRadius, style: .continuous).strokeBorder(Theme.Desk.Home.cardRing, lineWidth: 0.5))
  }

  private func send(_ state: PaneComposerState) {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard state.canSend, !text.isEmpty else { return }
    model.steer(agentId: agentId, body: text, skills: skills); draft = ""; skills = []
  }
}

/// The model chip: the agent's harness mark, the model its next turn runs on, the picked effort's bars. A click opens its
/// menu; on a daemon that can't take a model with a message it only says what the agent runs on.
struct AgentModelChip: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  let choice: AgentModelChoice
  let open: Bool
  var body: some View {
    let label = DriverChipLabel(provider: choice.provider, text: choice.chip, effort: choice.effortIndex.map { ($0, choice.efforts.count) }, available: true)
    if choice.editable {
      Button { model.toggleAgentModelMenu(agentId) } label: { label }
        .buttonStyle(PressableStyle()).fixedSize()
        .help(choice.pending ? "\(choice.label)" : "The model and effort for its next turn")
        .accessibilityLabel(choice.label).accessibilityHint("Picks the model and effort for its next turn")
        .accessibilityAddTraits(open ? .isSelected : [])
    } else {
      label.fixedSize().allowsHitTesting(true)
        .help("\(choice.label). This capcomd can't change an agent's model yet.")
        .accessibilityLabel(choice.label)
    }
  }
}

/// The model menu over the pane composer: the agent's harness and its models (✓ the one its next turn runs on), then
/// Effort. A pick applies from its next turn (it goes with the next message). Esc or a second click closes it.
struct AgentModelMenu: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let agentId: String
  let choice: AgentModelChoice
  @State private var hover: String?
  @State private var shown = false
  @FocusState private var focused: Bool

  var body: some View {
    let levels: [String?] = [nil] + choice.efforts.map { Optional($0) }
    VStack(alignment: .leading, spacing: 0) {
      Text(verbatim: choice.harness ?? "Model").font(Theme.Desk.Home.menuHeader).foregroundStyle(Theme.Desk.tertiary)
        .padding(.horizontal, 9).padding(.top, 7).padding(.bottom, 3).accessibilityAddTraits(.isHeader)
      if choice.models.isEmpty {
        Text(verbatim: choice.chip).font(Theme.Desk.Home.menuItem).foregroundStyle(Theme.Desk.secondary)
          .padding(.horizontal, 9).frame(height: Theme.Desk.Home.itemHeight)
      }
      ForEach(choice.models) { m in item(m) }
      if !choice.efforts.isEmpty {
        Rectangle().fill(Theme.Desk.Home.separator).frame(height: 0.5).padding(.vertical, 5).padding(.horizontal, 4)
        Text("Effort").font(Theme.Desk.Home.menuHeader).foregroundStyle(Theme.Desk.tertiary)
          .padding(.horizontal, 9).padding(.top, 7).padding(.bottom, 3).accessibilityAddTraits(.isHeader)
        EffortSegments(levels: levels, picked: choice.effort) { model.pickNextTurn(agentId: agentId, effort: .some($0)) }
          .padding(.horizontal, 6).padding(.top, 4).padding(.bottom, 6)
      }
      Text("From its next turn").font(Theme.Desk.Home.menuNote).foregroundStyle(Theme.Desk.tertiary)
        .padding(.horizontal, 9).padding(.top, 2).padding(.bottom, 5)
    }
    .padding(Theme.Desk.Home.menuPadding)
    .frame(width: Theme.Desk.Home.menuWidth, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.Home.menuRadius, style: .continuous).fill(Theme.Desk.Home.menuFill)
      .shadow(color: .black.opacity(0.55), radius: 16, y: 12))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.Home.menuRadius, style: .continuous).strokeBorder(Theme.Desk.Home.menuRing, lineWidth: 0.5))
    .opacity(shown ? 1 : 0).offset(y: shown || reduceMotion ? 0 : 3)
    .onAppear { withAnimation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.14)) { shown = true }; focused = true }
    .focusable().focused($focused).focusEffectDisabled()
    .onKeyPress(.escape) { model.closeAgentModelMenu(agentId); return .handled }
    .accessibilityElement(children: .contain).accessibilityLabel("Model for its next turn").accessibilityAddTraits(.isModal)
  }

  private func item(_ m: ModelInfo) -> some View {
    let checked = m.id == choice.model, lit = hover == m.id
    return Button { model.pickNextTurn(agentId: agentId, model: m.id); model.closeAgentModelMenu(agentId) } label: {
      HStack(spacing: 8) {
        Text(checked ? "✓" : "").font(Theme.Desk.Home.menuItem).frame(width: 12)
        Text(verbatim: m.name).font(Theme.Desk.Home.menuItem).lineLimit(1)
        Spacer(minLength: 8)
        Text(verbatim: m.note).font(Theme.Desk.Home.menuNote).foregroundStyle(lit ? Color.white.opacity(0.8) : Theme.Desk.tertiary).lineLimit(1)
      }
      .foregroundStyle(Theme.Desk.text)
      .padding(.horizontal, 9).frame(height: Theme.Desk.Home.itemHeight)
      .background(RoundedRectangle(cornerRadius: Theme.Desk.Home.itemRadius, style: .continuous).fill(lit ? Theme.Desk.Home.itemHighlight : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { h in hover = h ? m.id : (hover == m.id ? nil : hover) }
    .accessibilityLabel("\(m.name), \(m.note)").accessibilityAddTraits(checked ? .isSelected : [])
  }
}
#endif
