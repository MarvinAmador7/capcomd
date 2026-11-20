#!/usr/bin/env python3
"""DRAFT boards: a left side navigation for the desktop window (desktop/leftnav/). Not approved.

Writes NavA/NavB/NavC/NavCompare.dc.html. Each Nav board is the window (1440 x 900, Reel.png's size) and, below it,
the variant's states (#states). Render with tools/renderleftnav.sh. Run from apps/menubar/design.
"""
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "desktop", "leftnav")
B = "../bots/"   # the approved boards' bots
N = "bots/"      # catalog bots made for these boards (packages/bot-avatar, botTeam)

CSS = """
body{margin:0;background:#0b0b0c}
a{color:#F2F2F7;text-decoration:none}
.win,.board{--ground:#0e0e10;--col:#151518;--line:rgba(255,255,255,.08);--text:#F2F2F7;--sec:#A9A9B1;--ter:#8E8E96;--blue:#0A84FF;--amber:#FFB020;--red:#FF6961;--green:#30D158;font-family:-apple-system,"SF Pro Text",Inter,system-ui,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased;font-size:13px;line-height:1.45}
.win *,.board *{box-sizing:border-box}
.mono{font-family:"SF Mono",ui-monospace,"JetBrains Mono",monospace;font-variant-numeric:tabular-nums}
.lights{display:flex;gap:8px}
.lights span{width:12px;height:12px;border-radius:6px;background:#3a3a3e}
.ib{all:unset;box-sizing:border-box;position:relative;width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--ter);cursor:pointer;flex:0 0 auto}
.ib.hov{background:rgba(255,255,255,.06);color:var(--text)}
.ib.on{background:rgba(255,255,255,.10);color:var(--text)}
.follow{all:unset;display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:8px;background:rgba(10,132,255,.16);color:#6CB4FF;font-size:12px;font-weight:500;cursor:pointer}
.badge{position:absolute;top:1px;right:0;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--amber);color:#1D1D1F;font-size:10px;font-weight:700;line-height:15px;text-align:center;box-shadow:0 0 0 2px #0e0e10}
.tp{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px 0 4px;border-radius:9px;color:var(--sec);font-size:12.5px;white-space:nowrap}
.tp img{width:22px;height:22px;image-rendering:pixelated}
.tp.ask{color:var(--text);background:rgba(255,176,32,.14);box-shadow:inset 0 0 0 1px rgba(255,176,32,.55)}
.grp{display:flex;align-items:center;gap:4px;height:44px;padding:0 4px 0 12px;border-radius:13px;background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12)}
.inview{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:rgba(255,255,255,.07)}
.deck{display:inline-flex;align-items:center;gap:9px;height:40px;padding:0 10px 0 9px;border-radius:12px;background:rgba(255,255,255,.05);color:var(--sec);font-size:12.5px;white-space:nowrap}
.deck.ask{box-shadow:inset 0 0 0 1px rgba(255,176,32,.6);color:var(--text)}
.dk{display:inline-flex;align-items:center;flex:0 0 auto}
.dk span{width:22px;height:22px;border-radius:6px;background:#26262a;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px #0e0e10}
.dk span+span{margin-left:-14px}
.dk img{width:16px;height:16px;image-rendering:pixelated}
.dk.sm span{width:20px;height:20px;border-radius:6px}
.dk.sm span+span{margin-left:-13px}
.dk.sm img{width:14px;height:14px}
.dim{opacity:.55}
/* reel */
.reel{flex:1;min-height:0;display:flex;gap:10px;padding:0 0 10px;overflow:hidden}
.col{min-width:0;background:var(--col);border-radius:11px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.09);display:flex;flex-direction:column;overflow:hidden}
.c3 .col{flex:0 0 calc((100% - 88px - 40px) / 3)}
.c2 .col{flex:0 0 calc((100% - 88px - 30px) / 2)}
.ch{height:40px;flex:0 0 40px;display:flex;align-items:center;gap:8px;padding:0 10px 0 12px;font-size:12.5px;white-space:nowrap}
.ch img{width:20px;height:20px;image-rendering:pixelated}
.cb{flex:1;min-height:0;padding:6px 16px 12px;display:flex;flex-direction:column;gap:12px;overflow:hidden;color:#E6E6EC;line-height:1.55}
.tool{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--sec);height:22px}
.tool .d{margin-left:auto;font-size:11px;color:var(--ter)}
.comp{margin:0 12px 12px;display:flex;align-items:center;height:40px;padding:0 12px;border-radius:10px;background:rgba(255,255,255,.06);color:#6f6f77;font-size:13px}
.peek{flex:0 0 44px;background:var(--col);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.07);display:flex;flex-direction:column;align-items:center;padding-top:10px;gap:10px;opacity:.7}
.peek img{width:20px;height:20px;image-rendering:pixelated}
.btn{height:28px;padding:0 12px;border-radius:7px;font:500 12.5px/1 inherit;font-family:inherit;color:var(--text);background:transparent;border:.5px solid rgba(255,255,255,.2);display:inline-flex;align-items:center;gap:6px}
.btn.inv{background:#F2F2F7;color:#1D1D1F;border:0;font-weight:600;min-width:104px;justify-content:center}
.btn.text{border:0;color:var(--sec);padding:0 6px;font-size:12px}
.key{font:600 10.5px/1 inherit;font-family:inherit;padding:2px 4px;border-radius:4px;background:rgba(0,0,0,.14)}
.ln{display:flex;gap:10px;font-size:11.5px;line-height:20px;color:var(--sec)}
.ln .t{color:#6f6f77;width:52px;flex:0 0 52px}
.code{font-size:12px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.07)}
/* the nav */
.side{flex:0 0 auto;display:flex;flex-direction:column;padding:0 10px 10px;min-height:0}
.stop{height:58px;flex:0 0 58px;display:flex;align-items:center;padding:0 0 0 6px}
.place{display:flex;align-items:center;gap:9px;height:30px;padding:0 8px 0 9px;border-radius:8px;color:var(--sec);font-size:13px;white-space:nowrap}
.place svg{color:var(--ter);flex:0 0 auto}
.place.on{background:rgba(255,255,255,.08);color:var(--text)}
.place.on svg{color:var(--text)}
.place.hov{background:rgba(255,255,255,.04);color:var(--text)}
.place .k{margin-left:auto;font-size:11.5px;color:var(--ter)}
.sh{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px 0 9px;margin-top:14px;font-size:11.5px;font-weight:600;color:var(--ter)}
.sh .n{font-weight:400}
.pr{display:flex;align-items:center;gap:10px;height:46px;padding:0 9px 0 10px;border-radius:10px;color:var(--sec);margin-top:2px}
.pr .gl{color:#C7C7CE;flex:0 0 auto;display:inline-flex}
.pr .tx{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.28}
.pr .nm{color:var(--text);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr .st{font-size:11.5px;color:var(--ter);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr .st.a{color:var(--amber)}
.pr.open{background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12)}
.pr.open .nm{font-weight:600}
.pr.ask{box-shadow:inset 0 0 0 1px rgba(255,176,32,.6)}
.pr.hov{background:rgba(255,255,255,.04)}
.pr.done .nm{color:var(--sec)}
.pr.draft{box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);background:transparent;border:0}
.pr.one{height:32px}
.pr .kh{font-size:11.5px;color:var(--ter);margin-right:2px}
.mark{display:inline-flex;color:var(--ter);flex:0 0 auto}
/* C: decks stacked in the sidebar, the open one fanned into its crew */
.sdeck{display:flex;align-items:center;gap:9px;height:38px;padding:0 9px 0 10px;border-radius:11px;background:rgba(255,255,255,.05);color:var(--sec);margin-top:6px;font-size:12.5px}
.sdeck .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.sdeck .gl{color:#C7C7CE;display:inline-flex}
.sdeck.ask{box-shadow:inset 0 0 0 1px rgba(255,176,32,.6);height:46px}
.sdeck.hov{background:rgba(255,255,255,.08)}
.sdeck.done .nm{color:var(--sec)}
.fan{margin-top:6px;border-radius:13px;background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12);padding:4px}
.fanh{display:flex;align-items:center;gap:9px;height:36px;padding:0 6px 0 8px;font-size:13px}
.fanh .gl{color:#C7C7CE;display:inline-flex}
.crow{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px 0 6px;border-radius:8px;font-size:12.5px;color:var(--sec);white-space:nowrap}
.crow img{width:18px;height:18px;image-rendering:pixelated;flex:0 0 auto}
.crow .s{margin-left:auto;font-size:11px;color:var(--ter)}
.crow.ask{color:var(--text);background:rgba(255,176,32,.14);box-shadow:inset 0 0 0 1px rgba(255,176,32,.55)}
.crow.ask .s{color:var(--amber)}
.crow.in{color:var(--text)}
.bracket{margin:1px 0;padding:2px;border-radius:10px;background:rgba(255,255,255,.06)}
/* the rail */
.rail{flex:0 0 60px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:2px 0 12px}
/* the board around the window */
.board{background:#0b0b0c;color:var(--text);box-sizing:border-box}
.frame{background:#0e0e10;border-radius:12px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12);overflow:hidden;position:relative}
.cap{margin:14px 0 0;font-size:13px;line-height:1.55;color:var(--sec)}
.cap b{color:var(--text);font-weight:600}
.h1{font-family:-apple-system,"SF Pro Display",Inter,system-ui,sans-serif;font-size:30px;font-weight:600;letter-spacing:-.022em;margin:0}
.h2{font-size:13px;font-weight:600;margin:0 0 10px;color:var(--text)}
.draft-tag{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:11px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.3);font-size:11.5px;font-weight:600;color:var(--sec);letter-spacing:.02em}
.lbl{position:absolute;font-size:11.5px;color:var(--ter);white-space:nowrap;display:flex;align-items:center;gap:6px}
.lbl::before{content:"";width:18px;height:.5px;background:rgba(255,255,255,.28)}
.kbd{display:grid;grid-template-columns:96px 1fr;row-gap:6px;font-size:12.5px;color:var(--sec)}
.kbd span:nth-child(odd){color:var(--text);font-family:-apple-system,"SF Pro Text",Inter,sans-serif}
.menu{background:#232326;border-radius:13px;padding:6px;box-shadow:0 0 0 .5px rgba(255,255,255,.14),0 18px 40px rgba(0,0,0,.5);display:flex;flex-direction:column}
.mi{display:flex;align-items:center;gap:10px;height:30px;padding:0 10px;border-radius:7px;font-size:13px;color:var(--text);white-space:nowrap}
.mi .k{margin-left:auto;font-size:12px;color:var(--ter)}
.mi .gl{color:#C7C7CE;display:inline-flex}
.sep{height:.5px;background:rgba(255,255,255,.1);margin:5px 6px}
.glass{background:rgba(36,36,40,.72);-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18),0 18px 40px rgba(0,0,0,.45)}
table.cmp{width:100%;border-collapse:collapse;font-size:12.5px;line-height:1.5}
table.cmp th{text-align:left;font-weight:600;color:var(--ter);font-size:11.5px;padding:10px 14px 10px 0;vertical-align:top;width:150px}
table.cmp td{padding:10px 16px 10px 0;color:var(--sec);vertical-align:top;border-top:.5px solid rgba(255,255,255,.08)}
table.cmp tr:first-child td,table.cmp tr:first-child th{border-top:0}
table.cmp th{border-top:.5px solid rgba(255,255,255,.08)}
table.cmp td b{color:var(--text);font-weight:500}
.good{color:var(--text)}
/* one file, two renders: the window, or (#states) its states */
html.st #window{display:none !important}
"""

