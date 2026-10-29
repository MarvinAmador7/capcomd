#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot

/// The Active card, direction B "The ask leads" (design/active-card, card-spec.md). Folded it is one sentence: the
/// crew's heads and who is doing what. An approval, a failure or a usage-limit pause unfolds it into a headline, who it
/// concerns, the evidence and one bar of controls; the agent tree is one click away. What it says comes from
/// CapcomdStore.activeCard; this only lays it out.
struct ActiveCardView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorSchemeContrast) private var contrast
  let project: Project
  @FocusState private var focused: Bool
  @State private var hovering = false

  var body: some View {
    let card = model.card(project)
    // An ask can't be put away; a failure can (Hide), until something else unfolds the card.
    let open = card.reason.map { $0.hasPrefix("ask:") || !model.hiddenReasons.contains($0) } ?? false
    let tree = model.treeShown.contains(project.id)
    let asking = open && card.reason?.hasPrefix("ask:") == true
    let shape = RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      top(card, open: open)
      ZStack(alignment: .topLeading) {
        if open { unfolded(card, tree: tree).transition(contentTransition) }
        else if let run = model.meeting(project) { MeetTeamView(runId: run.id).padding(.top, Theme.Ask.lineTop).transition(contentTransition) }
        else { folded(card, tree: tree).transition(contentTransition) }
      }
      if tree {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(card.runIds, id: \.self) { AgentTreeView(runId: $0, compact: true, showApprovals: false, rowHeight: Theme.Ask.treeRow) }
        }
        .padding(.top, Theme.Ask.treeTop)
        .transition(.opacity)
      }
      if open { bar(card).transition(.opacity) }
    }
    .padding(Theme.Ask.padding)
    .background { shape.fill(Theme.Ask.fill) }
    .overlay {
      ZStack {
        shape.strokeBorder(Theme.Ask.amberRing, lineWidth: Theme.Ask.ringWidth).opacity(asking ? 1 : 0)
        shape.strokeBorder(Theme.Craft.contrastStroke, lineWidth: Theme.Craft.contrastStrokeWidth).opacity(contrast == .increased && !asking ? 1 : 0)
      }
      .allowsHitTesting(false)
    }
    .clipShape(shape)
    .contentShape(shape)
    // Unfold on the slower spring, fold back on the faster one; Reduce Motion: one 150 ms ease-out, no spring.
    .animation(reduceMotion ? Theme.Ask.reduced : open ? Theme.Ask.unfold : Theme.Ask.fold, value: open ? card.reason : nil)
    .animation(reduceMotion ? Theme.Ask.reduced : Theme.Ask.shift, value: tree)
    .onHover { hovering = $0 }
    // Return approves while the card has focus (a click on it, or Tab); Esc never denies.
    .focusable(interactions: .activate)
    .focused($focused)
    .focusEffectDisabled(!asking)
    .onKeyPress(.return) {
      guard asking, case .ask(let ask) = card.body, ask.approval.decision == .idle || ask.approval.isRetryable else { return .ignored }
      model.decide(ask.approval.id, .approve)   // keyboard: no haptic, no press animation
      return .handled
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(spoken(card, open: open))
    .modifier(AskActions(card: card, asking: asking))
  }

  // MARK: top row
  /// The run's title (13/600 folded, 12 secondary once the ask leads; the full goal on hover) and the elapsed time.
  /// Opens the run.
  private func top(_ c: ActiveCard, open: Bool) -> some View {
    Button { model.open(run: c.runId) } label: {
      HStack(alignment: .firstTextBaseline, spacing: Theme.Ask.topGap) {
        Text(verbatim: c.title)   // untrusted title: verbatim, never markdown
          .font(open ? Theme.Ask.goalFont : Theme.Ask.titleFont).tracking(open ? 0 : Theme.Ask.titleTracking)
          .foregroundStyle(open ? Theme.Ask.text2 : Theme.Ask.text)
          .lineLimit(1).truncationMode(.tail)
          .frame(maxWidth: .infinity, alignment: .leading)
          .help(project.fullTitle)
        ElapsedClock(since: c.startedAtMs)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(c.title)
    .accessibilityHint("Opens the run")
  }

  // MARK: folded
  private func folded(_ c: ActiveCard, tree: Bool) -> some View {
    HStack(spacing: Theme.Ask.lineGap) {
      CrewHeads(members: c.crew, more: c.crewMore)
      SentenceTicker(sentence: c.sentence, frozen: hovering)
        .frame(maxWidth: .infinity, alignment: .leading)
      TreeChevron(projectId: project.id, open: tree)
    }
    .frame(height: Theme.Ask.lineHeight)
    .padding(.top, Theme.Ask.lineTop)
  }

  // MARK: unfolded
  @ViewBuilder private func unfolded(_ c: ActiveCard, tree: Bool) -> some View {
    switch c.body {
    case .ask(let a):
      VStack(alignment: .leading, spacing: 0) {
        Headline(icon: "hand.raised", tint: Theme.Ask.amber, text: a.question)
        HStack(spacing: Theme.Ask.whoGap) {
          if let asker = a.asker { CrewHeads(members: [asker], asker: asker.id) }
          AskedLine(asker: a.asker?.name, at: a.approval.requestedAtMs, waiters: a.waiters.map(\.name))
            .frame(maxWidth: .infinity, alignment: .leading)
          TreeChevron(projectId: project.id, open: tree)
        }
        .padding(.top, Theme.Ask.whoTop)
        if let diff = a.approval.diff { FilesList(diff: diff).padding(.top, Theme.Ask.filesTop) }
        else if let line = a.approval.branchLine {
          Text(verbatim: line).font(Theme.Ask.monoFont).foregroundStyle(Theme.Ask.text2).lineLimit(1).truncationMode(.middle)
            .padding(.top, Theme.Ask.filesTop)
        }
      }
    case .failed(let f):
      VStack(alignment: .leading, spacing: 0) {
        Headline(icon: "xmark.circle", tint: Theme.Ask.red, text: f.checksFailed ? "\(f.agent.name)'s checks failed" : "\(f.agent.name) failed")
        HStack(spacing: Theme.Ask.whoGap) {
          CrewHeads(members: [f.agent])
          (Text(verbatim: f.agent.name).font(Theme.Ask.whoLineFont.weight(.medium)).foregroundColor(Theme.Ask.text)
           + Text(verbatim: f.checksFailed ? " · its checks didn't pass" : " · stopped with an error").font(Theme.Ask.whoLineFont).foregroundColor(Theme.Ask.text2))
            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
          TreeChevron(projectId: project.id, open: tree)
        }
        .padding(.top, Theme.Ask.whoTop)
        if let d = f.detail {
          Text(verbatim: d.plain)   // the agent's or the checked code's text: plain, never markdown
            .font(Theme.Ask.errFont).lineSpacing(Theme.Ask.errSpacing).foregroundStyle(Theme.Ask.text2)
            .lineLimit(Theme.Ask.errMaxLines).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Ask.errPadding)
            .background(RoundedRectangle(cornerRadius: Theme.Ask.errRadius, style: .continuous).fill(Theme.Ask.sunk))
            .padding(.top, Theme.Ask.errTop)
        }
      }
    case .paused(let p):
      VStack(alignment: .leading, spacing: 0) {
        Headline(icon: "pause.circle", tint: Theme.Ask.text2,
                 text: p.provider.map { "Paused at \($0.displayName)'s usage limit" } ?? "Paused at a usage limit")
        HStack(spacing: Theme.Ask.whoGap) {
          CrewHeads(members: p.agents)
          ResumeLine(names: p.agents.map(\.name), at: p.resumesAtMs)
            .frame(maxWidth: .infinity, alignment: .leading)
          TreeChevron(projectId: project.id, open: tree)
        }
        .padding(.top, Theme.Ask.whoTop)
      }
    case .working:
      folded(c, tree: tree)
    }
  }

  // MARK: the bar
  @ViewBuilder private func bar(_ c: ActiveCard) -> some View {
    HStack(spacing: Theme.Ask.barGap) {
      switch c.body {
      case .ask(let a):
        Button("View diff") { model.viewDiff(runId: c.runId) }.buttonStyle(CardTextButtonStyle())
        Spacer(minLength: 0)
        DecisionButtons(approval: a.approval)
      case .failed(let f):
        Button("Hide") { if let r = c.reason { model.hiddenReasons.insert(r) } }.buttonStyle(CardTextButtonStyle())
          .accessibilityHint("Folds the card until something else needs you")
        Spacer(minLength: 0)
        // There is no retry in the API yet: the thread is where to see why and steer it on.
        Button("Open thread") { model.open(run: c.runId); model.path.append(.thread(runId: c.runId, agentId: f.agent.agentId)) }
          .buttonStyle(CardButtonStyle(kind: .primary))
      case .paused:
        let state = model.controlState(c.runId)
        Group {
          if case .failed(let m) = state { Text(verbatim: m).foregroundStyle(Theme.Ask.red) }
          else { Text(state.isRequested(.resume) ? "Resuming…" : "Nothing to do unless it's urgent").foregroundStyle(Theme.Ask.text3) }
        }
        .font(Theme.Ask.noteFont).lineLimit(1)
        Spacer(minLength: 0)
        // Resuming clears the recorded limit and runs the agents again now (POST …/resume).
        Button("Resume now") { model.control(c.runId, .resume) }
          .buttonStyle(CardButtonStyle(kind: .ghost))
          .disabled(state.isSubmitting)
      case .working:
        EmptyView()
      }
    }
    .lineLimit(1)
    .padding(Theme.Ask.barPadding)
    .frame(maxWidth: .infinity)
    .background(Theme.Ask.sunk)
    .padding(.horizontal, -Theme.Ask.padding).padding(.bottom, -Theme.Ask.padding)   // docked to the card's foot
    .padding(.top, Theme.Ask.barTop)
  }

  private var contentTransition: AnyTransition {
    reduceMotion ? .opacity : .blurFade(Theme.Ask.crossfadeBlur).animation(Theme.Ask.crossfade)
  }

  /// One sentence for VoiceOver: what the card says, folded or not.
  private func spoken(_ c: ActiveCard, open: Bool) -> String {
    var parts = [c.title]
    if let s = c.startedAtMs { parts.append("running for \(spokenDuration(ms: nowMs() - s))") }
    switch c.body {
    case .ask(let a) where open:
      parts.append("Approval needed: \(a.question)")
      if !a.waiters.isEmpty { parts.append("\(namesPhrase(a.waiters.map(\.name), max: 3)) \(a.waiters.count == 1 ? "waits" : "wait") on it") }
      if let d = a.approval.diff { parts.append("\(d.total) \(d.total == 1 ? "file" : "files"), \(d.added) lines added, \(d.removed) removed") }
    case .failed(let f) where open:
      parts.append(f.checksFailed ? "\(f.agent.name)'s checks failed" : "\(f.agent.name) failed")
      if let d = f.detail { parts.append(d.firstLine) }
    case .paused(let p) where open:
      parts.append("Paused at \(p.provider?.displayName ?? "a") usage limit")
    default:
      parts.append(c.sentence.text)
      parts.append("\(c.crewTotal) \(c.crewTotal == 1 ? "agent" : "agents")")
    }
    return parts.joined(separator: ". ")
  }
}

