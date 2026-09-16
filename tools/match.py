"""Find where a candidate image sits inside a Figma region: brute-force NCC over scale and offset at reduced resolution."""
import sys, numpy as np
from PIL import Image, ImageOps
fig=Image.open('figcrops/full-1920.png').convert('L')
def ncc(a,b):
    a=a-a.mean(); b=b-b.mean(); d=np.sqrt((a*a).sum()*(b*b).sum()); return (a*b).sum()/d if d else -1
def search(region, cand, scales, flip=False, step=4, red=8, pad=400):
    x0,y0,x1,y1=region; R=fig.crop(region)
    Rs=np.asarray(R.resize((R.width//red, R.height//red), Image.BOX),dtype=np.float32)
    # gradient magnitude makes the match robust to the colour overlay
    def grad(m): gx=np.abs(np.diff(m,axis=1,prepend=m[:,:1])); gy=np.abs(np.diff(m,axis=0,prepend=m[:1])); return gx+gy
    Rg=grad(Rs)
    best=(-2,None)
    C=Image.open(cand).convert('L')
    if flip: C=ImageOps.mirror(C)
    for sc in scales:
        cw,ch=int(C.width*sc),int(C.height*sc)
        Cs=np.asarray(C.resize((cw//red, ch//red), Image.BOX),dtype=np.float32); Cg=grad(Cs)
        rh,rw=Rg.shape; chh,cww=Cg.shape
        # candidate placed at (dx,dy) relative to region (can be negative); overlap must cover the region
        for dy in range(-(chh-rh)-pad//red, pad//red+1, max(1,step//2)):
            for dx in range(-(cww-rw)-pad//red, pad//red+1, max(1,step//2)):
                # region pixel (i,j) maps to candidate (i-dy, j-dx)
                ys=slice(max(0,dy), min(rh, dy+chh)); xs=slice(max(0,dx), min(rw, dx+cww))
                if (ys.stop-ys.start) < rh*0.9 or (xs.stop-xs.start) < rw*0.9: continue
                sub=Rg[ys,xs]; csub=Cg[ys.start-dy:ys.stop-dy, xs.start-dx:xs.stop-dx]
                v=ncc(sub,csub)
                if v>best[0]: best=(v,(sc,dx*red,dy*red))
    return best
if __name__=="__main__":
    which=sys.argv[1]
    ref='/Users/atulrathour/Codebase/Figma to HTML-JSX/frame-4804-export 2/assets/'
    if which=='hero':
        print("hero:", search((0,111,1920,1111), ref+'ref/hero-section.jpg', [0.9375,0.98,1.02,1.06,1.10], flip=True))
        print("hero-noflip:", search((0,111,1920,1111), ref+'ref/hero-section.jpg', [0.9375,1.02,1.10], flip=False))
    if which=='map':
        for f in ['images/gemini-generated-image-u1w5kju1w5kju1w5--676aa643.png','images/gemini-generated-image-lonvoulonvoulonv--cd739ffa.png']:
            C=Image.open(ref+f); print(f, C.size)
            for base in (0.5,):
                print(" ", search((833,6111,1920,6981), ref+f, [base*s for s in (0.9,1.0,1.1,1.2,1.3,1.4,1.5)], flip=False, step=4, red=8, pad=600))