# ---- glyphs ------------------------------------------------------------------------------------------------------
CLOUD = '<svg width="16" height="12" viewBox="0 0 16 12" role="img" aria-label="Cloud"><path d="M4.6 10.6h7.1a2.8 2.8 0 00.5-5.6 4 4 0 00-7.7-.8A3.2 3.2 0 004.6 10.6z" stroke="currentColor" fill="none" stroke-width="1.2" stroke-linejoin="round"/></svg>'
LOCAL = '<svg width="16" height="12" viewBox="0 0 16 12" role="img" aria-label="Local"><rect x="2.6" y="1.6" width="10.8" height="7.2" rx="1.2" stroke="currentColor" fill="none" stroke-width="1.2"/><path d="M.9 10.6h14.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
HOME = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.2 8 2.8l5.5 4.4v6.3H9.6V10H6.4v3.5H2.5z" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linejoin="round"/></svg>'
CREW = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="5" width="11.6" height="8.3" rx="2.4" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M8 5V2.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="2.2" r="1" fill="currentColor"/><rect x="5.2" y="8.1" width="1.6" height="1.9" rx=".5" fill="currentColor"/><rect x="9.2" y="8.1" width="1.6" height="1.9" rx=".5" fill="currentColor"/></svg>'
HIST = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.7 8.2A5.3 5.3 0 1 0 4.3 4.3" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/><path d="M2.3 2.4v2.5h2.5" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5.2v3l2.1 1.4" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
GEAR = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="currentColor" fill="none" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linejoin="round"/></svg>'
SIDEBAR = '<svg width="17" height="15" viewBox="0 0 17 15" aria-hidden="true"><rect x="1.2" y="1.5" width="14.6" height="12" rx="2.6" stroke="currentColor" fill="none" stroke-width="1.25"/><path d="M6.2 1.5v12" stroke="currentColor" stroke-width="1.25"/><path d="M3 4.6h1.5M3 6.8h1.5M3 9h1.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>'
PLUS = '<svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>'
CMD = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5h5v5h-5zM5.5 5.5V4a1.5 1.5 0 10-1.5 1.5h1.5zM10.5 5.5H12a1.5 1.5 0 10-1.5-1.5v1.5zM10.5 10.5V12a1.5 1.5 0 101.5-1.5h-1.5zM5.5 10.5H4a1.5 1.5 0 101.5 1.5v-1.5z" stroke="currentColor" fill="none" stroke-width="1.2"/></svg>'
EYE = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>'
CHEV = '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>'
CHEVR = '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>'
PAUSE = '<svg width="12" height="12" viewBox="0 0 12 12" role="img" aria-label="Paused"><rect x="3" y="2.5" width="2" height="7" rx=".6" fill="currentColor"/><rect x="7" y="2.5" width="2" height="7" rx=".6" fill="currentColor"/></svg>'
CHECK = '<svg width="12" height="12" viewBox="0 0 12 12" role="img" aria-label="Finished"><path d="M2.5 6.4 5 8.8l4.6-5.6" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
SEARCH = '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M9.2 9.2 12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

LIGHTS = '<div class="lights" aria-hidden="true"><span></span><span></span><span></span></div>'
RIGHT = (f'<button class="follow" aria-pressed="true">{EYE}Follow</button>'
         f'<button class="ib" aria-label="Actions (⌘K)">{CMD}</button>'
         f'<button class="ib" aria-label="New project (⇧⌘N)">{PLUS}</button>')

# ---- the five projects ---------------------------------------------------------------------------------------------
MK = [B + "mk-planner-0-xs.svg", B + "mk-lead-1-xs.svg", B + "mk-worker-3-xs.svg"]
PR = [B + "pr-planner-0-xs.svg", B + "pr-worker-1-xs.svg", B + "pr-critic-2-xs.svg"]
BF = [N + "bf-planner-0-xs.svg", N + "bf-lead-1-xs.svg", N + "bf-worker-2-xs.svg"]
NB = [N + "nb-planner-0-xs.svg", N + "nb-worker-1-xs.svg"]
SB = [N + "sb-planner-0-xs.svg", N + "sb-worker-1-xs.svg", N + "sb-critic-2-xs.svg"]

PROJECTS = [
    # key, name, cloud, heads, state line, kind
    ("mk", "Migrate matchkey", True, MK, "4423 asks", "open"),
    ("pr", "Fix proration", False, PR, "relay asks", "ask"),
    ("bf", "Backfill addriva_id", True, BF, "backfilling, 41%", "run"),
    ("nb", "Nightly bumps", False, NB, "usage limit · back 15:40", "paused"),
    ("sb", "Billing test speed", False, SB, "ready for a PR · 1 h", "done"),
]


