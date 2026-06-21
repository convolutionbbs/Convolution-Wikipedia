#!/usr/bin/env python3
# wiki_render.py - Render a Wikipedia article page as sixel using Pillow

import sys, os, json, subprocess, re

# Sixel pixels per terminal cell. These must match how many sixel pixels your
# SyncTERM draws per character cell -- which depends on the terminal FONT.
# Both change whenever you switch SyncTERM fonts, so re-tune if you do.
#
# CHAR_W (horizontal): sixel-pixels per column. This sets how many COLUMNS the
#   renderer reports a photo occupies, which the door uses to CENTER the photo
#   and draw the TAB highlight box around it. If it's too high the count comes
#   out too small, so photos get pushed right of center and the highlight box is
#   too narrow / sits to their left; too low and they drift left with a box
#   that's too wide. It does NOT change a (height-bound) photo's on-screen size
#   -- that's CHAR_H. Tuned so the column count matches the real photo width.
# CHAR_H (vertical): sixel-pixels per row -- this is the photo SIZE knob. These
#   were originally low (8 / 7.8) for an OLD full-page renderer that's no longer
#   used; the current door sizes photos to a cell box and weaves them into real
#   text, so low values made photos tiny and left a blank band beneath them.
#   If a photo OVERLAPS the text below it, lower CHAR_H; if there's a gap, raise.
CHAR_W = 8.0    # fallback sixel-pixels per column when the JS layer didn't pass a cell size
CHAR_H = 13.7   # fallback sixel-pixels per row (only used if no cellw/cellh is supplied)
# Normally the JS layer detects the terminal's real character-cell pixel size and
# passes it in (defaulting to 8x8); render_photo then uses that directly, so image
# sizing is correct for any font/resolution and these fallbacks go unused.

# Top breathing room (pixels) before the title.
#   0  = title sits right at the top of the screen.
#   ~16 (one row) = nudge down a little if SyncTERM clips the very top line.
# This replaces the old SYNCTERM_OFFSET (which was pushing everything ~12 rows
# down and is what made the page look like it had "scrolled too far down").
TOP_MARGIN = 0

# --- Vertical aspect compensation -------------------------------------------
# SyncTERM (at least on macOS) draws sixels taller than wide: measured ~1.4x
# (horizontal magnification ~2.25, vertical ~3.14). That stretch makes text
# look tall/loosely-spaced and elongates the photo. We counteract it by
# rendering ~VSTRETCH times more vertical content per screen and squishing it
# back down before output, so SyncTERM's stretch restores correct proportions
# and the text ends up shorter (more lines per screen).
#   1.0  = no compensation (square 1:1, what a spec-correct terminal shows)
#   1.4  = cancels the measured macOS SyncTERM stretch
# If text looks vertically squashed, lower this; if still tall, raise it.
VSTRETCH = 1.4

# --- Scroll step ------------------------------------------------------------
# How far each page-down/up moves, as a fraction of one screen of content.
# Each screen shows a lot of (dense) text, so a full-screen jump felt like
# "scrolling too far". This advances only part of a screen per keypress, so
# successive views overlap and movement is gentle. Nothing is ever skipped.
#   1.0  = jump a full screen each time (what felt too far)
#   0.5  = move about a third of a screen (gentle)
#   0.33 = move even less (very gentle, lots of overlap)
# Lower = less movement per keypress; raise it if it now moves too little.
SCROLL_STEP = 0.5


