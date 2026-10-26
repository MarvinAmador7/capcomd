import re
exec(open('tools/agenticons.py').read())
ns={}; exec(open('tools/genicons.py').read().split("open('icons-sheet.html'")[0],ns)
I,S,svg=ns['I'],ns['S'],ns['svg']
B='#0a84ff';SEC='rgba(235,235,245,.6)';TER='rgba(235,235,245,.32)';AMB='#ffb020';RED='#ff6961'
FOLD='<svg width="11" height="9" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M1 2.2c0-.6.4-1 1-1h2.6l1.2 1.3H10c.6 0 1 .4 1 1V8c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1z"/></svg>'
def chev(o): return f'<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="{TER}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate({90 if o else 0}deg)"><path d="M3.5 2l3 3-3 3"/></svg>'
CSS='''<style>
.tree{margin:8px -4px 0;padding-top:4px;border-top:.5px solid rgba(255,255,255,.08)}
.tr{display:flex;align-items:center;height:26px;padding:0 4px;font-size:12.5px;color:rgba(255,255,255,.78);border-radius:6px}
.gd{width:16px;height:26px;position:relative;flex:none}
.gd.v:before,.gd.t:before,.gd.l:before{content:"";position:absolute;left:7.5px;top:0;width:.5px;background:rgba(255,255,255,.18)}
.gd.v:before,.gd.t:before{bottom:0}.gd.l:before{height:13px}
.gd.t:after,.gd.l:after{content:"";position:absolute;left:7.5px;top:13px;width:7px;height:.5px;background:rgba(255,255,255,.18)}
.cv{width:12px;display:flex;justify-content:center;flex:none}
.ic{width:16px;display:flex;justify-content:center;margin:0 6px 0 2px;flex:none}
.nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc{display:flex;align-items:center;gap:3px;font-size:11px;color:rgba(235,235,245,.5);margin-left:8px}
.stt{width:14px;display:flex;justify-content:flex-end;margin-left:8px;flex:none}
.sfx{font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.32);margin-left:6px;font-weight:400}.tr.cur{color:#fff;font-weight:500}.tr.dimr{color:rgba(235,235,245,.42)}
.tr.sel{background:rgba(10,132,255,.22);color:#fff}
.apx{margin:2px 0 8px 74px}.apx .q{font-size:12px;color:#fff;font-weight:500;margin-bottom:3px}
.lanes{position:relative;margin-top:6px}
.ln{display:grid;grid-template-columns:138px 1fr;align-items:center;height:24px;font-size:12px;color:rgba(255,255,255,.75)}
.ln .n{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.trk{position:relative;height:24px}
.trk:before{content:"";position:absolute;left:0;right:0;top:11.5px;height:.5px;background:rgba(255,255,255,.07)}
.sg{position:absolute;top:9px;height:6px;border-radius:3px;background:rgba(235,235,245,.35)}
.sg.f{background:#ff6961}.sg.b{background:#0a84ff}.sg.a{background:#ffb020}.sg.q{background:none;border:.5px dashed rgba(235,235,245,.3);height:5px}
.nowl{position:absolute;top:-2px;bottom:-2px;width:1px;background:rgba(10,132,255,.6)}
.axis{display:grid;grid-template-columns:138px 1fr;font:10px 'JetBrains Mono';color:rgba(235,235,245,.3);margin-top:4px}
.axis div{display:flex;justify-content:space-between}
</style></head>'''
def row(g,o,k,name,repo,st=None,cls='',col=SEC):
    gs=''.join(f'<span class="gd {c}"></span>' for c in g)
    cv=chev(o=='o') if o else ''
    s={'run':svg(S['running'][1],B,12),'fail':svg(S['failed'][1],RED,12),'q':svg(S['queued'][1],TER,12),'wait':svg(I['approval'][1],AMB,13)}.get(st,'')
    rc=f'<span class=rc>{FOLD}{repo}</span>' if repo else ''
    return f'<div class="tr {cls}">{gs}<span class=cv>{cv}</span><span class=ic>{svg(picon(name.split()[0].split('<')[0]),col,14)}</span><span class=nm>{name}</span>{rc}<span class=stt>{s}</span></div>'
# ---- card
TREE=(row('','o','agent','Planner','',  'run','cur',B)+
 row('t','','agent','Worker','matchkey')+
 row('t','o','agent','Lead','ids/v1','run','cur',B)+
 row('vt','c','agent','Worker<span class=sfx>d3ce</span>','ids/v1','run')+
 row('vl','','agent','Worker<span class=sfx>4423</span>','ids/v1','wait','',AMB)+
 '<div class=apx><div class=q>Merge backfill into main?</div><div class="cmd mono" style="margin:0 0 8px">fix/backfill → main</div><div class=btns><div class=btn>Deny</div><div class="btn p">Approve</div></div></div>'+
 row('l','','agent','Critic','addriva','q','dimr',TER))
