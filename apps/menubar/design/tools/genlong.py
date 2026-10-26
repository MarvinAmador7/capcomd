import re
h=open('drill-a2-log.html').read()
def row(g,n,a,b,d,k='',ind=0):
    col={'now':'#fff','err':'#ff6961','pend':'rgba(255,255,255,.45)'}.get(k,'rgba(255,255,255,.75)')
    bc={'now':'#0a84ff','err':'#ff6961'}.get(k,'rgba(255,255,255,.28)')
    glc={'now':'#0a84ff','err':'#ff6961'}.get(k,'rgba(255,255,255,.5)')
    sh='box-shadow:0 0 0 3px rgba(10,132,255,.22);' if k=='now' else ''
    bar=f'<i style="left:{a}%;width:{max(b-a,3)}%;background:{bc};{sh}"></i>'
    return f'<div class=sp style="color:{col}"><span class=gl style="color:{glc}">{g}</span><span class=n style="padding-left:{ind*14}px">{n}</span><div class=trk>{bar}</div><span class="d mono" style="color:{col if k in ("now","err") else ""}">{d}</span></div>'
C='<span style="opacity:.45;font-size:9px;margin-right:5px">▸</span>'
O='<span style="opacity:.6;font-size:9px;margin-right:5px">▾</span>'
HIST=[row('▹',C+'plan migration',0,6,'0:33'),
 row('▫',C+'read inputs',6,14,'1:02'),
 row('▹','model call · retry ✗',14,16,'0:09','err',1),
 row('▹','model call',16,19,'0:12','',1),
 row('⊡',C+'sandbox up',19,22,'0:06'),
 row('▫',C+'build matchkey index',22,38,'1:48')]
CUR=[row('▫',O+'write parquet shards',38,97,'5:12'),
 row('▫','shard 117',90,92,'0:03','',1),row('▫','shard 118',92,94,'0:03','',1),row('▫','shard 119',94,97,'0:02','now',1)]
CSS2="""<style>.reg{position:relative;height:110px;overflow:hidden;margin:0 -4px;padding:0 4px}
.reg .scr{position:absolute;left:4px;right:4px}
.fade{-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 30px)}
.fadeb{-webkit-mask-image:linear-gradient(to top,transparent 0,rgba(0,0,0,.35) 18px,#000 40px)}.pill{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);background:#0a84ff;color:#fff;font-size:11.5px;font-weight:500;height:22px;line-height:22px;padding:0 10px 0 8px;border-radius:11px;box-shadow:0 4px 12px rgba(0,0,0,.35);white-space:nowrap}
</style>"""
def make(name,rows,bottom,fade,pill):
    pos='bottom:0' if bottom else 'top:0'
    reg=f'<div class="reg{" fade" if fade else ""}"><div class="scr{' fadeb' if pill else ''}" style="{pos}">{"".join(rows)}</div>{pill}</div>'
    out=re.sub(r'(<div class=lbl>Spans</div>).*?(<div class=seg>)',lambda m:m.group(1)+reg+m.group(2),h,flags=re.S)
    out=out.replace('</head>',CSS2+'</head>')
    open(name+'.html','w').write(out)
make('long-follow',HIST+CUR,True,True,'')
make('long-scrolled',HIST[1:]+CUR[:1],False,False,'<div class=pill>↓ Jump to now</div>')
