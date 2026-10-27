#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// SPEC §4.6 thread input (thread-panel-v2 `.ib`, input-*.html, skills-picker.html): `+` · text · send. Return sends,
/// ⇧Return adds a line. `@` mentions an agent under this one; `/` picks a skill when the daemon can attach one.
/// Esc closes a list, then clears, then leaves the field.
struct ThreadComposer: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  let agentId: String
  @State private var text = ""                     // plain, a pill as U+FFFC (MentionTextView.swift)
  @State private var beforeCaret = ""
  @State private var editor = ComposerText()
  @State private var picked: [String] = []          // skill names, shown as chips
  @State private var highlight = 0
  @State private var dismissed: String?             // a token whose list the user closed with Esc
  @State private var focused = false

  private var agent: AgentNode? { model.tree(runId).flatMap { [$0] + flat($0.children) }.first { $0.id == agentId } }
  private func flat(_ ns: [AgentNode]) -> [AgentNode] { ns.flatMap { [$0] + flat($0.children) } }
  private var role: String { agent?.name ?? "agent" }
  /// The bot's name leads ("Tell Bolt…", "Bolt is writing…"); the role is the fallback.
  private var name: String { model.botName(runId: runId, agentId: agentId) ?? role }
  private var ended: Bool { agent.map { [.done, .failed, .cancelled, .handedOff].contains($0.status) } ?? false }
  private var canPause: Bool { model.capabilities.contains(Capability.agentPause) }
  /// Esc or the stop button: pause this agent (and its subtree) while it works and the field is empty.
  private var canStop: Bool { agent?.status == .running && text.isEmpty && picked.isEmpty && canPause }
  private var control: ControlState { model.agentControlState(agentId) }
  private var stopping: Bool { if case .requested(.pause) = control { return true }; if case .submitting(.pause) = control { return true }; return false }
  private var canAttachSkills: Bool { model.capabilities.contains(Capability.steerSkills) }

  // MARK: the list open under the cursor's token
  enum Trigger: Equatable { case mention(String), skill(String) }
  private var token: String { String(beforeCaret.reversed().prefix { !$0.isWhitespace }.reversed()) }
  private var trigger: Trigger? {
    let t = token
    guard t != dismissed, let first = t.first else { return nil }
    if first == "@" { return .mention(String(t.dropFirst()).lowercased()) }
    if first == "/", canAttachSkills { return .skill(String(t.dropFirst()).lowercased()) }
    return nil
  }
  private func handle(_ n: AgentNode) -> String { "@" + n.name + (n.suffix.map { "-\($0)" } ?? "") }
  private var mentionRows: [AgentNode] {
    guard case .mention(let q) = trigger else { return [] }
    return Array(model.descendants(runId: runId, of: agentId).filter { n in
      q.isEmpty || handle(n).lowercased().contains(q) || (model.botName(runId: runId, agentId: n.id)?.lowercased().contains(q) ?? false)
    }.prefix(Theme.Thread.popMaxRows))
  }
  private var skillRows: [SkillInfo] {
    guard case .skill(let q) = trigger else { return [] }
    return Array(model.skills.filter { q.isEmpty || $0.name.lowercased().contains(q) }.prefix(Theme.Thread.popMaxRows))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      popover
      if agent?.status == .running { writing }
      else if agent?.status == .paused { pausedRow }
      if case .failed(let why) = control {
        Text(verbatim: why).font(Theme.Thread.writingFont).foregroundStyle(Theme.red).padding(Theme.Thread.writingPadding)
      }
      box
    }
    .padding(Theme.Thread.inputMargin)
    .animation(Theme.Motion.fast, value: focused)
    .task { await model.refreshDaemonInfo() }
    .onChange(of: token) { highlight = 0; if token != dismissed { dismissed = nil } }
  }

  // MARK: box

  private var box: some View {
    let ready = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    // Composer board: who it's for and picked skills as chips, 15 pt text, a tool row, the white send.
    return VStack(alignment: .leading, spacing: Theme.Composer2.gap) {
      HStack(spacing: Theme.Composer2.chipGap) {
        Chip2(leading: BotAvatar(traits: model.bot(runId: runId, agentId: agentId), size: .xs), text: name, onRemove: nil)
          .help(name == role ? "" : role)
        chips
      }
      field.padding(.horizontal, Theme.Composer2.textInset)
      HStack(spacing: Theme.Composer2.chipGap) {
        plusMenu
        HStack(spacing: 2) {
          pill("@ Mention") { insertTrigger("@") }
          if canAttachSkills { pill("/ Skill") { insertTrigger("/") } }
        }
        .padding(3).background(Capsule().fill(Theme.Composer2.pillGroupFill))
        .fixedSize()   // the pills never truncate; the hint gives way first
        Spacer(minLength: 0)
        if focused {
          ViewThatFits(in: .horizontal) {
            Text("↩ send · ⇧↩ newline"); Text("↩ send"); Color.clear.frame(width: 0)
          }
          .font(Theme.Composer2.hintFont).foregroundStyle(Theme.Composer2.hintText).lineLimit(1).transition(.opacity)
        }
        sendButton(ready: ready)
      }
    }
    .padding(Theme.Composer2.padding)
    .background { ComposerCard(focused: focused) }
    .disabled(ended)
  }

  /// 1…6 lines, then it scrolls. An @ mention becomes an inline pill (MentionTextView.swift).
  private var field: some View {
    ComposerTextView(text: $text, beforeCaret: $beforeCaret, focused: $focused, controller: editor,
                     accessibilityLabel: name == role ? "Message \(name)" : "Message \(name), \(role)") { command in
      switch command {
      case .send: if !pickHighlighted() { send() }; return true
      case .up: return move(-1) == .handled
      case .down: return move(1) == .handled
      case .tab: return pickHighlighted()
      case .escape: _ = escape(); return true
      }
    }
    .overlay(alignment: .topLeading) {
      if text.isEmpty {
        Text(verbatim: ended ? "\(name) has finished" : "Tell \(name)…").font(Theme.Thread.inputFont)
          .foregroundStyle(Theme.Thread.inputPlaceholder).padding(.vertical, Theme.Thread.inputInset).allowsHitTesting(false)
      }
    }
  }

  private func pill(_ title: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).font(Theme.Composer2.pillFont).foregroundStyle(Theme.Composer2.pillText)
        .padding(.horizontal, 10).frame(height: Theme.Composer2.pillHeight).contentShape(Capsule())
    }
    .buttonStyle(PressableStyle())
  }

  private var chips: some View {
    HStack(spacing: Theme.Thread.chipGap) {
      ForEach(picked, id: \.self) { s in
        HStack(spacing: Theme.Thread.chipGap) {
          Image(systemName: "book.closed").font(.system(size: 9))
          Text(verbatim: s).font(Theme.Thread.chipFont).lineLimit(1)
          Button { picked.removeAll { $0 == s } } label: {
            Image(systemName: "xmark").font(.system(size: 7, weight: .bold))
              .frame(width: Theme.Thread.chipClose, height: Theme.Thread.chipClose)
              .background(Circle().fill(Theme.Thread.chipCloseFill))
          }
          .buttonStyle(.plain).accessibilityLabel("Remove \(s)")
        }
        .foregroundStyle(Theme.Thread.chipText)
        .padding(Theme.Thread.chipPadding).frame(height: Theme.Thread.chipHeight)
        .background(RoundedRectangle(cornerRadius: Theme.Thread.chipRadius, style: .continuous).fill(Theme.Thread.chipFill))
      }
    }
  }

  private var plusMenu: some View {
    Menu {
      Button("Mention agent…") { insertTrigger("@") }
      if canAttachSkills { Button("Add skill…") { insertTrigger("/") } }
    } label: {
      Image(systemName: "plus").font(Theme.Composer2.plusFont).foregroundStyle(.white)
        .frame(width: Theme.Composer2.round, height: Theme.Composer2.round)
        .background(Circle().fill(Theme.Composer2.roundFill)).overlay(Circle().strokeBorder(Theme.Composer2.roundStroke, lineWidth: 0.5))
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()   // no borderless inset: centred on the first line
    .accessibilityLabel("Add")
  }

  @ViewBuilder private func sendButton(ready: Bool) -> some View {
    let canStop = canStop && !stopping
    SendCircle(ready: ready, stop: canStop, label: canStop ? "Stop \(name)" : "Send", action: canStop ? stop : send)
  }


  private var writing: some View {
    HStack(spacing: Theme.Thread.writingGap) {
      HStack(spacing: Theme.Thread.dotGap) {
        ForEach(Theme.Thread.dotOpacities.indices, id: \.self) { i in
          Circle().fill(Theme.accent).frame(width: Theme.Thread.dot, height: Theme.Thread.dot).opacity(Theme.Thread.dotOpacities[i])
        }
      }
      Text(verbatim: stopping ? "Stopping \(name)…" : "\(name) is writing…")
      Spacer(minLength: 0)
      if canPause && !stopping { Text("Esc to stop") }
    }
    .font(Theme.Thread.writingFont).foregroundStyle(Theme.Thread.writingText)
    .padding(Theme.Thread.writingPadding)
    .accessibilityElement(children: .combine)
  }

  /// A paused agent: its work is pushed; Resume runs it (and its paused subtree) on from its branch.
  private var pausedRow: some View {
    HStack(spacing: Theme.Thread.writingGap) {
      Text(verbatim: "\(name) is paused")
      Spacer(minLength: 0)
      if canPause {
        Button("Resume") { model.controlAgent(runId: runId, agentId: agentId, .resume) }
          .buttonStyle(.plain).foregroundStyle(Theme.accent)
          .disabled({ if case .submitting = control { return true }; return false }())
      }
    }
    .font(Theme.Thread.writingFont).foregroundStyle(Theme.Thread.writingText)
    .padding(Theme.Thread.writingPadding)
  }

  private func stop() { guard canStop, !stopping else { return }; model.controlAgent(runId: runId, agentId: agentId, .pause) }

  // MARK: popover

  @ViewBuilder private var popover: some View {
    switch trigger {
    case .mention:
      if !mentionRows.isEmpty {
        list(header: nil) {
          ForEach(Array(mentionRows.enumerated()), id: \.element.id) { i, n in
            Button { pickMention(n) } label: { MentionRow(node: n, on: i == highlight, bot: model.bot(runId: runId, agentId: n.id)) }.buttonStyle(.plain)
          }
        }
      }
    case .skill(let q):
      list(header: "Skills") {
        if skillRows.isEmpty {
          Text("No matching skills").font(Theme.Thread.emptyFont).foregroundStyle(Theme.Thread.emptyText)
            .padding(Theme.Thread.emptyPadding).frame(maxWidth: .infinity, alignment: .leading)
        } else {
          ForEach(Array(skillRows.enumerated()), id: \.element.id) { i, s in
            Button { pickSkill(s) } label: { SkillRow(skill: s, query: q, on: i == highlight) }.buttonStyle(.plain)
          }
        }
      }
    case nil: EmptyView()
    }
  }

  private func list<C: View>(header: String?, @ViewBuilder _ rows: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if let header { Text(header).font(Theme.Thread.popHeaderFont).foregroundStyle(Theme.Thread.popHeaderText).padding(Theme.Thread.popHeaderPadding) }
      rows()
      HStack(spacing: Theme.Thread.footGap) { Text("↑↓ move"); Text("↩ pick"); Text("esc close") }
        .font(Theme.Thread.footFont).foregroundStyle(Theme.Thread.footText).padding(Theme.Thread.footPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(Theme.Thread.footDivider).frame(height: 0.5) }
        .padding(.top, 3)
    }
    .padding(Theme.Thread.popPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Thread.popRadius, style: .continuous).fill(Theme.Thread.popFill)
      .shadow(color: Theme.Thread.popShadow, radius: Theme.Thread.popShadowRadius, y: Theme.Thread.popShadowY))
    .overlay(RoundedRectangle(cornerRadius: Theme.Thread.popRadius, style: .continuous).strokeBorder(Theme.Thread.popStroke, lineWidth: 0.5))
    .padding(Theme.Thread.popMargin)
    .transition(.opacity)
  }

  // MARK: actions

  private var rowCount: Int { if case .mention = trigger { return mentionRows.count }; if case .skill = trigger { return skillRows.count }; return 0 }
  private func move(_ d: Int) -> KeyPress.Result {
    guard rowCount > 0 else { return .ignored }
    highlight = (highlight + d + rowCount) % rowCount; return .handled
  }
  private func pickHighlighted() -> Bool {
    switch trigger {
    case .mention: guard mentionRows.indices.contains(highlight) else { return false }; pickMention(mentionRows[highlight]); return true
    case .skill: guard skillRows.indices.contains(highlight) else { return false }; pickSkill(skillRows[highlight]); return true
    case nil: return false
    }
  }
  private var tokenLength: Int { (token as NSString).length }
  private func pickMention(_ n: AgentNode) {
    let name = model.botName(runId: runId, agentId: n.id) ?? n.name
    editor.replaceTokenBeforeCaret(length: tokenLength, with: .init(handle: handle(n), agentId: n.id), label: name, bot: model.bot(runId: runId, agentId: n.id))
  }
  private func pickSkill(_ s: SkillInfo) {
    if !picked.contains(s.name) { picked.append(s.name) }
    editor.replaceTokenBeforeCaret(length: tokenLength, with: nil)
  }
  private func insertTrigger(_ c: String) {
    editor.focus()
    editor.insert(!beforeCaret.isEmpty && !(beforeCaret.last?.isWhitespace ?? true) ? " " + c : c)
  }
  private func escape() -> KeyPress.Result {
    if trigger != nil { dismissed = token; return .handled }
    if !text.isEmpty || !picked.isEmpty { editor.clear(); picked = []; return .handled }
    if canStop && !stopping { stop(); return .handled }   // SPEC §4.6: …clears → stops the agent when empty
    editor.unfocus(); return .handled
  }
  private func send() {
    let body = editor.body().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty, !ended else { return }
    // Mentions are plain text for the agent; name the agents they point at so it can act on them.
    model.steer(runId: runId, agentId: agentId, body: SteerMentions.compose(body, editor.mentions()), skills: picked)
    editor.clear(); picked = []
  }
}

