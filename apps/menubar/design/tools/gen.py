BASE = """
*{box-sizing:border-box;margin:0;padding:0}
body{width:760px;height:%(H)spx;overflow:hidden;font-family:'SF Pro Text',Inter,sans-serif;-webkit-font-smoothing:antialiased;color:#f2f2f7;
 background:#0b0d14}
.wall{position:absolute;inset:-40px;background:
 radial-gradient(600px 400px at 15%% 70%%,#2b3a6b 0,transparent 70%%),
 radial-gradient(500px 500px at 85%% 85%%,#5a2e4a 0,transparent 70%%),
 radial-gradient(500px 300px at 60%% 20%%,#1f4a55 0,transparent 70%%),
 radial-gradient(400px 400px at 35%% 35%%,#4a3a24 0,transparent 70%%),#0b0d14;filter:blur(30px)}
.mb{position:absolute;top:0;left:0;right:0;height:28px;background:rgba(20,20,26,.35);backdrop-filter:blur(30px) saturate(1.6);
 display:flex;justify-content:flex-end;align-items:center;gap:18px;padding:0 14px;font-size:13px;font-weight:500;color:rgba(255,255,255,.92)}
.mb .ic{width:16px;height:14px;opacity:.9;display:flex;align-items:center;justify-content:center;font-size:13px}
.cc{position:relative;height:22px;padding:0 7px;border-radius:5px;display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.18)}
.cc .mark{width:14px;height:14px;border:1.6px solid #fff;border-radius:50%%;position:relative}
.cc .mark:after{content:'';position:absolute;inset:3px;background:#fff;border-radius:50%%}
.cc .n{font:600 12px 'JetBrains Mono';}
.cc .dot{position:absolute;top:3px;left:16px;width:6px;height:6px;border-radius:50%%;background:#ffb020;box-shadow:0 0 0 1.5px rgba(30,30,36,.9)}
.mono{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums}
.panel{position:absolute;top:34px;width:380px;left:%(PL)spx;border-radius:16px;overflow:hidden}
"""
MENUBAR = """<div class=wall></div><div class=mb>
<div class=ic>⌁</div><div class=cc><div class=mark></div><span class=n>3</span><div class=dot></div></div>
<div class=ic>◠</div><div class=ic>▭</div><div class=ic>⌕</div><div class=ic>⊜</div><span>Sat Oct 24&nbsp; 8:24 PM</span></div>"""

def page(css, body, H=860, PL=None):
    return f"<html><head><style>{BASE % {'H':H,'PL':PL or 250}}{css}</style></head><body>{MENUBAR}{body}</body></html>"

LOG = [("▫","read src/billing/proration.ts","0.4s"),("▫","read src/billing/invoice.ts","0.3s"),("▹","plan edits · 3 files","2.1s")]

# ---------- A: native glass, system blue
A_css = """
.panel{background:rgba(40,40,48,.52);backdrop-filter:blur(40px) saturate(1.8);border:.5px solid rgba(255,255,255,.18);
 box-shadow:0 0 0 .5px rgba(0,0,0,.6),0 20px 50px rgba(0,0,0,.45);padding:10px}
.in{height:36px;border-radius:9px;background:rgba(255,255,255,.07);display:flex;align-items:center;padding:0 10px;gap:8px;font-size:13.5px;color:rgba(255,255,255,.45)}
.kbd{margin-left:auto;font-size:11.5px;color:rgba(255,255,255,.4);border:.5px solid rgba(255,255,255,.2);border-radius:5px;padding:1px 5px}
.sec{font-size:11px;font-weight:600;color:rgba(255,255,255,.45);margin:14px 6px 6px}
.card{border-radius:11px;background:rgba(255,255,255,.06);padding:12px;margin-bottom:8px}
.row{display:flex;align-items:center;gap:8px}
.t{font-size:13.5px;font-weight:600}.s{font-size:12px;color:rgba(255,255,255,.55)}
.time{margin-left:auto;font-size:13px;color:rgba(255,255,255,.85)}
.bar{display:flex;gap:3px;margin:11px 0 10px}.bar i{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.12)}
.bar i.d{background:#0a84ff}.bar i.a{background:linear-gradient(90deg,#0a84ff 45%,rgba(10,132,255,.35) 45%)}
.log{font-size:11.5px;color:rgba(255,255,255,.6);display:flex;gap:7px;line-height:19px}.log b{font-weight:400;margin-left:auto;color:rgba(255,255,255,.38)}
.g{width:18px;text-align:center;color:#0a84ff}
.amb{color:#ffb020}
.btns{display:flex;gap:8px;margin-top:11px}.btn{flex:1;height:28px;border-radius:7px;font-size:13px;font-weight:500;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.1)}
.btn.p{background:#0a84ff;color:#fff}
.done{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:13px;color:rgba(255,255,255,.7)}
.ft{display:flex;justify-content:space-between;align-items:center;border-top:.5px solid rgba(255,255,255,.1);margin:6px -10px -10px;padding:10px 16px;font-size:12.5px}
.ft .h{color:rgba(255,255,255,.4)}
"""
def logs(cls="log"):
    return "".join(f"<div class={cls}><span>{g}</span><span>{t}</span><b class=mono>{d}</b></div>" for g,t,d in LOG)
