ns={}; exec(open('tools/gen5.py').read().replace("open('v5-a.html','w')","(lambda *a:None)('x','w') and None or open('/dev/null','w')"),ns)
BASE,MB,CSS,CCX=ns['BASE'],ns['MB'],ns['CSS'],ns['CCX']
D="""
.hdr{display:flex;align-items:center;gap:8px;padding:2px 4px 10px}
.back{width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.07)}
.crumb{font-size:11.5px;color:rgba(255,255,255,.45)}.ttl{font-size:15px;font-weight:600;letter-spacing:-.01em;margin-top:1px}
.hdr .tm{margin-left:auto;font-size:13px;color:rgba(255,255,255,.85)}
.lbl{font-size:11px;font-weight:600;color:rgba(255,255,255,.45);margin:12px 4px 6px}
.sp{display:grid;grid-template-columns:16px var(--nw,132px) 1fr 36px;gap:7px;align-items:center;height:22px;padding:0 4px;font-size:12px;color:rgba(255,255,255,.75)}
.sp .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp .gl{text-align:center;color:rgba(255,255,255,.5)}
.trk{position:relative;height:6px}.trk i{position:absolute;top:0;height:6px;border-radius:3px;background:rgba(255,255,255,.28)}
.trk i.b{background:#0a84ff}.trk i.cur{background:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.22)}
.sp .d{text-align:right;font-size:11px;color:rgba(255,255,255,.45)}.sp.now{color:#fff}.sp.now .gl{color:#0a84ff}.sp.now .d{color:rgba(255,255,255,.85)}
.sub{padding-left:14px}
.pane{height:94px}.seg{display:flex;width:150px;margin:12px 0 8px 4px;padding:2px;border-radius:7px;background:rgba(255,255,255,.08)}.seg span{flex:1;text-align:center;font-size:11.5px;font-weight:500;height:20px;line-height:20px;border-radius:5px;color:rgba(255,255,255,.6)}.seg span.on{background:rgba(255,255,255,.2);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.tail{font-size:11px;line-height:17px;color:rgba(255,255,255,.55);padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.18)}
.tail div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tail .ts{color:rgba(255,255,255,.3);margin-right:8px}.tail .l{color:rgba(255,255,255,.85)}
.f{display:grid;grid-template-columns:14px 1fr auto auto;gap:7px;align-items:center;height:22px;padding:0 4px;font-size:12px;color:rgba(255,255,255,.75)}
.f .r{font-size:11px;color:rgba(255,255,255,.4)}.f .add{color:#30d158;font-size:11px}.f .del{color:#ff6961;font-size:11px}
.acts{display:flex;gap:8px;align-items:center;border-top:.5px solid rgba(255,255,255,.1);margin:10px -10px -10px;padding:10px 12px}
.ab{height:26px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;display:flex;align-items:center;background:rgba(255,255,255,.1)}
.ab.term{margin-left:auto;background:none;color:rgba(255,255,255,.75);padding:0 4px}
.win{position:absolute;border-radius:14px;background:rgba(40,40,48,.55);backdrop-filter:blur(40px) saturate(1.8);border:.5px solid rgba(255,255,255,.18);box-shadow:0 0 0 .5px rgba(0,0,0,.6),0 30px 70px rgba(0,0,0,.5);padding:0 14px 14px}
.tb{display:flex;align-items:center;gap:8px;height:38px;margin:0 -14px 6px;padding:0 14px;border-bottom:.5px solid rgba(255,255,255,.08)}
.tl{display:flex;gap:8px}.tl i{width:12px;height:12px;border-radius:50%}
.cols{display:grid;grid-template-columns:310px 1fr;gap:16px}.cols>div{min-width:0}.cols .sp{--nw:140px}
"""
F=ns['F']
SP=[('▹','plan migration <span style="opacity:.4;font-size:10px">▸</span>',0,19,'0:33',''),
 ('⊡','sandbox up',19,23,'0:06',''),('▫','write parquet shards',23,86,'5:12','now'),('▫','validate row counts',86,100,'—','pend'),('⌥','commit to matchkey',93,100,'—','pend')]
def spans(w=1):
    o=''
    for g,n,a,b,d,k in SP:
        cls='now' if k=='now' else ''
        bar='' if k=='pend' else f'<i class="{"cur" if k=="now" else ("b" if 0 else "")}" style="left:{a}%;width:{max(b-a,4)}%"></i>'
        if k=='pend': bar=f'<i style="left:{a}%;width:{b-a}%;border:1px dashed rgba(255,255,255,.18);background:rgba(255,255,255,.1)"></i>'
        o+=f'<div class="sp {cls}"><span class=gl>{g}</span><span class="n{k if k==" sub" else ""}">{n}</span><div class=trk>{bar}</div><span class="d mono">{d}</span></div>'
    return o
LOG=[('20:58:41','shard 116/256 ok  412k rows'),('20:58:44','shard 117/256 ok  409k rows'),('20:58:47','shard 118/256 ok  415k rows'),('20:58:49','<span class=l>writing shard 119 → r2://matchkey/v3.2/…</span>')]
tail='<div class="tail mono">'+''.join(f'<div><span class=ts>{t}</span>{m}</div>' for t,m in LOG)+'</div>'
FILES=[('matchkey/v3.2/schema.json','matchkey','+42','−0'),('ids/v1/join_addriva_id.sql','ids/v1','+18','−3'),('addriva/src/matchkey.ts','addriva','+7','−7')]
files=''.join(f'<div class=f><span style="opacity:.55">▫</span><span class=mono style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p}</span><span class=add>{a}</span><span class=del>{d}</span></div>' for p,r,a,d in FILES)
bar='<div class=bar style="margin:0 4px 4px"><i class=d></i><i class=d></i><i class=d></i><i class=h></i><i></i><i></i></div>'
CHEV='<svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1L1.5 6 6 11"/></svg>'
TERM='<svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="white" stroke-opacity=".75" stroke-width="1.2" stroke-linecap="round"><rect x=".6" y=".6" width="11.8" height="9.8" rx="2"/><path d="M3 4l2 1.6L3 7.2M6.5 7.5h3"/></svg>'
acts=f'<div class=acts><div class=ab>Pause</div><div class=ab>Stop</div><div class="ab term">{TERM}&nbsp; Open in terminal</div></div>'
def page(body,W,H): return f"<html><head><style>{BASE % {'H':H,'PL':0}}body{{width:{W}px}}{CSS}{D}</style></head><body>{MB}{body}</body></html>"
# A
for k in ('log','files'):
  seg='<div class=seg>'+''.join(f'<span class={"on" if k==x.lower() else ""}>{x}</span>' for x in ('Log','Files'))+'</div>'
  pane=tail if k=='log' else '<div style="padding-top:2px">'+files+'</div>'
  A=f"""<div class=panel style="left:{CCX-12}px">
<div class=hdr><div class=back>{CHEV}</div><div><div class=crumb>Migrate matchkey to v3.2</div><div class=ttl>Writing parquet shards</div></div><span class="tm mono">6:15</span></div>
{bar}<div class=lbl>Spans</div>{spans()}{seg}<div class=pane>{pane}</div>{acts}</div>"""
  open(f'drill-a2-{k}.html','w').write(page(A,760,640))
