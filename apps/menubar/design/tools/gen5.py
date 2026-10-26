import re
src=open('tools/gen.py').read()
ns={}; exec(src.split("# ---------- A")[0],ns)
BASE=ns['BASE']
W='rgba(255,255,255,.92)'
svg=lambda b,w=18: f'<svg width="{w}" height="14" viewBox="0 0 {w} 14" fill="none" stroke="{W}" stroke-width="1.4" stroke-linecap="round">{b}</svg>'
ICONS=[svg('<path d="M3 6.5a8.5 8.5 0 0 1 12 0"/><path d="M5.3 8.8a5 5 0 0 1 7.4 0"/><circle cx="9" cy="11.3" r="1.1" fill="white" stroke="none"/>'),
 svg('<rect x="1.5" y="3" width="17" height="8.5" rx="2.4"/><rect x="3.3" y="4.8" width="10" height="4.9" rx="1" fill="white" stroke="none"/><path d="M20.3 6v2.5"/>',22),
 svg('<circle cx="7.5" cy="7" r="4.5"/><path d="M11 10.5l3.5 3"/>',16),
 svg('<rect x="1" y="1.5" width="7" height="4.5" rx="2.25"/><circle cx="5.75" cy="3.75" r="1.3" fill="white" stroke="none"/><rect x="1" y="8" width="7" height="4.5" rx="2.25"/><circle cx="3.25" cy="10.25" r="1.3" fill="white" stroke="none"/><rect x="10" y="1.5" width="7" height="11" rx="2"/>')]
CCX=262  # capcomd icon left
MB=f"""<div class=wall></div><div class=mb style="justify-content:flex-start;padding:0"><div class=cc style="position:absolute;left:{CCX}px;top:3px"><div class=mark></div><span class=n>3</span><div class=dot></div></div>
<div style="position:absolute;left:{CCX+58}px;top:0;height:28px;display:flex;align-items:center;gap:17px">{''.join(ICONS)}<span style="margin-left:2px">Sat Oct 24&nbsp; 8:52 PM</span></div></div>"""
CSS="""
.panel{transform-origin:22px 0;background:rgba(40,40,48,.52);backdrop-filter:blur(40px) saturate(1.8);border:.5px solid rgba(255,255,255,.18);
 box-shadow:0 0 0 .5px rgba(0,0,0,.6),0 20px 50px rgba(0,0,0,.45);padding:10px}
.in{height:36px;border-radius:9px;background:rgba(255,255,255,.07);display:flex;align-items:center;padding:0 10px;gap:8px;font-size:13.5px;color:rgba(255,255,255,.45)}
.kbd{margin-left:auto;font-size:11.5px;color:rgba(255,255,255,.4);border:.5px solid rgba(255,255,255,.2);border-radius:5px;padding:1px 5px}
.sec{font-size:11px;font-weight:600;color:rgba(255,255,255,.45);margin:14px 6px 6px}
.card{border-radius:11px;background:rgba(255,255,255,.06);padding:12px 12px 6px;margin-bottom:8px}
.card.amb{background:rgba(255,176,32,.08);box-shadow:inset 0 0 0 .5px rgba(255,176,32,.35)}
.t{font-size:14px;font-weight:600;letter-spacing:-.01em}
.chips{display:flex;gap:5px;margin-top:7px}.chip{display:flex;align-items:center;gap:4px;font-size:11.5px;color:rgba(255,255,255,.6);background:rgba(255,255,255,.07);border-radius:5px;padding:2px 6px}
.chip svg{opacity:.6}
.stat{font-size:12px;color:rgba(255,255,255,.5);margin-top:8px}.stat .a{color:#ffb020}
.runs{margin:8px -4px 0;border-top:.5px solid rgba(255,255,255,.08)}
.run{display:grid;grid-template-columns:18px 1fr auto 36px 14px;gap:7px;align-items:center;height:32px;padding:0 4px;font-size:12.5px}
.run .act{color:rgba(255,255,255,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.run .repo{font-size:11.5px;color:rgba(255,255,255,.4)}.run .tm{text-align:right;font-size:12px;color:rgba(255,255,255,.8)}
.g{text-align:center;color:#0a84ff}.y{color:#ffb020}.mute{color:rgba(255,255,255,.4)}
.ex{padding:0 4px 8px 29px}
.bar{display:flex;gap:3px;margin:2px 0 8px}.bar i{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.12)}.bar i.d{background:#0a84ff}.bar i.h{background:rgba(10,132,255,.45)}
.log{font-size:11.5px;color:rgba(255,255,255,.55);display:flex;gap:7px;line-height:18px}.log b{font-weight:400;margin-left:auto;color:rgba(255,255,255,.35)}
.cmd{font-size:12px;color:rgba(255,255,255,.6);margin:-6px 0 10px}
.btns{display:flex;gap:8px}.btn{flex:1;height:27px;border-radius:7px;font-size:12.5px;font-weight:500;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.1)}.btn.p{background:#0a84ff}
.done{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:13px;color:rgba(255,255,255,.7)}
.ft{display:flex;justify-content:space-between;border-top:.5px solid rgba(255,255,255,.1);margin:6px -10px -10px;padding:10px 16px;font-size:12.5px}.ft .h{color:rgba(255,255,255,.4)}
"""
F='<svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="white" stroke-width="1.1"><path d="M1 2.2c0-.6.4-1 1-1h2.6l1.2 1.3H10c.6 0 1 .4 1 1V8c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1z"/></svg>'
chips=lambda *c:"<div class=chips>"+"".join(f"<span class=chip>{F}{x}</span>" if not x.startswith('+') else f"<span class=chip>{x}</span>" for x in c)+"</div>"
def run(g,act,repo,tm,st,cls=''):
  if tm=='': return f'<div class=run style="grid-template-columns:18px 1fr auto 14px"><span class="g {cls}">{g}</span><span class=act>{act}</span><span class="repo">{repo}</span><span class="{cls}" style="font-size:11px">{st}</span></div>'
  return f'<div class=run><span class="g {cls}">{g}</span><span class=act>{act}</span><span class="repo">{repo}</span><span class="tm mono">{tm}</span><span class="{cls or "mute"}" style="font-size:11px">{st}</span></div>'