v=open('v5-a-final.html').read().replace('</head>',CSS)
a=v.find('<div class=sec>Active</div>')+len('<div class=sec>Active</div>'); b=v.find('<div class=done>')
FC=lambda n:f'<span class=chip><svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="white" stroke-width="1.1"><path d="M1 2.2c0-.6.4-1 1-1h2.6l1.2 1.3H10c.6 0 1 .4 1 1V8c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1z"/></svg>{n}</span>'
card=f'<div class="card amb"><div class=t>Migrate matchkey to v3.2</div><div class=chips>{FC("matchkey")}{FC("ids/v1")}{FC("addriva")}</div><div class=tree>{TREE}</div></div>'
card2=f'<div class=card style="padding-bottom:4px"><div class=t>Fix proration rounding in billing</div><div class=chips>{FC("relay")}{FC("addriva")}</div><div class=tree>{row("","","agent","Planner","","run","cur",B)}</div></div>'
open('tree-card-v3.html','w').write(v[:a]+card+card2+v[b:])
# ---- detail
d=open('view-activity.html').read().replace('</head>',CSS)
d=d.replace('<div class=crumb>Migrate matchkey to v3.2</div><div class=ttl>Writing parquet shards</div>','<div class=crumb>Migrate matchkey to v3.2</div><div class=ttl>Agents</div>')
d=re.sub(r'<div class=bar style="margin:0 4px 4px">.*?</div>','',d,count=1,flags=re.S)
DT=(row('','o','agent','Planner','','run','cur',B)+
 row('t','','agent','Worker','matchkey')+
 row('t','o','agent','Lead','ids/v1','run','sel',B)+
 row('vt','','agent','Worker<span class=sfx>4423</span>','ids/v1','run','',B)+
 row('vt','','agent','Worker<span class=sfx>ff88</span>','ids/v1','run','',B)+
 row('vt','','agent','Worker<span class=sfx>8b50</span>','ids/v1','fail','',RED)+
 row('vl','','agent','Critic','ids/v1','q','dimr',TER)+
 row('l','','agent','Critic','addriva','q','dimr',TER))
# move switch out of header into a label row above activity
sw=re.search(r'<div class=sw>.*?</div>',d).group(0)
d=d.replace(sw,'')
d=d.replace('<span class="tm mono">6:15</span>','<span class="tm mono" style="margin-left:auto">6:15</span>')
d=d.replace('<div class=reg style="margin-top:14px">',f'<div class=tree style="margin:2px 0 0;border:0">{DT}</div><div style="display:flex;align-items:center;margin:12px 4px 4px;border-top:.5px solid rgba(255,255,255,.08);padding-top:10px"><span style="font-size:12px;font-weight:600;color:#fff">Lead</span>{sw.replace("margin-left:auto;","").replace("<div class=sw>","<div class=sw style=margin-left:auto;margin-right:0>")}</div><div class=reg style="margin-top:0;height:120px!important">')
open('tree-detail-v3.html','w').write(d)
# ---- lanes
def lane(name,ind,segs,col=SEC,cls=''):
    sg=''.join(f'<i class="sg {c}" style="left:{x}%;width:{w}%"></i>' for x,w,c in segs)
    return f'<div class=ln><span class=n style="padding-left:{ind*12}px;{"color:"+TER if cls else ""}">{svg(picon(name.split()[0].split('<')[0]),col,13)}{name}</span><div class=trk>{sg}<i class=nowl style="left:78%"></i></div></div>'
L=(lane('Planner',0,[(0,78,'b')],B)+lane('Schema migrator',1,[(4,26,'')])+lane('Lead',1,[(30,48,'b')],B)+
   lane('Worker<span class=sfx>4423</span>',2,[(34,44,'b')],B)+lane('Worker<span class=sfx>ff88</span>',2,[(36,42,'b')],B)+lane('Worker<span class=sfx>8b50</span>',2,[(38,12,'f')],RED)+
   lane('Merger',2,[(79,12,'q')],TER,1)+lane('Critic',1,[(86,12,'q')],TER,1))
L=L.replace('<i class="sg " style="background:#ff6961" style=','<i class="sg " style="background:#ff6961;')
ax='<div class=axis><span></span><div><span>0:00</span><span>3:00</span><span>6:00</span><span style="color:#0a84ff">now</span><span></span></div></div>'
lanes=re.sub(r'<div class=tree style=.*?</div><div style="display:flex',f'<div class=lanes>{L}</div>{ax}<div style="display:flex',d,count=1,flags=re.S)

