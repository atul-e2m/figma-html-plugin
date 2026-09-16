import sys
from PIL import Image
tag=sys.argv[1]
html=Image.open(f'{tag}-html.png').convert('RGB')
secs=[('header',0,112),('hero',111,1000),('about',1110,944),('tours',2053,1855),('why',3907,1403),('testi',5309,1672),('news',6980,1446),('insta',8425,703),('ctafooter',9127,1945)]
for n,y,h in secs:
    f=Image.open(f'figcrops/{n}.png'); hh=html.crop((0,y,1920,y+h))
    s=Image.new('RGB',(1920*2+16,h),(255,0,255)); s.paste(f,(0,0)); s.paste(hh,(1936,0))
    scale = 0.5 if h>600 else 1.0
    s=s.resize((int(s.width*scale),int(s.height*scale)),Image.LANCZOS); s.save(f'{tag}-sbs-{n}.png')
print("done")