A = f"""<div class=panel>
<div class=in><span>＋</span>Start a run…<span class=kbd>⌘K</span></div>
<div class=sec>Running · 2</div>
<div class=card><div class=row><span class=g>◉</span><span class=t>Reading 12 files</span><span class="time mono">0:42</span></div>
<div class=row style="margin:3px 0 0 26px"><span class=s>▹ claude-sonnet &nbsp;·&nbsp; Step 2 of 6</span></div>
<div class=bar><i class=d></i><i class=a></i><i></i><i></i><i></i><i></i></div>{logs()}</div>
<div class=card style="background:rgba(255,176,32,.09);box-shadow:inset 0 0 0 .5px rgba(255,176,32,.35)">
<div class=row><span class="g amb">⌥</span><span class=t>Needs approval</span><span class="time mono amb">1:08</span></div>
<div class="s mono" style="margin:5px 0 0 26px;color:rgba(255,255,255,.8);font-size:12px">git push origin fix/proration</div>
<div class=btns><div class=btn>Deny</div><div class="btn p">Approve</div></div></div>
<div class=done><span style="color:#30d158">✓</span>Done in 13s · 6 files changed<span class=mono style="margin-left:auto;color:rgba(255,255,255,.35);font-size:11.5px">2m ago</span></div>
<div class=ft><span>Open capcomd</span><span class=h>Summon <span class=mono>⌥Space</span></span></div></div>"""

# ---------- B: graphite, amber
B_css = A_css.replace("#0a84ff","#ffb020").replace("rgba(10,132,255,.35)","rgba(255,176,32,.3)") + """
.panel{background:rgba(22,22,24,.96);backdrop-filter:none;border:1px solid rgba(255,255,255,.07);border-radius:14px}
.card{background:#1e1e21;border:1px solid rgba(255,255,255,.05)}
.in{background:#1e1e21;border:1px solid rgba(255,255,255,.06)}
.btn.p{color:#1a1206;font-weight:600}
.sec{text-transform:uppercase;letter-spacing:.06em;font-size:10px;font-family:'JetBrains Mono'}
"""
B = A.replace('style="background:rgba(255,176,32,.09);box-shadow:inset 0 0 0 .5px rgba(255,176,32,.35)"','style="border-color:rgba(255,176,32,.4)"')

# ---------- C: instrument
C_css = """
.panel{background:rgba(18,19,22,.78);backdrop-filter:blur(40px) saturate(1.5);border:.5px solid rgba(255,255,255,.14);box-shadow:0 20px 50px rgba(0,0,0,.5);font-family:'JetBrains Mono';font-size:12px}
.in{display:flex;align-items:center;gap:8px;padding:12px 14px;color:rgba(255,255,255,.4);font-family:Inter;font-size:13px;border-bottom:.5px solid rgba(255,255,255,.08)}
.in .k{margin-left:auto;font-family:'JetBrains Mono';font-size:11px}
.r{display:grid;grid-template-columns:16px 1fr auto 44px;gap:8px;align-items:center;padding:0 14px;height:34px;border-bottom:.5px solid rgba(255,255,255,.06)}
.r .n{font-family:Inter;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r .m{color:rgba(255,255,255,.4);font-size:11px}.r .tm{text-align:right}
.act{background:rgba(255,255,255,.045)}
.x{padding:2px 14px 12px 38px;background:rgba(255,255,255,.045);border-bottom:.5px solid rgba(255,255,255,.06)}
.st{display:flex;gap:2px;margin:4px 0 9px}.st i{flex:1;height:3px;background:rgba(255,255,255,.12)}.st i.d{background:#0a84ff}.st i.a{background:rgba(10,132,255,.5)}
.l{display:flex;gap:8px;color:rgba(255,255,255,.55);font-size:11px;line-height:18px}.l b{margin-left:auto;font-weight:400;color:rgba(255,255,255,.35)}
.btn{font-family:Inter;font-size:12px;font-weight:500;padding:3px 10px;border-radius:6px;background:rgba(255,255,255,.1)}.btn.p{background:#0a84ff}
.ft{display:flex;justify-content:space-between;padding:9px 14px;font-size:11px;color:rgba(255,255,255,.4)}
"""
C = f"""<div class=panel>
<div class=in>›&nbsp;Start a run…<span class=k>⌘K</span></div>
<div class="r act"><span style="color:#0a84ff">◉</span><span class=n>Reading 12 files</span><span class=m>2/6 · sonnet</span><span class=tm>0:42</span></div>
<div class=x><div class=st><i class=d></i><i class=a></i><i></i><i></i><i></i><i></i></div>{logs('l')}</div>
<div class=r style="grid-template-columns:16px 1fr auto auto"><span style="color:#ffb020">⌥</span><span class=n style="color:#ffb020">push fix/proration</span><span class=btn>Deny</span><span class="btn p">Approve</span></div>
<div class=r><span style="color:#30d158">✓</span><span class=n style="color:rgba(255,255,255,.6)">Done · 6 files changed</span><span class=m>2m ago</span><span class=tm style="color:rgba(255,255,255,.5)">13s</span></div>
<div class=ft><span>Open capcomd ↗</span><span>⌥Space</span></div></div>"""

for k,(css,b) in {"a":(A_css,A),"b":(B_css,B),"c":(C_css,C)}.items():
    open(f"v1-{k}.html","w").write(page(css,b, H=(430 if k=="c" else 650)))
