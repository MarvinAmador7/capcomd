import re
ns={}; exec(open('tools/genicons.py').read().split("open('icons-sheet.html'")[0],ns)
I,S,svg=ns['I'],ns['S'],ns['svg']
SEC='rgba(235,235,245,.6)'
def ic(k,col,s=13): return svg(I[k][1],col,s)
def st(k,col): return svg(S[k][1],col,12)
src=open('long-follow-iconsA.html').read()
CSS='''<style>.sw{display:flex;gap:5px;font-size:11.5px;font-weight:500;margin-left:auto;margin-right:10px;color:rgba(235,235,245,.3)}.sw .on{color:#fff}
.reg{height:172px!important}
.ph{font-size:10.5px;font-weight:600;color:rgba(235,235,245,.3);height:14px;line-height:14px;padding:0 4px}
.ar{display:grid;grid-template-columns:16px 1fr auto;gap:8px;align-items:center;height:18px;padding:0 4px;font-size:12px;color:rgba(235,235,245,.78)}
.ar>span:first-child{display:flex;justify-content:center}.ar .t{font-family:'JetBrains Mono';font-size:10.5px;color:rgba(235,235,245,.38);display:flex;align-items:center;gap:6px}
.ar.now{color:#fff;font-weight:500}.ar.now .t{color:#fff}.ar.up{color:rgba(235,235,245,.32)}.ar.err{color:rgba(255,105,97,.8)}</style></head>'''
src=src.replace('</head>',CSS)
tm='<span class="tm mono">6:15</span>'
def sw(a): return f'<div class=sw><span{" class=on" if a else ""}>Activity</span><span>·</span><span{"" if a else " class=on"}>Trace</span></div>'+tm
trace=src.replace(tm,sw(False))
B='#0a84ff'
def ar(k,txt,t,cls='',col=SEC,stat=''):
    return f'<div class="ar {cls}"><span>{ic(k,col)}</span><span>{txt}</span><span class=t>{t}{stat}</span></div>'
rows=('<div class=ph>Plan</div>'+ar('plan','Planned the migration','6m ago')+ar('file read','Read the ids/v1 schema','6m ago')+
 '<div class=ph>Build</div>'+ar('sandbox','Started a sandbox','5m ago')+ar('retry','Retried a model call','3m ago','err','rgba(255,105,97,.8)')+
 ar('file write','Writing parquet shards to R2','now','now',B,st('running',B))+
 '<div class=ph>Ship</div>'+ar('tool call','Validate row counts','','up','rgba(235,235,245,.3)',st('queued','rgba(235,235,245,.3)'))+ar('git','Commit to matchkey','','up','rgba(235,235,245,.3)',st('queued','rgba(235,235,245,.3)')))
act=re.sub(r'<div class=lbl>Spans</div>.*?(<div class=seg>)',lambda m:'<div class=reg style="margin-top:14px">'+rows+'</div>'+m.group(1),src.replace(tm,sw(True)),flags=re.S)
trace=trace.replace('<div class=lbl>Spans</div>','<div style="height:10px"></div>')
open('view-activity.html','w').write(act);open('view-trace.html','w').write(trace)
v=open('v5-a-iconsA.html').read()
v=re.sub(r'<svg[^>]*><circle cx="7" cy="7" r="5.6"/><path d="M5.5[^<]*</svg>|<svg(?:(?!<svg).)*?pause[^<]*</svg>','X',v,count=0) if False else v
pass