def heads(srcs, cls="dk sm", dim=False):
    inner = "".join(f'<span><img src="{s}" alt=""></span>' for s in srcs)
    return f'<span class="{cls}{" dim" if dim else ""}" aria-hidden="true">{inner}</span>'


def pr_row(p, extra="", keyhint=None):
    key, name, cloud, hs, line, kind = p
    cls = "pr"
    if kind == "open":
        cls += " open"
    if kind == "ask":
        cls += " ask"
    if kind == "done":
        cls += " done"
    if extra:
        cls += " " + extra
    st_cls = "st a" if kind in ("open", "ask") else "st"
    right = heads(hs, dim=(kind == "done"))
    if keyhint:
        right = f'<span class="kh">{keyhint}</span>' + right
    cur = ' aria-current="page"' if kind == "open" else ""
    return (f'<a href="#" class="{cls}"{cur} aria-label="{name}, {line}"><span class="gl">{CLOUD if cloud else LOCAL}</span>'
            f'<span class="tx"><span class="nm">{name}</span><span class="{st_cls}">{line}</span></span>{right}</a>')


def place(icon, label, on=False, hov=False, key=None):
    cls = "place" + (" on" if on else "") + (" hov" if hov else "")
    k = f'<span class="k">{key}</span>' if key else ""
    cur = ' aria-current="page"' if on else ""
    return f'<a href="#" class="{cls}"{cur}>{icon}{label}{k}</a>'


# ---- the reel (the approved Reel board's columns) -------------------------------------------------------------------
LEAD_COL = f'''<section class="col" aria-label="lead Nugget">
      <div class="ch"><img src="{B}mk-lead-1-small.svg" alt=""><span style="font-weight:600">lead</span><span style="color:var(--ter)">Nugget</span><span style="font-size:11.5px;color:var(--sec)">· working</span><span style="flex:1"></span><span style="font-size:11px;color:var(--ter)">ids/v1</span><span class="mono" style="font-size:11px;color:var(--ter)">14:02</span></div>
      <div class="cb">
        <div>I'll split ids/v1 across three workers: d3ce writes the shards, 4423 fixes the join, 9b1f takes over at shard 200 if d3ce stalls.</div>
        <div>
          <div class="tool"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5h5.5L11 4v8.5H3z" stroke="currentColor" fill="none" stroke-width="1.1"/></svg>Read the ids/v1 schema<span class="d mono">0.4s</span></div>
          <div class="tool"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4.5 9.5l5-5M9.5 4.5h-3M9.5 4.5v3" stroke="currentColor" fill="none" stroke-width="1.1" stroke-linecap="round"/></svg>Spawned three workers<span style="display:inline-flex;gap:2px;margin-left:4px"><img src="{B}mk-worker-2-xs.svg" alt="" style="width:14px;height:14px"><img src="{B}mk-worker-3-xs.svg" alt="" style="width:14px;height:14px"><img src="{B}mk-worker-4-xs.svg" alt="" style="width:14px;height:14px"></span><span class="d mono">0.9s</span></div>
        </div>
        <article style="border-radius:10px;background:rgba(255,255,255,.05);padding:10px 12px">
          <div style="display:flex;align-items:center;gap:7px;font-size:12.5px"><img src="{B}mk-worker-3-xs.svg" alt="" style="width:16px;height:16px;image-rendering:pixelated"><span style="font-weight:500">worker 4423</span><span style="color:var(--ter)">handed back</span></div>
          <div style="margin-top:6px;font-size:12.5px">The join matched on raw email, so 4,812 rows fell through. Emails are normalised first now; the tests pass.</div>
        </article>
        <div>Good fix. I'm checking it against the nulls before it goes in.</div>
        <div class="tool" style="color:var(--text)"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.1"/><path d="M4 6l1.5 1.5L4 9" stroke="currentColor" fill="none" stroke-width="1.1"/></svg>Running test/ids/join.test.ts<span class="d mono" style="color:var(--blue)">0:12</span></div>
      </div>
      <div class="comp">Tell lead…</div>
    </section>'''

D3CE_COL = f'''<section class="col" aria-label="worker d3ce Tinker">
      <div class="ch"><img src="{B}mk-worker-2-small.svg" alt=""><span style="font-weight:600">worker</span><span class="mono" style="font-size:10.5px;color:var(--ter)">d3ce</span><span style="color:var(--ter)">Tinker</span><span style="font-size:11.5px;color:var(--sec)">· working</span><span style="flex:1"></span><span class="mono" style="font-size:11px;color:var(--ter)">6:15</span></div>
      <div class="cb">
        <div>Writing the v3.2 shards to <span class="mono code">r2://staging/mk</span>, 256 in all.</div>
        <div style="border-radius:10px;background:#0f0f11;padding:10px 12px" class="mono">
          <div class="ln"><span class="t">21:48:05</span><span>shard 115 written</span></div>
          <div class="ln"><span class="t">21:48:09</span><span style="color:var(--amber)">shard 116 retry 1, model timeout</span></div>
          <div class="ln"><span class="t">21:48:14</span><span>shard 116 written</span></div>
          <div class="ln"><span class="t">21:48:17</span><span>shard 117 written</span></div>
          <div class="ln"><span class="t">21:48:20</span><span style="color:var(--text)">shard 118 written</span></div>
        </div>
        <div>
          <div style="display:flex;align-items:baseline;gap:6px"><span class="mono" style="font-size:20px;font-weight:500">118</span><span class="mono" style="font-size:12px;color:var(--ter)">/ 256</span></div>
          <div style="display:grid;grid-template-columns:repeat(32,1fr);gap:2px;margin-top:8px" role="img" aria-label="118 of 256 shards written"><span style="grid-column:span 15;height:5px;background:var(--blue);border-radius:1px"></span><span style="grid-column:span 17;height:5px;background:rgba(255,255,255,.10);border-radius:1px"></span></div>
        </div>
      </div>
      <div class="comp">Tell worker d3ce…</div>
    </section>'''

ASK_COL = f'''<section class="col" aria-label="worker 4423 Volt, waiting on you" style="box-shadow:inset 0 0 0 1px rgba(255,176,32,.6)">
      <div class="ch"><img src="{B}mk-worker-3-small.svg" alt=""><span style="font-weight:600">worker</span><span class="mono" style="font-size:10.5px;color:var(--ter)">4423</span><span style="color:var(--ter)">Volt</span><span style="font-size:11.5px;color:var(--amber)">· waiting on you</span><span style="flex:1"></span>
        <span style="display:flex;gap:2px"><span class="ib" style="width:24px;height:24px"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7 1.5h3.5V5M5 10.5H1.5V7M10.5 1.5L7 5M1.5 10.5L5 7" stroke="currentColor" fill="none" stroke-width="1.2" stroke-linecap="round"/></svg></span><span class="ib" style="width:24px;height:24px"><svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span></span>
      </div>
      <div class="cb">
        <div>The join matched on raw email. I normalise both sides first, then join on <span class="mono code">email_norm</span>.</div>
        <div style="border-radius:10px;background:#0f0f11;overflow:hidden">
          <div style="display:flex;align-items:center;height:32px;padding:0 12px;font-size:12px;border-bottom:.5px solid var(--line)"><span class="mono" style="flex:1">ids/v1/join_addriva_id.sql</span><span class="mono" style="color:var(--green)">+18</span><span class="mono" style="color:var(--red);margin-left:8px">−3</span></div>
          <div class="mono" style="font-size:11.5px;line-height:21px;padding:4px 0">
            <div style="padding:0 12px;color:var(--sec)">  LEFT JOIN matchkey m</div>
            <div style="padding:0 12px;background:rgba(255,105,97,.10)"><span style="color:var(--red)">−</span>   ON m.email = i.email</div>
            <div style="padding:0 12px;background:rgba(48,209,88,.10)"><span style="color:var(--green)">+</span>   ON m.email_norm = lower(i.email)</div>
            <div style="padding:0 12px;background:rgba(48,209,88,.10)"><span style="color:var(--green)">+</span>  AND m.version = 'v3.2'</div>
          </div>
        </div>
        <div class="tool"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5l2.5 2.5L11 4" stroke="#30D158" fill="none" stroke-width="1.3" stroke-linecap="round"/></svg>Checks passed<span class="d mono">31 s</span></div>
      </div>
      <div style="background:#1f1c17;padding:12px 14px;display:flex;flex-direction:column;gap:8px">
        <h2 style="margin:0;font-size:15px;font-weight:600;letter-spacing:-.015em">Merge worker 4423's work into main?</h2>
        <div style="font-size:11.5px;color:var(--sec)">3 files, +73 −5 · lead and planner wait on it</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:2px"><span class="btn text">View diff</span><span style="flex:1"></span><span class="btn">Deny</span><span class="btn inv">Approve <span class="key">↩</span></span></div>
      </div>
    </section>'''

