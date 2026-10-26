import re
ns={}; exec(open('tools/genicons.py').read().split("open('icons-sheet.html'")[0],ns)
I,S,svg=ns['I'],ns['S'],ns['svg']
B='#0a84ff';SEC='rgba(235,235,245,.6)';TER='rgba(235,235,245,.32)';RED='#ff6961'
base=open('tree-detail-v2.html').read()
head=base[:base.find('<body')]
MB=base[base.find('<body'):base.find('<div class=panel')]
BACK=re.search(r'<div class=back>.*?</div>',base).group(0)
CSS='''<style>
.th{overflow:hidden;position:relative;margin:0 -12px;padding:2px 16px 0}
.th:after{content:"";position:absolute;left:0;right:0;bottom:0;height:24px;background:linear-gradient(transparent,rgba(30,34,44,.9))}
.p{font-size:13px;line-height:19px;color:rgba(255,255,255,.86);margin:0 0 9px}
.h{font-size:13px;font-weight:600;color:#fff;margin:14px 0 5px}
ul.l{margin:0 0 9px;padding-left:16px;font-size:13px;line-height:19px;color:rgba(255,255,255,.86)}ul.l li{margin:1px 0;padding-left:2px}ul.l li::marker{color:rgba(235,235,245,.4)}
.icd{font:11.5px 'JetBrains Mono';background:rgba(255,255,255,.08);border-radius:4px;padding:1px 4px;color:rgba(255,255,255,.9)}
.pre{background:rgba(0,0,0,.28);border-radius:8px;margin:0 0 10px;overflow:hidden;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.08)}
.pre .bar2{display:flex;justify-content:space-between;font-size:10.5px;color:rgba(235,235,245,.4);padding:5px 10px 0}
.pre pre{margin:0;padding:4px 10px 9px;font:11.5px/17px 'JetBrains Mono';color:rgba(255,255,255,.85);white-space:pre;overflow:hidden}
.k{color:#7cb7ff}.s{color:#a8d4a0}.c{color:rgba(235,235,245,.36)}.n{color:#e3b77a}
table.t{width:100%;border-collapse:collapse;font-size:12px;margin:0 0 10px}
table.t th{text-align:left;font-weight:600;color:rgba(235,235,245,.55);font-size:11px;padding:3px 6px;border-bottom:.5px solid rgba(255,255,255,.14)}
table.t td{padding:4px 6px;color:rgba(255,255,255,.85);border-bottom:.5px solid rgba(255,255,255,.06)}table.t td.m{font-family:'JetBrains Mono';font-size:11px;text-align:right}table.t th.m{text-align:right}
.tc{display:grid;grid-template-columns:16px 1fr auto 10px;gap:8px;align-items:center;height:26px;font-size:12.5px;color:rgba(235,235,245,.7);border-radius:6px;padding:0 6px;margin:0 -6px}
.tc .d{font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.4)}
.tx{margin:0 0 8px 24px;background:rgba(0,0,0,.22);border-radius:7px;padding:7px 9px;font:10.5px/15px 'JetBrains Mono';color:rgba(235,235,245,.7);white-space:pre;overflow:hidden}
.tx .lb{font-family:Inter;font-size:10px;font-weight:600;color:rgba(235,235,245,.38);display:block;margin-bottom:2px}
.thk{display:flex;align-items:center;gap:6px;height:24px;font-size:12px;color:rgba(235,235,245,.42)}
.thb{margin:0 0 9px 6px;padding-left:12px;border-left:1px solid rgba(255,255,255,.12);font-size:12px;line-height:17px;color:rgba(235,235,245,.55)}
.me{display:flex;justify-content:flex-end;margin:6px 0 10px}.me div{max-width:76%;background:rgba(255,255,255,.1);border-radius:13px 13px 4px 13px;padding:6px 11px;font-size:13px;line-height:18px;color:rgba(255,255,255,.9)}
.me + .meta{text-align:right}
.ho{border-radius:10px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.1);padding:9px 10px;margin:0 0 10px}
.ho .r1{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#fff;font-weight:500}.ho .r1 .sfx{font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.32);font-weight:400}
.ho .r1 .go{margin-left:auto}
.ho .sm{font-size:12.5px;line-height:18px;color:rgba(255,255,255,.8);margin:5px 0 7px}
.art{display:inline-flex;align-items:center;gap:4px;font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.6);background:rgba(255,255,255,.07);border-radius:5px;padding:2px 6px;margin-right:4px}
.df{border-radius:8px;overflow:hidden;background:rgba(0,0,0,.25);margin:0 0 10px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.08)}
.df .fh{display:flex;align-items:center;gap:7px;font:11px 'JetBrains Mono';color:rgba(255,255,255,.8);padding:6px 10px;border-bottom:.5px solid rgba(255,255,255,.07)}
.df .fh .st2{margin-left:auto}.ad{color:#30d158}.rm{color:#ff6961}
.df .ln2{font:11px/16px 'JetBrains Mono';padding:0 10px;white-space:pre;color:rgba(235,235,245,.6)}
.df .ln2.a{background:rgba(48,209,88,.1);color:rgba(255,255,255,.9)}.df .ln2.r{background:rgba(255,105,97,.1);color:rgba(255,255,255,.75)}
.df .ln2 b{font-weight:400;display:inline-block;width:12px;color:rgba(235,235,245,.4)}
.sw2{display:flex;gap:5px;font-size:11.5px;font-weight:500;color:rgba(235,235,245,.3)}.sw2 .on{color:#fff}
.steer{display:flex;align-items:center;gap:8px;border-radius:10px;background:rgba(255,255,255,.07);padding:6px 6px 6px 11px;margin:8px 4px 0}
.steer span{flex:1;font-size:12.5px;color:rgba(255,255,255,.4)}
.snd{width:22px;height:22px;border-radius:11px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center}
.win{position:absolute;border-radius:12px;overflow:hidden;background:rgba(30,34,44,.78);backdrop-filter:blur(40px) saturate(1.6);box-shadow:0 0 0 .5px rgba(255,255,255,.16),0 30px 80px rgba(0,0,0,.55)}
.tb{height:38px;display:flex;align-items:center;padding:0 14px;gap:8px;border-bottom:.5px solid rgba(255,255,255,.08)}
.tl{width:12px;height:12px;border-radius:6px;background:rgba(255,255,255,.18)}
.sheet{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;padding:24px}
.cell{border-radius:14px;background:rgba(30,34,44,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.14);padding:12px 16px}
.cap{font-size:10.5px;font-weight:600;color:rgba(235,235,245,.4);margin-bottom:8px;letter-spacing:.02em}
</style></head>'''
CH=lambda o:f'<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="{TER}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate({90 if o else 0}deg)"><path d="M3.5 2l3 3-3 3"/></svg>'
UP='<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="rgba(235,235,245,.32)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V3M3.5 6.5L7 3l3.5 3.5"/></svg>'
def tc(k,txt,d,o=False,body='',col=SEC):
    r=f'<div class=tc><span style="display:flex">{svg(I[k][1],col,14)}</span><span>{txt}</span><span class=d>{d}</span>{CH(o)}</div>'
    return r+(f'<div class=tx>{body}</div>' if o else '')
