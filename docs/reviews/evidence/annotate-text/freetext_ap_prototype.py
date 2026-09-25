"""Prototype: FreeText whose appearance is drawn line-by-line with ONE font (Arimo),
at baselines the browser computes identically (ascent/descent overrides pinned)."""
import pymupdf as f
from bidi.algorithm import get_display
FONT='fonts/Arimo-Regular.ttf'
ASC, DESC = 1854/2048, 434/2048          # pinned in CSS via ascent/descent-override
LH = 1.2                                  # line-height ratio, both sides
face = f.Font(fontfile=FONT)

def is_rtl(s):
    for ch in s:
        o=ord(ch)
        if 0x590<=o<=0x8ff: return True
        if ch.isalpha(): return False
    return False

def box_size(lines, size):
    w = max((face.text_length(l, fontsize=size) for l in lines), default=0)
    return w, len(lines)*LH*size

def add_text_box(doc, page, x, y, lines, size, color=(0,0,0)):
    """x,y = top-left of the box in page points (top-left origin)."""
    w, h = box_size(lines, size)
    w = max(w, 1)
    rect = f.Rect(x, y, x+w, y+h)
    annot = page.add_freetext_annot(rect, "\n".join(lines), fontsize=size, text_color=color, border_width=0)
    annot.update()
    # draw the lines on a scratch page of exactly the box size
    scratch = doc.new_page(width=w, height=h)
    tw = f.TextWriter(scratch.rect, color=color)
    rtl_para = is_rtl("\n".join(lines))
    for i, line in enumerate(lines):
        base = (LH*size - (ASC+DESC)*size)/2 + ASC*size + i*LH*size
        vis = get_display(line, base_dir='R' if rtl_para else 'L')
        lw = face.text_length(vis, fontsize=size)
        lx = (w - lw) if rtl_para else 0
        tw.append((lx, base), vis, font=face, fontsize=size)
    tw.write_text(scratch)
    scratch.clean_contents()
    cx = scratch.get_contents()[0]
    res = doc.xref_get_key(scratch.xref, "Resources")
    kind, ap = doc.xref_get_key(annot.xref, "AP/N"); apx = int(ap.split()[0])
    doc.xref_set_key(apx, "Resources", res[1])
    doc.xref_set_key(apx, "BBox", f"[0 0 {w} {h}]")
    doc.xref_set_key(apx, "Matrix", "[1 0 0 1 0 0]")
    doc.update_stream(apx, doc.xref_stream(cx))
    return rect, scratch.number

doc = f.open('form.pdf'); page = doc[0]
BOXES = [
  (100, 52, ["Yuval Haspel"], 12),
  (125, 100, ["12 Herzl St., Petah Tikva", "second line, still visible"], 12),
  (125, 150, ["רחוב הרצל 12, פתח תקווה", "דירה 4"], 14),
  (300, 200, ["small 9pt text AVAWAY fi fl"], 9),
]
scratch=[]
for x,y,lines,size in BOXES:
    r,n = add_text_box(doc, doc[0], x,y,lines,size); scratch.append(n); print(r)
doc.delete_pages(scratch)
doc.save('zen_proto.pdf', garbage=3, deflate=True)
d=f.open('zen_proto.pdf'); p=d[0]
for a in p.annots(): print(a.type[1], a.rect)
# expected baselines vs what a reader extracts
for b in p.get_text('dict')['blocks']:
  for l in b['lines']:
    for s in l['spans']:
      print(round(s['origin'][0],2), round(s['origin'][1],2), s['font'], s['size'], repr(s['text']))