LIVE_DOT = '<svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" stroke="#0A84FF" stroke-width="1.6" fill="none"/><circle cx="7" cy="7" r="2.4" fill="#0A84FF"/></svg>'
IDLE_DOT = '<svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" stroke="#8E8E96" stroke-width="1.4" fill="none"/></svg>'


def peek(src, dot, left, label):
    r = "0 11px 11px 0" if left else "11px 0 0 11px"
    return f'<a href="#" class="peek" aria-label="{label}" style="border-radius:{r}"><img src="{src}" alt="">{dot}</a>'


REEL3 = (f'<div class="reel c3">{peek(B + "mk-planner-0-small.svg", LIVE_DOT, True, "planner Glint (scroll left)")}'
         f'{LEAD_COL}{D3CE_COL}{ASK_COL}{peek(B + "mk-worker-4-small.svg", IDLE_DOT, False, "worker 9b1f, queued (scroll right)")}</div>')
REEL2 = (f'<div class="reel c2">{peek(B + "mk-lead-1-small.svg", LIVE_DOT, True, "lead Nugget (scroll left)")}'
         f'{D3CE_COL}{ASK_COL}{peek(B + "mk-worker-4-small.svg", IDLE_DOT, False, "worker 9b1f, queued (scroll right)")}</div>')


def crew_tabs(compact=False):
    if compact:  # the approved squeeze: tabs outside the bracket fold into "+n"
        return (f'<a href="#" class="tp"><img src="{B}mk-planner-0-small.svg" alt="">planner</a>'
                f'<span class="inview" aria-label="In view">'
                f'<a href="#" class="tp" style="color:var(--text)"><img src="{B}mk-lead-1-small.svg" alt="">lead</a>'
                f'<a href="#" class="tp" style="color:var(--text)"><img src="{B}mk-worker-2-small.svg" alt="">d3ce</a>'
                f'<a href="#" class="tp ask" aria-current="true"><img src="{B}mk-worker-3-small.svg" alt="">4423<span style="color:var(--amber)">asks</span></a></span>'
                f'<a href="#" class="tp" style="color:var(--ter);padding:0 10px">+2</a>')
    return (f'<a href="#" class="tp"><img src="{B}mk-planner-0-small.svg" alt="">planner</a>'
            f'<span class="inview" aria-label="In view">'
            f'<a href="#" class="tp" style="color:var(--text)"><img src="{B}mk-lead-1-small.svg" alt="">lead</a>'
            f'<a href="#" class="tp" style="color:var(--text)"><img src="{B}mk-worker-2-small.svg" alt="">d3ce</a>'
            f'<a href="#" class="tp ask" aria-current="true"><img src="{B}mk-worker-3-small.svg" alt="">4423<span style="color:var(--amber)">asks</span></a></span>'
            f'<a href="#" class="tp" style="opacity:.6"><img src="{B}mk-worker-4-small.svg" alt="">9b1f</a>'
            f'<a href="#" class="tp" style="opacity:.6"><img src="{B}mk-critic-5-small.svg" alt="">critic</a>')


def open_group(tabs=True, compact=False):
    t = crew_tabs(compact) if tabs else ""
    return (f'<div class="grp" role="group" aria-label="Migrate matchkey to v3.2, open">'
            f'<span style="color:#C7C7CE;display:inline-flex">{CLOUD}</span>'
            f'<span style="display:inline-flex;align-items:center;gap:6px;padding:0 10px 0 6px;font-weight:600;font-size:12.5px;white-space:nowrap">Migrate matchkey<span style="color:var(--ter)">{CHEV}</span></span>{t}</div>')


def deck(p, named=True, ask_line=None):
    key, name, cloud, hs, line, kind = p
    cls = "deck" + (" ask" if kind == "ask" else "")
    trail = ""
    if kind == "paused":
        trail = f'<span class="mark">{PAUSE}</span>'
    if kind == "done":
        trail = f'<span class="mark">{CHECK}</span>'
    if named:
        sub = f'<span style="font-size:10.5px;color:var(--amber)">{ask_line}</span>' if ask_line else ""
        txt = f'<span style="display:flex;flex-direction:column;line-height:1.2"><span style="color:var(--text)">{name}</span>{sub}</span>'
    else:
        txt = ""
    return (f'<a href="#" class="{cls}" aria-label="{name}, {line}"><span style="color:#C7C7CE;display:inline-flex">{CLOUD if cloud else LOCAL}</span>'
            f'{txt}{heads(hs, "dk", dim=(kind == "done"))}{trail}</a>')


def page(title, desc, window, states, height_states):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<meta name="description" content="{desc}">
<script>if (location.hash === "#states") document.documentElement.classList.add("st");</script>
<script src="../support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<style>{CSS}</style>
</helmet>
<!-- DRAFT: a proposal for the owner's review, not approved. Build nothing from it. -->
{window}
{states}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":900}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''


WIN_STYLE = "width:1440px;height:900px;display:flex;background:var(--ground);border-radius:14px;overflow:hidden;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12)"


def bottom_settings():
    return f'<span style="flex:1"></span>{place(GEAR, "Settings")}'


# ==== A: a full sidebar; the decks go ================================================================================
def side_a(width=248, rows=None, places=None, toggle=True, top=True):
    rows = rows if rows is not None else "".join(pr_row(p) for p in PROJECTS)
    places = places if places is not None else (place(HOME, "Home") + place(CREW, "Crew") + place(HIST, "History"))
    t = f'<div class="stop">{LIGHTS}<span style="flex:1"></span><button class="ib" aria-label="Hide the sidebar (⌃⌘S)">{SIDEBAR}</button></div>' if top else ""
    return (f'<aside class="side" aria-label="Navigation" style="width:{width}px">{t}'
            f'<nav aria-label="Places" style="display:flex;flex-direction:column;gap:1px">{places}</nav>'
            f'<div class="sh">Projects<span class="n">5</span></div>'
            f'<nav aria-label="Projects" style="display:flex;flex-direction:column">{rows}</nav>'
            f'{bottom_settings()}</aside>')


def window_a():
    header = (f'<header style="height:58px;flex:0 0 58px;display:flex;align-items:center;gap:8px;padding:0 10px 0 0">'
              f'{open_group()}<span style="flex:1"></span>{RIGHT}</header>')
    return (f'<div class="win" id="window" style="{WIN_STYLE}">{side_a()}'
            f'<div style="flex:1;min-width:0;display:flex;flex-direction:column">{header}{REEL2}</div></div>')


def board_wrap(inner, h):
    return f'<div class="board" id="states" style="width:1440px;min-height:{h}px;padding:56px 64px 64px">{inner}</div>'


def titlebar_strip(left, right=RIGHT, w=1312):
    return (f'<div class="frame" style="width:{w}px;height:60px;display:flex;align-items:center;gap:8px;padding:0 10px 0 16px">'
            f'{left}<span style="flex:1"></span>{right}</div>')


def kbd(rows):
    return '<div class="kbd">' + "".join(f"<span>{k}</span><span>{v}</span>" for k, v in rows) + "</div>"