/// Approve and Deny as VoiceOver actions on the card itself (the buttons stay in the bar too).
private struct AskActions: ViewModifier {
  @Environment(AppModel.self) private var model
  let card: ActiveCard
  let asking: Bool
  func body(content: Content) -> some View {
    if asking, case .ask(let a) = card.body {
      content
        .accessibilityAction(named: "Approve") { model.decide(a.approval.id, .approve) }
        .accessibilityAction(named: "Deny") { model.decide(a.approval.id, .deny) }
        .accessibilityAction(named: "View diff") { model.viewDiff(runId: card.runId) }
    } else {
      content
    }
  }
}

// MARK: - parts

/// Elapsed time in tabular mono, ticking once a second.
struct ElapsedClock: View {
  let since: Int?
  var body: some View {
    if let since {
      TimelineView(.periodic(from: .now, by: 1)) { ctx in
        Text(verbatim: elapsedClock(ms: Int(ctx.date.timeIntervalSince1970 * 1000) - since))
          .font(Theme.Ask.timeFont).foregroundStyle(Theme.Ask.text3).monospacedDigit()
      }
      .fixedSize()
      .accessibilityHidden(true)   // the card's label says it in words
    }
  }
}

/// The crew's heads: 18 pt tiles overlapping by 4, cut apart by a ring of the card's colour; "+n" when there are more.
/// A head that joins slides in from 6 pt to the right, 40 ms after the one before it.
struct CrewHeads: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let members: [ActiveCard.Member]
  var more = 0
  var asker: String? = nil

  var body: some View {
    HStack(spacing: -Theme.Ask.headOverlap) {
      ForEach(Array(members.enumerated()), id: \.element.id) { i, m in
        let r = Theme.Ask.headRadius
        BotAvatar(traits: model.bot(runId: m.runId, agentId: m.agentId), size: .xs)
          .frame(width: Theme.Ask.head, height: Theme.Ask.head)
          .background(RoundedRectangle(cornerRadius: r, style: .continuous).fill(Theme.Ask.tile))
          .background(RoundedRectangle(cornerRadius: r + Theme.Ask.headCut, style: .continuous).fill(Theme.Ask.cut).padding(-Theme.Ask.headCut))
          .overlay {
            if m.agentId == asker {
              RoundedRectangle(cornerRadius: r + Theme.Ask.headCut + Theme.Ask.headRing, style: .continuous)
                .strokeBorder(Theme.Ask.amber, lineWidth: Theme.Ask.headRing).padding(-(Theme.Ask.headCut + Theme.Ask.headRing))
            }
          }
          .help(model.botName(runId: m.runId, agentId: m.agentId).map { "\(m.name) · \($0)" } ?? m.name)
          .transition(reduceMotion ? .opacity : .asymmetric(
            insertion: .offset(x: Theme.Ask.joinOffset).combined(with: .opacity)
              .animation(Theme.Ask.join.delay(Double(min(i, Theme.Ask.joinStaggerMax)) * Theme.Ask.joinStagger)),
            removal: .opacity))
      }
      if more > 0 {
        Text(verbatim: "+\(more)").font(Theme.Ask.moreFont).foregroundStyle(Theme.Ask.text3)
          .padding(.leading, Theme.Ask.headOverlap + Theme.Ask.moreLeading)
      }
    }
    .padding(.horizontal, Theme.Ask.headCut)
    .animation(reduceMotion ? Theme.Ask.reduced : Theme.Ask.shift, value: members.map(\.id))
    .accessibilityHidden(true)
  }
}

