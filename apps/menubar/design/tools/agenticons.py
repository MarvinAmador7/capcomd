import math
def poly(pts): return 'M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in pts)+'Z'
def star(n,r1,r2,cx=7,cy=7,rot=0):
    return poly([(cx+(r1 if i%2==0 else r2)*math.cos(rot+i*math.pi/n),cy+(r1 if i%2==0 else r2)*math.sin(rot+i*math.pi/n)) for i in range(2*n)])
hexa=poly([(7+5*math.cos(math.pi/6+i*math.pi/3),7+5*math.sin(math.pi/6+i*math.pi/3)) for i in range(6)])
gear=star(8,5.2,4.1,rot=math.pi/16)
P={
'planner':[('point.3.connected.trianglepath.dotted','<circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="10.6" r="1.4"/><circle cx="11" cy="10.6" r="1.4"/><path d="M6.3 4.4L3.8 9.2M7.7 4.4l2.5 4.8M4.6 10.6h4.8" stroke-dasharray=".1 1.9"/>'),
           ('map','<path d="M1.8 3.6l3.4-1.3 3.6 1.4 3.4-1.3v8l-3.4 1.3-3.6-1.4-3.4 1.3z"/><path d="M5.2 2.3v8M8.8 3.7v8"/>')],
'lead':[('flag','<path d="M3.6 12.4V2.2"/><path d="M3.6 2.8h7.2l-1.7 2.6 1.7 2.6H3.6"/>'),
        ('arrow.triangle.branch','<path d="M4 12.2V2.4M4 2.4L2.2 4.2M4 2.4l1.8 1.8"/><path d="M4 8.2c0-2 1.6-3.2 3.6-3.2H11M11 5l-1.6-1.6M11 5L9.4 6.6"/>')],
'worker':[('hammer','<g transform="translate(-.36 .36)"><path d="'+poly([(12.32,6.2),(10.2,8.32),(5.68,3.8),(7.8,1.68)])+'"/><path d="M7.94 6.06L2.4 11.6"/></g>'),
          ('gearshape',f'<path d="{gear}"/><circle cx="7" cy="7" r="1.7"/>')],
'critic':[('checkmark.seal',f'<path d="{star(10,5.6,4.6)}"/><path d="M4.9 7.1l1.4 1.4 2.8-2.9"/>'),
          ('eye','<path d="M1.6 7C3 4.4 4.8 3.3 7 3.3s4 1.1 5.4 3.7C11 9.6 9.2 10.7 7 10.7S3 9.6 1.6 7z"/><circle cx="7" cy="7" r="1.7"/>')],
'other':[('hexagon',f'<path d="{hexa}"/><circle cx="7" cy="7" r=".6" fill="currentColor"/>'),
         ('circle.hexagongrid','<circle cx="7" cy="7" r="5.5"/><circle cx="7" cy="4.9" r=".55" fill="currentColor"/><circle cx="5.2" cy="8" r=".55" fill="currentColor"/><circle cx="8.8" cy="8" r=".55" fill="currentColor"/>')]}
PICK={'planner':0,'lead':0,'worker':0,'critic':0,'other':0}
def picon(profile): k=profile.lower(); k=k if k in P else 'other'; return P[k][PICK[k]][1]
