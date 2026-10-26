C='<circle cx="7" cy="7" r="5.6"/>'
I={
'agent':('person.circle',C+'<circle cx="7" cy="5.7" r="1.9"/><path d="M3.4 11c.9-1.4 2.1-2 3.6-2s2.7.6 3.6 2"/>'),
'model call':('sparkles','<path d="M6 1.8l1.1 3.2 3.2 1.1-3.2 1.1L6 10.4 4.9 7.2 1.7 6.1l3.2-1.1z"/><path d="M11 9.2l.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45z"/>'),
'tool call':('wrench.adjustable','<path d="M9.6 1.8a3 3 0 0 0-3.1 4L2.2 10.1a1.2 1.2 0 0 0 1.7 1.7l4.3-4.3a3 3 0 0 0 4-3.1l-1.7 1.7-1.6-.4-.4-1.6z"/>'),
'file read':('doc.text','<path d="M3 1.5h5l3 3v8H3z"/><path d="M8 1.5v3h3M5 7.5h4M5 10h3"/>'),
'file write':('square.and.pencil','<path d="M7 2.5H3.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7"/><path d="M11 1.6l1.4 1.4L7.2 8.2l-1.9.5.5-1.9z"/>'),
'shell':('terminal','<rect x="1.5" y="2.5" width="11" height="9" rx="2"/><path d="M4 5.5l2 1.5-2 1.5M7.5 9H10"/>'),
'git':('arrow.triangle.branch','<circle cx="4" cy="2.8" r="1.3"/><circle cx="4" cy="11.2" r="1.3"/><circle cx="10" cy="4.5" r="1.3"/><path d="M4 4.1v5.8M10 5.8c0 2.6-6 1.6-6 3.9"/>'),
'sandbox':('shippingbox','<path d="M7 1.5l5 2.5v6L7 12.5 2 10V4z"/><path d="M2 4l5 2.5L12 4M7 6.5v6"/>'),
'approval':('hand.raised','<path d="M4.6 7.2V3.4a.9.9 0 0 1 1.8 0v3.2M6.4 6.2V2.4a.9.9 0 0 1 1.8 0v4M8.2 6.4V3.2a.9.9 0 0 1 1.8 0V8c0 2.6-1.6 4.5-4 4.5-1.6 0-2.6-.8-3.4-2.2L1.6 8.6a.9.9 0 0 1 1.5-1l1.5 1.4"/>'),
'plan':('list.bullet','<path d="M5.2 3.5h7M5.2 7h7M5.2 10.5h7"/><circle cx="2.3" cy="3.5" r=".6" fill="currentColor"/><circle cx="2.3" cy="7" r=".6" fill="currentColor"/><circle cx="2.3" cy="10.5" r=".6" fill="currentColor"/>'),
'network':('globe',C+'<ellipse cx="7" cy="7" rx="2.4" ry="5.6"/><path d="M1.4 7h11.2"/>'),
'retry':('arrow.clockwise','<path d="M11.6 7.4A4.6 4.6 0 1 1 10.2 3.7"/><path d="M10.6 1.4v2.6H8"/>'),
'error':('exclamationmark.triangle','<path d="M7 1.8l5.8 10.2H1.2z"/><path d="M7 5.6v3"/><circle cx="7" cy="10.2" r=".4" fill="currentColor"/>'),
}
S={'running':('circle.dotted.circle',C+'<circle cx="7" cy="7" r="2.4" fill="currentColor" stroke="none"/>'),
'done':('checkmark.circle',C+'<path d="M4.6 7.2l1.7 1.7 3.2-3.5"/>'),
'failed':('xmark.circle',C+'<path d="M5.1 5.1l3.8 3.8M8.9 5.1L5.1 8.9"/>'),
'queued':('clock',C+'<path d="M7 4.2V7l1.9 1.2"/>'),
'paused':('pause.circle',C+'<path d="M5.8 5v4M8.2 5v4"/>')}
def svg(p,col='rgba(235,235,245,.6)',s=14): return f'<svg width="{s}" height="{s}" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:{col};flex:none">{p}</svg>'
BLUE='#0a84ff';RED='#ff6961';SEC='rgba(235,235,245,.6)'
TINT={'model call':BLUE,'git':'#bf8cff','error':RED,'retry':RED,'approval':'#ffb020'}
DOT={'model call':BLUE,'tool call':'#8e8e93','git':'#bf8cff'}
def icon(set_,k,p,state=''):
    col=SEC
    if state=='now': col=BLUE
    if state=='err' or k=='error' and set_=='A': col=RED
    if set_=='A': return svg(p,col)
    if set_=='B':
        t=TINT.get(k); t=RED if state=='err' else t
        bg=(t+'2e') if t else 'rgba(255,255,255,.09)'
        fg=t if t else ('rgba(255,255,255,.85)')
        if state=='now': bg,fg=BLUE+'40',BLUE
        return f'<span style="width:18px;height:18px;border-radius:5px;background:{bg};display:flex;align-items:center;justify-content:center;flex:none">{svg(p,fg,12)}</span>'
    d=DOT.get(k)
    dot=f'<i style="position:absolute;right:-2px;bottom:-1px;width:5px;height:5px;border-radius:50%;background:{d};box-shadow:0 0 0 1.5px #2a2a32"></i>' if d else ''
    return f'<span style="position:relative;display:flex;flex:none">{svg(p,col)}{dot}</span>'
