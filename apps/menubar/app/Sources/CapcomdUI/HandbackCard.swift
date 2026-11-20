#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdThread

// Typed hand-backs (ADR-026 §7) in a hand-back card, in thread v2's look: a child's handback@1 as its outcome line, then
// what the parent must decide (right under it, so a clamped card still shows it), what changed (paths in mono), what
// was checked (each with its status on the right, as a tool row says it) and its risks; a reviewer's review-verdict@1
// findings under the seal, each with its severity and where. Only a failure's words take colour (a failed check, Blocked, a blocker); the rest stays grey. Every string is
// agent text, shown verbatim.

/// The body of a typed hand-back's card (`.hb`), under the who line.
package struct HandbackBody: View {
  package let handback: Handback
  package init(handback: Handback) { self.handback = handback }
  package var body: some View {
    VStack(alignment: .leading, spacing: Theme.Handback.sectionGap) {
      outcome
      if !handback.decide.isEmpty { section("Decide") { BulletLines(lines: handback.decide, mark: "?") } }
      if !handback.changed.isEmpty {
        section("Changed") {
          ForEach(Array(handback.changed.enumerated()), id: \.offset) { _, c in
            HStack(alignment: .firstTextBaseline, spacing: Theme.Handback.pathGap) {
              Text(verbatim: c.path).font(Theme.Handback.path).foregroundStyle(Theme.Handback.pathText).lineLimit(1).truncationMode(.middle)
              if let what = c.what { Text(verbatim: what).font(Theme.Handback.note).foregroundStyle(Theme.Handback.noteText).lineLimit(1) }
            }
            .help(c.path)
          }
        }
      }
      if !handback.checked.isEmpty {
        section("Checked") {
          ForEach(Array(handback.checked.enumerated()), id: \.offset) { _, c in
            HStack(alignment: .center, spacing: Theme.Handback.pathGap) {
              Text(verbatim: c.check).font(Theme.Rows.cardFont).foregroundStyle(Theme.Rows.cardText).fixedSize(horizontal: false, vertical: true)
              if let note = c.note { Text(verbatim: note).font(Theme.Handback.note).foregroundStyle(Theme.Handback.noteText).lineLimit(1) }
              Spacer(minLength: Theme.Rows.statusLead)
              CheckResultView(result: c.result)
            }
          }
        }
      }
      if !handback.risks.isEmpty { section("Risks") { BulletLines(lines: handback.risks, mark: "•") } }
    }
    .textSelection(.enabled)
    .accessibilityElement(children: .combine)
  }

  /// "Done  added the parser." The status word leads in the card's medium weight; Blocked takes the failure colour.
  var outcome: some View {
    var s = AttributedString(handback.statusWord)
    s.font = Theme.Rows.verdictFont
    s.foregroundColor = handback.status == .blocked ? Theme.Affect.bad : Theme.Rows.verdictText
    var rest = AttributedString("  " + handback.outcome)
    rest.font = Theme.Rows.cardFont; rest.foregroundColor = Theme.Rows.cardText
    return Text(s + rest).lineSpacing(Theme.Affect.bodySpacing).fixedSize(horizontal: false, vertical: true)
  }

  func section<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Theme.Handback.rowGap) {
      Text(label).font(Theme.Handback.label).foregroundStyle(Theme.Handback.labelText)
      content()
    }
  }
}

/// A check's result on the right of its line, as a tool row says its status: the blue tick (passed), × and "Failed"
/// in the failure colour, "Not run" quietly.
package struct CheckResultView: View {
  package let result: Handback.Result
  package init(result: Handback.Result) { self.result = result }
  package var body: some View {
    Group {
      switch result {
      case .passed: ToolStatusView(status: .done, duration: nil)
      case .failed: ToolStatusView(status: .failed, duration: nil)
      case .notRun: Text("Not run").font(Theme.Rows.statusWord).foregroundStyle(Theme.Rows.statusText)
      }
    }
    .accessibilityLabel(result.word)
  }
}

/// Lines with a mark in the bullet column (13/20, 18 pt indent), as a reviewer's reasons are listed.
package struct BulletLines: View {
  package let lines: [String]
  package let mark: String
  package init(lines: [String], mark: String) { self.lines = lines; self.mark = mark }
  package var body: some View {
    VStack(alignment: .leading, spacing: Theme.Rows.bulletGap) {
      ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          Text(verbatim: mark).foregroundStyle(Theme.Handback.markText).frame(width: Theme.Rows.bulletIndent, alignment: .leading).accessibilityHidden(true)
          Text(verbatim: l).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .font(Theme.Rows.cardFont).foregroundStyle(Theme.Rows.cardText).lineSpacing(Theme.Affect.bodySpacing)
  }
}

/// A reviewer's findings (review-verdict@1), most severe first: "blocker  src/b.txt:1  writes the wrong content". A
/// blocker's word takes the failure colour; other severities and the place are quiet.
package struct FindingsList: View {
  package let findings: [Finding]
  package init(findings: [Finding]) { self.findings = findings }
  package var body: some View {
    VStack(alignment: .leading, spacing: Theme.Rows.bulletGap) {
      ForEach(Array(findings.enumerated()), id: \.offset) { _, f in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          Text(verbatim: "•").frame(width: Theme.Rows.bulletIndent, alignment: .leading).accessibilityHidden(true)
          Text(Self.line(f)).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .font(Theme.Rows.cardFont).foregroundStyle(Theme.Rows.cardText).lineSpacing(Theme.Affect.bodySpacing)
    .textSelection(.enabled)
  }

  package static func line(_ f: Finding) -> AttributedString {
    var out = AttributedString()
    if let sev = f.severity {
      var s = AttributedString(sev.rawValue)
      s.font = Theme.Handback.severity
      s.foregroundColor = sev == .blocker ? Theme.Affect.bad : Theme.Handback.noteText
      out += s + AttributedString("  ")
    }
    if let place = f.place {
      var p = AttributedString(place)
      p.font = Theme.Handback.path; p.foregroundColor = Theme.Handback.noteText
      out += p + AttributedString("  ")
    }
    out += AttributedString(f.text)
    return out
  }
}
#endif
