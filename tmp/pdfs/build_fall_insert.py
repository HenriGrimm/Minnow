from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import CMYKColor
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject
import math

ROOT=Path.cwd()
OUT=ROOT/'output/pdf'
ART=Path(r'C:/Users/dukky/.codex/generated_images/01a160a0-c7a6-7723-97e1-0c54e3c7f3d2')
for name,file in [('Serif','GARA.TTF'),('SerifItalic','GARAIT.TTF'),('SerifBold','GARABD.TTF'),('Script','FREESCPT.TTF'),('DisplayScript','VIVALDII.TTF')]:
    pdfmetrics.registerFont(TTFont(name,str(Path('C:/Windows/Fonts')/file)))
pdfmetrics.registerFont(TTFont('Handwritten',str(ROOT/'tmp/pdfs/fonts/WindSong.ttf')))
IVORY=CMYKColor(0,.018,.045,.012)
COPPER=CMYKColor(.06,.66,.85,.06)
DARK=CMYKColor(.35,.67,.69,.58)
W,H=396,612

def tracked(c,text,x,y,size=8,spacing=1.8,color=DARK,center=True):
    c.saveState()
    width=pdfmetrics.stringWidth(text,'SerifBold',size)+(len(text)-1)*spacing
    t=c.beginText(x-width/2 if center else x,y)
    t.setFont('SerifBold',size); t.setCharSpace(spacing); t.setFillColor(color); t.textOut(text); c.drawText(t)
    c.restoreState()

def line(c,x1,y,x2,color=COPPER,width=.45):
    c.setStrokeColor(color);c.setLineWidth(width);c.line(x1,y,x2,y)

def art(c,file,x,y,w,h):
    c.saveState();c.setBlendMode('Multiply');c.setFillAlpha(.34)
    c.drawImage(str(ART/file),x,y,width=w,height=h,mask='auto',preserveAspectRatio=True,anchor='c')
    c.restoreState()

def monogram(c,x,y,size=25):
    c.setStrokeColor(COPPER);c.setLineWidth(.65);c.rect(x-size/2,y-size/2,size,size)
    c.setFillColor(COPPER);c.setFont('Serif',size*.67)
    c.drawCentredString(x,y-size*.22,'GB')

def masthead(c,y):
    text='GRIMM’S BLUFF'
    for i,ch in enumerate(text):
        offset=(i-(len(text)-1)/2)*10.5
        c.saveState();c.translate(198+offset,y+15*(1-(offset/70)**2))
        c.rotate(-offset*.22);c.setFillColor(COPPER);c.setFont('SerifBold',10)
        c.drawCentredString(0,0,ch);c.restoreState()
    c.setFillColor(COPPER);c.setFont('Serif',24)
    c.drawString(188,y-24,'G');c.drawString(198,y-32,'B')
    line(c,157,y-19,173);line(c,224,y-19,240)
    tracked(c,'WINE CLUB  /  FALL 2026',198,y-51,6.8,1.4)

def para(c,text,x,top,width,size=11.7,leading=16.5):
    style=ParagraphStyle('body',fontName='Serif',fontSize=size,leading=leading,textColor=DARK)
    p=Paragraph(text,style);_,height=p.wrap(width,500);p.drawOn(c,x,top-height)
    return top-height

def paint(c,side,bleed=0):
    c.setFillColor(IVORY);c.rect(-bleed,-bleed,W+2*bleed,H+2*bleed,fill=1,stroke=0)
    if side==0:
        masthead(c,550)
        c.setFillColor(COPPER)
        c.saveState();c.translate(21,332);c.rotate(12);c.setFont('Handwritten',112)
        c.drawString(0,0,'thank');c.restoreState()
        c.saveState();c.translate(133,264);c.rotate(10);c.setFont('Handwritten',115)
        c.drawString(0,0,'you');c.restoreState()
        tracked(c,'FOR THE TABLE. FOR THE SEASON. FOR YOU.',198,196,6.7,.85)
        art(c,'exec-7422bf40-4553-4db4-bde2-a7f810dc85b8.png',-17,21,115,149)
        art(c,'exec-01dced3f-e0f1-4395-abc9-4d9d6e4b8322.png',108,37,176,118)
        art(c,'exec-cdff28cc-7f1d-48aa-8b5e-426c463ce4b5.png',286,40,87,92)
    else:
        masthead(c,556)
        art(c,'exec-7422bf40-4553-4db4-bde2-a7f810dc85b8.png',289,403,124,161)
        c.setFillColor(COPPER);c.setFont('Serif',55)
        c.drawString(38,447,'A season')
        c.drawString(38,393,'to savor.')
        top=352
        paragraphs=[
          'For dinners that linger, familiar faces, and evenings that call for another glass - we’re happy to send a little Grimm’s Bluff your way.',
          'Thank you for being part of our wine club and supporting the care that goes into this estate and every bottle we share.',
          'We hope these wines find their way to a table full of good food and people you love. Open a bottle, share a story, and settle in.',
          'Here’s to good company and a season worth savoring.'
        ]
        for text in paragraphs:
            top=para(c,text,38,top,317,size=12,leading=16.5)-14
        c.setFillColor(DARK);c.setFont('SerifItalic',11);c.drawString(38,top-4,'With gratitude,')
        c.setFillColor(COPPER);c.setFont('Handwritten',23);c.drawString(35,top-38,'Rick & Aurora Grimm')
        tracked(c,'HAPPY CANYON OF SANTA BARBARA',174,49,6.2,.9)
        tracked(c,'GRIMMSBLUFF.COM',174,34,6.7,1.1)
        monogram(c,344,44,24)

def metadata(c):
    c.setTitle('Grimm’s Bluff | Fall 2026 Wine Club Insert')
    c.setAuthor('Grimm’s Bluff')
    c.setSubject('5.5 x 8.5 inch double-sided wine club thank-you insert')

raw=ROOT/'tmp/pdfs/press-raw.pdf'
c=canvas.Canvas(str(raw),pagesize=(432,648),pageCompression=1);metadata(c)
for side in range(2):
    c.saveState();c.translate(18,18);paint(c,side,9);c.restoreState()
    c.setStrokeColor(CMYKColor(0,0,0,1));c.setLineWidth(.3)
    for x in (18,414):
        c.line(x,2,x,7);c.line(x,641,x,646)
    for y in (18,630):
        c.line(2,y,7,y);c.line(425,y,430,y)
    c.showPage()
c.save()
reader=PdfReader(raw);writer=PdfWriter()
for page in reader.pages:
    page.trimbox=RectangleObject([18,18,414,630])
    page.bleedbox=RectangleObject([9,9,423,639])
    writer.add_page(page)
writer.add_metadata({'/Title':'Grimm’s Bluff | Fall 2026 | Printer version','/Author':'Grimm’s Bluff'})
with open(OUT/'grimms-bluff-fall-2026-printer.pdf','wb') as f:writer.write(f)

c=canvas.Canvas(str(OUT/'grimms-bluff-fall-2026-letter-two-up.pdf'),pagesize=(792,612),pageCompression=1);metadata(c)
for side in range(2):
    for x in (0,396):
        c.saveState();c.translate(x,0);c.rect(0,0,W,H,stroke=0,fill=0)
        p=c.beginPath();p.rect(0,0,W,H);c.clipPath(p,stroke=0)
        paint(c,side);c.restoreState()
    c.showPage()
c.save()
print('Created two final PDFs.')
