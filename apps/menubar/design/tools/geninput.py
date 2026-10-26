import re
ns={}; exec(open('tools/genicons.py').read().split("open('icons-sheet.html'")[0],ns)
I,S,svg=ns['I'],ns['S'],ns['svg']
B='#0a84ff';SEC='rgba(235,235,245,.6)';TER='rgba(235,235,245,.3)'
def P(d,c=SEC,s=12,w=1.5): return f'<svg width="{s}" height="{s}" viewBox="0 0 14 14" fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" style="flex:none">{d}</svg>'
PLUS='<path d="M7 2.5v9M2.5 7h9"/>'; X='<path d="M4.5 4.5l5 5M9.5 4.5l-5 5"/>'
FOLD='<path d="M1.8 4c0-.7.5-1.2 1.2-1.2h2.7l1.3 1.4H11c.7 0 1.2.5 1.2 1.2v4.6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>'
CHEV='<path d="M4.5 5.5L7 8l2.5-2.5"/>'; UP='<path d="M7 11V3M3.5 6.5L7 3l3.5 3.5"/>'
CSS='''<style>
.box{border-radius:10px;background:rgba(255,255,255,.07);padding:9px 10px 8px}
.box.f{background:rgba(255,255,255,.1);box-shadow:0 0 0 .5px rgba(255,255,255,.18),0 0 0 3.5px rgba(10,132,255,.28)}
.ta{font-size:13.5px;line-height:19px;color:#fff;max-height:76px;overflow:hidden}
.ta .ph{color:rgba(255,255,255,.4)}
.car{display:inline-block;width:1.5px;height:15px;background:#0a84ff;vertical-align:-2px;margin-left:1px}
.mn{color:#0a84ff}
.acc{display:flex;align-items:center;gap:5px;margin-top:9px}
.sc{display:flex;align-items:center;gap:4px;font-size:11.5px;color:rgba(255,255,255,.7);background:rgba(255,255,255,.08);border-radius:5px;padding:2px 4px 2px 6px}
.add{width:22px;height:20px;border-radius:5px;display:flex;align-items:center;justify-content:center;gap:1px;border:.5px dashed rgba(255,255,255,.22)}
.mdl{margin-left:auto;display:flex;align-items:center;gap:2px;font-size:11.5px;color:rgba(235,235,245,.55)}
.snd{width:24px;height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.1);margin-left:6px}
.snd.on{background:#0a84ff}
.panel.dim>*:not(.box):not(.sug){opacity:.42}
.sug{margin-top:6px;border-radius:10px;background:rgba(40,44,54,.92);box-shadow:0 0 0 .5px rgba(255,255,255,.14),0 10px 30px rgba(0,0,0,.4);padding:4px}
.si{display:grid;grid-template-columns:16px auto 1fr;gap:8px;align-items:center;height:28px;padding:0 8px;border-radius:6px;font-size:12.5px;color:rgba(255,255,255,.85)}
.si .p{font-family:'JetBrains Mono';font-size:10.5px;color:rgba(235,235,245,.38);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.si.hl{background:#0a84ff;color:#fff}.si.hl .p{color:rgba(255,255,255,.7)}
.card.new{box-shadow:0 0 0 .5px rgba(10,132,255,.45)}
</style></head>'''
v=open('v5-a-final.html').read().replace('</head>',CSS)
IDLE=re.search(r'<div class=in>.*?</div>',v).group(0)
idle_new=f'<div class=in>{P(PLUS,"rgba(255,255,255,.45)",13)}Start a project…<span class=kbd>⌘K</span></div>'
v=v.replace(IDLE,idle_new)
def chip(n): return f'<span class=sc>{P(FOLD,SEC,12,1.2)}{n}{P(X,TER,10,1.4)}</span>'
def acc(chips,on=True):
    return (f'<div class=acc>{"".join(chip(c) for c in chips)}<span class=add>{P(PLUS,SEC,10)}</span>'
     f'<span class=mdl>claude-sonnet{P(CHEV,"rgba(235,235,245,.5)",11)}</span>'
     f'<span class="snd{" on" if on else ""}">{P(UP,"#fff" if on else TER,12,1.8)}</span></div>')
GOAL='Migrate matchkey to v3.2 and backfill addriva_id in ids/v1'
foc=f'<div class="box f"><div class=ta>{GOAL}<span class=car></span></div>{acc(["addriva","ids/v1"])}</div>'
def W(html,name,H=760): open(name+'.html','w').write(html)
W(v,'input-idle')
W(v.replace(idle_new,foc).replace('<div class=panel ','<div class="panel dim" '),'input-focused')
sug=''.join(f'<div class="si{" hl" if i==0 else ""}">{P(FOLD,"#fff" if i==0 else SEC,13,1.2)}<span>{n}</span><span class=p>{p}</span></div>' for i,(n,p) in enumerate([('matchkey','~/code/matchkey'),('matchkey/schemas','~/code/matchkey/schemas'),('migrations','~/code/addriva/migrations')]))
men=f'<div class="box f"><div class=ta>{GOAL} then update <span class=mn>@m</span><span class=car></span></div>{acc(["addriva","ids/v1"])}</div><div class=sug>{sug}</div>'
W(v.replace(idle_new,men).replace('<div class=panel ','<div class="panel dim" '),'input-mention')
run=(f'<div class=runs><div class=run style="grid-template-columns:18px 1fr auto 14px"><span class=g style="display:flex;justify-content:center">{svg(I["plan"][1],B,14)}</span>'
     f'<span class=act>planning</span><span class="tm mono">0:02</span><span style="display:flex">{svg(S["running"][1],B,12)}</span></div></div>')
FC=lambda n:f'<span class=chip><svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="white" stroke-width="1.1"><path d="M1 2.2c0-.6.4-1 1-1h2.6l1.2 1.3H10c.6 0 1 .4 1 1V8c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1z"/></svg>{n}</span>'
card=f'<div class="card new"><div class=t>{GOAL}</div><div class=chips>{FC("addriva")}{FC("ids/v1")}</div>{run}</div>'
sent=v.replace('<div class=sec>Active</div>','<div class=sec>Active</div>'+card,1)
# remove done row to keep height reasonable? keep
W(sent,'input-sent')
# steer
a=open('view-activity.html').read().replace('</head>',CSS+'</head>' if False else CSS)
steer=f'<div class="box" style="margin:10px 0 0;padding:6px 6px 6px 10px;display:flex;align-items:center;gap:8px"><span style="font-size:12.5px;color:rgba(255,255,255,.4);flex:1">Tell the agent…</span><span class=snd style="width:22px;height:22px;margin:0">{P(UP,TER,11,1.8)}</span></div>'
a=a.replace('<div class=acts>',steer+'<div class=acts>')
open('input-steer.html','w').write(a)