def states_a():
    collapsed = titlebar_strip(
        f'{LIGHTS}<span style="width:10px"></span><button class="ib" aria-label="Show the sidebar (⌃⌘S), 1 project asks">{SIDEBAR}<span class="badge">1</span></button>{open_group()}')
    rows = (pr_row(PROJECTS[0]) + pr_row(PROJECTS[1]) + pr_row(PROJECTS[2], "hov", "⌘3") + pr_row(PROJECTS[3]) + pr_row(PROJECTS[4]))
    slice_rows = (f'<div class="frame" style="width:268px;height:452px;padding-top:12px">'
                  f'{side_a(268, rows, place(HOME, "Home") + place(CREW, "Crew", hov=True, key="⇧⌘C") + place(HIST, "History"), top=False)}</div>')
    labels = [(48, "hover: its key"), (161, "open: in the reel"), (209, "asks: amber ring"),
              (256, "hover: its key (⌘3)"), (305, "paused: back when"), (353, "finished: quieter")]
    lbl = "".join(f'<span class="lbl" style="left:282px;top:{t}px">{s}</span>' for t, s in labels)
    draft_row = (f'<a href="#" class="pr draft"><span class="gl" style="color:var(--ter)">{LOCAL}</span><span class="tx">'
                 f'<span class="nm" style="color:var(--sec)">Add SSO to the admin app</span><span class="st">on Home · not started</span></span></a>')
    new_rows = draft_row + "".join(pr_row(p if p[5] != "open" else (p[0], p[1], p[2], p[3], p[4], "ask")) for p in PROJECTS[:3])
    slice_new = (f'<div class="frame" style="width:268px;height:452px;padding-top:12px">'
                 f'{side_a(268, new_rows, place(HOME, "Home", on=True, key="⌘0") + place(CREW, "Crew") + place(HIST, "History"), top=False)}</div>')
    many = []
    names = [("Migrate matchkey", True, MK, "4423 asks", "open"), ("Fix proration", False, PR, "relay asks", "ask"),
             ("Backfill addriva_id", True, BF, "backfilling, 41%", "run"), ("Nightly bumps", False, NB, "usage limit · back 15:40", "paused"),
             ("Search reindex", True, SB, "3 workers on the shards", "run"), ("Docs site move", False, PR, "reviewing the redirects", "run"),
             ("Feature flags cleanup", False, NB, "critic is reading", "run")]
    for i, (nm, cl, hs, ln, kd) in enumerate(names):
        many.append(pr_row(("x", nm, cl, hs, ln, kd)))
    filt = (f'<div style="display:flex;align-items:center;gap:7px;height:28px;margin:0 0 4px;padding:0 9px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--ter);font-size:12.5px">{SEARCH}Filter projects</div>')
    many_html = (f'<div class="frame" style="width:268px;height:452px;padding:12px 10px 0">{filt}'
                 f'<div class="sh" style="margin-top:6px">Active<span class="n">7</span></div>{"".join(many)}'
                 f'<div class="sh" style="margin-top:8px">{CHEVR}Finished<span class="n">13</span></div></div>')
    keys = kbd([("⌃⌘S", "Show or hide the sidebar (View › Hide Sidebar; ⌘\\ too)"), ("⌘1 – ⌘9", "The first nine projects, top to bottom"),
                ("⌘0", "Home"), ("⇧⌘C", "Crew"), ("⇧⌘H", "History"), ("⌘,", "Settings (its own window, as today)"),
                ("⇧⌘N", "Home with the composer focused"), ("Tab", "Into the sidebar: ↑ ↓ move, Return opens, type to filter")])
    inner = f'''
  <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:28px"><h1 class="h1">A · Sidebar</h1><span class="draft-tag">DRAFT — proposal, not approved</span></div>
  <h2 class="h2">Collapsed</h2>
  {collapsed}
  <p class="cap" style="max-width:1100px"><b>Hidden, nothing takes its place.</b> ⌃⌘S (or the toggle) hides the sidebar and the reel gets its third column back. The decks don't come back: the projects are reached with ⌘1–9, ⌘K or the toggle, which wears an amber count while a hidden project asks (here: Fix proration). This is A's real cost: with the sidebar hidden you don't see the other projects at all.</p>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:40px">
    <div><h2 class="h2">Rows</h2><div style="position:relative;height:452px">{slice_rows}{lbl}</div>
      <p class="cap"><b>Two lines a project</b>, on the window's ground, no fill: where it runs, its name, one live line (the Home card's sentence, cut at six words), the crew's heads. The open project is the only filled row; a project that asks has the 1 pt amber ring and says who asks. Hover shows its key. A click opens it in the reel (≤ 50 ms, no animation from the keyboard).</p></div>
    <div><h2 class="h2">+ New project</h2>{slice_new}
      <p class="cap"><b>+ stays in the title bar</b> (⇧⌘N): Home opens with the composer focused and Home is selected in the sidebar. While a goal is typed, a quiet row holds its place at the top of the projects; Start turns it into the project's row (0.35 s spring from 6 pt above, as Home's cards) and the reel opens on the planner. Esc with nothing typed removes it.</p></div>
    <div><h2 class="h2">20 projects</h2>{many_html}
      <p class="cap"><b>Active first, finished folded.</b> Active is everything with a run going (running, asking, paused) in the order they started, so rows don't jump; Finished folds to its count. ⌘1–9 number the rows as shown. Typing in the sidebar filters. An asking project is never folded away.</p></div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:40px">
    <div><h2 class="h2">Keyboard</h2>{keys}</div>
    <div><h2 class="h2">What moves</h2><p class="cap" style="margin:0"><b>Out of the title bar:</b> every deck and Home. <b>Stays:</b> the open project (name, menu, crew tabs), Follow, Actions ⌘K, +. <b>Into the sidebar:</b> the projects, Home, Crew (the profiles' future home), History, Settings. Against the approved Reel mode: <b>it replaces the decks</b>, so the title bar no longer shows the other projects; that's a reversal of an approved decision.</p></div>
    <div><h2 class="h2">Performance</h2><p class="cap" style="margin:0">The sidebar is its own view beside the reel's scroll view (the split view's sidebar item), fed by <span class="mono">.projects</span> and <span class="mono">.run(id)</span> changes only, never <span class="mono">.thread</span>: a scroll frame in the reel touches nothing in it. It costs the reel 248 pt: three columns become two at 1440. Toggling slides the reel as a layer (0.25 s ease-out, keyboard instant) and lays it out once, at rest, for its new column count; no text reflows while it moves or while scrolling.</p></div>
  </div>'''
    return board_wrap(inner, 1290)


# ==== B: a slim rail; the decks stay ================================================================================
def rail(home_badge="2", on=None, hov=None):
    def b(icon, label, key, k):
        cls = "ib" + (" on" if on == k else "") + (" hov" if hov == k else "")
        badge = f'<span class="badge">{home_badge}</span>' if (k == "home" and home_badge) else ""
        return f'<a href="#" class="{cls}" aria-label="{label} ({key})" style="width:34px;height:34px;border-radius:9px">{icon}{badge}</a>'
    return (f'<nav class="rail" aria-label="Places">{b(HOME, "Home, 2 projects ask", "⌘0", "home")}{b(CREW, "Crew", "⇧⌘C", "crew")}'
            f'{b(HIST, "History", "⇧⌘H", "hist")}<span style="flex:1"></span>{b(GEAR, "Settings", "⌘,", "set")}</nav>')


def title_decks(compact=False):
    last = "" if compact else deck(PROJECTS[4], False)  # a crop: the finished deck is off its right edge
    return (f'{open_group(compact=compact)}{deck(PROJECTS[1], True, "relay asks")}{deck(PROJECTS[2], False)}'
            f'{deck(PROJECTS[3], False)}{last}')


def window_b():
    header = (f'<header style="height:58px;flex:0 0 58px;display:flex;align-items:center;gap:8px;padding:0 10px 0 16px">'
              f'{LIGHTS}<span style="width:10px"></span><nav aria-label="Projects" style="display:flex;align-items:center;gap:8px;min-width:0">{title_decks()}</nav>'
              f'<span style="flex:1"></span>{RIGHT}</header>')
    body = f'<div style="flex:1;min-height:0;display:flex">{rail()}{REEL3}</div>'
    return f'<div class="win" id="window" style="{WIN_STYLE};flex-direction:column">{header}{body}</div>'


