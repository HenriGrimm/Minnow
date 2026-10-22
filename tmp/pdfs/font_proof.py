from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pathlib import Path
c=canvas.Canvas('tmp/pdfs/font-proof.pdf',pagesize=(700,1000))
for i,name in enumerate(['PassionsConflict','MrsSaintDelafield','WindSong','OoohBaby','Whisper']):
    pdfmetrics.registerFont(TTFont(name,str(Path('tmp/pdfs/fonts')/(name+'.ttf'))))
    y=920-i*190
    c.setFillColorRGB(.3,.2,.15);c.setFont('Helvetica',12);c.drawString(20,y,name)
    c.setFillColorRGB(.76,.35,.14);c.setFont(name,115);c.drawString(40,y-115,'thank you')
c.save()
