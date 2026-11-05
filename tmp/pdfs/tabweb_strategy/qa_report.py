from pathlib import Path
import json, re
import pymupdf as fitz
from PIL import Image, ImageOps, ImageDraw

ROOT=Path(__file__).resolve().parents[3]
WORK=Path(__file__).resolve().parent
PDF=ROOT/'output/pdf/Tabweb-Education-Business-Strategy-AR.pdf'
doc=fitz.open(PDF)
manifest=json.loads((WORK/'manifest.json').read_text(encoding='utf-8'))
assert len(doc)==len(manifest),(len(doc),len(manifest))
thumbs=[]
stats=[]
for i,p in enumerate(doc):
    text=p.get_text()
    pix=p.get_pixmap(matrix=fitz.Matrix(1.25,1.25),alpha=False)
    pix.save(str(WORK/f'page-{i+1:02}.png'))
    im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
    im.thumbnail((297,420))
    tile=Image.new('RGB',(321,452),'#dce4ec')
    tile.paste(im,((321-im.width)//2,8))
    ImageDraw.Draw(tile).text((12,434),f'PAGE {i+1:02}',fill='#14364d')
    thumbs.append(tile)
    stats.append({'page':i+1,'chars':len(text),'arabic_chars':len(re.findall(r'[\u0600-\u06ff]',text)),'links':len(p.get_links())})
for start in range(0,len(thumbs),6):
    sheet=Image.new('RGB',(321*3,452*2),'#dce4ec')
    for j,tile in enumerate(thumbs[start:start+6]): sheet.paste(tile,((j%3)*321,(j//3)*452))
    sheet.save(WORK/f'contact-{start//6+1:02}.jpg',quality=92)
alltext='\n'.join(p.get_text() for p in doc)
(WORK/'extracted.txt').write_text(alltext,encoding='utf-8')
report={'pages':len(doc),'bytes':PDF.stat().st_size,'words':len(alltext.split()),'total_links':sum(x['links'] for x in stats),'bookmarks':len(doc.get_toc()),'pages_stats':stats}
(WORK/'qa-summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
assert all(x['arabic_chars']>70 for x in stats)
print(json.dumps({k:v for k,v in report.items() if k!='pages_stats'}))