/// `.mi`: the bot · its name · role and suffix · status, highlighted blue. The inserted handle stays role-based.
struct MentionRow: View {
  let node: AgentNode
  let on: Bool
  var bot: BotTraits? = nil
  var body: some View {
    HStack(spacing: Theme.Thread.skillGap) {
      BotAvatar(traits: bot, size: .xs)
      Text(verbatim: bot?.name ?? node.name).font(Theme.Thread.mentionFont).foregroundStyle(on ? Color.white : Theme.Thread.mentionText)
      if bot != nil { Text(verbatim: node.name).font(Theme.Thread.mentionSuffix).foregroundStyle(on ? Theme.Thread.onHighlightSecondary : Theme.Thread.mentionSuffixText) }
      if let s = node.suffix { Text(verbatim: s).font(Theme.Thread.mentionSuffix).foregroundStyle(on ? Theme.Thread.onHighlightSecondary : Theme.Thread.mentionSuffixText) }
      Spacer(minLength: 0)
      Text(status).font(Theme.Thread.mentionStatus).foregroundStyle(on ? Theme.Thread.onHighlightSecondary : Theme.Thread.mentionStatusText)
    }
    .padding(.horizontal, 8).frame(height: Theme.Thread.mentionHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Thread.rowRadius, style: .continuous).fill(on ? Theme.Thread.rowHighlight : .clear))
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
  private var status: String {
    switch node.status { case .running: "Running"; case .done, .handedOff: "Done"; case .failed: "Failed"; case .cancelled: "Stopped"; case .paused: "Paused"; default: "Queued" }
  }
}

