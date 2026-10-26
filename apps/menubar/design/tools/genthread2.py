src=open('tools/genthread.py').read().split("open('thread-panel.html'")[0]
exec(src); exec(open('tools/agenticons.py').read())
CSS2='''<style>
.ib{border-radius:10px;background:rgba(255,255,255,.07);padding:7px 6px 6px 8px;margin:8px 4px 0;transition:none}
.ib.foc{background:rgba(255,255,255,.1);box-shadow:0 0 0 .5px rgba(255,255,255,.18),0 0 0 3.5px rgba(10,132,255,.28)}
.ib .irw{display:flex;align-items:flex-end;gap:6px}
.ib .tx2{flex:1;font-size:13px;line-height:18px;color:rgba(255,255,255,.92);padding:2px 0 1px;min-height:18px}
.ib .phd{color:rgba(255,255,255,.38)}
.ib .car{display:inline-block;width:1.5px;height:15px;background:#0a84ff;vertical-align:-3px;margin-left:1px}
.ipl{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}
.isb{width:22px;height:22px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.1);flex:none}
.isb.on{background:#0a84ff}.isb.stop{background:rgba(255,255,255,.88)}
.hint{display:flex;justify-content:flex-end;gap:10px;font-size:10.5px;color:rgba(235,235,245,.34);padding:5px 4px 0 30px}
.mt{color:#409cff;background:rgba(10,132,255,.14);border-radius:4px;padding:0 3px}
.mpop{margin:0 4px 6px;border-radius:10px;background:rgba(40,44,54,.94);box-shadow:0 0 0 .5px rgba(255,255,255,.14),0 10px 30px rgba(0,0,0,.4);padding:4px}
.mi{display:grid;grid-template-columns:16px auto 1fr auto;gap:8px;align-items:center;height:28px;padding:0 8px;border-radius:6px;font-size:12.5px;color:rgba(255,255,255,.85)}
.mi .sfx{font:10.5px 'JetBrains Mono';color:rgba(235,235,245,.35)}.mi .p{font-size:11px;color:rgba(235,235,245,.4);text-align:right}
.mi.hl{background:#0a84ff;color:#fff}.mi.hl .sfx,.mi.hl .p{color:rgba(255,255,255,.7)}
.strm{display:flex;align-items:center;gap:6px;font-size:11px;color:rgba(235,235,245,.45);padding:0 4px 6px 6px}
.dots i{display:inline-block;width:3px;height:3px;border-radius:2px;background:#0a84ff;margin-right:2px;opacity:.9}.dots i+i{opacity:.55}.dots i+i+i{opacity:.3}
</style></head>'''
PLUS='<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="rgba(235,235,245,.55)" stroke-width="1.5" stroke-linecap="round"><path d="M7 2.5v9M2.5 7h9"/></svg>'
def AR(c): return f'<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="{c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11.5V2.8M3.2 6.4L7 2.6l3.8 3.8"/></svg>'
SQ='<svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" rx="1.2" fill="#1c1f26"/></svg>'
def steer(st='idle',name='Lead'):
    f=st in('text','mention')
    if st=='idle' or st=='stream': t=f'<span class=phd>Tell {name}…</span>'
    elif st=='text': t='Keep the backfill on staging, and before merging<br>re-run the null check on shards 116–118.<span class=car></span>'
    else: t='Ask <span class=mt>@w</span><span class=car></span>'
    btn={'idle':f'<div class=isb>{AR("rgba(235,235,245,.35)")}</div>','text':f'<div class="isb on">{AR("#fff")}</div>','mention':f'<div class="isb on">{AR("#fff")}</div>','stream':f'<div class="isb stop">{SQ}</div>'}[st]
    pre=''
    if st=='mention':
        it=[('Worker','4423','worker','Done',1),('Worker','d3ce','worker','Running',0),('Worker','ff88','worker','Failed',0),('Critic','','critic','Queued',0)]
        pre='<div class=mpop>'+''.join(f'<div class="mi{" hl" if h else ""}">{svg(picon(pf),"#fff" if h else SEC,14)}<span>{n} <span class=sfx>{s}</span></span><span></span><span class=p>{p}</span></div>' for n,s,pf,p,h in it)+'</div>'
    if st=='stream': pre=f'<div class=strm><span class=dots><i></i><i></i><i></i></span>{name} is writing…<span style="margin-left:auto">Esc to stop</span></div>'
    hint='<div class=hint><span>↩ send</span><span>⇧↩ newline</span></div>' if f else ''
    return pre+f'<div class="ib{" foc" if f else ""}"><div class=irw><div class=ipl>{PLUS}</div><div class=tx2>{t}</div>{btn}</div></div>'+hint
def HO2(): return HO().replace(svg(I["agent"][1],SEC,14),svg(picon('worker'),SEC,14))
def thread2(): return thread().replace(HO(),HO2()).replace(svg(I['agent'][1],SEC,14),svg(picon('worker'),SEC,14))
def page2():
    hdr=(f'<div class=hdr>{BACK}<div><div class=crumb>Migrate matchkey to v3.2 / Lead</div><div class=ttl style="display:flex;align-items:center;gap:7px"><span style="display:flex">{svg(picon("lead"),SEC,14)}</span>Lead{svg(S["running"][1],B,12)}</div></div>'
         f'<div class=sw2 style="margin-left:auto"><span class=on>Thread</span><span>·</span><span>Trace</span></div></div>')
    body=f'<div class=th style="height:450px">{thread2()}</div>{steer("stream")}<div class=acts style="margin-top:10px"><div class=ab>Pause</div><div class=ab>Stop</div><div class="ab term">Open in window</div></div>'
    return head.replace('</head>',CSS+CSS2)+MB+f'<div class=panel style="left:250px">{hdr}{body}</div></body></html>'
def inputs():
    cs=[('Idle',steer('idle')),('Focused · multi-line text',steer('text')),('@ mention a child agent',steer('mention')),('Agent streaming · stop',steer('stream'))]
    g=''.join(f'<div class=cell style="padding:12px 12px 14px"><div class=cap>{a}</div><div style="display:flex;flex-direction:column;justify-content:flex-end;min-height:170px">{b}</div></div>' for a,b in cs)
    return head.replace('</head>',CSS+CSS2+'<style>body{width:1240px}</style>')+f'<body><div class=wall style="position:fixed;inset:0"></div><div style="position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:22px;width:1196px">{g}</div></body></html>'
open('thread-panel-v2.html','w').write(page2()); open('thread-input.html','w').write(inputs())