body=f"""<div class=panel style="left:{CCX-12}px">
<div class=in><span>＋</span>Start a project…<span class=kbd>⌘K</span></div>
<div class=sec>Active</div>
<div class="card amb"><div class=t>Fix proration rounding in billing</div>{chips('relay','addriva','apps/tui')}

<div class=runs>{run('⌥','<span style="color:#fff;font-weight:500">Push fix to origin?</span>','relay','','◔','y')}
<div class=ex><div class="cmd mono">git push origin fix/proration</div><div class=btns><div class=btn>Deny</div><div class="btn p">Approve</div></div></div></div></div>
<div class=card><div class=t>Migrate matchkey to v3.2</div>{chips('addriva','ids/v1','matchkey','+2')}

<div class=runs>{run('◉','writing parquet shards','addriva','6:15','⋯')}
<div class=ex><div class=bar><i class=d></i><i class=d></i><i class=d></i><i class=h></i><i></i><i></i></div>
<div class=log><span>▫</span><span>shard 118 / 256 written</span><b class=mono>3.2s</b></div><div class=log><span>▫</span><span>verify row counts</span><b class=mono>0.8s</b></div><div class=log><span>▹</span><span>plan addriva_id join</span><b class=mono>1.9s</b></div></div>
{run('∘','queued: schema check','relay','—','∘','mute')}</div></div>
<div class=done><span style="color:#30d158">✓</span><span style="white-space:nowrap">Launch Addriva Verify docs</span><span class=mute style="margin-left:auto;font-size:12px;white-space:nowrap">Done in 4m · 3 repos</span></div>
<div class=ft><span>Open capcomd</span><span class=h>Summon <span class=mono>⌥Space</span></span></div></div>"""
open('v5-a.html','w').write(f"<html><head><style>{BASE % {'H':760,'PL':0}}{CSS}</style></head><body>{MB}{body}</body></html>")