def states_b():
    hidden = titlebar_strip(
        f'{LIGHTS}<span style="width:10px"></span><button class="ib" aria-label="Home (⌘0)">{HOME}</button>{open_group(compact=True)}{deck(PROJECTS[1], True, "relay asks")}{deck(PROJECTS[2], False)}{deck(PROJECTS[3], False)}')
    rail_slice = (f'<div class="frame" style="width:60px;height:420px;display:flex">{rail(on="hist", hov="crew")}</div>'
                  f'<div class="glass" style="position:absolute;left:58px;top:42px;height:26px;padding:0 9px;border-radius:7px;display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">Crew<span style="color:var(--ter)">⇧⌘C</span></div>')
    labels = [(8, "Home: amber count while any project asks"), (88, "History: pressed while it shows")]
    lbl = "".join(f'<span class="lbl" style="left:76px;top:{t + 12}px">{s}</span>' for t, s in labels)
    # Hover to read: labels slide out over the reel as a control-layer overlay; the reel doesn't move.
    over = (f'<div class="frame" style="width:400px;height:420px;display:flex">{rail(home_badge="2")}'
            f'<div class="reel c3" style="flex:1;padding:0;opacity:.9">{peek(B + "mk-planner-0-small.svg", LIVE_DOT, True, "planner")}'
            f'<section class="col" style="flex:0 0 400px"><div class="ch"><img src="{B}mk-lead-1-small.svg" alt=""><span style="font-weight:600">lead</span><span style="color:var(--ter)">Nugget</span></div>'
            f'<div class="cb"><div>I\'ll split ids/v1 across three workers: d3ce writes the shards, 4423 fixes the join.</div></div></section></div>'
            f'<div class="glass" style="position:absolute;left:8px;top:6px;width:196px;border-radius:13px;padding:5px;display:flex;flex-direction:column;gap:1px">'
            f'{place(HOME, "Home", key="⌘0")}{place(CREW, "Crew", hov=True, key="⇧⌘C")}{place(HIST, "History", key="⇧⌘H")}'
            f'<div style="height:262px"></div>{place(GEAR, "Settings", key="⌘,")}</div></div>')
    over_menu = (f'<div class="frame" style="width:400px;height:420px;padding:12px">'
                 f'<div style="display:flex;align-items:center;gap:8px">{deck(PROJECTS[2], False)}{deck(PROJECTS[3], False)}'
                 f'<a href="#" class="deck" style="padding:0 12px;color:var(--text)">+14</a></div>'
                 f'<div class="menu" style="margin:8px 0 0 70px;width:300px">'
                 + "".join(f'<div class="mi"><span class="gl">{g}</span>{n}<span class="k">{k}</span></div>' for g, n, k in [
                     (CLOUD, "Search reindex", "⌘6"), (LOCAL, "Docs site move", "⌘7"), (LOCAL, "Feature flags cleanup", "⌘8"),
                     (CLOUD, "Usage export", "⌘9"), (LOCAL, "Billing test speed", ""), (LOCAL, "Onboarding copy", "")])
                 + f'<div class="sep"></div><div class="mi" style="color:var(--sec)">8 more finished…</div></div></div>')
    keys = kbd([("⌃⌘S", "Show or hide the rail (⌘\\ too)"), ("⌘0", "Home (in the rail now)"), ("⇧⌘C", "Crew"), ("⇧⌘H", "History"),
                ("⌘,", "Settings"), ("⌘1 – ⌘9", "Projects, in the title bar's order (as approved)"), ("⇧⌘N", "Home with the composer focused")])
    inner = f'''
  <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:28px"><h1 class="h1">B · Rail</h1><span class="draft-tag">DRAFT — proposal, not approved</span></div>
  <h2 class="h2">Rail hidden</h2>
  {hidden}
  <p class="cap" style="max-width:1100px"><b>Hidden, the window is the approved Reel again:</b> Home goes back to the title bar beside the traffic lights. The rail holds places, not projects, so hiding it loses nothing you were watching; Crew and History stay one ⌘K away.</p>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:40px">
    <div><h2 class="h2">The rail</h2><div style="position:relative;height:420px">{rail_slice}{lbl}</div>
      <p class="cap"><b>60 pt, under the traffic lights,</b> on the window's ground. 34 pt buttons, the title bar's icon style: hover lightens, the page that shows is pressed. Home wears an amber count while any project asks, since Home is where the asks wait (its Running cards). A tooltip after 0.5 s names each and its key.</p></div>
    <div><h2 class="h2">Hover to read</h2>{over}
      <p class="cap"><b>Rest on the rail for 0.6 s</b> and its labels slide out over the reel (opacity and 6 pt, 0.18 s ease-out), a control-layer surface, so it may be Liquid Glass. It covers the peek and the column's edge for as long as the pointer stays; the reel never moves or reflows.</p></div>
    <div><h2 class="h2">20 projects</h2>{over_menu}
      <p class="cap"><b>Exactly the approved overflow:</b> the decks drop their names, then "+n" lists the rest. The rail doesn't help here. Asks never go into the overflow.</p></div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:40px">
    <div><h2 class="h2">Keyboard</h2>{keys}</div>
    <div><h2 class="h2">What moves</h2><p class="cap" style="margin:0"><b>Out of the title bar:</b> Home only. <b>Stays:</b> the open project and its crew tabs, every deck, Follow, Actions ⌘K, +. + works as today: Home opens with the composer focused (Home is pressed in the rail) and the new project arrives as a deck. Nothing approved is reversed.</p></div>
    <div><h2 class="h2">Performance</h2><p class="cap" style="margin:0">60 pt off the reel: at 1440 it keeps its three columns (417 pt instead of 437). The rail has one live value, the ask count, from <span class="mono">.approvals</span>; nothing in it changes while the reel scrolls. Hiding it changes the reel's width once, at rest (the column count holds above 1340 pt). The hover labels are an overlay: zero layout.</p></div>
  </div>'''
    return board_wrap(inner, 1180)


# ==== C: B's rail opens into a sidebar the decks fold into =========================================================
def crow(src, label, state="", cls="", indent=0):
    s = f'<span class="s">{state}</span>' if state else ""
    return f'<a href="#" class="crow {cls}" style="padding-left:{6 + indent}px"><img src="{src}" alt="">{label}{s}</a>'


def fan():
    return (f'<div class="fan" role="group" aria-label="Migrate matchkey, open">'
            f'<div class="fanh"><span class="gl">{CLOUD}</span><span style="font-weight:600;flex:1;white-space:nowrap">Migrate matchkey</span><span style="color:var(--ter);display:inline-flex">{CHEV}</span></div>'
            f'{crow(B + "mk-planner-0-small.svg", "planner", "working")}'
            f'<div class="bracket" aria-label="In view">'
            f'{crow(B + "mk-lead-1-small.svg", "lead", "ids/v1", "in", 10)}'
            f'{crow(B + "mk-worker-2-small.svg", "d3ce", "118 / 256", "in", 22)}'
            f'{crow(B + "mk-worker-3-small.svg", "4423", "asks", "ask", 22)}</div>'
            f'{crow(B + "mk-worker-4-small.svg", "9b1f", "queued", "", 22)}'
            f'{crow(B + "mk-critic-5-small.svg", "critic", "queued", "", 10)}</div>')


def sdeck(p, extra=""):
    key, name, cloud, hs, line, kind = p
    cls = "sdeck" + (" ask" if kind == "ask" else "") + (" done" if kind == "done" else "") + (" " + extra if extra else "")
    trail = ""
    if kind == "paused":
        trail = f'<span class="mark" title="{line}">{PAUSE}</span>'
    if kind == "done":
        trail = f'<span class="mark">{CHECK}</span>'
    if kind == "ask":
        nm = f'<span style="flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25"><span class="nm">{name}</span><span style="font-size:11px;color:var(--amber)">{line}</span></span>'
    else:
        nm = f'<span class="nm">{name}</span>'
    if extra == "hov":
        trail = f'<span class="kh" style="font-size:11.5px;color:var(--ter)">⌘3</span>' + trail
    return (f'<a href="#" class="{cls}" aria-label="{name}, {line}"><span class="gl">{CLOUD if cloud else LOCAL}</span>{nm}'
            f'{heads(hs, "dk sm", dim=(kind == "done"))}{trail}</a>')