/// "worker is editing 2 files": who in medium, the rest secondary. A change waits until 1.5 s after the last one and
/// until the pointer leaves the card, then crossfades with a 1.5 pt blur.
struct SentenceTicker: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let sentence: ActiveCard.Sentence
  let frozen: Bool
  @State private var shown: ActiveCard.Sentence?
  @State private var changedAt = Date.distantPast
  @State private var pending: Task<Void, Never>?

  var body: some View {
    let s = shown ?? sentence
    ZStack(alignment: .leading) {
      Self.text(s).id(s.text)
        .transition(reduceMotion ? .opacity : .blurFade(Theme.Ask.tickerBlur))
    }
    .onAppear { shown = sentence; changedAt = Date() }
    .onChange(of: sentence) { schedule() }
    .onChange(of: frozen) { if !frozen { schedule() } }
    .onDisappear { pending?.cancel() }
  }

  static func text(_ s: ActiveCard.Sentence) -> Text {
    (Text(verbatim: s.who?.name ?? "").font(Theme.Ask.whoFont).foregroundColor(Theme.Ask.text)
     + Text(verbatim: s.rest).font(Theme.Ask.sentenceFont).foregroundColor(Theme.Ask.text2))
  }

  private func schedule() {
    pending?.cancel()
    guard sentence != shown, !frozen else { return }
    let wait = max(0, Theme.Ask.tickerHold - Date().timeIntervalSince(changedAt))
    pending = Task { @MainActor in
      if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
      guard !Task.isCancelled else { return }
      withAnimation(reduceMotion ? Theme.Ask.reduced : Theme.Ask.ticker) { shown = sentence }
      changedAt = Date()
    }
  }
}