CSS="""*{margin:0;padding:0;box-sizing:border-box}body{background:#0b0d14;font-family:Inter;color:#f2f2f7;-webkit-font-smoothing:antialiased;position:relative;overflow:hidden}
.wall{position:absolute;inset:-40px;background:radial-gradient(600px 400px at 15% 70%,#2b3a6b 0,transparent 70%),radial-gradient(500px 500px at 85% 85%,#5a2e4a 0,transparent 70%),radial-gradient(500px 300px at 60% 20%,#1f4a55 0,transparent 70%),#0b0d14;filter:blur(30px)}
.card{position:absolute;width:360px;border-radius:16px;background:rgba(40,40,48,.6);backdrop-filter:blur(40px) saturate(1.8);border:.5px solid rgba(255,255,255,.18);box-shadow:0 20px 50px rgba(0,0,0,.45);padding:14px}
h2{font-size:14px;font-weight:600}.sub{font-size:11.5px;color:rgba(255,255,255,.45);margin:2px 0 10px}
.r{display:flex;align-items:center;gap:10px;height:24px;font-size:12.5px}.r .k{width:84px;color:rgba(255,255,255,.85)}.r .s{font-family:'JetBrains Mono';font-size:11px;color:rgba(255,255,255,.45)}.ic{width:18px;display:flex;justify-content:center}
.hr{height:.5px;background:rgba(255,255,255,.1);margin:8px 0}.mono{font-family:'JetBrains Mono';font-variant-numeric:tabular-nums}
.sp{display:grid;grid-template-columns:18px 1fr 90px 34px 14px;gap:8px;align-items:center;height:24px;font-size:12px;color:rgba(255,255,255,.75)}
.trk{position:relative;height:6px}.trk i{position:absolute;top:0;height:6px;border-radius:3px}
"""
SETS=[('A','Outline monochrome','Secondary label color · blue only on current span · red on errors'),('B','Tinted fill','18pt tiles · low-opacity tint on model, git, approval, errors'),('C','Hybrid','Outline · 3pt dot on model, tool, git')]
def sheet():
    o=''
    for i,(s,t,d) in enumerate(SETS):
        rows=''.join(f'<div class=r><span class=ic>{icon(s,k,p)}</span><span class=k>{k}</span><span class=s>{n}</span></div>' for k,(n,p) in I.items())
        st={'running':'now','failed':'err'}
        rows+='<div class=hr></div>'+''.join(f'<div class=r><span class=ic>{svg(p,{"running":BLUE,"failed":RED,"done":"#30d158" if s!="A" else SEC}.get(k,SEC))}</span><span class=k>{k}</span><span class=s>{n}</span></div>' for k,(n,p) in S.items())
        o+=f'<div class=card style="left:{24+i*384}px;top:24px"><h2>{s} · {t}</h2><div class=sub>{d}</div>{rows}</div>'
    return f'<html><head><style>{CSS}</style></head><body style="width:1200px;height:640px"><div class=wall></div>{o}</body></html>'
def mrow(s,k,name,a,b,dur,status,state='',ind=0,fold=''):
    col={'now':'#fff','err':RED}.get(state,'rgba(255,255,255,.75)')
    bc={'now':BLUE,'err':RED}.get(state,'rgba(255,255,255,.28)')
    sh='box-shadow:0 0 0 3px rgba(10,132,255,.22);' if state=='now' else ''
    scol={'running':BLUE,'failed':RED}.get(status,'rgba(255,255,255,.35)')
    chev=f'<span style="opacity:.45;font-size:9px;margin-right:5px">{fold}</span>' if fold else ''
    return f'<div class=sp style="color:{col}"><span class=ic>{icon(s,k,I[k][1],state)}</span><span style="padding-left:{ind*14}px;white-space:nowrap;overflow:hidden">{chev}{name}</span><div class=trk><i style="left:{a}%;width:{max(b-a,4)}%;background:{bc};{sh}"></i></div><span class=mono style="text-align:right;font-size:11px;color:{col if state else "rgba(255,255,255,.45)"}">{dur}</span>{svg(S[status][1],scol,12)}</div>'
def trace(s):
    R=[mrow(s,'plan','plan migration',0,6,'0:33','done',fold='▸'),
       mrow(s,'file read','read inputs',6,14,'1:02','done',fold='▸'),
       mrow(s,'model call','model call · retry',14,16,'0:09','failed','err',1),
       mrow(s,'model call','model call',16,19,'0:12','done','',1),
       mrow(s,'sandbox','sandbox up',19,22,'0:06','done',fold='▸'),
       mrow(s,'git','checkout matchkey',22,24,'0:02','done',fold='▸'),
       mrow(s,'file write','write parquet shards',24,97,'5:12','running',fold='▾'),
       mrow(s,'shell','duckdb export',88,92,'0:04','done','',1),
       mrow(s,'network','upload to r2',92,95,'0:03','done','',1),
       mrow(s,'file write','shard 119',95,98,'0:02','running','now',1),
       mrow(s,'tool call','validate row counts',98,100,'—','queued'),
       mrow(s,'approval','approve commit',98,100,'—','queued')]
    return ''.join(R)
def ctx():
    o=''
    for i,(s,t,d) in enumerate(SETS):
        o+=f'''<div class=card style="left:{24+i*384}px;top:24px"><div style="font-size:11.5px;color:rgba(255,255,255,.45)">Migrate matchkey to v3.2</div><h2 style="font-size:15px;margin-bottom:10px">Writing parquet shards</h2>
<div class=sub style="margin:0 0 4px">{s} · {t}</div><div style="-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 28px)">{trace(s)}</div></div>'''
    return f'<html><head><style>{CSS}</style></head><body style="width:1200px;height:420px"><div class=wall></div>{o}</body></html>'
open('icons-sheet.html','w').write(sheet()); open('icons-in-trace.html','w').write(ctx())
