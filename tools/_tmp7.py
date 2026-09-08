import re, subprocess, statistics
from collections import defaultdict
lines=[]
for a in ('t2','t3'):
    r=subprocess.run(['grep','-a','monster-move','substrate/keeper-%s.log'%a],capture_output=True,text=True)
    lines+=r.stdout.splitlines()
pat=re.compile(r'who=(\S+) x=(-?\d+) y=(-?\d+) col=(-?\d+) row=(-?\d+) t=(\d+)')
seq=defaultdict(list)
for ln in lines:
    m=pat.search(ln)
    if m: seq[m.group(1)].append((int(m.group(6)), int(m.group(2)), int(m.group(3))))
for who,evs in seq.items():
    evs.sort()
    moving=[]   # gaps where the monster actually changed position
    for i in range(1,len(evs)):
        dt=evs[i][0]-evs[i-1][0]
        if not (0<dt<5000): continue
        s=((evs[i][1]-evs[i-1][1])**2+(evs[i][2]-evs[i-1][2])**2)**0.5/64.0
        if s>0.01: moving.append((dt,s))
    if not moving:
        print(who, 'no movement observed'); continue
    gaps=[d for d,_ in moving]
    steps=[s for _,s in moving]
    tot=sum(s for _,s in moving); span=sum(d for d,_ in moving)/1000.0
    print('%s: %d position-CHANGING packets (of %d total)' % (who, len(moving), len(evs)))
    print('   gap between MOVING packets: median %dms' % statistics.median(gaps))
    print('   ground per MOVING packet  : median %.2f  max %.2f squares' % (statistics.median(steps), max(steps)))
    print('   => speed while moving: %.2f squares/s' % (tot/span))