/// The headline: 15/600 with its mark 7 pt before it.
struct Headline: View {
  let icon: String
  let tint: Color
  let text: String
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.Ask.headGap) {
      Image(systemName: icon).font(.system(size: Theme.Ask.headIcon, weight: .medium)).foregroundStyle(tint).accessibilityHidden(true)
      Text(verbatim: text)   // a merge's question is worded by the app; another kind's is the agent's: plain text
        .font(Theme.Ask.headFont).tracking(Theme.Ask.headTracking).lineSpacing(Theme.Ask.headSpacing)
        .foregroundStyle(Theme.Ask.text).lineLimit(3).fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, Theme.Ask.headTop)
    .accessibilityAddTraits(.isHeader)
  }
}

/// "worker asked 18s ago · planner and reviewer wait on it".
struct AskedLine: View {
  let asker: String?
  let at: Int?
  let waiters: [String]
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      let now = Int(ctx.date.timeIntervalSince1970 * 1000)
      var t = Text(verbatim: asker ?? "An agent").font(Theme.Ask.whoLineFont.weight(.medium)).foregroundColor(Theme.Ask.text)
        + Text(verbatim: at.map { " asked \(shortDuration(ms: now - $0)) ago" } ?? " asks").font(Theme.Ask.whoLineFont).foregroundColor(Theme.Ask.text2)
      if !waiters.isEmpty {
        t = t + Text(verbatim: " · \(namesPhrase(waiters)) \(waiters.count == 1 ? "waits" : "wait") on it").font(Theme.Ask.whoLineFont).foregroundColor(Theme.Ask.text2)
      }
      return t.lineLimit(1).truncationMode(.tail)
    }
  }
}