def side_c(width=248, decks=None, places=None, top=True, opened=True):
    places = places if places is not None else (place(HOME, "Home") + place(CREW, "Crew") + place(HIST, "History"))
    decks = decks if decks is not None else (fan() + "".join(sdeck(p) for p in PROJECTS[1:]))
    t = f'<div class="stop">{LIGHTS}<span style="flex:1"></span><button class="ib on" aria-label="Fold the sidebar (⌃⌘S)" aria-pressed="true">{SIDEBAR}</button></div>' if top else ""
    return (f'<aside class="side" aria-label="Navigation" style="width:{width}px">{t}'
            f'<nav aria-label="Places" style="display:flex;flex-direction:column;gap:1px">{places}</nav>'
            f'<div class="sh">Projects<span class="n">5</span></div>'
            f'<nav aria-label="Projects" style="display:flex;flex-direction:column">{decks}</nav>'
            f'{bottom_settings()}</aside>')


def window_c():
    header = (f'<header style="height:58px;flex:0 0 58px;display:flex;align-items:center;gap:8px;padding:0 10px 0 0">'
              f'<span style="flex:1"></span>{RIGHT}</header>')
    return (f'<div class="win" id="window" style="{WIN_STYLE}">{side_c()}'
            f'<div style="flex:1;min-width:0;display:flex;flex-direction:column">{header}{REEL2}</div></div>')


def states_c():
    # Collapsed: B. A crop of the window's top-left at actual size: the rail and the title bar with the decks.
    collapsed = (f'<div class="frame" style="width:1312px;height:250px;display:flex;flex-direction:column">'
                 f'<div style="height:58px;flex:0 0 58px;display:flex;align-items:center;gap:8px;padding:0 10px 0 16px">{LIGHTS}<span style="width:10px"></span>'
                 f'<button class="ib" aria-label="Open the sidebar (⌃⌘S)">{SIDEBAR}</button>{title_decks(compact=True)}<span style="flex:1"></span>{RIGHT}</div>'
                 f'<div style="flex:1;display:flex;min-height:0">{rail()}<div class="reel c3" style="padding-bottom:0">'
                 f'{peek(B + "mk-planner-0-small.svg", LIVE_DOT, True, "planner")}'
                 f'<section class="col"><div class="ch"><img src="{B}mk-lead-1-small.svg" alt=""><span style="font-weight:600">lead</span><span style="color:var(--ter)">Nugget</span><span style="font-size:11.5px;color:var(--sec)">· working</span></div></section>'
                 f'<section class="col"><div class="ch"><img src="{B}mk-worker-2-small.svg" alt=""><span style="font-weight:600">worker</span><span class="mono" style="font-size:10.5px;color:var(--ter)">d3ce</span><span style="font-size:11.5px;color:var(--sec)">· working</span></div></section>'
                 f'<section class="col" style="box-shadow:inset 0 0 0 1px rgba(255,176,32,.6)"><div class="ch"><img src="{B}mk-worker-3-small.svg" alt=""><span style="font-weight:600">worker</span><span class="mono" style="font-size:10.5px;color:var(--ter)">4423</span><span style="font-size:11.5px;color:var(--amber)">· waiting on you</span></div></section>'
                 f'{peek(B + "mk-worker-4-small.svg", IDLE_DOT, False, "9b1f")}</div></div></div>')
    rows = fan() + sdeck(PROJECTS[1]) + sdeck(PROJECTS[2], "hov") + sdeck(PROJECTS[3]) + sdeck(PROJECTS[4])
    slice_rows = f'<div class="frame" style="width:268px;height:600px;padding-top:12px">{side_c(268, rows, top=False)}</div>'
    labels = [(164, "open: fanned out"), (246, "bracket: on screen"), (283, "an ask steps out"),
              (390, "asks: amber ring"), (437, "hover: its key"), (482, "paused, done: a mark")]
    lbl = "".join(f'<span class="lbl" style="left:282px;top:{t}px">{s}</span>' for t, s in labels)
    draft = (f'<a href="#" class="sdeck" style="background:transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)"><span class="gl" style="color:var(--ter)">{LOCAL}</span>'
             f'<span class="nm" style="color:var(--sec)">Add SSO to the admin app</span><span style="font-size:11px;color:var(--ter)">on Home</span></a>')
    folded = [("mk", "Migrate matchkey", True, MK, "4423 asks", "ask")] + PROJECTS[1:]
    new_decks = draft + "".join(sdeck(p) for p in folded)
    slice_new = (f'<div class="frame" style="width:268px;height:600px;padding-top:12px">'
                 f'{side_c(268, new_decks, place(HOME, "Home", on=True, key="⌘0") + place(CREW, "Crew") + place(HIST, "History"), top=False)}</div>')
    many = [("x", "Fix proration", False, PR, "relay asks", "ask"), ("x", "Backfill addriva_id", True, BF, "", "run"), ("x", "Nightly bumps", False, NB, "paused", "paused"),
            ("x", "Search reindex", True, SB, "", "run"), ("x", "Docs site move", False, PR, "", "run"), ("x", "Feature flags cleanup", False, NB, "", "run"),
            ("x", "Usage export", True, BF, "", "run")]
    filt = (f'<div style="display:flex;align-items:center;gap:7px;height:28px;margin:0 0 4px;padding:0 9px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--ter);font-size:12.5px">{SEARCH}Filter projects</div>')
    small_fan = (f'<div class="fan"><div class="fanh"><span class="gl">{CLOUD}</span><span style="flex:1;display:flex;flex-direction:column;line-height:1.25"><span style="font-weight:600">Migrate matchkey</span><span style="font-size:11px;color:var(--amber)">4423 asks</span></span>'
                 f'{heads(MK, "dk sm")}<span style="color:var(--ter);display:inline-flex;margin-left:4px">{CHEVR}</span></div></div>')
    many_html = (f'<div class="frame" style="width:268px;height:600px;padding:12px 10px 0">{filt}'
                 f'<div class="sh" style="margin-top:6px">Active<span class="n">8</span></div>{small_fan}{"".join(sdeck(p) for p in many)}'
                 f'<div class="sh" style="margin-top:10px">{CHEVR}Finished<span class="n">12</span></div></div>')
    keys = kbd([("⌃⌘S", "Open or fold the sidebar (View › Show Sidebar; ⌘\\ too)"), ("⌘1 – ⌘9", "Projects, in the same order folded or open"),
                ("⌃1 – ⌃9", "The open project's agents, the crew list's order"), ("⌘0", "Home"), ("⇧⌘C", "Crew"), ("⇧⌘H", "History"),
                ("⌘,", "Settings"), ("⇧⌘N", "Home with the composer focused")])
    inner = f'''
  <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:28px"><h1 class="h1">C · Folding sidebar</h1><span class="draft-tag">DRAFT — proposal, not approved</span></div>
  <h2 class="h2">Folded (the default): this is B</h2>
  {collapsed}
  <p class="cap" style="max-width:1120px"><b>Folded, the window is the approved Reel plus B's rail:</b> decks and crew tabs in the title bar, three columns, Home/Crew/History in the rail. The sidebar button sits after the traffic lights. <b>Opening it</b> (⌃⌘S, the button, or "+n" when the decks overflow), each deck slides from the title bar to its row and the open project's crew tabs flow into its crew list (transform and opacity, 0.3 s spring without bounce, names fade in over the last 120 ms); folding reverses it. From the keyboard it doesn't animate. The rail becomes the sidebar's places: same icons, same order, now with names.</p>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:40px">
    <div><h2 class="h2">Rows</h2><div style="position:relative;height:600px">{slice_rows}{lbl}</div>
      <p class="cap"><b>The decks, stacked.</b> Each project keeps the look it has in the title bar (where it runs, its name, its crew's heads) so nothing has to be learned twice. The open one is fanned out into its crew in tree order, with the bracket on the columns on screen; this list is the reel's index while the sidebar is open, and a lead's subtree folds like a swarm stack.</p></div>
    <div><h2 class="h2">+ New project</h2>{slice_new}
      <p class="cap"><b>+ stays in the title bar</b> (⇧⌘N): Home with the composer focused, Home selected, every project folded to its deck (the open one keeps its amber "asks"). A quiet deck holds the goal's place while it's typed; Start makes it the project's deck and it fans out on the planner.</p></div>
    <div><h2 class="h2">20 projects</h2>{many_html}
      <p class="cap"><b>Open, it scrolls;</b> active projects first in the order they started, finished ones folded to a count, type to filter. <b>Folded,</b> the title bar does what's approved: names drop, then "+n", whose click opens the sidebar instead of a menu.</p></div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:40px">
    <div><h2 class="h2">Keyboard</h2>{keys}</div>
    <div><h2 class="h2">What moves</h2><p class="cap" style="margin:0"><b>Folded:</b> only Home moves (into the rail), as in B. <b>Open:</b> the decks and the open project's crew tabs move into the sidebar, so the title bar keeps only Follow, Actions ⌘K and +, a quiet drag area. Against the approved decisions: folded, nothing; open, the crew tabs leave the title bar while it shows (an open choice: they could stay there and the sidebar list only the projects).</p></div>
    <div><h2 class="h2">Performance</h2><p class="cap" style="margin:0">Folded, B's numbers. Open, 248 pt: two columns at 1440. The sidebar is its own view fed by <span class="mono">.projects</span>, <span class="mono">.run(id)</span> and <span class="mono">.agent(id)</span>, never <span class="mono">.thread</span>. The crew list follows the reel's leading column (reported once per column crossed), so scrolling moves the bracket, not a layout. The fold moves layers only; the reel is laid out once, at rest, for its new column count.</p></div>
  </div>'''
    return board_wrap(inner, 1650)