/// `.sk`: book · mono name (match in blue) · source, then a one-line description.
struct SkillRow: View {
  let skill: SkillInfo
  let query: String
  let on: Bool
  var body: some View {
    HStack(alignment: .top, spacing: Theme.Thread.skillGap) {
      Image(systemName: "book.closed").font(.system(size: 11)).foregroundStyle(on ? Color.white : Theme.Thread.skillDescText).frame(width: 16).padding(.top, 1)
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          name.font(Theme.Thread.skillName)
          Spacer(minLength: 0)
          Text(verbatim: skill.source).font(Theme.Thread.skillSource).foregroundStyle(on ? Color.white : Theme.Thread.skillSourceText)
        }
        Text(verbatim: skill.description).font(Theme.Thread.skillDesc).foregroundStyle(on ? Theme.Thread.skillDescOn : Theme.Thread.skillDescText).lineLimit(1)
      }
    }
    .padding(Theme.Thread.skillPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Thread.rowRadius, style: .continuous).fill(on ? Theme.Thread.rowHighlight : .clear))
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
  /// The typed part of the name in blue (underlined white when highlighted).
  private var name: Text {
    let n = skill.name, base = on ? Color.white : Theme.Thread.skillNameText
    guard !query.isEmpty, let r = n.range(of: query, options: .caseInsensitive) else { return Text(verbatim: n).foregroundColor(base) }
    let match = Text(verbatim: String(n[r])).foregroundColor(on ? .white : Theme.Thread.skillMatch).underline(on)
    return Text(verbatim: String(n[..<r.lowerBound])).foregroundColor(base) + match + Text(verbatim: String(n[r.upperBound...])).foregroundColor(base)
  }
}