/// "planner and reviewer pick up again at 15:40" (local time), or when the limit resets.
struct ResumeLine: View {
  let names: [String]
  let at: Int?
  var body: some View {
    let who = namesPhrase(names)
    let verb = names.count == 1 ? "picks" : "pick"
    let when = at.map { "at \(Date(timeIntervalSince1970: Double($0) / 1000).formatted(date: .omitted, time: .shortened))" } ?? "when the limit resets"
    (Text(verbatim: who).font(Theme.Ask.whoLineFont.weight(.medium)).foregroundColor(Theme.Ask.text)
     + Text(verbatim: " \(verb) up again \(when)").font(Theme.Ask.whoLineFont).foregroundColor(Theme.Ask.text2))
      .lineLimit(1).truncationMode(.tail)
  }
}

/// The files a merge lands: up to four rows, path in mono, then +added (green) and −removed (red, grey at zero, a dash
/// for a binary file), right-aligned in tabular figures; "and n more files" when there are more.
struct FilesList: View {
  let diff: ApprovalDiff
  var body: some View {
    let shown = Array(diff.files.prefix(Theme.Ask.maxFiles))
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(shown.enumerated()), id: \.offset) { i, f in
        HStack(spacing: 0) {
          Text(verbatim: f.path.plain).font(Theme.Ask.fileFont).foregroundStyle(Theme.Ask.text)
            .lineLimit(1).truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)
          count(f.added.map { "+\($0)" }, tint: f.added.map { $0 > 0 ? Theme.Ask.green : Theme.Ask.text3 })
          count(f.removed.map { "−\($0)" }, tint: f.removed.map { $0 > 0 ? Theme.Ask.red : Theme.Ask.text3 })
        }
        .frame(height: Theme.Ask.fileRow)
        .overlay(alignment: .top) { if i > 0 { Rectangle().fill(Theme.Ask.rule).frame(height: 0.5) } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(f.path.plain), \(f.added.map { "\($0) added" } ?? "binary")\(f.removed.map { ", \($0) removed" } ?? "")")
      }
      if diff.total > shown.count {
        let n = diff.total - shown.count
        Text(verbatim: "and \(n) more \(n == 1 ? "file" : "files")").font(Theme.Ask.moreFilesFont).foregroundStyle(Theme.Ask.text3)
          .frame(height: Theme.Ask.fileRow)
          .overlay(alignment: .top) { Rectangle().fill(Theme.Ask.rule).frame(height: 0.5) }
      }
    }
  }
  private func count(_ s: String?, tint: Color?) -> some View {
    Text(verbatim: s ?? "–").font(Theme.Ask.countFont).foregroundStyle(tint ?? Theme.Ask.text3)
      .frame(width: Theme.Ask.countWidth, alignment: .trailing)
  }
}