# ==== the comparison ===============================================================================================
def compare():
    def card(png, name, idea):
        return (f'<div><img src="{png}" alt="{name}" style="width:100%;border-radius:10px;box-shadow:0 0 0 .5px rgba(255,255,255,.14);display:block">'
                f'<div style="margin-top:12px;font-size:15px;font-weight:600;letter-spacing:-.01em">{name}</div>'
                f'<div style="margin-top:2px;font-size:12.5px;color:var(--sec)">{idea}</div></div>')
    rows = [
        ("Projects live in", "<b>The sidebar</b>, two lines each, always", "<b>The title bar</b>, as decks (approved)", "<b>Decks</b> folded; <b>the sidebar</b> open, as stacked decks"),
        ("Leaves the title bar", "Every deck and Home", "Home only", "Folded: Home. Open: the decks and the crew tabs"),
        ("Reel at 1440 pt", "2 columns (sidebar shown) · 3 hidden", "<b class=good>3 columns</b> (417 pt each, −20)", "<b class=good>3 columns</b> folded · 2 open"),
        ("Layout cost", "One reel relayout per toggle, at rest", "<b class=good>None</b>: fixed rail, labels are an overlay", "Folded none; one relayout per fold, at rest"),
        ("Asks you can see", "In the sidebar; hidden → a count on its toggle", "Decks (amber ring) + a count on Home", "Decks or rows, always; crew asks in the list"),
        ("Discoverability", "<b class=good>Best</b>: every place named", "Weakest: icons, tooltips, hover labels", "Good: named when open, icons when folded"),
        ("20 projects", "<b class=good>Scrolls, filters</b>, finished fold", "Approved overflow: names drop, then +n", "<b class=good>Opens into the list</b>; +n opens it"),
        ("Crew (profiles) gets", "A named place in the list", "A rail button", "A rail button, a named place when open"),
        ("Against approved decisions", "<b>Reverses the decks</b> (flagged)", "<b class=good>Nothing reversed</b>", "Folded nothing; open, crew tabs move"),
        ("Build", "Medium: new list, drop decks", "<b class=good>Small</b>: rail + overlay", "Largest: B + list + the fold motion"),
    ]
    trs = "".join(f"<tr><th>{h}</th><td>{a}</td><td>{b}</td><td>{c}</td></tr>" for h, a, b, c in rows)
    inner = f'''
  <div style="display:flex;align-items:baseline;gap:14px"><h1 class="h1">Left navigation · three ways</h1><span class="draft-tag">DRAFT — proposal, not approved</span></div>
  <p class="cap" style="max-width:1000px;margin-top:10px">Today the window has no sidebar: one project open, the others folded into decks in the title bar. Each variant below gives the app's places (Home, Crew, History, Settings) a home, and says what happens to the decks. Same window as Reel.png, same five projects: two asking, one running in the cloud, one paused at a usage limit, one finished.</p>
  <div style="display:grid;grid-template-columns:150px repeat(3,1fr);gap:0 24px;margin-top:32px">
    <div></div>{card("NavA.png", "A · Sidebar", "A full sidebar replaces the decks.")}{card("NavB.png", "B · Rail", "A 60 pt rail of places; the decks stay.")}{card("NavC.png", "C · Folding sidebar", "B's rail opens into a sidebar the decks fold into.")}
  </div>
  <table class="cmp" style="margin-top:20px"><colgroup><col style="width:174px"><col><col><col></colgroup>{trs}</table>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px">
    <div class="frame" style="padding:20px 22px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)">
      <h2 class="h2" style="font-size:15px">Recommendation: C, folded by default</h2>
      <p class="cap" style="margin:0">Folded, C is B: the approved Reel mode untouched, three columns, and one 60 pt rail that finally gives Crew, History and Settings a place. Opened (⌃⌘S), it becomes the list the decks can't be: twenty projects with live state, the open crew as a tree that scales to a swarm. The reel never reflows while scrolling; a fold costs one layout at rest. The price is two renderings of the projects (decks and rows) and of the crew (tabs and tree) to keep in step, so ship it in two steps: <b>B first</b> (small, reverses nothing), then the sidebar when people keep more projects than the title bar holds.</p>
    </div>
    <div class="frame" style="padding:20px 22px">
      <h2 class="h2" style="font-size:15px">Open choices for the owner</h2>
      <ol class="cap" style="margin:0;padding-left:18px">
        <li><b>Which variant</b> (A, B, C), and whether to ship C as B first.</li>
        <li><b>C open: crew in the sidebar or in the title bar?</b> Drawn: the crew tabs move into the tree. Alternative: they stay up top and the sidebar lists only projects.</li>
        <li><b>Two wide columns or three narrow</b> while a sidebar shows at 1440 (537 pt vs 355 pt).</li>
        <li><b>The toggle key:</b> ⌃⌘S (the macOS standard) with ⌘\\ as an alias, or ⌘\\ only.</li>
        <li><b>The sidebar's surface:</b> the window's ground (drawn, quiet) or Liquid Glass (it's control layer, so allowed).</li>
        <li><b>Places:</b> Home, Crew, History now; do Memory, Triggers and Plugins join when they have screens? History has no design yet.</li>
        <li><b>The amber count</b> on Home (B, C folded) and on A's hidden toggle: yes or no.</li>
      </ol>
    </div>
  </div>'''
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Left navigation: compare</title>
<meta name="description" content="DRAFT: three left navigation variants for the desktop window compared, with a recommendation.">
<script src="../support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>{CSS}</style>
</helmet>
<!-- DRAFT: a proposal for the owner's review, not approved. -->
<div class="board" style="width:1440px;padding:56px 64px 64px">{inner}</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":1290}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''


def main():
    os.makedirs(OUT, exist_ok=True)
    files = {
        "NavA.dc.html": page("Nav A: sidebar", "DRAFT: a full sidebar replaces the title bar's decks.", window_a(), states_a(), 1500),
        "NavB.dc.html": page("Nav B: rail", "DRAFT: a slim rail of places beside the approved decks.", window_b(), states_b(), 1460),
        "NavC.dc.html": page("Nav C: folding sidebar", "DRAFT: the rail opens into a sidebar the decks fold into.", window_c(), states_c(), 1560),
        "NavCompare.dc.html": compare(),
    }
    for name, html in files.items():
        with open(os.path.join(OUT, name), "w") as f:
            f.write(html)
        print("wrote", name)


if __name__ == "__main__":
    main()