/// `.me`: a steer to this agent, right-aligned. Pending ones show sending (dimmed) or failed (Retry · Discard).
struct SteerBubble: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let text: String
  var state: PendingSteer.State? = nil
  var onRetry: (() -> Void)? = nil
  var onDiscard: (() -> Void)? = nil
  var body: some View {
    let sending = state == .sending
    let failure: String? = { if case .failed(let m) = state { return m }; return nil }()
    HStack {
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 4) {
        shown   // what the operator typed, with its mentions as pills again
          .font(Theme.Thread.bubbleFont).foregroundStyle(Theme.Thread.bubbleText)
          .lineSpacing(Theme.Thread.lineSpacing)
          .padding(Theme.Thread.bubblePadding)
          .background(UnevenRoundedRectangle(topLeadingRadius: Theme.Thread.bubbleRadius, bottomLeadingRadius: Theme.Thread.bubbleRadius,
                                             bottomTrailingRadius: Theme.Thread.bubbleTail, topTrailingRadius: Theme.Thread.bubbleRadius)
            .fill(Theme.Thread.bubbleFill))
          .opacity(sending ? Theme.Thread.bubbleSendingOpacity : 1)
          .textSelection(.enabled)
        if let failure {
          HStack(spacing: 8) {
            Text(verbatim: failure).foregroundStyle(Theme.red)
            if let onRetry { Button("Retry", action: onRetry).buttonStyle(.plain).foregroundStyle(Theme.accent) }
            if let onDiscard { Button("Discard", action: onDiscard).buttonStyle(.plain).foregroundStyle(Theme.Thread.writingText) }
          }
          .font(Theme.Thread.bubbleNoteFont)
        }
      }
      .containerRelativeFrame(.horizontal, alignment: .trailing) { w, _ in w * Theme.Thread.bubbleMaxWidth }
    }
    .padding(Theme.Thread.bubbleMargin)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("You: \(text)" + (sending ? ", sending" : "") + (failure.map { ", not sent: \($0)" } ?? ""))
  }

  /// Hide the line naming the mentioned agents (SteerMentions) and draw each handle it names as its pill; anything
  /// else shows as typed.
  private var shown: Text {
    let (visible, mentions) = SteerMentions.parse(text)
    guard !mentions.isEmpty else { return Text(verbatim: text) }
    let agents = Dictionary(mentions.map { ($0.handle, $0.agentId) }, uniquingKeysWith: { a, _ in a })
    let handles = agents.keys.sorted { $0.count > $1.count }
    var out = Text(verbatim: ""), rest = Substring(visible)
    while !rest.isEmpty {
      let hit = handles.compactMap { h in rest.range(of: h).map { (h, $0) } }.min { $0.1.lowerBound < $1.1.lowerBound }
      guard let (h, r) = hit else { out = out + Text(verbatim: String(rest)); break }
      let id = agents[h]!
      let pill = MentionPill.image(label: model.botName(runId: runId, agentId: id) ?? String(h.dropFirst()), bot: model.bot(runId: runId, agentId: id))
      out = out + Text(verbatim: String(rest[..<r.lowerBound]))
        + Text(Image(nsImage: pill)).baselineOffset(MentionPill.baseline(textSize: Theme.Thread.bubbleFontSize))
      rest = rest[r.upperBound...]
    }
    return out
  }

}
#endif