def thk(o=False,t='Thought for 8s',body=''):
    return f'<div class=thk>{CH(o)}<span>{t}</span></div>'+(f'<div class=thb>{body}</div>' if o else '')
CODE='''<div class=pre><div class=bar2><span>sql</span><span>Copy</span></div><pre><span class=k>SELECT</span> shard, <span class=k>count</span>(*) <span class=k>AS</span> rows
<span class=k>FROM</span> read_parquet(<span class=s>'r2://matchkey/v3.2/*.parquet'</span>)
<span class=k>WHERE</span> addriva_id <span class=k>IS NULL</span>   <span class=c>-- must be 0</span>
<span class=k>GROUP BY</span> shard <span class=k>LIMIT</span> <span class=n>5</span>;</pre></div>'''
TABLE='<table class=t><tr><th>Shard</th><th class=m>Rows</th><th>Status</th></tr><tr><td>116</td><td class=m>412k</td><td>Written</td></tr><tr><td>117</td><td class=m>409k</td><td>Written</td></tr><tr><td>118</td><td class=m>415k</td><td>Written</td></tr></table>'
DIFF=f'''<div class=df><div class=fh>{svg(I["file write"][1],SEC,12)}ids/v1/join_addriva_id.sql<span class=st2><span class=ad>+18</span> <span class=rm>−3</span></span></div>
<div class=ln2><b> </b>  LEFT JOIN matchkey m</div><div class="ln2 r"><b>−</b>    ON m.email = i.email</div><div class="ln2 a"><b>+</b>    ON m.email_norm = lower(i.email)</div><div class="ln2 a"><b>+</b>   AND m.version = 'v3.2'</div></div>'''
def HO(o=True): return f'''<div class=ho><div class=r1>{svg(I["agent"][1],SEC,14)}Worker<span class=sfx>4423</span><span style="font-size:11px;color:rgba(235,235,245,.45);font-weight:400">handed back</span><span class=go>{CH(False)}</span></div>
<div class=sm>Wrote shards 1–118 to R2. Two shards needed a retry after a model timeout; both validated clean.</div><span class=art>{svg(I["network"][1],SEC,11)}r2://matchkey/v3.2/</span><span class=art>{svg(I["file read"][1],SEC,11)}report.md</span></div>'''
TX='<span class=lb>Arguments</span>{"path": "ids/v1/schema.sql"}\n<span class=lb style="margin-top:6px">Result</span>CREATE TABLE ids (\n  id        BIGINT,\n  email     TEXT,\n  addriva_id TEXT  -- nullable\n);'
THB='Shard writers are idle-bound on R2 PUTs, so three in parallel should be safe under the budget. The join key needs the normalized email or about 4% of rows miss.'
def thread(wide=False):
    return (f'<div class=me><div>Skip shards above 200 and keep it on the staging bucket.</div></div>'
    f'<div class=p>Got it. I’ll cap the backfill at shard 200 and point every worker at <span class=icd>r2://staging</span>.</div>'
    +thk()+
    '<div class=h>Plan</div><ul class=l><li>Normalize emails before the join</li><li>Fan out three workers on <span class=icd>ids/v1</span></li><li>Validate nulls, then ask to merge</li></ul>'
    +tc('file read','Read the ids/v1 schema','0.4s')+tc('shell','Counted rows with duckdb','2.1s')+tc('agent','Spawned three workers','0.9s')
    +HO()+'<div class=p>The join was matching on raw email. Fixed:</div>'+DIFF
    +(CODE+TABLE if wide else CODE))
