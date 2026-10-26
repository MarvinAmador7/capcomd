exec(open('tools/genthread2.py').read().split("open('thread-panel-v2.html'")[0])
BOOK='<path d="M2.5 3.2c1.6-.6 3.1-.5 4.5.5v8c-1.4-1-2.9-1.1-4.5-.5zM11.5 3.2c-1.6-.6-3.1-.5-4.5.5v8c1.4-1 2.9-1.1 4.5-.5z"/>'
X='<svg width="8" height="8" viewBox="0 0 8 8" stroke="rgba(235,235,245,.6)" stroke-width="1.3" stroke-linecap="round"><path d="M2 2l4 4M6 2L2 6"/></svg>'
CSS3='''<style>
.skp{margin:0 4px 6px;border-radius:10px;background:rgba(40,44,54,.94);box-shadow:0 0 0 .5px rgba(255,255,255,.14),0 10px 30px rgba(0,0,0,.4);padding:4px}
.skh{font-size:10.5px;font-weight:600;color:rgba(235,235,245,.38);padding:4px 8px 3px}
.sk{display:grid;grid-template-columns:16px 1fr;column-gap:8px;padding:5px 8px;border-radius:6px}
.sk .n{font:11.5px 'JetBrains Mono';color:rgba(255,255,255,.9);display:flex;justify-content:space-between}
.sk .n span{font-family:Inter;font-size:10.5px;color:rgba(235,235,245,.36)}
.sk .d{grid-column:2;font-size:11px;line-height:15px;color:rgba(235,235,245,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk.hl{background:#0a84ff}.sk.hl .n,.sk.hl .d,.sk.hl .n span{color:#fff}.sk.hl .d{color:rgba(255,255,255,.75)}
.sk b{font-weight:400;color:#409cff}.sk.hl b{color:#fff;text-decoration:underline}
.ske{padding:10px 8px 9px;font-size:12px;color:rgba(235,235,245,.45)}
.skf{display:flex;gap:10px;font-size:10px;color:rgba(235,235,245,.32);padding:5px 8px 2px;border-top:.5px solid rgba(255,255,255,.07);margin-top:3px}
.chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 5px 0 6px;border-radius:6px;background:rgba(10,132,255,.16);color:#8cc4ff;font:11px 'JetBrains Mono';vertical-align:1px;margin-right:4px}
.chip i{display:flex;width:14px;height:14px;border-radius:7px;align-items:center;justify-content:center;background:rgba(255,255,255,.08)}
</style></head>'''
SK=[('capcomd-orchestration','relay','Compose capcomd primitives into multi-agent coding patterns.'),
    ('migrate-matchkey','matchkey','Steps and checks for matchkey schema migrations.'),
    ('validate-shards','ids/v1','Null and row-count checks for parquet shards.')]
def item(n,s,d,hl=False,q=''):
    nm=n.replace(q,f'<b>{q}</b>',1) if q else n
    return f'<div class="sk{" hl" if hl else ""}"><span style="display:flex;padding-top:1px">{svg(BOOK,"#fff" if hl else SEC,14)}</span><div class=n><em style="font-style:normal">{nm}</em><span>{s}</span></div><div class=d>{d}</div></div>'
FOOT='<div class=skf><span>↑↓ move</span><span>↩ pick</span><span>esc close</span></div>'
def box(t,btn=True,foc=True):
    b=f'<div class="isb on">{AR("#fff")}</div>' if btn else f'<div class=isb>{AR("rgba(235,235,245,.35)")}</div>'
    return f'<div class="ib{" foc" if foc else ""}"><div class=irw><div class=ipl>{PLUS}</div><div class=tx2>{t}</div>{b}</div></div>'
CAR='<span class=car></span>'
def st(k):
    if k=='open': return '<div class=skp><div class=skh>Skills</div>'+''.join(item(*s,hl=i==0) for i,s in enumerate(SK))+FOOT+'</div>'+box('/'+CAR,False)
    if k=='filter': return '<div class=skp><div class=skh>Skills</div>'+item(*SK[2],hl=True,q='val')+FOOT+'</div>'+box('/val'+CAR,False)
    if k=='chip': return box(f'<span class=chip>{svg(BOOK,"#8cc4ff",12)}validate-shards<i>{X}</i></span>Re-run on shards 116–118 before merging.'+CAR)+'<div class=hint><span>↩ send</span><span>⇧↩ newline</span></div>'
    if k=='empty': return '<div class=skp><div class=ske>No matching skills</div></div>'+box('/deploy'+CAR,False)
def sheet():
    cs=[('/ opens the list · first item selected',st('open')),('Filtered by typing',st('filter')),('Picked · removable chip',st('chip')),('No match',st('empty'))]
    g=''.join(f'<div class=cell style="padding:12px 12px 14px"><div class=cap>{a}</div><div style="display:flex;flex-direction:column;justify-content:flex-end;min-height:230px">{b}</div></div>' for a,b in cs)
    note='<div style="grid-column:1/5;font-size:11px;color:rgba(235,235,245,.45)">Proposal: name and description come from SKILL.md frontmatter; the right-hand label is the repo it lives in. Only capcomd-orchestration exists today; the other two are illustrative. The + menu offers "Add skill…" for the same list.</div>'
    return head.replace('</head>',CSS+CSS2+CSS3+'<style>body{width:1240px}</style>')+f'<body><div class=wall style="position:fixed;inset:0"></div><div style="position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:22px;width:1196px">{g}{note}</div></body></html>'
def panel():
    hdr=(f'<div class=hdr>{BACK}<div><div class=crumb>Migrate matchkey to v3.2 / Lead</div><div class=ttl style="display:flex;align-items:center;gap:7px"><span style="display:flex">{svg(picon("lead"),SEC,14)}</span>Lead{svg(S["running"][1],B,12)}</div></div>'
         f'<div class=sw2 style="margin-left:auto"><span class=on>Thread</span><span>·</span><span>Trace</span></div></div>')
    body=f'<div class=th style="height:430px">{thread2()}</div>{st("chip")}<div class=acts style="margin-top:10px"><div class=ab>Pause</div><div class=ab>Stop</div><div class="ab term">Open in window</div></div>'
    return head.replace('</head>',CSS+CSS2+CSS3)+MB+f'<div class=panel style="left:250px">{hdr}{body}</div></body></html>'
open('skills-picker.html','w').write(sheet()); open('input-with-skill.html','w').write(panel())