/// Deny (ghost) and Approve ↩ (inverted): or, once decided, how it went. A click gets a trackpad tick; the keyboard doesn't.
struct DecisionButtons: View {
  @Environment(AppModel.self) private var model
  let approval: PendingApproval
  var body: some View {
    switch approval.decision {
    case .decided(let status, let by, let already):
      Text(verbatim: decidedText(status, by, already)).font(Theme.Ask.statusFont).foregroundStyle(Theme.Ask.text2)
    case .failed(let msg):
      Text(verbatim: msg).font(Theme.Ask.statusFont).foregroundStyle(Theme.Ask.red).lineLimit(1)
      buttons(submitting: nil)
    case .submitting(let d):
      buttons(submitting: d)
    case .idle:
      buttons(submitting: nil)
    }
  }
  private func buttons(submitting: ApprovalDecision?) -> some View {
    HStack(spacing: Theme.Ask.barGap) {
      Button { Haptics.decided(); model.decide(approval.id, .deny) } label: { label("Deny", busy: submitting == .deny) }
        .buttonStyle(CardButtonStyle(kind: .ghost))
      Button { Haptics.decided(); model.decide(approval.id, .approve) } label: {
        HStack(spacing: Theme.Ask.keyGap) {
          label("Approve", busy: submitting == .approve)
          Text(verbatim: "↩").font(Theme.Ask.keyFont)
            .frame(minWidth: Theme.Ask.key, minHeight: Theme.Ask.key)
            .background(RoundedRectangle(cornerRadius: Theme.Ask.keyRadius, style: .continuous).fill(Theme.Ask.keyFill))
            .accessibilityHidden(true)
        }
        .frame(minWidth: Theme.Ask.approveMinWidth - 2 * Theme.Ask.buttonPadding)
      }
      .buttonStyle(CardButtonStyle(kind: .primary))
      .accessibilityHint("Return approves while the card is focused")
    }
    .disabled(submitting != nil)
  }
  private func label(_ s: String, busy: Bool) -> some View {
    ZStack {
      Text(verbatim: s).opacity(busy ? 0 : 1)
      if busy { ProgressView().controlSize(.mini) }
    }
    .fixedSize()   // the bar's buttons never truncate; the text action and note give way
  }
  private func decidedText(_ status: String, _ by: String?, _ already: Bool) -> String {
    let who = by.map { " by \($0)" } ?? ""
    if already { return "Already \(status)\(who)" }
    return status == "approved" ? "Approved\(who) · merging" : status.prefix(1).uppercased() + String(status.dropFirst()) + who
  }
}

/// The chevron that shows or hides the agent tree. A click animates the rows; the keyboard doesn't.
struct TreeChevron: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let projectId: String
  let open: Bool
  var body: some View {
    Button {
      let keyboard = NSApp.currentEvent?.type == .keyDown
      var t = Transaction(animation: keyboard ? nil : reduceMotion ? Theme.Ask.reduced : Theme.Ask.shift)
      t.disablesAnimations = keyboard
      withTransaction(t) { if open { model.treeShown.remove(projectId) } else { model.treeShown.insert(projectId) } }
    } label: {
      Image(systemName: "chevron.down").font(Theme.Ask.chevronFont).foregroundStyle(Theme.Ask.text3)
        .rotationEffect(.degrees(open ? 180 : 0))
        .frame(width: Theme.Ask.chevron, height: Theme.Ask.chevron)
        .contentShape(RoundedRectangle(cornerRadius: Theme.Ask.chevronRadius, style: .continuous))
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(open ? "Hide the agents" : "Show the agents")
  }
}

/// The bar's buttons (.btn): 28 pt, 7 pt corners. Primary is the inverted fill, ghost a 0.5 pt outline.
struct CardButtonStyle: ButtonStyle {
  enum Kind { case primary, ghost }
  let kind: Kind
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Ask.buttonRadius, style: .continuous)
    configuration.label
      .font(kind == .primary ? Theme.Ask.approveFont : Theme.Ask.buttonFont)
      .foregroundStyle(kind == .primary ? Theme.Ask.approveText : Theme.Ask.text)
      .padding(.horizontal, Theme.Ask.buttonPadding)
      .frame(height: Theme.Ask.buttonHeight)
      .background {
        if kind == .primary { shape.fill(Theme.Ask.approveFill) }
        else { shape.fill(configuration.isPressed ? Theme.Ask.ghostPressed : .clear).overlay(shape.strokeBorder(Theme.Ask.ghostStroke, lineWidth: Theme.Ask.ghostStrokeWidth)) }
      }
      .contentShape(shape)
      .opacity(enabled ? 1 : Theme.Approval.disabledOpacity)
      .modifier(PressFeedback(isPressed: configuration.isPressed))
  }
}