def panelpage():
    hdr=(f'<div class=hdr>{BACK}<div><div class=crumb>Migrate matchkey to v3.2 / Lead</div><div class=ttl style="display:flex;align-items:center;gap:7px">Lead{svg(S["running"][1],B,12)}</div></div>'
         f'<div class=sw2 style="margin-left:auto"><span class=on>Thread</span><span>·</span><span>Trace</span></div></div>')
    body=f'<div class=th style="height:470px">{thread()}</div><div class=steer><span>Tell Lead…</span><div class=snd>{UP}</div></div><div class=acts style="margin-top:10px"><div class=ab>Pause</div><div class=ab>Stop</div><div class="ab term">Open in window</div></div>'
    return head.replace('</head>',CSS)+MB+f'<div class=panel style="left:250px">{hdr}{body}</div></body></html>'
def winpage():
    hdr=(f'<div class=tb><span class=tl></span><span class=tl></span><span class=tl></span><div style="margin-left:14px;font-size:12px;color:rgba(235,235,245,.5)">Migrate matchkey to v3.2 /</div><div style="font-size:13px;font-weight:600;color:#fff;display:flex;gap:6px;align-items:center">Lead{svg(S["running"][1],B,12)}</div>'
         f'<div class=sw2 style="margin-left:auto"><span class=on>Thread</span><span>·</span><span>Trace</span></div></div>')
    body=f'<div style="padding:12px 28px 14px"><div class=th style="height:590px;margin:0 -28px;padding:2px 28px 0">{thread(True)}</div><div class=steer><span>Tell Lead…</span><div class=snd>{UP}</div></div></div>'
    return head.replace('</head>',CSS+'<style>body{width:900px}.wall{width:900px}</style>')+'<body><div class=wall></div>'+f'<div class=win style="left:140px;top:40px;width:620px">{hdr}{body}</div></body></html>'
def sheetpage():
    cells=[('Tool call · collapsed',tc('shell','Counted rows with duckdb','2.1s')+tc('file read','Read the ids/v1 schema','0.4s')),
     ('Tool call · expanded',tc('file read','Read the ids/v1 schema','0.4s',True,TX)),
     ('Thinking · folded / unfolded',thk()+'<div style="height:10px"></div>'+thk(True,'Thought for 8s',THB)),
     ('Code block',CODE),('Table',TABLE),('Diff',DIFF),
     ('Child handoff',HO()),('Steer message',f'<div class=me><div>Skip shards above 200 and keep it on the staging bucket.</div></div>'),
     ('Prose',f'<div class=h style="margin-top:0">Plan</div><ul class=l><li>Normalize emails before the join</li><li>Fan out three workers on <span class=icd>ids/v1</span></li></ul><div class=p>Point every worker at <span class=icd>r2://staging</span>.</div>')]
    g=''.join(f'<div class=cell><div class=cap>{a}</div>{b}</div>' for a,b in cells)
    return head.replace('</head>',CSS+'<style>body{width:1240px}.wall{width:1240px;height:100%}</style>')+f'<body><div class=wall style="position:fixed;inset:0"></div><div class=sheet style="position:relative;width:1192px">{g}</div></body></html>'
open('thread-panel.html','w').write(panelpage());open('thread-window.html','w').write(winpage());open('thread-states.html','w').write(sheetpage())
