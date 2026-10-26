import re,html
ns={}; exec(open('tools/genicons.py').read().split("open('icons-sheet.html'")[0],ns)
I,S,svg=ns['I'],ns['S'],ns['svg']
SEC='rgba(235,235,245,.6)';BLUE='#0a84ff';RED='#ff6961';AMB='#ffb020'
def typ(t):
    t=re.sub('<[^>]+>','',t).lower()
    for kw,k in [('plan','plan'),('model','model call'),('sandbox','sandbox'),('push','git'),('commit','git'),('checkout','git'),('read','file read'),('writ','file write'),('shard','file write'),('upload','network'),('duckdb','shell'),('validate','tool call'),('verify','tool call'),('build','tool call'),('schema','tool call')]:
        if kw in t: return k
    return 'agent'
def ic(k,col=SEC,s=14): return svg(I[k][1],col,s).replace('style="','style="vertical-align:-2px;')
def st(k,col): return svg(S[k][1],col,12).replace('style="','style="vertical-align:-2px;margin-left:6px;')
def proc(h):
    # trace rows (drill, long)
    def sp(m):
        style=m.group(1) or ''; col=BLUE if '0a84ff' in style else RED if 'ff6961' in style else SEC
        return f'<span class=gl style="display:flex;justify-content:center">{ic(typ(re.split(r'</div>',m.string[m.end(2):m.end(2)+300])[0]),col)}</span>'+m.group(2)+m.group(3)
    h=re.sub(r'<span class=gl( style="[^"]*")?>[^<]*</span>(<span class="?n[^>]*>)(.*?</span>)',sp,h)
    # status in trace durations
    h=re.sub(r'(<span class="d mono"[^>]*>)(—)(</span>)',lambda m:m.group(1)+m.group(2)+st('queued','rgba(255,255,255,.4)')+m.group(3),h)
    h=re.sub(r'(<div class="sp now">.*?<span class="d mono"[^>]*>[^<]*)(</span>)',lambda m:m.group(1)+st('running',BLUE)+m.group(2),h,flags=re.S)
    h=re.sub(r'(<div class=sp style="color:#fff">.*?<span class="d mono"[^>]*>[^<]*)(</span>)',lambda m:m.group(1)+st('running',BLUE)+m.group(2),h,flags=re.S)
    h=re.sub(r'(<div class=sp style="color:#ff6961">.*?<span class="d mono"[^>]*>[^<]*)(</span>)',lambda m:m.group(1)+st('failed',RED)+m.group(2),h,flags=re.S)
    # panel run rows
    def run(m):
        cls,act,rest=m.group(1),m.group(2),m.group(3)
        col=AMB if 'y' in cls.split() else SEC if 'mute' in cls else BLUE
        t=typ(act)
        rest=rest.replace('>⋯<','>'+st('running',BLUE)+'<').replace('>◔<','>'+st('paused',AMB)+'<').replace('>∘<','>'+st('queued','rgba(255,255,255,.4)')+'<')
        return f'<span class="g {cls}" style="display:flex;justify-content:center">{ic(t,col)}</span><span class=act>{act}</span>{rest}'
    h=re.sub(r'<span class="g ([^"]*)">[^<]*</span><span class=act>(.*?)</span>(.*?</div>)',run,h)
    h=h.replace('<span class="mute" style="font-size:11px"></span>','')
    # log glyphs (v5) and files
    h=re.sub(r'<div class=log><span>[^<]*</span><span>([^<]*)</span>',lambda m:f'<div class=log><span style="display:flex;align-items:center">{ic(typ(m.group(1)),SEC,12)}</span><span>{m.group(1)}</span>',h)
    h=h.replace('<span style="opacity:.55">▫</span>',f'<span style="display:flex">{ic("file write",SEC,12)}</span>')
    # done row check
    h=h.replace('<span style="color:#30d158">✓</span>',"<span></span>")
    h=h.replace('</head>','<style>.sp{grid-template-columns:16px var(--nw,132px) 1fr 58px!important}.sp .d{display:flex;justify-content:flex-end;align-items:center;white-space:nowrap}</style></head>')
    return h
for f in ['drill-a2-log','drill-a2-files','long-follow','long-scrolled','v5-a']:
    open(f+'-iconsA.html','w').write(proc(open(f+'.html').read()))