/// A text action in the bar (View diff, Hide, Open thread): secondary text, no chrome.
struct CardTextButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(Theme.Ask.textButtonFont).foregroundStyle(Theme.Ask.text2)
      .padding(.horizontal, 2).frame(height: Theme.Ask.buttonHeight).contentShape(Rectangle())
      .modifier(PressFeedback(isPressed: configuration.isPressed))
  }
}

/// A finished project's newest run, folded to its outcome: its crew, the run's title, how it ended (a mark) and how long
/// it took, the goal when the title doesn't already say it, then what landed (files, lines, checks, cost) or why it
/// failed. ⌘1 opens it, like the Recent rows below it.
struct OutcomeRow: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let project: Project
  var body: some View {
    if let o = model.outcome(project) {
      let title = project.title
      Button { model.open(run: o.runId) } label: {
        VStack(alignment: .leading, spacing: 0) {
          // The top row keeps the Active card's shape: the title, then how it ended (a mark) by the time it took.
          HStack(alignment: .firstTextBaseline, spacing: Theme.Ask.topGap) {
            // The title names the work (untrusted: verbatim, never markdown); a better one (the merged work's) crossfades in.
            ZStack(alignment: .leading) {
              Text(verbatim: title).font(Theme.Ask.titleFont).tracking(Theme.Ask.titleTracking).foregroundStyle(Theme.Ask.text)
                .lineLimit(1).truncationMode(.tail)
                .id(title).transition(reduceMotion ? .opacity : .blurFade(Theme.Ask.tickerBlur))
            }
            .animation(reduceMotion ? Theme.Ask.reduced : Theme.Ask.ticker, value: title)
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(project.fullTitle)
            FinishSparkle(endedAtMs: model.run(o.runId)?.endedAtMs)
            HStack(alignment: .firstTextBaseline, spacing: Theme.Ask.markGap) {
              OutcomeMark(end: o.end, label: o.head, tooltip: false)
              if let d = o.durationMs { Text(verbatim: elapsedClock(ms: d)).font(Theme.Ask.timeFont).foregroundStyle(Theme.Ask.text3).monospacedDigit() }
            }
            .fixedSize()
            .help(o.durationMs.map { "\(o.head) · took \(spokenDuration(ms: $0))" } ?? o.head)
          }
          if let goal = project.goalLine {
            Text(verbatim: goal).font(Theme.Ask.goalFont).foregroundStyle(Theme.Ask.text2).lineLimit(1).truncationMode(.tail)
              .padding(.top, Theme.Ask.outcomeGoalTop)
          }
          // Where the Active card's crew said what it was doing, the crew and what landed.
          if !o.crew.isEmpty || Self.hasStats(o) {
            HStack(spacing: Theme.Ask.lineGap) {
              if !o.crew.isEmpty { CrewHeads(members: o.crew) }
              stats(o)
            }
            .frame(height: Theme.Ask.lineHeight)
            .padding(.top, Theme.Ask.lineTop)
          }
        }
        .padding(Theme.Ask.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.Ask.fill))
        .contentShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
      }
      .buttonStyle(PressableStyle())
      .keyboardShortcut("1", modifiers: .command)
      .onAppear { model.loadOutcomeFiles(o.runId) }
      .accessibilityLabel(spoken(o))
      .accessibilityHint("Opens the run (Command-1)")
    }
  }

  @ViewBuilder private func stats(_ o: CardOutcome) -> some View {
    HStack(spacing: Theme.Ask.statsGap) {
      if let f = o.failure {
        // The ✕ is the top row's mark: here only why.
        Text(verbatim: f.firstLine).font(Theme.Ask.errFont).foregroundStyle(Theme.Ask.text2).lineLimit(1).truncationMode(.tail)
      } else {
        // The ✓ reads as "landed": not on work whose merge was denied or failed.
        if o.checksPassed == true, !o.notMerged { Image(systemName: "checkmark").foregroundStyle(Theme.Ask.green) }
        if let n = o.files {
          Text(verbatim: "\(n) \(n == 1 ? "file" : "files")").foregroundStyle(Theme.Ask.text2)
          if let a = o.added { Text(verbatim: "+\(a)").foregroundStyle(a > 0 ? Theme.Ask.green : Theme.Ask.text3).monospacedDigit() }
          if let r = o.removed { Text(verbatim: "−\(r)").foregroundStyle(r > 0 ? Theme.Ask.red : Theme.Ask.text3).monospacedDigit() }
        }
        if let c = o.checksPassed {
          if o.files != nil { dot }
          Text(verbatim: c ? "checks passed" : "checks failed").foregroundStyle(c ? Theme.Ask.text2 : Theme.Ask.red)
        }
        if let usd = o.costUsd {
          if o.files != nil || o.checksPassed != nil { dot }
          Text(verbatim: Self.money(usd)).foregroundStyle(Theme.Ask.text2).monospacedDigit()
        }
      }
    }
    .font(Theme.Ask.statsFont).lineLimit(1)
  }
  private var dot: some View { Text(verbatim: "·").foregroundStyle(Theme.Ask.text3) }
  static func hasStats(_ o: CardOutcome) -> Bool { o.failure != nil || o.files != nil || o.checksPassed != nil || o.costUsd != nil }
  static func money(_ usd: Double) -> String { usd >= 100 ? String(format: "$%.0f", usd) : String(format: "$%.2f", usd) }

  private func spoken(_ o: CardOutcome) -> String {
    var parts = [project.title, o.head]
    if let g = project.goalLine { parts.append(g) }
    if let d = o.durationMs { parts.append("took \(spokenDuration(ms: d))") }
    if let f = o.failure { parts.append(f.firstLine) }
    if let n = o.files { parts.append("\(n) \(n == 1 ? "file" : "files"), \(o.added ?? 0) lines added, \(o.removed ?? 0) removed") }
    if let c = o.checksPassed { parts.append(c ? "checks passed" : "checks failed") }
    if let usd = o.costUsd { parts.append(Self.money(usd)) }
    return parts.joined(separator: ", ")
  }
}

