import re
exec(open('tools/genview.py').read().split("open('view-activity.html'")[0])
A='#ffb020';TER='rgba(235,235,245,.3)';MU='rgba(235,235,245,.45)'
CV=lambda up:f'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="rgba(235,235,245,.45)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate({0 if up else 180}deg)"><path d="M2.5 6.2L5 3.7l2.5 2.5"/></svg>'
def sw2(a,collapsed): return f'<div class=sw><span class=cvb>{CV(not collapsed)}</span><span class=on>Activity</span><span>·</span><span>Trace</span></div>'+tm
CSS2='''<style>.cvb{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;margin-right:1px}
.strip{position:relative;height:30px;margin-top:12px;display:flex;align-items:center;overflow:hidden;border-radius:8px;background:rgba(255,255,255,.04)}
.strip .sin{display:flex;align-items:center;gap:2px;padding:0 6px;white-space:nowrap}
.si2{width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;position:relative;flex:none}
.si2.now{background:rgba(10,132,255,.16)}.si2.ap{background:rgba(255,176,32,.0)}
.si2.hv{background:rgba(255,255,255,.1)}
.pdv{width:1px;height:12px;background:rgba(255,255,255,.14);margin:0 6px;flex:none}
.fl,.fr{position:absolute;top:0;bottom:0;width:28px;pointer-events:none}
.fl{left:0;background:linear-gradient(90deg,rgba(32,36,46,1),rgba(32,36,46,0))}.fr{right:30px;background:linear-gradient(270deg,rgba(32,36,46,1),rgba(32,36,46,0))}
.stip{position:absolute;bottom:31px;white-space:nowrap;font-size:11.5px;color:#fff;background:rgba(48,52,62,.96);box-shadow:0 0 0 .5px rgba(255,255,255,.16),0 6px 18px rgba(0,0,0,.4);border-radius:6px;padding:4px 8px;z-index:3}
.stip span{font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.45);margin-left:6px}
.sheet2{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:22px;position:relative;width:1196px}
.cell2{border-radius:14px;background:rgba(30,34,44,.82);box-shadow:0 0 0 .5px rgba(255,255,255,.14);padding:12px 14px 14px}
.cap2{font-size:10.5px;font-weight:600;color:rgba(235,235,245,.4);margin-bottom:8px}
.mot{font-size:11.5px;line-height:17px;color:rgba(235,235,245,.6)}
.mot b{color:#fff;font-weight:500}
.cvx{position:absolute;right:0;top:0;bottom:0;width:30px;display:flex;align-items:center;justify-content:center;background:rgba(32,36,46,.0);border-left:.5px solid rgba(255,255,255,.08)}
.cve{position:absolute;right:4px;top:0}</style></head>'''
def si(k,col,cls=''): return f'<div class="si2 {cls}">{ic(k,col,14)}</div>'
D='<div class=pdv></div>'
BASE=[[('plan',MU),('file read',MU)],[('sandbox',MU),('retry','rgba(255,105,97,.8)'),('file write',B,'now')],[('tool call',TER),('git',TER)]]
def strip(groups,fade='',tip=None,shift=0):
    inner=D.join(''.join(si(*x) for x in g) for g in groups)
    t=f'<div class=stip style="left:{tip[0]}px">{tip[1]}<span>{tip[2]}</span></div>' if tip else ''
    fl='<div class=fl></div>' if 'l' in fade else ''; fr='<div class=fr></div>' if 'r' in fade else ''
    return f'<div style="position:relative;width:100%">{t}<div class=strip><div class=sin style="transform:translateX({-shift}px)">{inner}</div>{fl}{fr}<div class=cvx>{CV(False)}</div></div></div>'
APR=[[('plan',MU),('file read',MU)],[('sandbox',MU),('file write',MU),('approval',A,'ap')],[('git',TER)]]
HOV=[[('plan',MU),('file read',MU,'hv')],[('sandbox',MU),('retry','rgba(255,105,97,.8)'),('file write',B,'now')],[('tool call',TER),('git',TER)]]
LONG=[[('plan',MU),('file read',MU),('file read',MU),('network',MU)],[('sandbox',MU),('shell',MU),('model call',MU),('retry','rgba(255,105,97,.8)'),('file write',MU),('shell',MU),('file write',MU),('model call',MU),('file write',B,'now')],[('tool call',TER),('git',TER)]]
HDR=lambda c:f'<div style="display:flex;align-items:center;font-size:12px;color:rgba(235,235,245,.5)"><span>Writing parquet shards</span><div class=sw style="margin-right:0">{"".join(sw2(1,c).split(tm)[0].split("<div class=sw>")[1:]).replace("</div>","",1)}</div></div>'
MOTION='''<div class=mot><b>Motion.</b> Collapse: spring, no bounce, ~0.3s (damping 1.0). The region's height eases 172→30 while each icon slides from its row position into the strip, staggered 12ms top-down; text rows fade out in the first 120ms. Expand reverses from the current on-screen value, so it can be interrupted. Clicking an icon expands and scrolls that row into view with a brief highlight. <b>Reduce Motion:</b> 150ms crossfade, no movement. The state is remembered per user, not per run.</div>'''
def page():
    cells=[('Expanded (reference)','<div class=reg style="height:172px;margin-top:0;position:relative"><div class=cve>'+CV(True)+'</div>'+rows+'</div>'),
           ('Collapsed · running',strip(BASE)),('Collapsed · approval waiting',strip(APR)),
           ('Hover tooltip',strip(HOV,tip=(24,'Read the ids/v1 schema','6m ago'))),
           ('Overflow · pinned to now, edge fade',strip(LONG,'l',shift=122)),('Motion',MOTION)]
    g=''.join(f'<div class=cell2><div class=cap2>{a}</div><div style="display:flex;flex-direction:column;justify-content:flex-end;{"min-height:60px" if i else ""};padding-top:{30 if i==3 else 0}px">{b}</div></div>' for i,(a,b) in enumerate(cells))
    return src.split('<body')[0].replace('</head>',CSS+CSS2)+f'<body><div class=wall style="position:fixed;inset:0"></div><div class=sheet2>{g}</div></body></html>'
open('activity-collapse.html','w').write(page())
act=re.sub(r'<div class=lbl>Spans</div>.*?(<div class=seg>)',lambda m:strip(BASE)+m.group(1),src.replace("</head>",CSS2).replace(tm,sw(True)),flags=re.S)
open('drill-collapsed.html','w').write(act)
