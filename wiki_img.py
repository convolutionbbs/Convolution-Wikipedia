#!/usr/bin/env python3
# wiki_img.py — Image-to-Sixel converter for Convolution Wikipedia Door
# Usage: python wiki_img.py <input_image> <output_file> <cols> <rows> [cw] [ch]
#
# Output file format:
#   Line 1: "DIMS:<actual_cols>:<actual_rows>"  (actual rendered size in terminal cells)
#   Rest:   sixel escape sequence data
#
# This lets the JS caller know the true image dimensions for layout.

import sys, os

def write_result(out_path, text):
    try:
        with open(out_path, 'wb') as f:
            f.write(text.encode('latin-1', errors='replace'))
    except Exception:
        pass

def open_image(img_path):
    from PIL import Image
    with open(img_path, 'rb') as f:
        magic = f.read(16)
    if magic[:1] == b'<' or magic[:5] == b'<?xml':
        try:
            import cairosvg, io
            png_data = cairosvg.svg2png(url=img_path, output_width=400)
            return Image.open(io.BytesIO(png_data)).convert('RGB')
        except ImportError:
            pass
        return None
    img = Image.open(img_path)
    if getattr(img, 'is_animated', False) or img.format == 'GIF':
        img.seek(0)
    return img.convert('RGB')

def image_to_sixel(img_path, px_width, px_height, char_w, char_h, max_colors=256):
    try:
        from PIL import Image, ImageEnhance, ImageOps
    except ImportError:
        return "ERROR: Pillow not installed"

    if not os.path.exists(img_path):
        return "ERROR: File not found: " + img_path

    if os.path.getsize(img_path) < 50:
        return "ERROR: File too small"

    try:
        img = open_image(img_path)
        if img is None:
            return "ERROR: Cannot open image (unsupported format)"
    except Exception as e:
        try:
            from PIL import Image
            img = Image.open(img_path).convert('RGB')
        except Exception as e2:
            return "ERROR: " + str(e2)

    # Enhance
    try:
        img = ImageOps.autocontrast(img, cutoff=2)
        img = ImageEnhance.Color(img).enhance(1.3)
        img = ImageEnhance.Contrast(img).enhance(1.2)
        img = ImageEnhance.Sharpness(img).enhance(1.4)
    except Exception:
        pass

    # Resize preserving aspect ratio
    img.thumbnail((px_width, px_height), Image.LANCZOS)
    w, h = img.size

    if w < 2 or h < 2:
        return "ERROR: Image too small: " + str(w) + "x" + str(h)

    # Calculate actual terminal cell dimensions
    actual_cols = max(1, (w + char_w - 1) // char_w)   # ceil division
    actual_rows = max(1, (h + char_h - 1) // char_h)   # ceil division

    # Quantize
    try:
        img_p = img.quantize(colors=max_colors, method=Image.Quantize.MEDIANCUT)
    except Exception:
        try:
            img_p = img.quantize(colors=max_colors)
        except Exception as e:
            return "ERROR: Quantize: " + str(e)

    palette = img_p.getpalette()
    try:
        pixels = list(img_p.get_flattened_data())
    except AttributeError:
        pixels = list(img_p.getdata())

    # Build sixel
    # Raster attributes force 1:1 pixel aspect (overrides 2:1 DEC default)
    # Format: "Pan;Pad;Ph;Pv where Pan:Pad = vertical:horizontal aspect
    raster = '"%d;%d;%d;%d' % (1, 1, w, h)  # 1:1 aspect, w x h pixels
    out = ["\x1bP0;1;0q", raster]  # P0=2:1 default, overridden by raster
    num_colors = min(max_colors, len(palette) // 3)
    for ci in range(num_colors):
        r = int(palette[ci*3]   * 100 // 255)
        g = int(palette[ci*3+1] * 100 // 255)
        b = int(palette[ci*3+2] * 100 // 255)
        out.append("#%d;2;%d;%d;%d" % (ci, r, g, b))

    for band_y in range(0, h, 6):
        color_cols = {}
        for x in range(w):
            for bit in range(6):
                y = band_y + bit
                if y < h:
                    ci = pixels[y * w + x]
                    if ci not in color_cols:
                        color_cols[ci] = [0] * w
                    color_cols[ci][x] |= (1 << bit)
        first = True
        for ci in sorted(color_cols):
            bits_arr = color_cols[ci]
            if not first:
                out.append("$")
            out.append("#%d" % ci)
            i = 0
            while i < len(bits_arr):
                ch  = bits_arr[i] + 63
                run = 1
                while (i+run < len(bits_arr) and bits_arr[i+run]+63 == ch and run < 255):
                    run += 1
                if run >= 3:
                    out.append("!%d%s" % (run, chr(ch)))
                else:
                    out.append(chr(ch) * run)
                i += run
            first = False
        out.append("-")

    out.append("\x1b\\")

    # Prepend dimension header so JS knows actual rendered size
    sixel_data = "".join(out)
    return "DIMS:%d:%d\n%s" % (actual_cols, actual_rows, sixel_data)


def main():
    out_path = None
    try:
        if len(sys.argv) < 5:
            if len(sys.argv) >= 3:
                write_result(sys.argv[2], "ERROR: need 4+ args")
            sys.exit(1)
        img_path    = sys.argv[1]
        out_path    = sys.argv[2]
        target_cols = int(sys.argv[3])
        target_rows = int(sys.argv[4])
        char_w      = int(sys.argv[5]) if len(sys.argv) > 5 else 9
        char_h      = int(sys.argv[6]) if len(sys.argv) > 6 else 3
        result = image_to_sixel(img_path, target_cols*char_w, target_rows*char_h, char_w, char_h)
        write_result(out_path, result)
        sys.exit(0 if not result.startswith("ERROR") else 1)
    except Exception as e:
        if out_path:
            write_result(out_path, "ERROR: " + str(e))
        sys.exit(1)

if __name__ == "__main__":
    main()