/// How a finished run ended, as a status mark (SPEC §5's marks, plus merged / merge denied / merge failed): the shape
/// differs per outcome, so it never rests on colour; its words are the tooltip and what VoiceOver reads.
struct OutcomeMark: View {
  let end: CardOutcome.End
  let label: String
  var font: Font = Theme.Ask.markFont
  /// Off where the mark sits in a group with a tooltip of its own.
  var tooltip = true
  var body: some View {
    Image(systemName: Self.symbol(end)).font(font).symbolRenderingMode(.hierarchical).foregroundStyle(Self.tint(end))
      .help(tooltip ? label : "").accessibilityLabel(label)
  }
  static func symbol(_ e: CardOutcome.End) -> String {
    switch e {
    case .merged: "arrow.triangle.merge"
    case .done: "checkmark.circle"
    case .mergeDenied: "hand.raised.slash"
    case .mergeFailed: "exclamationmark.triangle"
    case .failed: "xmark.circle"
    case .stopped: "stop.circle"
    }
  }
  /// Green only for work that landed, red for failures; a decision or a stop isn't one, so it stays grey.
  static func tint(_ e: CardOutcome.End) -> Color {
    switch e {
    case .merged: Theme.Ask.green
    case .done, .mergeDenied: Theme.Ask.text2
    case .mergeFailed, .failed: Theme.Ask.red
    case .stopped: Theme.Ask.text3
    }
  }
}

/// "4 minutes, 12 seconds".
func spokenDuration(ms: Int) -> String {
  let f = DateComponentsFormatter(); f.unitsStyle = .full; f.allowedUnits = [.hour, .minute, .second]; f.maximumUnitCount = 2
  return f.string(from: Double(max(0, ms)) / 1000) ?? shortDuration(ms: ms)
}
func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

/// Opacity with a blur, so two lines crossfading read as one changing (Emil: blur masks the in-between).
struct BlurFade: ViewModifier {
  let blur: CGFloat
  let opacity: Double
  func body(content: Content) -> some View { content.blur(radius: blur).opacity(opacity) }
}
extension AnyTransition {
  static func blurFade(_ radius: CGFloat) -> AnyTransition {
    .modifier(active: BlurFade(blur: radius, opacity: 0), identity: BlurFade(blur: 0, opacity: 1))
  }
}

extension PendingApproval {
  /// A decision that didn't go through can be tried again (the same idempotency key).
  var isRetryable: Bool { if case .failed = decision { return true }; return false }
}
extension ControlState {
  var isSubmitting: Bool { if case .submitting = self { return true }; return false }
  func isRequested(_ a: RunControl) -> Bool { if case .requested(let r) = self { return r == a }; return false }
}
#endif
