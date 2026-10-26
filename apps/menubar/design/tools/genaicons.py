ns={}; exec(open('tools/genicons.py').read().split("open('icons-sheet.html'")[0],ns); svg=ns['svg']
exec(open('tools/agenticons.py').read())
head=open('thread-states.html').read().split('<body')[0]
rows=''
for k,opts in P.items():
    cells=''
    for i,(nm,p) in enumerate(opts):
        pk=i==PICK[k]
        big=svg(p,'#fff',56).replace('stroke-width="1.5"','stroke-width="1.5" vector-effect="non-scaling-stroke"').replace('width="56"','width="56" style="stroke-width:1.5px"')
        grid='<div style="position:relative;width:56px;height:56px;background:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 1px,transparent 1px 4px),repeating-linear-gradient(90deg,rgba(255,255,255,.05) 0 1px,transparent 1px 4px);border-radius:4px">'+svg(p,'#fff',56).replace('stroke-width="1.5"','stroke-width="1.5"')+'</div>'
        cells+=f'''<div class=cell style="display:flex;gap:16px;align-items:center;{'box-shadow:0 0 0 1.5px #0a84ff' if pk else ''}">{grid}
<div style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;gap:10px;align-items:center">{svg(p,'rgba(235,235,245,.6)',14)}{svg(p,'#0a84ff',14)}{svg(p,'#ff6961',14)}<span style="font-size:13px;color:#fff">{k.capitalize() if k!='other' else 'Other'}</span></div>
<div style="font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.45)">{nm}</div>{'<div style="font-size:10.5px;font-weight:600;color:#0a84ff">Pick</div>' if pk else '<div style="font-size:10.5px;color:rgba(235,235,245,.3)">Alt</div>'}</div></div>'''
    rows+=cells
open('agent-icons.html','w').write(head+f'<body><div class=wall style="position:fixed;inset:0"></div><div style="position:relative;display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:22px;width:640px">{rows}<div style="grid-column:1/3;font-size:11px;color:rgba(235,235,245,.45)">Other covers unknown profiles (sup, cx, coder…). 14pt grid, 1.5pt stroke, round caps.</div></div></body></html>')