def get_font(size, bold=False):
    from PIL import ImageFont
    fonts = [
        (r"C:\Windows\Fonts\arialbd.ttf",  r"C:\Windows\Fonts\arial.ttf"),
        (r"C:\Windows\Fonts\verdanab.ttf", r"C:\Windows\Fonts\verdana.ttf"),
        (r"C:\Windows\Fonts\calibrib.ttf", r"C:\Windows\Fonts\calibri.ttf"),
        (r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\segoeui.ttf"),
        # Linux fallbacks (handy for off-machine testing)
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for bold_path, reg_path in fonts:
        path = bold_path if bold else reg_path
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    # Last resort: scalable default if this Pillow supports a size arg
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def download_image(url, dest):
    try:
        rc = subprocess.run(
            ['curl', '-s', '-L', '-k', '--max-time', '10',
             '-H', 'User-Agent: Mozilla/5.0', '-o', dest, url],
            capture_output=True, timeout=15).returncode
        return rc == 0 and os.path.exists(dest) and os.path.getsize(dest) > 200
    except Exception:
        return False


def _to_rgb_white(im):
    """Normalize any image mode to RGB, compositing transparency onto WHITE.
    Wikipedia infobox art is usually a transparent PNG meant to sit on a white
    page; dropping alpha with a bare convert('RGB') exposes whatever undefined
    RGB lives in the transparent pixels (often a flat color that then skews the
    contrast stretch). Compositing onto white matches the real presentation and
    keeps the histogram clean. Palette-with-transparency and CMYK are handled too."""
    from PIL import Image
    if im.mode == 'P' and 'transparency' in im.info:
        im = im.convert('RGBA')
    if im.mode in ('RGBA', 'LA'):
        im = im.convert('RGBA')
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        return Image.alpha_composite(bg, im).convert('RGB')
    return im.convert('RGB')


def _autocontrast_luma(im, cutoff=2):
    """Luminance-preserving autocontrast. Plain ImageOps.autocontrast stretches
    each of R/G/B independently, so a strongly-tinted image gets a color cast --
    an indigo GameCube (very low green channel) has its green over-stretched and
    turns green/teal. Here the stretch is derived once from the luminance
    histogram and the SAME mapping is applied to every channel, so brightness/
    contrast improve but hue is left intact."""
    from PIL import Image, ImageOps
    try:
        return ImageOps.autocontrast(im, cutoff=cutoff, preserve_tone=True)
    except TypeError:
        pass  # older Pillow: fall back to a manual luminance LUT
    hist = im.convert('L').histogram()
    total = sum(hist)
    if total <= 0:
        return im
    cut = total * cutoff // 100
    lo, acc = 0, 0
    for i in range(256):
        acc += hist[i]
        if acc > cut:
            lo = i
            break
    hi, acc = 255, 0
    for i in range(255, -1, -1):
        acc += hist[i]
        if acc > cut:
            hi = i
            break
    if hi <= lo:
        return im
    scale = 255.0 / (hi - lo)
    lut = [max(0, min(255, int(round((i - lo) * scale)))) for i in range(256)]
    return im.point(lut * len(im.getbands()))


def render(article, width_px, height_px, scroll_px):
    from PIL import Image, ImageDraw, ImageOps, ImageEnhance

    BG      = ( 15,  15,  15)
    FG      = (225, 225, 225)
    TITLE_C = (255, 255, 255)
    DESC_C  = (165, 165, 165)
    HEAD_C  = (255, 205,  60)
    BORDER  = ( 85,  85,  85)

    PAD        = 12
    FONT_SIZE  = 16
    TITLE_SIZE = 22
    HEAD_SIZE  = 17

    font       = get_font(FONT_SIZE)
    title_font = get_font(TITLE_SIZE, bold=True)
    head_font  = get_font(HEAD_SIZE,  bold=True)

    # Pitch near the font's nominal line height. The vertical squish (VSTRETCH)
    # compresses everything afterward, so this displays as tight single spacing
    # with correctly-proportioned glyphs rather than the stretched/loose look.
    _asc, _desc = font.getmetrics()
    LINE_H = round((_asc + _desc) * 0.95)

    # Tall scratch canvas; we crop one screenful out of it per page.
    page_h = height_px * 12
    page   = Image.new('RGB', (width_px, page_h), BG)
    draw   = ImageDraw.Draw(page)

    # ---- Thumbnail (top-right) ----------------------------------------------
    thumb = None
    thumb_w = thumb_h = 0
    thumb_x = thumb_y = 0
    image_url = article.get('imageUrl', '')
    if image_url:
        # Cache the thumbnail by URL hash so it is fetched ONCE per article,
        # not re-downloaded from Wikipedia on every page (that network round
        # trip was a big part of the per-page render time).
        import hashlib
        cache_dir = r"e:\sbbs\node1\temp"
        cache_name = "wiki_thumb_" + hashlib.md5(image_url.encode()).hexdigest()[:12] + ".jpg"
        tmp_path = os.path.join(cache_dir, cache_name)
        have = os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0
        if have or download_image(image_url, tmp_path):
            try:
                t = _to_rgb_white(Image.open(tmp_path))
                # Auto-level, add a touch of contrast/saturation, and pull
                # brightness DOWN slightly. A brightness boost was blowing the
                # highlights out to flat white (the washed-out look); this keeps
                # the full tonal range with essentially no clipping.
                t = _autocontrast_luma(t, cutoff=2)
                t = ImageEnhance.Contrast(t).enhance(1.12)
                t = ImageEnhance.Color(t).enhance(1.25)
                t = ImageEnhance.Brightness(t).enhance(0.96)
                max_w = int(width_px * 0.26)
                max_h = int(height_px * 0.55)
                t.thumbnail((max_w, max_h), Image.LANCZOS)
                # Pre-dither the photo into RGB so it keeps smooth tonality
                # after the global no-dither quantize (which keeps text crisp).
                # Without this, photos posterize/band badly.
                try:
                    t = t.convert('P', palette=Image.ADAPTIVE, colors=128,
                                  dither=Image.Dither.FLOYDSTEINBERG).convert('RGB')
                except Exception:
                    pass
                thumb = t
                thumb_w, thumb_h = t.size
                thumb_x = width_px - thumb_w - PAD
                thumb_y = TOP_MARGIN + PAD
            except Exception:
                thumb = None

    # Right edge for a line of text at vertical position y_line: if the line
    # sits next to the image, stop before it; otherwise use the full width.
    img_band_bot = (thumb_y + thumb_h + 8) if thumb else 0

    def right_edge(y_line):
        if thumb and (y_line + LINE_H) > thumb_y and y_line < img_band_bot:
            return thumb_x - PAD
        return width_px - PAD

    def hrule(y):
        draw.line([(PAD, y), (right_edge(y), y)], fill=BORDER)

    # Safe horizontal cut positions (between text lines). We snap the page crop
    # to these so a line is never sliced through the middle at the page edge.
    cut_ys = [0]

    def draw_wrapped(text, fnt, fill, y, limit):
        words = text.split()
        if not words:
            return y
        cur = ""
        for w in words:
            if y > limit:
                return y
            trial = w if not cur else cur + " " + w
            avail = right_edge(y) - PAD
            if fnt.getlength(trial) <= avail or not cur:
                cur = trial
            else:
                draw.text((PAD, y), cur, font=fnt, fill=fill)
                y += LINE_H
                cut_ys.append(y)
                cur = w
        if cur and y <= limit:
            draw.text((PAD, y), cur, font=fnt, fill=fill)
            y += LINE_H
            cut_ys.append(y)
        return y

    # Paste the image first; text layers stop before it anyway.
    if thumb:
        page.paste(thumb, (thumb_x, thumb_y))
        draw.rectangle([thumb_x - 1, thumb_y - 1,
                        thumb_x + thumb_w, thumb_y + thumb_h], outline=BORDER)

    y = TOP_MARGIN + PAD

    # ---- Title ----
    title = article.get('title', 'Untitled')
    draw.text((PAD, y), title, font=title_font, fill=TITLE_C)
    y += TITLE_SIZE + 6
    hrule(y)
    y += 9
    cut_ys.append(y)

    # ---- Description ----
    desc = article.get('description', '')
    if desc:
        y = draw_wrapped(desc, font, DESC_C, y, page_h - LINE_H)
        y += 8
        cut_ys.append(y)

    # ---- Body ----
    limit = page_h - LINE_H
    extract = article.get('extract', '')
    paragraphs = [p for p in extract.split('\n') if p.strip()]

    for para in paragraphs:
        if y > limit:
            break
        s = para.strip()

        # Section heading: "== Heading ==" (any number of '=')
        if s.startswith('=') and s.endswith('='):
            heading = s.strip('= ').strip()
            if not heading:
                continue
            y += 10
            cut_ys.append(y)
            draw.text((PAD, y), heading.upper(), font=head_font, fill=HEAD_C)
            y += HEAD_SIZE + 4
            hrule(y)
            y += 9
            cut_ys.append(y)
            continue

        y = draw_wrapped(s, font, FG, y, limit)
        y += 8  # paragraph gap
        cut_ys.append(y)

    # ---- Crop one screenful, then squish vertically to cancel SyncTERM's
    #      taller-than-wide sixel rendering. We grab VSTRETCH x more vertical
    #      content and shrink it back to height_px; SyncTERM stretches it on
    #      display, so proportions come out right and more lines fit.
    content_bottom = y
    eff_h      = max(1, int(round(height_px * VSTRETCH)))
    max_scroll = max(0, content_bottom - eff_h)
    # Advance only SCROLL_STEP of a screen per page, so movement is gentle and
    # successive pages overlap (nothing skipped). Raising SCROLL_STEP moves more.
    crop_top   = min(max(0, int(round(scroll_px * SCROLL_STEP))), max_scroll)

    # Snap the crop to line boundaries so the top and bottom lines are whole
    # rather than sliced through the middle. cut_ys holds safe (between-line)
    # y positions; we start at one and end at one. The pages overlap enough
    # (eff_h is much larger than one line) that snapping never skips content.
    import bisect
    cuts = sorted(set(cut_ys))
    def snap_down(v):
        i = bisect.bisect_right(cuts, v)
        return cuts[i - 1] if i > 0 else 0
    crop_top = snap_down(crop_top)
    crop_bot = snap_down(crop_top + eff_h)
    if crop_bot <= crop_top:                 # safety: at least one line tall
        crop_bot = min(crop_top + eff_h, content_bottom)
    crop_h = crop_bot - crop_top

    if crop_bot > page_h:
        bigger = Image.new('RGB', (width_px, crop_bot), BG)
        bigger.paste(page, (0, 0))
        page = bigger
    crop = page.crop((0, crop_top, width_px, crop_bot))   # width_px x crop_h
    # Squish the (whole-line) crop down to the target height. crop_h varies by
    # at most one line between pages, so text size is effectively constant.
    if crop_h != height_px:
        crop = crop.resize((width_px, height_px), Image.LANCZOS)
    return crop, max_scroll


def to_sixel(img):
    from PIL import Image
    w, h = img.size

    # MEDIANCUT + NO dithering. The old code reached the enum via an image
    # *instance* (img.Quantize...), which raises AttributeError and silently
    # fell back to a dithered quantize -- that dithering is what made the text
    # look fuzzy / hard to read.
    try:
        img_p = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT,
                             dither=Image.Dither.NONE)
    except Exception:
        img_p = img.quantize(colors=256, dither=Image.Dither.NONE)

    pal = img_p.getpalette()
    out = ['\x1bP0;1;0q', '"%d;%d;%d;%d' % (1, 1, w, h)]  # 1:1 pixel aspect
    for ci in range(min(256, len(pal) // 3)):
        r = pal[ci * 3]     * 100 // 255
        g = pal[ci * 3 + 1] * 100 // 255
        b = pal[ci * 3 + 2] * 100 // 255
        out.append('#%d;2;%d;%d;%d' % (ci, r, g, b))

    # ---- Fast path: vectorize the per-pixel bit-packing with NumPy. This loop
    #      (one pass over every pixel) was the bulk of the render time; NumPy
    #      turns ~1.8M Python iterations into a handful of array ops. If NumPy
    #      isn't installed it falls back to the pure-Python loop below with
    #      identical output (just slower). Run `pip install numpy` to enable.
    used_numpy = False
    try:
        import numpy as np
        idx = np.asarray(img_p, dtype=np.uint8)            # (h, w) palette idx
        weights = (1 << np.arange(6)).astype(np.uint16)    # 1,2,4,...,32
        for by in range(0, h, 6):
            band = idx[by:by + 6]                          # (nb, w), nb<=6
            wcol = weights[:band.shape[0]][:, None]
            first = True
            for ci in np.unique(band):                     # ascending, like sorted()
                vals = ((band == ci) * wcol).sum(axis=0).astype(np.uint8)  # (w,)
                if not first:
                    out.append('$')
                out.append('#%d' % int(ci))
                # Vectorized run-length encoding: find where the value changes,
                # then emit one token per run (text has long background runs, so
                # this is a handful of iterations instead of one per column).
                n = vals.shape[0]
                chg = np.nonzero(np.diff(vals))[0] + 1
                starts = np.concatenate(([0], chg))
                runs = np.diff(np.concatenate((starts, [n])))
                codes = (vals[starts].astype(np.int32) + 63)
                for code, run in zip(codes.tolist(), runs.tolist()):
                    ch = chr(code)
                    while run > 0:
                        r = 255 if run > 255 else run
                        out.append('!%d%s' % (r, ch) if r >= 3 else ch * r)
                        run -= r
                first = False
            out.append('-')
        used_numpy = True
    except ImportError:
        pass

    if not used_numpy:
        try:
            pixels = list(img_p.get_flattened_data())
        except AttributeError:
            pixels = list(img_p.getdata())
        for by in range(0, h, 6):
            cc = {}
            for x in range(w):
                for bit in range(6):
                    py = by + bit
                    if py < h:
                        ci = pixels[py * w + x]
                        if ci not in cc:
                            cc[ci] = [0] * w
                        cc[ci][x] |= (1 << bit)
            first = True
            for ci in sorted(cc):
                ba = cc[ci]
                if not first:
                    out.append('$')
                out.append('#%d' % ci)
                i = 0
                while i < len(ba):
                    ch = ba[i] + 63
                    run = 1
                    while i + run < len(ba) and ba[i + run] + 63 == ch and run < 255:
                        run += 1
                    out.append(('!%d%s' % (run, chr(ch))) if run >= 3 else chr(ch) * run)
                    i += run
                first = False
            out.append('-')

    out.append('\x1b\\')
    return ''.join(out)


def render_photo(article, maxcols, maxrows, upscale=False, cellw=None, cellh=None):
    """Render ONLY the article thumbnail to a sixel sized to fit at most
    maxcols x maxrows terminal cells. The photo is vertically pre-squished by
    VSTRETCH (same trick as the page) so SyncTERM's vertical stretch restores
    correct proportions. When upscale=True the image is scaled UP to fill the
    box (used for the full-screen "enlarge" view). Returns (sixel, rows, cols)
    or (None, 0, 0)."""
    from PIL import Image, ImageOps, ImageEnhance
    import math
    image_url = article.get('imageUrl', '')
    if not image_url:
        return None, 0, 0
    import hashlib
    cache_dir = r"e:\sbbs\node1\temp"
    cache_name = "wiki_thumb_" + hashlib.md5(image_url.encode()).hexdigest()[:12] + ".jpg"
    tmp_path = os.path.join(cache_dir, cache_name)
    have = os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0
    if not (have or download_image(image_url, tmp_path)):
        return None, 0, 0
    try:
        t = _to_rgb_white(Image.open(tmp_path))
    except Exception:
        return None, 0, 0
    # Auto-level PHOTOS for punch, but NOT flat-background subject art (Wikipedia
    # infobox PNGs sitting on white). On such art the subject fills only a narrow
    # tonal band and autocontrast would stretch it to 0-255, washing/darkening it
    # (and the per-channel variant tints it -- that's why the indigo GameCube went
    # green). A flat background shows a tall near-white or near-black spike; a
    # photo's luminance histogram is smooth, so use that to decide.
    _h = t.convert('L').histogram()
    _tot = sum(_h) or 1
    _flat_bg = (sum(_h[250:]) / float(_tot) > 0.15) or (sum(_h[:6]) / float(_tot) > 0.15)
    if _flat_bg:
        # Infobox product art: the source already has correct, saturated colors on
        # a clean background. Auto-leveling and a saturation boost only distort it
        # (washing/tinting the subject), so apply just a hair of contrast.
        t = ImageEnhance.Contrast(t).enhance(1.05)
    else:
        # Photo: auto-level for punch (luminance-preserving, so no color cast), a
        # little contrast and saturation, and brightness pulled down slightly to
        # keep highlights from blowing out.
        t = _autocontrast_luma(t, cutoff=2)
        t = ImageEnhance.Contrast(t).enhance(1.12)
        t = ImageEnhance.Color(t).enhance(1.25)
        t = ImageEnhance.Brightness(t).enhance(0.96)
    # Use the terminal's actual character-cell pixel size directly (the JS layer
    # detects it, or passes a sensible 8x8 default). When the grid's pixel
    # resolution matches the display aspect -- e.g. 160x90 @ 8x8 = 1280x720 = 16:9
    # -- pixels are square and no vertical squish is wanted, so vstr = 1.0.
    cw = float(cellw) if cellw else CHAR_W
    ch = float(cellh) if cellh else CHAR_H
    vstr = 1.0
    box_w = max(1, int(maxcols * cw))
    box_h = max(1, int(maxrows * ch))
    eff_h = max(1, int(box_h * vstr))
    if upscale:
        # Scale to fill the box (up or down), preserving aspect.
        scale = min(box_w / float(t.width), eff_h / float(t.height))
        t = t.resize((max(1, int(t.width * scale)), max(1, int(t.height * scale))), Image.LANCZOS)
    else:
        t.thumbnail((box_w, eff_h), Image.LANCZOS)   # downscale-only
    new_h = max(1, int(round(t.height / vstr)))
    t = t.resize((t.width, new_h), Image.LANCZOS)
    try:
        t = t.convert('P', palette=Image.ADAPTIVE, colors=128,
                      dither=Image.Dither.FLOYDSTEINBERG).convert('RGB')
    except Exception:
        pass
    sixel = to_sixel(t)
    # Sixels paint in 6px-tall bands, so the displayed height rounds up to the
    # next band boundary; count rows from THAT height so text never overlaps.
    padded_h  = int(math.ceil(t.height / 6.0) * 6)
    rows_used = int(math.ceil(padded_h / ch))
    cols_used = int(math.ceil(t.width / cw))
    return sixel, rows_used, cols_used


def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    article_json = sys.argv[1]
    output_path  = sys.argv[2]

    def err(msg):
        open(output_path, 'w').write('ERROR: ' + msg)

    # ---- Image-only mode: render just the photo as a top block ------------
    #   python wiki_render.py <json> <out> --image <maxcols> <maxrows>
    # Output file is "ROWS=<n>\n" followed by the raw sixel.
    if sys.argv[3] == '--image':
        try:
            maxcols = int(sys.argv[4]); maxrows = int(sys.argv[5])
            override_url = sys.argv[6] if len(sys.argv) > 6 else None
            upscale = False
            cellw = None; cellh = None
            for tok in sys.argv[7:]:
                if tok == 'upscale':
                    upscale = True
                else:
                    mcell = re.match(r'^cell(\d+)x(\d+)$', tok)
                    if mcell:
                        cellw = int(mcell.group(1)); cellh = int(mcell.group(2))
            if override_url:
                article = {'imageUrl': override_url}
            else:
                article = json.load(open(article_json, encoding='utf-8', errors='replace'))
        except Exception as e:
            err(str(e)); sys.exit(1)
        try:
            sixel, rows_used, cols_used = render_photo(article, maxcols, maxrows, upscale, cellw, cellh)
            if not sixel:
                err('no image'); sys.exit(1)
            with open(output_path, 'wb') as f:
                f.write(('ROWS=%d COLS=%d\n' % (rows_used, cols_used)).encode('latin-1'))
                f.write(sixel.encode('latin-1', 'replace'))
            sys.exit(0)
        except Exception as e:
            import traceback
            err(str(e) + '\n' + traceback.format_exc()); sys.exit(1)

    cols         = int(sys.argv[3])
    rows         = int(sys.argv[4])
    scroll_px    = int(sys.argv[5]) if len(sys.argv) > 5 else 0

    width_px  = int(round(cols * CHAR_W))
    height_px = int(round(rows * CHAR_H))

    try:
        article = json.load(open(article_json, encoding='utf-8', errors='replace'))
    except Exception as e:
        err(str(e)); sys.exit(1)

    try:
        img, max_scroll = render(article, width_px, height_px, scroll_px)
        debug_png = output_path.replace('.six', '.png')
        try:
            img.save(debug_png)
        except Exception:
            pass
        sixel = to_sixel(img)
        open(output_path, 'wb').write(sixel.encode('latin-1', 'replace'))
        sys.exit(0)
    except Exception as e:
        import traceback
        err(str(e) + '\n' + traceback.format_exc())
        sys.exit(1)


if __name__ == '__main__':
    main()
