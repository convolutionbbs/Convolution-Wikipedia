// =============================================================================
// CONVOLUTION WIKIPEDIA ENCYCLOPEDIA  v1.0
// A Synchronet BBS JavaScript Door
// Compton's MultiMedia Encyclopedia-style interface for Wikipedia
//
// Installation:
//   1. Copy this file to your Synchronet exec/ directory
//   2. In SCFG > External Programs > Online Programs (Doors), add a new door:
//      Name   : Wiki Encyclopedia
//      Command: ?wiki_encyclopedia.js
//      Access : (whatever level you want)
//   3. That's it! No external dependencies needed.
//
// Controls (in-door):
//   S or /  - Search for an article
//   N       - Next page of article text
//   P       - Previous page of article text
//   R       - Related topics / See Also
//   H       - Help screen
//   Q       - Quit back to BBS
// =============================================================================

"use strict";

// Load Synchronet constant definitions (K_UPPER, K_NOECHO, K_LINE, etc.)
load("sbbsdefs.js");

// ---------------------------------------------------------------------------
// ANSI color helpers using Synchronet Ctrl-A codes
// Ctrl-A + letter = color attribute
// ---------------------------------------------------------------------------
var A = "\x01";          // Ctrl-A prefix for Synchronet color codes

// Foreground colors
var FG_BLACK   = A+"0";
var FG_RED     = A+"1";  // (dark red in some terminals)
var FG_GREEN   = A+"2";
var FG_YELLOW  = A+"3";
var FG_BLUE    = A+"4";
var FG_MAGENTA = A+"5";
var FG_CYAN    = A+"6";
var FG_WHITE   = A+"7";

// Bright foreground
var FG_BBLACK   = A+"K";
var FG_BRED     = A+"R";
var FG_BGREEN   = A+"G";
var FG_BYELLOW  = A+"Y";
var FG_BBLUE    = A+"B";
var FG_BMAGENTA = A+"M";
var FG_BCYAN    = A+"C";
var FG_BWHITE   = A+"W";

// COL_ aliases used in display code
var COL_BWHITE  = A+"W";   // bright white (same as FG_BWHITE)

// Background colors
var BG_BLACK   = A+"0"+A+"-";   // workaround: set fg then flip
// We'll just use raw ANSI sequences for backgrounds since they're more reliable
var RESET      = A+"N";         // Normal/reset

// Raw ANSI escape sequences (more reliable for complex bg colors)
var ESC = "\x1b[";

function ansi(code)    { return ESC + code + "m"; }
function cls()         { return ESC + "2J" + ESC + "1;1H"; }
function gotoxy(x, y)  { return ESC + y + ";" + x + "H"; }
function savecursor()  { return ESC + "s"; }
function restorecursor() { return ESC + "u"; }

// Color combos used throughout
var COL_TITLE_BG  = ansi("1;37;44");   // bright white on blue  (title bar)
var COL_HEADER_BG = ansi("0;30;46");   // black on cyan         (section headers)
var COL_BODY_BG   = ansi("0;37;40");   // gray on black         (body text)
var COL_BODY_HI   = ansi("1;37;40");   // bright white on black (emphasis)
var COL_STATUS_BG = ansi("0;30;47");   // black on white        (status bar)
var COL_HILITE    = ansi("1;33;40");   // bright yellow on black (highlights)
var COL_LINK      = ansi("1;36;40");   // bright cyan on black  (cross-refs)
var COL_BORDER    = ansi("0;36;40");   // cyan on black         (borders)
var COL_KEY       = ansi("1;32;40");   // bright green          (key hints)
var COL_INPUT     = ansi("1;37;44");   // bright white on blue  (text input field)
var COL_RESET     = ansi("0");

// ---------------------------------------------------------------------------
// Terminal size detection — reads Synchronet's tracked size (native properties)
// only. No ESC[6n probe: reading its reply would desync the welcome getstr.
// ---------------------------------------------------------------------------
function detectTerminalSize() {
    // Synchronet already tracks the negotiated terminal size, so we just READ it
    // (console.screen_columns / screen_rows). That is a pure property read with no
    // terminal I/O, so -- unlike an ESC[6n cursor-position probe -- it can never
    // drain buffered input and desync the welcome search's getstr (the "only one
    // letter" bug). Retry briefly in case the properties aren't populated the very
    // instant the door starts.
    var cols = 0, rows = 0, i;
    for (i = 0; i < 6; i++) {
        try { if (console.screen_columns > 0) cols = console.screen_columns; } catch (e) {}
        try { if (console.screen_rows    > 0) rows = console.screen_rows;    } catch (e) {}
        if (!cols) { try { cols = console.columns || 0; } catch (e) {} }
        if (!rows) { try { rows = console.rows    || 0; } catch (e) {} }
        if (cols > 0 && rows > 0) return { cols: cols, rows: rows };
        mswait(50);
    }
    // Last resort: a sane default. We deliberately do NOT probe with ESC[6n here --
    // reading its reply would desync the first getstr, which is the whole bug.
    return { cols: cols || 80, rows: rows || 24 };
}

// ---------------------------------------------------------------------------
// Detect whether the connected terminal can display sixel graphics. Prefers
// Synchronet's own auto-detected capability flag; if that isn't available,
// asks the terminal with a Primary Device Attributes request (ESC[c) and looks
// for the sixel parameter ("4") in the reply. Only falls back to "yes" when
// nothing answers either way, so existing sixel terminals never lose images.
// ---------------------------------------------------------------------------
function detectSixel() {
    // This Synchronet build doesn't expose a SIXEL capability flag (confirmed via
    // logging: SIXELdef=false), and a manual ESC[c probe is consumed by Synchronet
    // before we can read it. So key off the terminal type Synchronet recorded at
    // login: SyncTERM (the sixel client used here) reports "syncterm"; SSH clients
    // like macOS Terminal report "xterm-256color" and have no sixel. Unknown
    // terminals default to NO graphics, so they get text instead of raw-sixel junk.
    var result = false, how = "term-name";
    var term = "";
    try { term = ("" + console.terminal).toLowerCase(); } catch (e) {}
    // Known sixel-capable terminal identifiers (add more here as needed).
    if (term.indexOf("syncterm") >= 0) result = true;
    // Future-proofing: if a build ever does expose a real SIXEL flag, trust a yes.
    try {
        if (!result && typeof console.term_supports === "function" && typeof SIXEL !== "undefined") {
            if (console.term_supports(SIXEL)) { result = true; how = "term_supports(SIXEL)"; }
        }
    } catch (e2) {}
    try { log(LOG_INFO, "wiki_encyclopedia: sixel -> " + result + " (" + how + ", term=\"" + term + "\")"); } catch (e3) {}
    return result;
}

// Ask the terminal for its character-cell size in pixels (ESC[16t -> reply
// ESC[6;<height>;<width>t). This lets image sizing adapt to the font (e.g. an
// 8x8 square font vs 8x16). Uses a NON-BLOCKING inkey read with a short total
// timeout, so if the terminal/Synchronet doesn't answer it simply gives up
// (no input is consumed by blocking). Returns {w,h} or null. Run lazily, after
// the welcome search's getstr, so it can never disturb that input.
function detectCellSize() {
    var resp = "", waited = 0, ch, w = 0, h = 0;
    try {
        console.putmsg("\x1b[16t");
        while (waited < 400) {
            ch = console.inkey(K_NOECHO, 50);
            if (!ch) { waited += 50; continue; }
            resp += ch;
            if (ch === "t") break;
            if (resp.length > 40) break;
        }
        var m = /\[6;(\d+);(\d+)t/.exec(resp);
        if (m) { h = parseInt(m[1], 10); w = parseInt(m[2], 10); }
    } catch (e) {}
    try { log(LOG_INFO, "wiki_encyclopedia: cellsize -> w=" + w + " h=" + h
        + " (reply=\"" + resp.replace(/\x1b/g, "<ESC>") + "\")"); } catch (e2) {}
    if (w > 0 && h > 0 && w < 64 && h < 64) return { w: w, h: h };
    return null;
}

// Screen dimensions — set dynamically at startup
var TERM = { rows: 24, cols: 80, has256: true, hasSixel: true };
var _pendingImageUrl = "";  // set by loadArticle before calling formatArticle
var _articleImgCols  = 0;   // image columns (set before redrawArticle)
var _articleImgRows  = 0;   // image rows    (set before redrawArticle)
// Application name shown in the standard header as "Convolution BBS - <APP_NAME>".
// Change this single line when reusing this header in another Convolution BBS door.
var APP_NAME = "Wikipedia";
var WEATHER_STR = "";   // header weather ("<desc> <temp>F"), fetched once per session from the user's zip
var SIXEL_CHECKED = false;   // detectSixel() runs once, lazily, on first article load (never before the first getstr)
var CELL_PX_W = 8;           // character-cell pixel size; detected lazily, defaults to 8x8 (the common SyncTERM text cell)
var CELL_PX_H = 8;
var CELL_CHECKED = false;

var COLS = 80;
var ROWS = 24;
var CONTENT_TOP  = 4;
var CONTENT_ROWS = 17;
var CONTENT_BOT  = 21;  // recalculated by initTerminal

// Character cell pixel dimensions (detected at startup)
var CELL_W = 9;   // measured: ~9px/col (135px = 15 cols)
var CELL_H = 11;  // 12px/row: 220px=18.3rows, fits in 20 reserved with 2 gap

// Initialise terminal dimensions. SyncTERM always supports 256-color and
// sixel, so both are enabled by default.
// CELL_W and CELL_H are measured empirically for SyncTERM 132x59:
//   198px wide sixel → 22 cols, so CELL_W = 9px/col
//   60px tall sixel → ~13-14 rows, so CELL_H = 4px/row (sixel pixel density)
function initTerminal() {
    var size     = detectTerminalSize();
    COLS         = (size.cols >= 80)  ? size.cols : 80;
    ROWS         = (size.rows >= 24)  ? size.rows : 24;
    CONTENT_TOP  = 4;
    CONTENT_ROWS = ROWS - CONTENT_TOP - 3;
    CONTENT_BOT  = ROWS - 3;
    // hasSixel is determined LATER (lazily, on the first article load) so that
    // no terminal-query I/O ever precedes the welcome search prompt's getstr.
    TERM         = { rows: ROWS, cols: COLS, has256: true, hasSixel: true };

    // Infer the character-cell PIXEL size from the grid we just detected. We can't
    // query it (this terminal never answers ESC[16t), but the grid tells us the
    // font by SyncTERM convention: the classic 80x25 default uses an 8x16 VGA
    // cell, while every larger mode (80x50, 132x60, 160x90, ...) uses an 8x8 cell.
    // Width is 8 in all of them. This drives image sizing in wiki_render.py so a
    // photo lands at ~25% of screen height with no black gap, at either size.
    //   - too-SHORT screens (<=30 rows) => 8x16  (the base case)
    //   - everything bigger              => 8x8
    CELL_PX_W = 8;
    CELL_PX_H = (ROWS <= 30) ? 16 : 8;
    try { log(LOG_INFO, "wiki_encyclopedia: cell inferred " + CELL_PX_W + "x" + CELL_PX_H
        + " from " + COLS + "x" + ROWS); } catch (eC) {}
}


// ---------------------------------------------------------------------------
// Draw a horizontal line
// ---------------------------------------------------------------------------
function hline(char, width, color) {
    var s = "";
    if (color) s += color;
    for (var i = 0; i < width; i++) s += char;
    s += COL_RESET;
    return s;
}

// ---------------------------------------------------------------------------
// Center text in a field of given width
// ---------------------------------------------------------------------------
function center(str, width) {
    // strip ANSI for length calculation
    var plain = str.replace(/\x1b\[[0-9;]*m/g, "");
    var pad = Math.floor((width - plain.length) / 2);
    if (pad < 0) pad = 0;
    var result = "";
    for (var i = 0; i < pad; i++) result += " ";
    result += str;
    var remain = width - pad - plain.length;
    for (var i = 0; i < remain; i++) result += " ";
    return result;
}

// ---------------------------------------------------------------------------
// Pad/truncate a string to exactly width chars (no ANSI inside plain parts)
// ---------------------------------------------------------------------------
function padRight(str, width) {
    if (str.length > width) return str.substring(0, width);
    while (str.length < width) str += " ";
    return str;
}

// ---------------------------------------------------------------------------
// Draw the main title / masthead bar (rows 1-3)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Header clock: current date/time in the user's local zone.
//
// Synchronet stores timezones in SMB format (low 12 bits = minutes, 0x8000 =
// west of UTC). We start from the server's own local time -- which is correct
// on a self-hosted BBS and already accounts for daylight saving via the OS --
// then shift by the (DST-invariant) difference between the calling user's zone
// and the system zone so that remote callers see their own local time.
// ---------------------------------------------------------------------------
function zoneBaseMin(zone) {
    if (zone === undefined || zone === null) return null;
    var z = (typeof zone === "string") ? parseInt(zone, 10) : zone;
    if (typeof z !== "number" || isNaN(z)) return null;
    var mag = z & 0x0FFF;
    return (z & 0x8000) ? -mag : mag;
}

function clockString() {
    var serverOff = -(new Date().getTimezoneOffset());   // server's actual UTC offset (minutes, DST-aware)
    var off = serverOff;
    try {
        if (typeof user !== "undefined" && user && typeof system !== "undefined") {
            var uz = zoneBaseMin(user.zone);
            var sz = zoneBaseMin(system.timezone);
            if (uz !== null && sz !== null) off = serverOff + (uz - sz);   // adjust to the caller's zone
        }
    } catch (e) {}
    var d   = new Date(new Date().getTime() + off * 60000);   // shift instant, then read via UTC getters
    var mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var H = d.getUTCHours(), Mi = d.getUTCMinutes();
    var ap  = (H < 12) ? "AM" : "PM";
    var h12 = H % 12; if (h12 === 0) h12 = 12;
    var dd = (d.getUTCDate() < 10 ? "0" : "") + d.getUTCDate();
    var mm = (Mi < 10 ? "0" : "") + Mi;
    return dd + " " + mon[d.getUTCMonth()] + " " + d.getUTCFullYear() + "  " + h12 + ":" + mm + " " + ap;
}

function drawHeaderClock() {
    if (COLS < 56) return;                  // too narrow to fit the clock beside the name
    var info = (WEATHER_STR ? WEATHER_STR + "   " : "") + clockString();
    var s    = " " + info + " ";            // weather (if any) sits just left of the date/time
    var col  = COLS - s.length;             // right-aligned on row 1
    if (col < 30) col = 30;                 // keep clear of "Convolution BBS - <app>"
    console.putmsg(gotoxy(col, 1) + COL_TITLE_BG + s + COL_RESET + gotoxy(1, 1));
}

// ---------------------------------------------------------------------------
// Standard two-line header, shared by every screen and reusable across all
// Convolution BBS doors:
//   Row 1 : "Convolution BBS" (left)  +  date / time (right)
//   Row 2 : an application-specific title (here, the article title)
//   Row 3 : a separator rule above the content area
// Content/body for every screen begins on row 4 (CONTENT_TOP).
// ---------------------------------------------------------------------------
function drawStdHeader(appTitle) {
    var suite = " Convolution BBS" + (APP_NAME ? " - " + APP_NAME : "");
    console.putmsg(gotoxy(1, 1) + COL_TITLE_BG + padRight(suite, COLS) + COL_RESET);
    drawHeaderClock();
    var t = translit(appTitle || "");
    if (t.length > COLS - 1) t = t.substring(0, COLS - 1);
    console.putmsg(gotoxy(1, 2) + COL_HEADER_BG + " " + padRight(t, COLS - 1) + COL_RESET);
    console.putmsg(gotoxy(1, 3) + COL_BORDER + repeat("\xC4", COLS) + COL_RESET);
    console.putmsg(gotoxy(1, 1));
}

// ---------------------------------------------------------------------------
// Draw the bottom status/nav bar
// ---------------------------------------------------------------------------
function drawStatusBar(pageNum, totalPages, msg) {
    var innerW  = COLS - 2;
    var rowSep  = ROWS - 2;   // separator line
    var rowKeys = ROWS - 1;   // key hints
    var rowMsg  = ROWS;       // message bar

    // Separator rule
    console.putmsg(gotoxy(1, rowSep) + COL_BORDER + repeat("\xC4", COLS) + COL_RESET);

    // Key hints + page counter
    var pageStr = (pageNum > 0) ? "Page " + pageNum + " of " + totalPages : "";
    var keys    = "\x18\x19 Scroll  TAB=Next link  ENTER=Follow  [S]earch  [Q]uit";
    var gap     = repeat(" ", Math.max(1, innerW - pageStr.length - keys.length));
    console.putmsg(
        gotoxy(1, rowKeys) +
        COL_STATUS_BG + " " + pageStr + gap + keys + " " + COL_RESET
    );

    // Message bar (write cols 1..COLS-1 only; filling the bottom-right cell
    // makes the terminal auto-scroll, which looks like extra lines appearing).
    var msgText = msg || "Ready. Press [S] to search or [Q] to quit.";
    console.putmsg(gotoxy(1, rowMsg) + COL_BODY_BG + padRight(" " + msgText, COLS - 1) + COL_RESET);
}

// ---------------------------------------------------------------------------
// Utility: repeat a character n times
// ---------------------------------------------------------------------------
function repeat(ch, n) {
    var s = "";
    for (var i = 0; i < n; i++) s += ch;
    return s;
}

// ---------------------------------------------------------------------------
// Word-wrap a string to maxWidth, returning array of lines
// ---------------------------------------------------------------------------
function wordWrap(text, maxWidth) {
    var words  = text.split(" ");
    var lines  = [];
    var line   = "";

    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (line.length === 0) {
            line = w;
        } else if (line.length + 1 + w.length <= maxWidth) {
            line += " " + w;
        } else {
            lines.push(line);
            line = w;
        }
    }
    if (line.length > 0) lines.push(line);
    return lines;
}

// ---------------------------------------------------------------------------
// Strip HTML tags from Wikipedia text (basic)
// ---------------------------------------------------------------------------
function stripHtml(html) {
    // Replace common entities
    html = html.replace(/&amp;/g,  "&");
    html = html.replace(/&lt;/g,   "<");
    html = html.replace(/&gt;/g,   ">");
    html = html.replace(/&quot;/g, '"');
    html = html.replace(/&#39;/g,  "'");
    html = html.replace(/&nbsp;/g, " ");
    // Strip tags
    html = html.replace(/<[^>]+>/g, "");
    // Collapse whitespace
    html = html.replace(/\s+/g, " ").trim();
    return html;
}

// ---------------------------------------------------------------------------
// Clean extract text — preserve section headers (==Header==) and newlines.
// Also cleans LaTeX math markup (\displaystyle etc.) that Wikipedia embeds.
// ---------------------------------------------------------------------------

// Convert common LaTeX/math sequences to readable ASCII equivalents
function cleanLatex(expr) {
    // Strip outer \displaystyle, \textstyle, \scriptstyle wrappers
    expr = expr.replace(/\\displaystyle\s*/g, "");
    expr = expr.replace(/\\textstyle\s*/g,    "");
    expr = expr.replace(/\\scriptstyle\s*/g,  "");
    expr = expr.replace(/\\mathbf\s*/g,       "");
    expr = expr.replace(/\\mathrm\s*/g,       "");
    expr = expr.replace(/\\mathit\s*/g,       "");
    expr = expr.replace(/\\text\s*/g,         "");
    expr = expr.replace(/\\mbox\s*/g,         "");

    // Common math symbols → ASCII/Unicode approximations
    expr = expr.replace(/\\times/g,   "x");
    expr = expr.replace(/\\cdot/g,    ".");
    expr = expr.replace(/\\div/g,     "/");
    expr = expr.replace(/\\pm/g,      "+/-");
    expr = expr.replace(/\\mp/g,      "-/+");
    expr = expr.replace(/\\leq/g,     "<=");
    expr = expr.replace(/\\geq/g,     ">=");
    expr = expr.replace(/\\neq/g,     "!=");
    expr = expr.replace(/\\approx/g,  "~=");
    expr = expr.replace(/\\infty/g,   "inf");
    expr = expr.replace(/\\pi/g,      "pi");
    expr = expr.replace(/\\alpha/g,   "alpha");
    expr = expr.replace(/\\beta/g,    "beta");
    expr = expr.replace(/\\gamma/g,   "gamma");
    expr = expr.replace(/\\delta/g,   "delta");
    expr = expr.replace(/\\lambda/g,  "lambda");
    expr = expr.replace(/\\mu/g,      "mu");
    expr = expr.replace(/\\sigma/g,   "sigma");
    expr = expr.replace(/\\omega/g,   "omega");
    expr = expr.replace(/\\theta/g,   "theta");
    expr = expr.replace(/\\phi/g,     "phi");
    expr = expr.replace(/\\rho/g,     "rho");
    expr = expr.replace(/\\eta/g,     "eta");
    expr = expr.replace(/\\epsilon/g, "epsilon");
    expr = expr.replace(/\\sum/g,     "SUM");
    expr = expr.replace(/\\prod/g,    "PROD");
    expr = expr.replace(/\\int/g,     "INT");
    expr = expr.replace(/\\sqrt/g,    "sqrt");
    expr = expr.replace(/\\frac/g,    "/");
    expr = expr.replace(/\\left/g,    "");
    expr = expr.replace(/\\right/g,   "");
    expr = expr.replace(/\\{/g,       "{");
    expr = expr.replace(/\\}/g,       "}");

    // Superscripts: ^{...} or ^x  →  ^...
    expr = expr.replace(/\^\{([^}]+)\}/g, "^$1");

    // Subscripts: _{...} or _x  →  _...
    expr = expr.replace(/_\{([^}]+)\}/g, "_$1");

    // Strip remaining bare backslash-commands (\foo) we didn't handle
    expr = expr.replace(/\\[a-zA-Z]+/g, "");

    // Strip curly braces used as LaTeX grouping
    expr = expr.replace(/[{}]/g, "");

    // Collapse multiple spaces
    expr = expr.replace(/\s+/g, " ").trim();

    return expr;
}

// Strip or convert LaTeX math blocks from Wikipedia extract text.
// Patterns seen: {\displaystyle X}, {\textstyle X}, bare \command
function cleanMath(text) {
    // Match outermost { ... } blocks containing a backslash command
    // Use a simple loop since JS regex can't do recursive matching
    var result = "";
    var i = 0;
    while (i < text.length) {
        if (text.charAt(i) === "{" && text.charAt(i+1) === "\\") {
            // Find matching closing brace, tracking nesting
            var depth = 1;
            var j     = i + 1;
            while (j < text.length && depth > 0) {
                if (text.charAt(j) === "{")  depth++;
                if (text.charAt(j) === "}") depth--;
                j++;
            }
            // Extract and convert the LaTeX block
            var block = text.substring(i+1, j-1);  // contents without outer braces
            var cleaned = cleanLatex(block);
            if (cleaned) result += cleaned;
            i = j;
        } else {
            result += text.charAt(i);
            i++;
        }
    }
    return result;
}

function cleanExtract(text) {
    if (!text) return "";

    // HTML entities
    text = text.replace(/&amp;/g,  "&");
    text = text.replace(/&lt;/g,   "<");
    text = text.replace(/&gt;/g,   ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g,  "'");
    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/<[^>]+>/g, "");

    // Normalise line endings to \n
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // -----------------------------------------------------------------------
    // Wikipedia extract contains MathML blocks. Each block is a run of lines
    // containing a single char or symbol, followed by a line like:
    //   {\\displaystyle a_{1}x_{1}+\\cdots +a_{n}x_{n}=b,}
    // We scan line by line. When we hit a displaystyle line we convert it
    // to readable text and discard the preceding MathML lines.
    // Normal prose lines are kept and joined into paragraphs.
    // -----------------------------------------------------------------------
    var lines    = text.split("\n");
    var outLines = [];
    var mathBuf  = false;   // true = currently inside a MathML block

    for (var i = 0; i < lines.length; i++) {
        var raw     = lines[i];
        var trimmed = raw.trim();

        // Empty / whitespace-only line
        if (!trimmed) {
            if (!mathBuf) outLines.push("");
            continue;
        }

        // Section header ==Foo== — always keep
        if (/^=+[^=]+=+$/.test(trimmed)) {
            mathBuf = false;
            outLines.push(trimmed);
            continue;
        }

        // Displaystyle/textstyle line — the readable equation
        // In the JS runtime string, backslash is a single \
        // The line looks like: {\\displaystyle ...}  (in source)
        // At runtime it is:    {\displaystyle ...}
        // trimmed[0]=={ trimmed contains \displaystyle or \textstyle
        if (trimmed.charAt(0) === "{" &&
            (trimmed.indexOf("\\displaystyle") >= 0 ||
             trimmed.indexOf("\\textstyle")    >= 0)) {
            // Convert to readable ASCII
            var eq = cleanLatex(trimmed);
            if (eq) {
                outLines.push(eq);
                outLines.push("");
            }
            mathBuf = false;
            continue;
        }

        // Indented MathML line — short, indented, single char or symbol
        var isIndented = (raw.length > 0 && raw.charAt(0) === " ");
        var isMLChar   = (trimmed.length <= 3) ||
                         /^[+\-=.,;:()\[\]\/\\^_|*]$/.test(trimmed) ||
                         /^[a-zA-Z]$/.test(trimmed) ||
                         /^\d+$/.test(trimmed);

        if (isIndented && isMLChar) {
            mathBuf = true;
            continue;   // drop this MathML fragment
        }

        // Normal prose line
        mathBuf = false;
        outLines.push(trimmed);
    }

    // Join consecutive non-empty, non-header lines into paragraphs
    var result    = [];
    var buf       = "";
    var lastBlank = false;

    function flush() {
        var s = buf.replace(/\s+/g, " ").trim();
        if (s) { result.push(s); buf = ""; }
    }

    for (var j = 0; j < outLines.length; j++) {
        var line = outLines[j];
        if (!line) {
            flush();
            if (!lastBlank) result.push("");
            lastBlank = true;
        } else if (/^=+[^=]+=+$/.test(line)) {
            flush();
            result.push(line);
            lastBlank = false;
        } else {
            buf = buf ? buf + " " + line : line;
            lastBlank = false;
        }
    }
    flush();

    return result.join("\n").trim();
}


// ---------------------------------------------------------------------------
// URL-encode a string (safe for all Synchronet SpiderMonkey builds)
// ---------------------------------------------------------------------------
function urlEncode(str) {
    str = String(str);
    var safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    var out  = "";
    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (safe.indexOf(ch) >= 0) {
            out += ch;
        } else if (ch === " ") {
            out += "+";
        } else {
            var code = str.charCodeAt(i);
            out += "%" + (code < 16 ? "0" : "") + code.toString(16).toUpperCase();
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// HTTP GET using curl via system.exec() — works reliably in door context
// on Windows (curl is built into Windows 10+ and is in Synchronet's util/).
// Output is written to a temp file, read back, then deleted.
// ---------------------------------------------------------------------------
function httpGet(url) {
    // Build a unique temp file path in Synchronet's temp directory
    var tmpFile = system.temp_dir + "wiki_" + time() + "_" + random(99999) + ".tmp";

    // curl flags:
    //   -s           silent (no progress meter)
    //   -S           show errors even in silent mode
    //   -L           follow redirects
    //   --max-time 15  give up after 15 seconds
    //   -A           user agent string
    //   -o           output file
    var cmd = "curl -s -S -L --max-time 15"
            + " -A \"SynchronetBBSWikiDoor/1.0\""
            + " -o \"" + tmpFile + "\""
            + " \"" + url + "\"";

    var rc = system.exec(cmd);
    // Read the temp file
    var f = new File(tmpFile);
    if (!f.open("r")) {
        return null;
    }
    var body = f.read();
    f.close();

    // Clean up
    file_remove(tmpFile);

    if (!body || body.length === 0) {
        return null;
    }

    return body;
}

// Fetch a short current-conditions string for the calling user's profile zip,
// e.g. "Partly cloudy 72F". Uses wttr.in's JSON output (no API key, no degree
// symbol, always Fahrenheit via temp_F). Returns "" on any problem so the
// header simply omits weather rather than breaking. Called once at startup.
function fetchWeather() {
    try {
        if (typeof user === "undefined" || !user) return "";
        var zip = ("" + (user.zipcode || "")).replace(/[^0-9A-Za-z]/g, "");
        if (!zip) return "";
        var tmpFile = system.temp_dir + "wx_" + time() + "_" + random(99999) + ".tmp";
        var url = "http://wttr.in/" + zip + "?format=j1";
        system.exec("curl -s -S -L --max-time 12 -A \"curl/7.88.1\" -o \"" + tmpFile + "\" \"" + url + "\"");
        var body = "";
        var f = new File(tmpFile);
        if (f.open("r")) { body = f.read(); f.close(); }
        file_remove(tmpFile);
        if (!body) return "";
        var data = JSON.parse(body);
        var cc = data && data.current_condition && data.current_condition[0];
        if (!cc) return "";
        var desc = (cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].value) ? ("" + cc.weatherDesc[0].value) : "";
        desc = desc.replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" ");   // keep it short
        var tF = (cc.temp_F !== undefined && cc.temp_F !== null) ? ("" + cc.temp_F) : "";
        var out = (desc ? desc + " " : "") + (tF ? tF + "F" : "");
        out = translit(out).trim();
        if (out.length > 22) out = out.substring(0, 22);
        return out;
    } catch (e) { return ""; }
}

// ---------------------------------------------------------------------------
// Search Wikipedia using the classic MediaWiki action API (more reliable
// than the REST v1 search endpoint across Synchronet versions)
// Returns array of {title, description} or []
// ---------------------------------------------------------------------------
function wikiSearch(query) {
    // Use action=opensearch — simple, reliable, no auth needed
    // Returns: [query, [titles], [descriptions], [urls]]
    var q   = urlEncode(query);
    var url = "http://en.wikipedia.org/w/api.php?action=opensearch&search="
              + q + "&limit=10&namespace=0&format=json";
    log(LOG_DEBUG, "wiki_encyclopedia: search URL: " + url);
    var raw = httpGet(url);
    log(LOG_DEBUG, "wiki_encyclopedia: raw length: " + (raw ? raw.length : "NULL"));
    if (raw) log(LOG_DEBUG, "wiki_encyclopedia: raw[0..200]: " + raw.substring(0, 200));
    if (!raw) return [];

    try {
        var data = JSON.parse(raw);
        log(LOG_DEBUG, "wiki_encyclopedia: parsed data type: " + typeof data + " isArray: " + (data instanceof Array));
        // opensearch format: [searchTerm, [titles], [descriptions], [urls]]
        if (!data || !data[1] || data[1].length === 0) return [];
        var titles = data[1];
        var descs  = data[2] || [];
        var results = [];
        for (var i = 0; i < titles.length; i++) {
            results.push({
                title:       titles[i] || "",
                description: descs[i]  || ""
            });
        }
        return results;
    } catch(e) {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Fetch a Wikipedia article — full text plus internal links
// Uses two separate API calls so neither is truncated by the other
// Returns { title, description, extract, links[] } or null
// ---------------------------------------------------------------------------
function wikiGetArticle(title) {
    var t = urlEncode(title);

    // Call 1: full plain-text extract (no exintro — get the whole article)
    var url1 = "http://en.wikipedia.org/w/api.php?action=query"
             + "&titles=" + t
             + "&prop=extracts|description"
             + "&explaintext=1"
             + "&redirects=1"
             + "&format=json";
    var raw1 = httpGet(url1);
    if (!raw1) return null;

    var pageTitle = title;
    var pageDesc  = "";
    var pageText  = "";

    try {
        var data1  = JSON.parse(raw1);
        var pages1 = data1.query && data1.query.pages;
        if (!pages1) return null;
        var pg1 = null;
        for (var id in pages1) { pg1 = pages1[id]; break; }
        if (!pg1 || pg1.missing !== undefined) return null;
        pageTitle = pg1.title       || title;
        pageDesc  = pg1.description || "";
        pageText  = cleanExtract(pg1.extract || "");
    } catch(e) {
        return null;
    }

    // Call 2: internal links (separate call so extract isn't truncated)
    var url2 = "http://en.wikipedia.org/w/api.php?action=query"
             + "&titles=" + t
             + "&prop=links"
             + "&pllimit=500"
             + "&plnamespace=0"
             + "&redirects=1"
             + "&format=json";
    var links = [];
    var raw2  = httpGet(url2);
    if (raw2) {
        try {
            var data2  = JSON.parse(raw2);
            var pages2 = data2.query && data2.query.pages;
            if (pages2) {
                var pg2 = null;
                for (var id2 in pages2) { pg2 = pages2[id2]; break; }
                if (pg2 && pg2.links) {
                    for (var li = 0; li < pg2.links.length; li++) {
                        links.push(pg2.links[li].title);
                    }
                }
            }
        } catch(e2) {
        }
    }

    // Call 3: get thumbnail image URL from summary API
    var imageUrl = "";
    var url3 = "http://en.wikipedia.org/api/rest_v1/page/summary/" + t.replace(/\+/g, "_");
    var raw3  = httpGet(url3);
    if (raw3) {
        try {
            var data3 = JSON.parse(raw3);
            if (data3.thumbnail && data3.thumbnail.source) {
                // Extract filename from the CDN URL and use Special:FilePath
                // which routes through en.wikipedia.org (works) instead of
                // upload.wikimedia.org (blocked by Wikimedia CDN allowlist)
                var src = data3.thumbnail.source;
                var fnMatch = src.match(/\/([^/]+\.(?:jpg|jpeg|png|gif|svg|webp|tiff?|bmp))/i)
                     || src.match(/\/([^/\.?]+(?:\.[^/\.?]+)?)(?:\?|$)/i);
                if (fnMatch) {
                    var fname = fnMatch[1].replace(/^\d+px-/, "");
                    imageUrl = "https://en.wikipedia.org/wiki/Special:FilePath/"
                             + fname + "?width=480";
                } else {
                    imageUrl = src;
                }
            }
        } catch(e3) {
        }
    }

    return {
        title:       pageTitle,
        description: pageDesc,
        extract:     pageText,
        links:       links,
        imageUrl:    imageUrl
    };
}

// ---------------------------------------------------------------------------
// Fetch related articles via action API "morelike" search
// Falls back to a plain search on the title if morelike returns nothing
// ---------------------------------------------------------------------------
function wikiRelated(title) {
    var t   = urlEncode(title);
    var url = "http://en.wikipedia.org/w/api.php?action=query"
              + "&list=search"
              + "&srsearch=morelike:" + t
              + "&srlimit=10"
              + "&srnamespace=0"
              + "&format=json";
    var raw = httpGet(url);
    if (!raw) return [];

    try {
        var data   = JSON.parse(raw);
        var items  = data.query && data.query.search;
        if (!items || items.length === 0) return [];
        var results = [];
        for (var i = 0; i < items.length; i++) {
            var s = items[i];
            results.push({
                title:       s.title   || "",
                description: stripHtml(s.snippet || "")
            });
        }
        return results;
    } catch(e) {
        return [];
    }
}

// ---------------------------------------------------------------------------
// A line in the article is either:
//   a plain string  — rendered as-is
//   a link object   — { link: true, title: "Article Title" }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Download and render a Wikipedia thumbnail as sixel graphics.
// imgCols = how many terminal columns wide to render the image
// imgRows = how many terminal rows tall to render the image
// Returns the sixel escape sequence string, or "" if unavailable.
// ---------------------------------------------------------------------------
function fetchSixel(imageUrl, imgCols, imgRows) {
    if (!imageUrl || !TERM.hasSixel) return "";

    var ts     = time() + "_" + random(99999);
    var tmpImg = system.temp_dir + "wiki_img_" + ts + ".img";
    var tmpSix = system.temp_dir + "wiki_six_" + ts + ".txt";
    var tmpErr = system.temp_dir + "wiki_err_" + ts + ".txt";

    // Download via Special:FilePath (upload.wikimedia.org CDN is blocked)
    var dlCmd = "curl -s -L -k --max-time 20"
              + " -H \"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\""
              + " -o \"" + tmpImg + "\""
              + " \"" + imageUrl + "\"";
    var rc = system.exec(dlCmd);

    // Check file size using Synchronet file_size() which doesn't open the file
    var fsize = file_size(tmpImg);
    if (fsize < 500) {
        file_remove(tmpImg);
        return "";
    }

    // Run wiki_img.py with explicit OUTPUT file argument (avoids shell redirection issues)
    // New wiki_img.py signature: wiki_img.py <input> <output> <cols> <rows> [char_w] [char_h]
    var pyCmd = "python \"" + system.exec_dir + "wiki_img.py\""
              + " \"" + tmpImg + "\""
              + " \"" + tmpSix + "\""
              + " " + imgCols
              + " " + imgRows
              + " " + CELL_W + " " + CELL_H;
    rc = system.exec(pyCmd);
    // Read sixel output — parse DIMS header then sixel data
    var sixelData = "";
    var actCols   = imgCols;
    var actRows   = imgRows;
    var f = new File(tmpSix);
    if (f.open("rb")) {
        var raw = f.read();
        f.close();
        if (raw && raw.substring(0, 5) === "DIMS:") {
            var nl   = raw.indexOf("\n");
            var hdr  = raw.substring(5, nl);
            var parts = hdr.split(":");
            if (parts.length === 2) {
                actCols = parseInt(parts[0]) || imgCols;
                actRows = parseInt(parts[1]) || imgRows;
            }
            sixelData = raw.substring(nl + 1);
        } else {
            sixelData = raw;
        }
    }

    file_remove(tmpImg);
    file_remove(tmpSix);

    if (!sixelData || sixelData.substring(0, 5) === "ERROR") {
        return null;
    }

    // Return actual dimensions with sixel data so caller can lay out correctly
    return { data: sixelData, cols: actCols, rows: actRows };
}

// Build a "loading image" placeholder for content lines array
// Returns lines to display while image loads, then replaces with sixel
function makeImagePlaceholder(imgCols, imgRows, title) {
    var lines = [];
    var border = repeat("Ä", imgCols);
    lines.push(COL_BORDER + "  " + border + COL_RESET);
    var mid = Math.floor(imgRows / 2);
    for (var i = 0; i < imgRows; i++) {
        if (i === mid) {
            var label = " [IMAGE: " + title.substring(0, imgCols - 12) + "] ";
            var pad   = repeat(" ", Math.max(0, imgCols - label.length));
            lines.push(COL_HEADER_BG + "  " + label + pad + COL_RESET);
        } else {
            lines.push(COL_BODY_BG + "  " + repeat(" ", imgCols) + COL_RESET);
        }
    }
    lines.push(COL_BORDER + "  " + border + COL_RESET);
    lines.push("");
    return lines;
}

// Render a sixel image at the current cursor position
// The sixel sequence is output directly — it advances the cursor down imgRows
function renderSixelImage(sixel, startRow, leftCol) {
    if (!sixel) return;
    console.putmsg(gotoxy(leftCol, startRow));
    print(sixel);   // raw output — do not use putmsg() for sixel data
    console.putmsg(gotoxy(1, startRow));
}

// ---------------------------------------------------------------------------
// Render a sixel image inline within the content area.
// Draws the image flush with the content area, text flows below.
// imgLines = number of terminal rows the image should occupy
// ---------------------------------------------------------------------------
function renderInlineImage(sixel, screenRow, imgRows) {
    if (!sixel) return;
    // Position cursor then write sixel raw — must use print() not console.putmsg()
    // because putmsg() interprets Ctrl-A codes and mangles the sixel escape sequences
    console.putmsg(gotoxy(2, screenRow));
    print(sixel);   // raw output, no Ctrl-A processing
    // Redraw borders
    for (var r = screenRow; r < screenRow + imgRows && r <= CONTENT_BOT; r++) {
        console.putmsg(
            gotoxy(1,  r) + COL_BORDER + "\xBA" + COL_RESET +
            gotoxy(COLS, r) + COL_BORDER + "\xBA" + COL_RESET
        );
    }
}

// ---------------------------------------------------------------------------
// 256-color ANSI block-art image renderer (fallback when sixel unavailable)
// Converts the image to 256-color ANSI using half-block characters (▄ \xDC)
// Each character represents 2 vertical pixels using fg/bg color.
// Uses ESC[38;5;Nm (256-color fg) and ESC[48;5;Nm (256-color bg).
// ---------------------------------------------------------------------------

// Nearest xterm-256 color (6x6x6 color cube + 24 grays)
function nearestXterm256(r, g, b) {
    // Try 6x6x6 color cube (indices 16-231)
    var cr = Math.round(r * 5 / 255);
    var cg = Math.round(g * 5 / 255);
    var cb = Math.round(b * 5 / 255);
    return 16 + (cr * 36) + (cg * 6) + cb;
}

function ansi256fg(n) { return "[38;5;" + n + "m"; }
function ansi256bg(n) { return "[48;5;" + n + "m"; }

// ---------------------------------------------------------------------------
// Render article image as 256-color ANSI block art.
// Downloads image, samples it to imgCols x (imgRows*2) pixels,
// outputs one line per two pixel rows using ▄ (lower-half block).
// Returns array of colored strings (one per screen row) or []
// ---------------------------------------------------------------------------
function fetchAnsiArt(imageUrl, imgCols, imgRows) {
    if (!imageUrl) return [];

    var tmpImg  = system.temp_dir + "wiki_img_" + time() + ".jpg";
    var tmpJson = system.temp_dir + "wiki_px_"  + time() + ".txt";

    // Download image
    var dlCmd = "curl -s -L -k --max-time 20"
              + " -e \"https://en.wikipedia.org/\""
              + " -A \"Mozilla/5.0 (compatible; SynchronetBBSDoor/1.0)\""
              + " -o \"" + tmpImg + "\"";
    dlCmd += " \"" + imageUrl + "\"";
    if (system.exec(dlCmd) !== 0 || file_size(tmpImg) < 500) {
        file_remove(tmpImg);
        return [];
    }

    // Use Python to sample pixels and output as JSON
    var pyScript = system.temp_dir + "wiki_px_" + time() + ".py";
    var pxF = new File(pyScript);
    var pyCmd = "";
    if (pxF.open("w")) {
        pxF.writeln("from PIL import Image");
        pxF.writeln("import json, sys");
        pxF.writeln("img = Image.open(sys.argv[1]).convert('RGB')");
        pxF.writeln("img.thumbnail((int(sys.argv[3]), int(sys.argv[4])*2))");
        pxF.writeln("w, h = img.size");
        pxF.writeln("rows = []");
        pxF.writeln("for y in range(0, h, 2):");
        pxF.writeln("    row = []");
        pxF.writeln("    for x in range(w):");
        pxF.writeln("        top = list(img.getpixel((x, y)))");
        pxF.writeln("        bot = list(img.getpixel((x, min(y+1,h-1))))");
        pxF.writeln("        row.append([top, bot])");
        pxF.writeln("    rows.append(row)");
        pxF.writeln("import json as _json");
        pxF.writeln("_out = open(sys.argv[2], 'w')");
        pxF.writeln("_out.write(_json.dumps({'w': w, 'rows': rows}))");
        pxF.writeln("_out.close()");
        pxF.close();
        pyCmd = "python \"" + pyScript + "\""
                + " \"" + tmpImg + "\""
                + " \"" + tmpJson + "\""
                + " " + imgCols + " " + imgRows;
                + imgCols + " " + imgRows + " > \"" + tmpJson + "\"";
    }

    if (pyCmd) system.exec(pyCmd);
    if (pyScript) file_remove(pyScript);

    var result = [];
    var f = new File(tmpJson);
    if (f.open("r")) {
        var raw = f.read();
        f.close();
        try {
            var data = JSON.parse(raw);
            var rows = data.rows;
            for (var ry = 0; ry < rows.length; ry++) {
                var line = "";
                var row  = rows[ry];
                for (var rx = 0; rx < row.length; rx++) {
                    var top = row[rx][0];
                    var bot = row[rx][1];
                    var fgN = nearestXterm256(bot[0], bot[1], bot[2]);
                    var bgN = nearestXterm256(top[0], top[1], top[2]);
                    // \xDC = ▄ (lower half block) — bottom color as fg, top as bg
                    line += ansi256fg(fgN) + ansi256bg(bgN) + "\xDC";
                }
                line += COL_RESET;
                result.push(line);
            }
        } catch(e) {
        }
    }

    file_remove(tmpImg);
    file_remove(tmpJson);
    return result;
}

// ---------------------------------------------------------------------------
// Render article image: tries sixel first, falls back to 256-color ANSI art,
// falls back to placeholder text. Returns array of display lines.
// imgCols: columns wide; imgRows: rows tall
// ---------------------------------------------------------------------------
function renderArticleImage(imageUrl, articleTitle, imgCols, imgRows) {
    var lines = [];
    var W     = COLS - 4;

    if (!imageUrl) return lines;
    showFetching("Loading image for: " + articleTitle + " ...");

    if (TERM.hasSixel) {
        var sixelResult = fetchSixel(imageUrl, imgCols, imgRows);
        if (sixelResult) {
            // Use actual rendered dimensions from DIMS header
            lines.push({ sixel: true, data: sixelResult.data,
                          rows: sixelResult.rows, cols: sixelResult.cols });
            lines.push("");
            return lines;
        }
    }

    // Fallback: 256-color ANSI block art
    if (TERM.has256) {
        var artLines = fetchAnsiArt(imageUrl, imgCols, imgRows);
        if (artLines.length > 0) {
            // Box the image
            lines.push(COL_BORDER + "  Ú" + repeat("Ä", imgCols) + "¿" + COL_RESET);
            for (var i = 0; i < artLines.length; i++) {
                lines.push(COL_BORDER + "  ³" + COL_RESET + artLines[i] + COL_BORDER + "³" + COL_RESET);
            }
            lines.push(COL_BORDER + "  À" + repeat("Ä", imgCols) + "Ù" + COL_RESET);
            lines.push("");
            return lines;
        }
    }

    // Final fallback: text placeholder
    lines.push(COL_BORDER + "  Ú" + repeat("Ä", imgCols) + "¿" + COL_RESET);
    var label = " Image: " + articleTitle.substring(0, imgCols - 4) + " ";
    var pad   = repeat(" ", Math.max(0, imgCols - label.length));
    lines.push(COL_BORDER + "  ³" + COL_RESET +
               COL_BODY_BG + label + pad + COL_RESET +
               COL_BORDER + "³" + COL_RESET);
    lines.push(COL_BORDER + "  À" + repeat("Ä", imgCols) + "Ù" + COL_RESET);
    lines.push("");
    return lines;
}

// ---------------------------------------------------------------------------
// Render article image — check if line is sixel type
// ---------------------------------------------------------------------------
function lineIsSixel(lines, idx) {
    var e = (idx >= 0 && idx < lines.length) ? lines[idx] : null;
    return !!(e && typeof e === "object" && e.sixel);
}

// ---------------------------------------------------------------------------
// Render article image — check if line is sixel type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Render a section header bar (==Header== style)
function pushHeader(lines, text, W, level) {
    lines.push("");
    if (level <= 2) {
        // Primary section: black on cyan, full width bar
        var label = "  " + text.toUpperCase() + "  ";
        var pad   = repeat(" ", Math.max(0, W - label.length));
        lines.push(COL_HEADER_BG + label + pad + COL_RESET);
    } else {
        // Subsection: bright yellow, box-draw dashes (\xC4 = horizontal line in CP437)
        var label2 = "  \xC4\xC4 " + text + " ";
        var dashes  = repeat("\xC4", Math.max(0, W - label2.length - 2));
        lines.push(COL_HILITE + label2 + dashes + "  " + COL_RESET);
    }
    lines.push("");
}

// ---------------------------------------------------------------------------
// Format article text into display lines (width=76, inside borders)
// Recognises ==Section== and ===Subsection=== markers from Wikipedia extracts
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SIXEL PAGE RENDERER
// Renders article as full-screen sixel image via wiki_render.py + wkhtmltoimage
// ---------------------------------------------------------------------------

// Escape non-ASCII and control characters for safe JSON serialization
function asciiSafeJson(obj) {
    return JSON.stringify(obj)
        // Escape non-ASCII
        .replace(/[\u0080-\uffff]/g, function(c) {
            return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
        })
        // Escape control characters (0x00-0x1f) except \n \r \t which JSON.stringify handles
        .replace(/[\u0000-\u001f]/g, function(c) {
            return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
        });
}

// Save article to temp JSON file for wiki_render.py
function saveArticleJson(article) {
    var path = system.node_dir + "temp\\wiki_article_" + time() + ".json";
    var f = new File(path);
    if (f.open("w")) {
        f.write(asciiSafeJson(article));
        f.close();
        log(LOG_WARNING, "wiki_render: saved json to " + path);
        return path;
    }
    log(LOG_WARNING, "wiki_render: FAILED to save json to " + path);
    return "";
}

// Render one screenful of article as sixel
function renderArticlePage(article, scroll_px) {
    var jsonPath = saveArticleJson(article);
    if (!jsonPath) return "";

    var outPath  = system.node_dir + "temp\\wiki_page_" + time() + ".six";
    var pyScript = system.exec_dir + "wiki_render.py";

    var cmd = "python \"" + pyScript + "\""
            + " \"" + jsonPath + "\""
            + " \"" + outPath + "\""
            + " " + (COLS - 2)
            + " " + (ROWS - 8)
            + " " + scroll_px;

    log(LOG_WARNING, "wiki_render: cmd=" + cmd + " scroll_px=" + scroll_px);
    var rc = system.exec(cmd);
    log(LOG_WARNING, "wiki_render: rc=" + rc + " outsize=" + file_size(outPath));

    var result = "";
    var outSize = file_size(outPath);
    if (outSize > 0 && outSize < 200) {
        // Small output - log it to see the error
        var ef = new File(outPath);
        if (ef.open("r")) {
            log(LOG_WARNING, "wiki_render: error file=[" + ef.read() + "]");
            ef.close();
        }
    }
    if (outSize > 100) {
        var f = new File(outPath);
        if (f.open("rb")) {
            result = f.read();
            f.close();
        }
    }

    file_remove(jsonPath);
    file_remove(outPath);

    if (!result || result.substring(0, 5) === "ERROR" || result.length < 50) {
        log(LOG_WARNING, "wiki_render: FAILED result=[" + result.substring(0, 120) + "]");
        return "";
    }
    log(LOG_WARNING, "wiki_render: success len=" + result.length);
    return result;
}

// Display a full-screen sixel page in the content area
function displaySixelPage(sixel) {
    if (!sixel) return;
    // Disable sixel scrolling, home cursor, render, restore
    console.putmsg("\x1b[?80h");   // disable sixel scroll (cursor stays put)
    console.putmsg("\x1b[2J");      // clear screen
    console.putmsg("\x1b[1;1H");    // cursor to row 1 col 1
    print(sixel);
    console.putmsg("\x1b[?80l");   // restore normal sixel scroll mode
    console.putmsg("\x1b[1;1H");    // cursor back home
}

// ---------------------------------------------------------------------------
// Article viewer — sixel-based full-screen rendering
// ---------------------------------------------------------------------------
// ===========================================================================
// TEXT-MODE ARTICLE VIEW
// Renders the article as real terminal text with inline, TAB-navigable links,
// and the photo as a sixel block at the top. (Replaces the old full-page
// sixel renderer, which baked text into pixels and so could not have links.)
// ===========================================================================

var COL_SEL = ansi("0;30;46");   // black on cyan -- the currently selected link

// ---- Selectable color palettes ('c' cycles through them) -----------------
// SyncTERM speaks xterm-256, so accents use SGR 38;5;N / 48;5;N (0-255).
// Palette 0 reproduces the original 16-color look exactly, so cycling back to
// it is unchanged. The 256-color themes keep ONE dark background tone across
// body / heading / link / border (so the whole article screen themes cleanly);
// the title bar, status bar and selection are the brighter "panels".
function _c(fg, bg) { return ansi("38;5;" + fg + ";48;5;" + bg); }

var PALETTES = [
    { name: "Classic",
      titlebar: ansi("1;37;44"), heading: ansi("1;33;40"), body: ansi("0;37;40"),
      status:   ansi("0;30;47"), link:   ansi("1;36;40"),   border: ansi("0;36;40"),
      sel:      ansi("0;30;46") },

    { name: "Ocean",
      titlebar: _c(231, 24),  heading: _c(222, 234), body:   _c(252, 234),
      status:   _c(232, 110), link:    _c(45, 234),  border: _c(31, 234),
      sel:      _c(232, 45) },

    { name: "Amber",
      titlebar: _c(232, 214), heading: _c(214, 233), body:   _c(222, 233),
      status:   _c(232, 208), link:    _c(229, 233), border: _c(94, 233),
      sel:      _c(232, 214) },

    { name: "Forest",
      titlebar: _c(231, 22),  heading: _c(150, 234), body:   _c(252, 234),
      status:   _c(232, 108), link:    _c(120, 234), border: _c(65, 234),
      sel:      _c(16, 120) },

    { name: "Grape",
      titlebar: _c(231, 54),  heading: _c(183, 235), body:   _c(253, 235),
      status:   _c(232, 182), link:    _c(177, 235), border: _c(97, 235),
      sel:      _c(16, 177) },

    { name: "Slate",
      titlebar: _c(231, 60),  heading: _c(117, 236), body:   _c(252, 236),
      status:   _c(232, 146), link:    _c(75, 236),  border: _c(67, 236),
      sel:      _c(16, 75) },

    { name: "Rose",
      titlebar: _c(231, 89),  heading: _c(217, 233), body:   _c(224, 233),
      status:   _c(232, 174), link:    _c(211, 233), border: _c(95, 233),
      sel:      _c(16, 211) }
];
var paletteIndex = 0;

// Reassign the global color slots from a palette. COL_RESET stays a plain
// reset; the secondary slots (COL_HEADER_BG/COL_BODY_HI/COL_KEY) are left as-is.
function applyPalette(p) {
    COL_TITLE_BG  = p.titlebar;
    COL_HILITE    = p.heading;
    COL_BODY_BG   = p.body;
    COL_STATUS_BG = p.status;
    COL_LINK      = p.link;
    COL_BORDER    = p.border;
    COL_SEL       = p.sel;
}

// ---- Unicode -> CP437/ASCII transliteration ------------------------------
var _ACCENTS = (function () {
    var m = {};
    function add(base, chars) { for (var i = 0; i < chars.length; i++) m[chars[i]] = base; }
    add("a", "\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u0101\u0103\u0105");
    add("A", "\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u0100\u0102\u0104");
    add("e", "\u00E8\u00E9\u00EA\u00EB\u0113\u0115\u0117\u0119\u011B");
    add("E", "\u00C8\u00C9\u00CA\u00CB\u0112\u0114\u0116\u0118\u011A");
    add("i", "\u00EC\u00ED\u00EE\u00EF\u0129\u012B\u012D\u012F\u0131");
    add("I", "\u00CC\u00CD\u00CE\u00CF\u0128\u012A\u012C\u012E\u0130");
    add("o", "\u00F2\u00F3\u00F4\u00F5\u00F6\u00F8\u014D\u014F\u0151");
    add("O", "\u00D2\u00D3\u00D4\u00D5\u00D6\u00D8\u014C\u014E\u0150");
    add("u", "\u00F9\u00FA\u00FB\u00FC\u0169\u016B\u016D\u016F\u0171\u0173");
    add("U", "\u00D9\u00DA\u00DB\u00DC\u0168\u016A\u016C\u016E\u0170\u0172");
    add("c", "\u00E7\u0107\u0109\u010B\u010D"); add("C", "\u00C7\u0106\u0108\u010A\u010C");
    add("n", "\u00F1\u0144\u0146\u0148");       add("N", "\u00D1\u0143\u0145\u0147");
    add("s", "\u015B\u015D\u015F\u0161");       add("S", "\u015A\u015C\u015E\u0160");
    add("z", "\u017A\u017C\u017E");             add("Z", "\u0179\u017B\u017D");
    add("y", "\u00FD\u00FF\u0177");             add("Y", "\u00DD\u0178\u0176");
    add("g", "\u011D\u011F\u0121\u0123");       add("r", "\u0155\u0157\u0159");
    add("l", "\u013A\u013C\u013E\u0142");       add("t", "\u0163\u0165\u0167");
    add("d", "\u010F\u0111");                   add("D", "\u010E\u0110");
    add("ae", "\u00E6"); add("AE", "\u00C6"); add("oe", "\u0153"); add("OE", "\u0152");
    add("ss", "\u00DF"); add("th", "\u00FE"); add("TH", "\u00DE");
    return m;
})();

var _PUNCT = {
    "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2010": "-", "\u2011": "-",
    "\u2018": "'", "\u2019": "'", "\u201A": ",", "\u2032": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u2033": '"',
    "\u2026": "...", "\u00A0": " ", "\u2009": " ", "\u200A": " ", "\u202F": " ",
    "\u2007": " ", "\u2008": " ",
    "\u00D7": "x", "\u00F7": "/", "\u00B7": ".", "\u2022": "*", "\u00B0": " deg",
    "\u2122": "(TM)", "\u00AE": "(R)", "\u00A9": "(C)",
    "\u00BD": "1/2", "\u00BC": "1/4", "\u00BE": "3/4",
    "\u00AB": '"', "\u00BB": '"',
    "\u00B9": "1", "\u00B2": "2", "\u00B3": "3", "\u2070": "0", "\u2074": "4",
    "\u2075": "5", "\u2076": "6", "\u2077": "7", "\u2078": "8", "\u2079": "9",
    "\u00A7": "S", "\u2192": "->", "\u2190": "<-"
};

function translit(s) {
    if (!s) return "";
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (s.charCodeAt(i) < 128) { out += ch; continue; }
        if (_PUNCT[ch] !== undefined) { out += _PUNCT[ch]; continue; }
        if (_ACCENTS[ch] !== undefined) { out += _ACCENTS[ch]; continue; }
        out += "?";
    }
    return out;
}

function _isWordChar(c) {
    if (!c) return false;
    return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
}

// Locate the FIRST whole-word occurrence of each link title in the text.
// Longer titles win on overlap. Returns spans {start,end,idx} sorted by pos.
function findLinkSpans(text, titles) {
    var order = [];
    for (var i = 0; i < titles.length; i++) order.push({ t: translit(titles[i] || ""), idx: i });
    order.sort(function (a, b) { return b.t.length - a.t.length; });
    var lower = text.toLowerCase();
    var occupied = new Array(text.length);
    var spans = [];
    for (var k = 0; k < order.length; k++) {
        var title = order[k].t;
        if (!title || title.length < 4) continue;
        var tl = title.toLowerCase();
        var from = 0, placed = false;
        while (!placed) {
            var pos = lower.indexOf(tl, from);
            if (pos < 0) break;
            var end = pos + tl.length;
            var okStart = (pos === 0) || !_isWordChar(text.charAt(pos - 1));
            var okEnd = (end >= text.length) || !_isWordChar(text.charAt(end));
            var free = true;
            for (var p = pos; p < end; p++) { if (occupied[p]) { free = false; break; } }
            if (okStart && okEnd && free) {
                for (var q = pos; q < end; q++) occupied[q] = true;
                spans.push({ start: pos, end: end, idx: order[k].idx });
                placed = true;
            } else { from = pos + 1; }
        }
    }
    spans.sort(function (a, b) { return a.start - b.start; });
    return spans;
}

function _mergeLinks(links) {
    if (links.length < 2) return links;
    links.sort(function (a, b) { return a.col - b.col; });
    var out = [links[0]];
    for (var i = 1; i < links.length; i++) {
        var prev = out[out.length - 1], cur = links[i];
        if (cur.idx === prev.idx && cur.col <= prev.col + prev.len + 1) {
            prev.len = Math.max(prev.col + prev.len, cur.col + cur.len) - prev.col;
        } else { out.push(cur); }
    }
    return out;
}

// Wrap cleaned text into display lines, carrying link columns.
// Returns [{text, heading, blank, links:[{col,len,idx}]}]
function layoutText(text, width, spans) {
    var lines = [];
    var paras = text.split("\n");
    var offset = 0;
    var lineWords = [];
    function flushLine() {
        if (lineWords.length === 0) return;
        var txt = "", links = [];
        for (var i = 0; i < lineWords.length; i++) {
            if (i > 0) txt += " ";
            var col = txt.length, lw = lineWords[i];
            txt += lw.w;
            var ws = lw.start, we = lw.start + lw.w.length;
            for (var s = 0; s < spans.length; s++) {
                var sp = spans[s];
                if (sp.start < we && sp.end > ws) { links.push({ col: col, len: lw.w.length, idx: sp.idx }); break; }
            }
        }
        lines.push({ text: txt, heading: false, blank: false, links: _mergeLinks(links) });
        lineWords = [];
    }
    for (var pi = 0; pi < paras.length; pi++) {
        var para = paras[pi];
        var trimmed = para.replace(/^\s+|\s+$/g, "");
        if (trimmed === "") {
            lines.push({ text: "", heading: false, blank: true, links: [] });
            offset += para.length + 1; continue;
        }
        var hmatch = /^=+\s*([\s\S]*?)\s*=+$/.exec(trimmed);
        if (hmatch) {
            var htext = hmatch[1].toUpperCase();
            if (htext.length > width) htext = htext.substring(0, width);
            lines.push({ text: htext, heading: true, blank: false, links: [] });
            offset += para.length + 1; continue;
        }
        var words = [];
        var re = /\S+/g, m, paraStart = offset;
        while ((m = re.exec(para)) !== null) words.push({ w: m[0], start: paraStart + m.index });

        lineWords = [];
        for (var wi = 0; wi < words.length; wi++) {
            var word = words[wi];
            while (word.w.length > width) {
                if (lineWords.length) flushLine();
                lines.push({ text: word.w.substring(0, width), heading: false, blank: false, links: [] });
                word = { w: word.w.substring(width), start: word.start + width };
            }
            if (lineWords.length === 0) { lineWords.push(word); }
            else {
                var curLen = 0;
                for (var c = 0; c < lineWords.length; c++) curLen += lineWords[c].w.length + 1;
                curLen -= 1;
                if (curLen + 1 + word.w.length <= width) lineWords.push(word);
                else { flushLine(); lineWords.push(word); }
            }
        }
        flushLine();
        offset += para.length + 1;
    }
    return lines;
}

function buildLinkStops(spans, titles) {
    var stops = [];
    for (var i = 0; i < spans.length; i++)
        stops.push({ idx: spans[i].idx, title: titles[spans[i].idx], start: spans[i].start, line: 0 });
    return stops;
}

// Map each link stop to the first display line it appears on (for TAB scroll).
function computeStopLines(lines, linkStops) {
    var idxToLine = {};
    for (var li = 0; li < lines.length; li++) {
        var lk = lines[li].links;
        if (!lk) continue;
        for (var j = 0; j < lk.length; j++)
            if (idxToLine[lk[j].idx] === undefined) idxToLine[lk[j].idx] = li;
    }
    for (var s = 0; s < linkStops.length; s++)
        linkStops[s].line = (idxToLine[linkStops[s].idx] !== undefined) ? idxToLine[linkStops[s].idx] : 0;
}

// Build the ANSI string for one laid-out line, highlighting links.
function lineToAnsi(line, selIdx) {
    if (!line || line.blank) return "";
    if (line.heading) return COL_HILITE + line.text + COL_RESET;
    var t = line.text;
    if (!line.links || line.links.length === 0) return COL_BODY_BG + t + COL_RESET;
    var runs = line.links.slice().sort(function (a, b) { return a.col - b.col; });
    var out = "", pos = 0;
    for (var i = 0; i < runs.length; i++) {
        var lk = runs[i];
        if (lk.col > pos) out += COL_BODY_BG + t.substring(pos, lk.col);
        var seg = t.substr(lk.col, lk.len);
        out += (lk.idx === selIdx ? COL_SEL : COL_LINK) + seg + COL_RESET;
        pos = lk.col + lk.len;
    }
    if (pos < t.length) out += COL_BODY_BG + t.substring(pos);
    return out + COL_RESET;
}

// Extract the FilePath filename (lowercased) from a Special:FilePath URL.
function _fileNameFromUrl(url) {
    if (!url) return "";
    var m = /Special:FilePath\/([^?]+)/i.exec(url);
    var fn = m ? m[1] : url;
    fn = fn.replace(/^\d+px-/, "");
    return fn.toLowerCase();
}

// Turn an image URL into a readable caption from its file name, e.g.
// ".../Special:FilePath/Nintendo_Kyoto_HQ.jpg?width=480" -> "Nintendo Kyoto HQ".
// Used as the description in the text placeholder shown on non-sixel terminals.
function imageCaptionFromUrl(url) {
    if (!url) return "";
    var m  = /Special:FilePath\/([^?]+)/i.exec(url);
    var fn = m ? m[1] : url;
    fn = fn.replace(/^\d+px-/, "");
    try { fn = decodeURIComponent(fn); } catch (e) {}
    fn = fn.replace(/\.[A-Za-z0-9]{2,4}$/, "");          // strip file extension
    fn = fn.replace(/_/g, " ").replace(/\s+/g, " ");
    return translit(fn).trim();
}

// Fetch the article's images in page order via the REST media-list API.
// Filters out vector logos/icons/flags and other non-photo junk. Returns image
// URLs rebuilt through Special:FilePath (so they load from en.wikipedia.org and
// not the blocked upload.wikimedia.org CDN).
function wikiGetImages(title) {
    var t = urlEncode(title).replace(/\+/g, "_");
    var url = "http://en.wikipedia.org/api/rest_v1/page/media-list/" + t;
    var raw = httpGet(url);
    if (!raw) return [];
    var out = [];
    var junk = /(commons-logo|edit[-_]?icon|ooui|wiki\w*-logo|disambig|question_book|ambox|symbol[_-]|padlock|magnify|loudspeaker|speaker|sound[-_]icon|red[_-]?x|x[_-]mark|yes[_-]?check|crystal|nuvola|gnome-|folder|portal|wikidata|wiktionary|wikisource|wikiquote|wikibooks|increase|decrease|steady|^arrow|^flag_of|map_of|blank\.|transparent|spacer|pictogram)/i;
    try {
        var data = JSON.parse(raw);
        var items = (data && data.items) ? data.items : [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.type && it.type !== "image") continue;
            var fname = (it.title || "").replace(/^File:/i, "").replace(/ /g, "_");
            if (!fname) continue;
            if (/\.svg$/i.test(fname)) continue;       // vector -> usually logos/icons
            if (junk.test(fname)) continue;
            out.push("https://en.wikipedia.org/wiki/Special:FilePath/" + fname + "?width=480");
        }
    } catch (e) {}
    return out;
}

var _imgSeq = 0;

// Render ONE image URL to a sixel via wiki_render.py --image.
// Returns {sixel, rows, cols} or null. jsonPath is any existing file used as
// argv[1]; the URL override is what actually gets rendered.
function renderImageSixel(jsonPath, imageUrl, maxcols, maxrows, upscale) {
    var outPath  = system.node_dir + "temp\\wiki_photo_" + time() + "_" + (_imgSeq++) + ".six";
    var pyScript = system.exec_dir + "wiki_render.py";
    var cmd = "python \"" + pyScript + "\" \"" + jsonPath + "\" \"" + outPath + "\""
            + " --image " + maxcols + " " + maxrows
            + " \"" + imageUrl + "\"";
    if (upscale) cmd += " upscale";
    if (CELL_PX_W > 0 && CELL_PX_H > 0) cmd += " cell" + CELL_PX_W + "x" + CELL_PX_H;
    var rc = system.exec(cmd);
    var sz = file_size(outPath);
    if (rc !== 0 || sz < 50) { file_remove(outPath); return null; }
    var f = new File(outPath);
    var data = "";
    if (f.open("rb")) { data = f.read(); f.close(); }
    file_remove(outPath);
    if (!data || data.substring(0, 5) === "ERROR") return null;
    var nl = data.indexOf("\n");
    if (nl < 0) return null;
    var head = data.substring(0, nl);
    var mr = /ROWS=(\d+)/.exec(head);
    var mc = /COLS=(\d+)/.exec(head);
    return {
        sixel: data.substring(nl + 1),
        rows: mr ? parseInt(mr[1], 10) : maxrows,
        cols: mc ? parseInt(mc[1], 10) : maxcols
    };
}

// Weave rendered image blocks into the wrapped text lines, in order. images[0]
// is the lead (placed at the very top); the rest are distributed through the
// article and snapped near section headings when one is close.
// Returns { lines: augmented, blocks: [{idx,startLine,rows,cols,sixel}] }.
function insertImages(textLines, images) {
    var blocks = [];
    var M = images.length;
    if (M === 0) return { lines: textLines.slice(), blocks: blocks };
    var T = textLines.length;
    var pos = [];
    pos[0] = 0;
    for (var i = 1; i < M; i++) {
        var base = Math.round(i * T / M);
        if (base > T) base = T;
        var snap = base;
        for (var d = 0; d <= 3; d++) {
            if (base - d >= 0 && base - d < T && textLines[base - d].heading) { snap = base - d; break; }
            if (base + d < T && textLines[base + d].heading) { snap = base + d; break; }
        }
        pos[i] = snap;
    }
    var insertBefore = {};
    for (var k = 0; k < M; k++) {
        if (!insertBefore[pos[k]]) insertBefore[pos[k]] = [];
        insertBefore[pos[k]].push(k);
    }
    var aug = [];
    function pushImageBlock(imgIdx) {
        var img = images[imgIdx];
        var start = aug.length;
        for (var r = 0; r < img.rows; r++)
            aug.push({ isImg: true, img: imgIdx, blank: false, heading: false, links: [], text: "" });
        aug.push({ blank: true, heading: false, links: [], text: "" });   // spacer
        blocks.push({ idx: imgIdx, startLine: start, rows: img.rows, cols: img.cols, sixel: img.sixel, url: img.url });
    }
    for (var ti = 0; ti <= T; ti++) {
        if (insertBefore[ti]) for (var z = 0; z < insertBefore[ti].length; z++) pushImageBlock(insertBefore[ti][z]);
        if (ti < T) aug.push(textLines[ti]);
    }
    return { lines: aug, blocks: blocks };
}

// Non-sixel terminals: instead of rendered images, weave a one-line text
// placeholder ("[ Image: <name> ]") into the flow at the same positions
// insertImages would have used. `width` truncates over-long captions.
function insertImagePlaceholders(textLines, imgUrls, width) {
    var M = imgUrls.length;
    if (M === 0) return textLines.slice();
    var T = textLines.length;
    var maxw = (width && width > 12) ? width : (COLS - 4);
    var pos = []; pos[0] = 0;
    for (var i = 1; i < M; i++) {
        var base = Math.round(i * T / M); if (base > T) base = T;
        var snap = base;
        for (var d = 0; d <= 3; d++) {
            if (base - d >= 0 && base - d < T && textLines[base - d].heading) { snap = base - d; break; }
            if (base + d < T && textLines[base + d].heading) { snap = base + d; break; }
        }
        pos[i] = snap;
    }
    var insertBefore = {};
    for (var k = 0; k < M; k++) { if (!insertBefore[pos[k]]) insertBefore[pos[k]] = []; insertBefore[pos[k]].push(k); }
    var aug = [];
    function pushPlaceholder(idx) {
        var cap   = imageCaptionFromUrl(imgUrls[idx]);
        var label = cap ? ("[ Image: " + cap + " ]") : "[ Image ]";
        if (label.length > maxw) label = label.substring(0, maxw - 2) + " ]";
        aug.push({ blank: true,  heading: false, links: [], text: "" });
        aug.push({ blank: false, heading: false, links: [], text: label, imgCaption: true });
        aug.push({ blank: true,  heading: false, links: [], text: "" });
    }
    for (var ti = 0; ti <= T; ti++) {
        if (insertBefore[ti]) for (var z = 0; z < insertBefore[ti].length; z++) pushPlaceholder(insertBefore[ti][z]);
        if (ti < T) aug.push(textLines[ti]);
    }
    return aug;
}

// Show a larger version of one image full-screen until a key is pressed.
function showLargeImage(article, url) {
    if (!url) return;
    showProgress("Loading larger image ...");
    // Request a high-res source (so it can fill the screen) and size the box to
    // ~90% of THIS terminal; upscale fills any remaining space.
    var reqW = Math.min(1920, Math.max(960, COLS * 8));
    var bigUrl = (/width=\d+/.test(url)) ? url.replace(/width=\d+/, "width=" + reqW)
                                         : url + (url.indexOf("?") >= 0 ? "&" : "?") + "width=" + reqW;
    // Use the ENTIRE grid so the photo grows until it touches the limiting
    // edge: a wide photo fills the full height, a tall one fills the full width.
    // ROWS-1 leaves the bottom line for the "press any key" prompt.
    var maxc = COLS - 1;
    var maxr = ROWS - 1;
    var jsonPath = saveArticleJson(article);
    var big = renderImageSixel(jsonPath, bigUrl, maxc, maxr, true);   // upscale to fill
    if (jsonPath) file_remove(jsonPath);
    console.putmsg(cls());
    if (big && big.sixel) {
        var lc = Math.max(1, Math.floor((COLS - big.cols) / 2) + 1);
        var lr = Math.max(1, Math.floor((ROWS - 1 - big.rows) / 2) + 1);   // center vertically
        console.putmsg("\x1b[?80h");
        console.putmsg(gotoxy(lc, lr));
        print(big.sixel);
        console.putmsg("\x1b[?80l");
    } else {
        console.putmsg(gotoxy(2, 2) + COL_HILITE + "Could not load a larger version of this image." + COL_RESET);
    }
    var note = " Press any key to return ";
    console.putmsg(gotoxy(Math.max(1, Math.floor((COLS - note.length) / 2)), ROWS) + COL_STATUS_BG + note + COL_RESET);
    console.getkey(K_NOECHO);
}

// ---------------------------------------------------------------------------
// Main article viewer (text + inline links + photo)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Read one navigation key, returning a named action ("UP","DOWN","PGUP",
// "PGDN","PGUP23","PGDN23","HOME","END","TAB","BTAB","ENTER","ESC") or the raw
// character for anything unmapped. Shared by the article viewer and the list
// screens so everything navigates identically.
//
// Synchronet delivers single control bytes for the special keys (Up/Down are
// confirmed \x1e/\x0a; the rest are Synchronet's command-key codes, with End
// = \x05 and Home = \x02). SyncTERM may also send raw ESC[ escapes, handled in
// the escape branch. Unmapped keys are returned as-is so callers can report them.
// ---------------------------------------------------------------------------
function readNavKey() {
    var key;
    while (true) {
        key = console.inkey(K_NOECHO, 1000);   // wait up to 1 second for a keypress
        if (key) break;
        drawHeaderClock();                      // no key yet -- advance the header clock
    }
    if      (key === "\x1e") return "UP";
    else if (key === "\x0a") return "DOWN";
    else if (key === "\x1d") return "PGUP23";   // Left arrow  -> 2/3 page up
    else if (key === "\x06") return "PGDN23";   // Right arrow -> 2/3 page down
    else if (key === "\x10") return "PGUP";     // Page Up   (Ctrl-P)
    else if (key === "\x0e") return "PGDN";     // Page Down (Ctrl-N)
    else if (key === "\x1f") return "PGUP";     // alternate Page Up
    else if (key === "\x16") return "PGDN";     // alternate Page Down
    else if (key === "\x02") return "HOME";     // Home key (Ctrl-B)
    else if (key === "\x05") return "END";      // End key  (Ctrl-E)
    else if (key === "\t" || key === "\x09") return "TAB";
    else if (key === "\r") return "ENTER";
    else if (key === "\x1b") {
        var ek = console.inkey(K_NOECHO, 50);
        if (ek === "[" || ek === "O") {
            var code = console.inkey(K_NOECHO, 50);
            if      (code === "A") return "UP";
            else if (code === "B") return "DOWN";
            else if (code === "C") return "PGDN23";   // right arrow
            else if (code === "D") return "PGUP23";   // left arrow
            else if (code === "H") return "HOME";     // xterm Home
            else if (code === "F") return "END";      // xterm End
            else if (code === "V") return "PGUP";     // SyncTERM Page Up
            else if (code === "U") return "PGDN";     // SyncTERM Page Down
            else if (code === "Z") return "BTAB";     // shift-tab
            else if (code === "1") { console.getkey(K_NOECHO); return "HOME"; }  // ESC[1~
            else if (code === "7") { console.getkey(K_NOECHO); return "HOME"; }  // ESC[7~
            else if (code === "4") { console.getkey(K_NOECHO); return "END";  }  // ESC[4~
            else if (code === "8") { console.getkey(K_NOECHO); return "END";  }  // ESC[8~
            else if (code === "5") { console.getkey(K_NOECHO); return "PGUP"; }  // ESC[5~
            else if (code === "6") { console.getkey(K_NOECHO); return "PGDN"; }  // ESC[6~
            else return "ESC";
        }
        return "ESC";
    }
    return key;
}

function loadArticle(title) {
    // Probe for sixel support exactly once, here -- AFTER the welcome search's
    // getstr has already run, so the probe can never disturb that input.
    if (!SIXEL_CHECKED) { TERM.hasSixel = detectSixel(); SIXEL_CHECKED = true; }
    // Character-cell pixel size stays at the 8x8 default (correct for the common
    // SyncTERM text cell). We do NOT probe with ESC[16t: this terminal never
    // answers it, so it added nothing but a stalled inkey loop that could desync
    // the next getstr (the "only one letter in search" bug). detectCellSize() is
    // kept in the file for terminals that do answer, but is intentionally not run.
    showFetching("Loading: " + title + " ...");
    var article = wikiGetArticle(title);
    if (!article) {
        // Not an exact page title -- treat what was typed as a search query.
        showFetching("Searching for \"" + title + "\" ...");
        var results = wikiSearch(title);
        if (!results || results.length === 0) {
            drawStatusBar(1, 1, "No article found for: " + title);
            mswait(1400);
            return "BACK";
        }
        var chosen = null;
        if (results.length === 1) chosen = results[0].title;                          // only one match
        else if (results[0].title.toLowerCase() === title.toLowerCase()) chosen = results[0].title;  // exact hit
        if (!chosen) {
            chosen = showSearchResults(results, title);   // let the user pick from the matches
            if (!chosen) return "BACK";
        }
        showFetching("Loading: " + chosen + " ...");
        article = wikiGetArticle(chosen);
        if (!article) { drawStatusBar(1, 1, "Could not load: " + chosen); mswait(1400); return "BACK"; }
    }
    if (!article.links) article.links = [];

    var bodyWidth = COLS - 3;   // col 1 margin, text, 1-col gap, scrollbar at col COLS
    var clean     = translit(article.extract || "");
    var spans     = findLinkSpans(clean, article.links);
    var lines     = layoutText(clean, bodyWidth, spans);
    var linkStops = buildLinkStops(spans, article.links);
    computeStopLines(lines, linkStops);

    var bodyTop  = 4;
    var bodyBot  = ROWS - 1;
    var bodyRows = Math.max(1, bodyBot - bodyTop + 1);

    // Gather image URLs: the lead image (known-good summary thumbnail) first,
    // then additional article images in page order (best-effort, deduped).
    var MAX_IMAGES = 8;
    var imgUrls = [];
    var seenFn = {};
    if (article.imageUrl) { imgUrls.push(article.imageUrl); seenFn[_fileNameFromUrl(article.imageUrl)] = true; }
    var extra = wikiGetImages(article.title || title);
    for (var ei = 0; ei < extra.length && imgUrls.length < MAX_IMAGES; ei++) {
        var fn = _fileNameFromUrl(extra[ei]);
        if (seenFn[fn]) continue;
        seenFn[fn] = true;
        imgUrls.push(extra[ei]);
    }

    // Render each image to a sixel block, sized to fit and be fully showable.
    var maxImgCols = Math.min(64, COLS - 4);
    // Target ~25% of the terminal's vertical height for the inline photo. Width
    // follows from the image's aspect (a landscape photo is height-bound here),
    // and the renderer sizes by the detected cell pixels so this holds at any
    // font/resolution. Clamp to a sane floor and to the available body space.
    var maxImgRows = Math.round(ROWS * 0.25);
    if (maxImgRows < 4) maxImgRows = 4;
    if (maxImgRows > bodyRows - 2) maxImgRows = Math.max(4, bodyRows - 2);
    var imgBlocks = [];
    if (TERM.hasSixel) {
        var images = [];
        if (imgUrls.length) {
            var jsonPath = saveArticleJson(article);
            for (var ii = 0; ii < imgUrls.length; ii++) {
                showProgress("Loading images (" + (ii + 1) + "/" + imgUrls.length + ") ...");
                var im = renderImageSixel(jsonPath, imgUrls[ii], maxImgCols, maxImgRows);
                if (im && im.sixel) { im.url = imgUrls[ii]; images.push(im); }
            }
            if (jsonPath) file_remove(jsonPath);
        }
        // Weave the rendered images into the text flow (they scroll with the text).
        var woven = insertImages(lines, images);
        lines = woven.lines;
        imgBlocks = woven.blocks;
    } else if (imgUrls.length) {
        // No sixel support: drop a text placeholder (with the image's name as a
        // description) wherever an image would have appeared.
        lines = insertImagePlaceholders(lines, imgUrls, bodyWidth);
    }
    computeStopLines(lines, linkStops);   // remap link line indices into the (possibly augmented) array

    // Combined TAB stops: text links AND images, in document (line) order.
    var navStops = [];
    for (var ls = 0; ls < linkStops.length; ls++)
        navStops.push({ kind: "link", linkIdx: linkStops[ls].idx, title: linkStops[ls].title, line: linkStops[ls].line });
    for (var bs = 0; bs < imgBlocks.length; bs++)
        navStops.push({ kind: "image", blockIdx: bs, url: imgBlocks[bs].url, line: imgBlocks[bs].startLine });
    navStops.sort(function (a, b) { return a.line - b.line; });

    var off = 0;
    var maxOff = Math.max(0, lines.length - bodyRows);
    var sel = -1;
    var twoThird = Math.max(1, Math.floor(bodyRows * 2 / 3));   // left/right arrow step

    function drawHeader() {
        console.putmsg(cls());
        var ttl   = translit(article.title || title);
        var desc  = translit(article.description || "");
        var line2 = desc ? (ttl + " - " + desc) : ttl;   // title, then its short description
        drawStdHeader(line2);
    }

    // full=true: repaint everything (scrolling). full=false: only rewrite text
    // rows for a selection change and leave sixels in place (no image flicker).
    // The text frame (rows + scrollbar + status) goes out in ONE putmsg with
    // full-width rows (no per-line erase) to keep scrolling smooth.
    function paintBody(full) {
        if (full === undefined) full = true;
        var selLinkIdx = (sel >= 0 && navStops[sel] && navStops[sel].kind === "link") ? navStops[sel].linkIdx : -1;
        var frame = "";
        for (var r = 0; r < bodyRows; r++) {
            var line = lines[off + r];
            if (!full && line && (line.isImg || line.blank)) continue;  // leave images/blanks untouched
            frame += gotoxy(1, bodyTop + r) + rowString(line, selLinkIdx);
        }
        frame += scrollbarFrame();
        frame += statusString();
        console.putmsg(frame);
        // Images: draw only on a full repaint, only when fully within the window,
        // and only touch sixel-scroll mode when one is actually visible.
        if (full && imgBlocks && imgBlocks.length) {
            var vis = [];
            for (var b = 0; b < imgBlocks.length; b++) {
                var blk = imgBlocks[b];
                if (blk.startLine >= off && blk.startLine + blk.rows <= off + bodyRows) vis.push(blk);
            }
            if (vis.length) {
                console.putmsg("\x1b[?80h");
                for (var v = 0; v < vis.length; v++) {
                    var lc = Math.floor((COLS - vis[v].cols) / 2) + 1;
                    if (lc < 1) lc = 1;
                    console.putmsg(gotoxy(lc, bodyTop + (vis[v].startLine - off)));
                    print(vis[v].sixel);
                }
                console.putmsg("\x1b[?80l");
            }
        }
        // Box around the selected image (if any and fully visible).
        if (sel >= 0 && navStops[sel] && navStops[sel].kind === "image") {
            var sb = imgBlocks[navStops[sel].blockIdx];
            if (sb && sb.startLine >= off && sb.startLine + sb.rows <= off + bodyRows) drawImageBox(sb);
        }
    }

    // Vertical scrollbar in the right-most column (track + position thumb).
    function scrollbarFrame() {
        var total = lines.length, out = "";
        var trackCh = "\xB1", thumbCh = "\xDB";
        var thumbSize, thumbTop;
        if (total <= bodyRows) { thumbSize = bodyRows; thumbTop = 0; }
        else {
            thumbSize = Math.max(1, Math.round(bodyRows * bodyRows / total));
            if (thumbSize > bodyRows) thumbSize = bodyRows;
            var maxThumbTop = bodyRows - thumbSize;
            thumbTop = (maxOff > 0) ? Math.round(off * maxThumbTop / maxOff) : 0;
            if (thumbTop < 0) thumbTop = 0;
            if (thumbTop > maxThumbTop) thumbTop = maxThumbTop;
        }
        for (var r = 0; r < bodyRows; r++) {
            var inThumb = (r >= thumbTop && r < thumbTop + thumbSize);
            out += gotoxy(COLS, bodyTop + r) + (inThumb ? COL_HILITE + thumbCh : COL_BORDER + trackCh) + COL_RESET;
        }
        return out;
    }

    // Draw a frame just outside a (fully visible) image to mark it as selected.
    function drawImageBox(blk) {
        var top = bodyTop + (blk.startLine - off);
        var bot = top + blk.rows - 1;
        var left = Math.max(1, Math.floor((COLS - blk.cols) / 2) + 1);
        var right = left + blk.cols - 1;
        var bL = Math.max(1, left - 1);
        var bR = Math.min(COLS - 1, right + 1);          // stay off the scrollbar column
        var horiz = repeat("\xC4", Math.max(0, bR - bL - 1));
        var s = COL_HILITE, out = "";
        if (top - 1 >= bodyTop) out += gotoxy(bL, top - 1) + s + "\xDA" + horiz + "\xBF" + COL_RESET;
        for (var r = top; r <= bot; r++)
            out += gotoxy(bL, r) + s + "\xB3" + COL_RESET + gotoxy(bR, r) + s + "\xB3" + COL_RESET;
        if (bot + 1 <= bodyBot) out += gotoxy(bL, bot + 1) + s + "\xC0" + horiz + "\xD9" + COL_RESET;
        console.putmsg(out);
    }

    function statusString() {
        var pct = lines.length ? Math.min(100, Math.round((off + bodyRows) * 100 / lines.length)) : 100;
        var msg = "\x18\x19 Line  <>=Page  TAB Link/Img  ENTER Open  [M]ark [B]ack [L]ist [S]earch [C]olor [Q]uit  " + pct + "%";
        if (sel >= 0 && navStops[sel]) {
            msg = (navStops[sel].kind === "image"
                   ? ">[Image]  ENTER=enlarge  "
                   : ">" + translit(navStops[sel].title) + "  ") + msg;
        }
        if (msg.length > COLS - 2) msg = msg.substring(0, COLS - 2);
        return gotoxy(1, ROWS) + COL_STATUS_BG + padRight(" " + msg, COLS - 1) + COL_RESET;
    }

    function ensureVisible(top, bot) {
        if (bot === undefined) bot = top;
        if (top < off) off = top;
        else if (bot > off + bodyRows - 1) off = bot - bodyRows + 1;
        if (off > top) off = top;          // if the block is taller than the window, keep its top in view
        if (off < 0) off = 0;
        if (off > maxOff) off = maxOff;
    }

    // Scroll so the selected stop is visible. For an image, bring the WHOLE
    // block into view (not just its top) so it can be drawn and boxed.
    function ensureStopVisible() {
        var st = navStops[sel];
        if (st.kind === "image") {
            var blk = imgBlocks[st.blockIdx];
            ensureVisible(st.line, st.line + (blk ? blk.rows : 1) - 1);
        } else {
            ensureVisible(st.line);
        }
    }

    // --- nav-stop lookups for "TAB selects the first VISIBLE link" ---------
    // navStops is sorted by line. firstStopFrom = first stop on/below a line;
    // lastStopUpto = last stop on/above a line; selOnScreen = whether the
    // current selection sits inside the visible window right now.
    function firstStopFrom(ln) {
        for (var i = 0; i < navStops.length; i++) {
            if (navStops[i].line >= ln) return i;
        }
        return -1;
    }
    function lastStopUpto(ln) {
        for (var j = navStops.length - 1; j >= 0; j--) {
            if (navStops[j].line <= ln) return j;
        }
        return -1;
    }
    function selOnScreen() {
        return sel >= 0 && navStops[sel] &&
               navStops[sel].line >= off &&
               navStops[sel].line <= off + bodyRows - 1;
    }

    drawHeader();
    paintBody();

    while (true) {
        var key = readNavKey();
        if (!key) continue;

        if      (key === "UP")   { if (off > 0) { off--; paintBody(true); } }
        else if (key === "DOWN") { if (off < maxOff) { off++; paintBody(true); } }
        else if (key === "PGUP") { if (off > 0) { off = Math.max(0, off - bodyRows); paintBody(true); } }
        else if (key === "PGDN") { if (off < maxOff) { off = Math.min(maxOff, off + bodyRows); paintBody(true); } }
        else if (key === "PGUP23") { if (off > 0) { off = Math.max(0, off - twoThird); paintBody(true); } }
        else if (key === "PGDN23") { if (off < maxOff) { off = Math.min(maxOff, off + twoThird); paintBody(true); } }
        else if (key === "HOME") { if (off !== 0) { off = 0; paintBody(true); } }
        else if (key === "END")  { if (off !== maxOff) { off = maxOff; paintBody(true); } }
        else if (key === "TAB")  {
            if (navStops.length) {
                var pSelT = sel, pOffT = off;
                if (selOnScreen()) {
                    sel = (sel + 1) % navStops.length;       // advance through links
                } else {
                    sel = firstStopFrom(off);                // first link on/after this page
                    if (sel < 0) sel = 0;                    // (all links above) wrap to top
                }
                ensureStopVisible();
                var fullT = (off !== pOffT) || (pSelT >= 0 && navStops[pSelT] && navStops[pSelT].kind === "image") || navStops[sel].kind === "image";
                paintBody(fullT);
            }
        }
        else if (key === "BTAB") {
            if (navStops.length) {
                var pSelB = sel, pOffB = off;
                if (selOnScreen()) {
                    sel = (sel - 1 + navStops.length) % navStops.length;
                } else {
                    sel = lastStopUpto(off + bodyRows - 1);  // last link on/before this page
                    if (sel < 0) sel = navStops.length - 1;  // (all links below) wrap to end
                }
                ensureStopVisible();
                var fullB = (off !== pOffB) || (pSelB >= 0 && navStops[pSelB] && navStops[pSelB].kind === "image") || navStops[sel].kind === "image";
                paintBody(fullB);
            }
        }
        else if (key === "ENTER"){
            if (sel >= 0 && navStops[sel]) {
                if (navStops[sel].kind === "image") {
                    showLargeImage(article, navStops[sel].url);   // enlarge image
                    drawHeader(); paintBody();
                } else {
                    var resE = loadArticle(navStops[sel].title); // push: follow link
                    if (resE === "QUIT") return "QUIT";            // Q propagates to menu
                    drawHeader(); paintBody();                     // returned BACK -> redraw this one
                }
            }
        }
        else if (key === "B" || key === "b") { return "BACK"; }  // back one article
        else if (key === "Q" || key === "q" || key === "ESC") { return "QUIT"; }
        else if (key === "S" || key === "s") {
            var nt = promptSearch();
            if (nt) {
                var resS = loadArticle(nt);
                if (resS === "QUIT") return "QUIT";
            }
            drawHeader(); paintBody();
        }
        else if (key === "L" || key === "l") {
            if (article.links.length) {
                var chosen = showSearchResults(article.links.map(function (l) { return { title: l, url: "" }; }), "Links");
                if (chosen) {
                    var resL = loadArticle(chosen);
                    if (resL === "QUIT") return "QUIT";
                }
            }
            drawHeader(); paintBody();
        }
        else if (key === "H" || key === "h") { showHelp(); drawHeader(); paintBody(); }
        else if (key === "M" || key === "m") {
            var bmAdded = toggleBookmark(article.title, article.description);
            showProgress(bmAdded ? ("Bookmarked \"" + translit(article.title) + "\"   (press M again to remove)")
                                 : ("Removed bookmark \"" + translit(article.title) + "\""));
        }
        else if (key === "C" || key === "c") {
            paletteIndex = (paletteIndex + 1) % PALETTES.length;
            applyPalette(PALETTES[paletteIndex]);
            drawHeader();
            paintBody();
            showProgress("Palette: " + PALETTES[paletteIndex].name + "   (press C to cycle)");
        }
        else if (key.length === 1 && (key.charCodeAt(0) < 32 || key.charCodeAt(0) === 127)) {
            // Unmapped control/navigation key: surface its code so it can be mapped.
            var kc = key.charCodeAt(0);
            showProgress("Unmapped key: 0x" + ("0" + kc.toString(16)).slice(-2).toUpperCase()
                       + "  (tell Claude which key you pressed)");
        }
    }
}

// ---------------------------------------------------------------------------
// Scrolling, selectable list. items = [{title, description}]. Returns the
// chosen index, or -1 if cancelled. Supports arrows, PgUp/PgDn, Home/End, and
// number-key shortcuts (relative to the visible window). When allowDelete is
// true, [D] removes the selected item in place and calls onDelete().
// ---------------------------------------------------------------------------
function runListPicker(items, title, category, allowDelete, onDelete) {
    var sel = 0, top = 0;
    var rows = CONTENT_ROWS;
    function clamp() {
        if (sel < 0) sel = 0;
        if (sel > items.length - 1) sel = items.length - 1;
        if (sel < top) top = sel;
        if (sel > top + rows - 1) top = sel - rows + 1;
        if (top < 0) top = 0;
    }
    function paintRows() {
        var r, idx;
        for (r = 0; r < rows; r++) {
            idx = top + r;
            if (idx < items.length) drawResultRow(r, items[idx], idx === sel);
            else console.putmsg(gotoxy(2, CONTENT_TOP + r) + COL_BODY_BG + repeat(" ", COLS - 3) + COL_RESET);
        }
        var pos  = (items.length ? (top + 1) + "-" + Math.min(top + rows, items.length) + " of " + items.length : "0");
        var ua   = (top > 0) ? "\x18" : " ";
        var da   = (top + rows < items.length) ? "\x19" : " ";
        var hint = allowDelete ? "ENTER Open  [D] Delete  [Q] Back" : "ENTER Select  [Q] Back";
        drawStatusBar(0, 0, ua + da + " " + pos + "   \x18\x19 Move  " + hint);
    }
    console.putmsg(cls());
    drawStdHeader(title);
    clamp();
    paintRows();
    while (true) {
        var k = readNavKey();
        if (!k) continue;
        if (k === "ESC" || k === "Q" || k === "q") return -1;
        if (k === "ENTER") return sel;
        if (k === "UP")   { sel--;        clamp(); paintRows(); continue; }
        if (k === "DOWN") { sel++;        clamp(); paintRows(); continue; }
        if (k === "PGUP" || k === "PGUP23") {
            if (top === 0) sel = 0; else { top = Math.max(0, top - rows); sel = top; }
            clamp(); paintRows(); continue;
        }
        if (k === "PGDN" || k === "PGDN23") {
            var maxTop = Math.max(0, items.length - rows);
            if (top >= maxTop) sel = items.length - 1; else { top = Math.min(maxTop, top + rows); sel = top; }
            clamp(); paintRows(); continue;
        }
        if (k === "HOME") { sel = 0;                  clamp(); paintRows(); continue; }
        if (k === "END")  { sel = items.length - 1;   clamp(); paintRows(); continue; }
        if (allowDelete && (k === "D" || k === "d")) {
            items.splice(sel, 1);
            if (onDelete) onDelete();
            if (!items.length) return -1;
            clamp(); paintRows();
            continue;
        }
        if (k >= "1" && k <= "9") { var i2 = top + parseInt(k, 10) - 1; if (i2 < items.length && i2 < top + rows) return i2; }
        if (k === "0") { var i3 = top + 9; if (i3 < items.length && i3 < top + rows) return i3; }
    }
}

function showSearchResults(results, query) {
    if (!results || results.length === 0) return null;
    var pick = runListPicker(results, "Search Results: " + query, "SEARCH", false, null);
    return (pick >= 0) ? results[pick].title : null;
}

// ---------------------------------------------------------------------------
// Prompt for search term using a clean input line
// ---------------------------------------------------------------------------
function promptSearch() {
    var start  = 3;                 // input begins right after the "> " prompt
    var fieldW = COLS - start;      // field cells: cols 3 .. COLS-1 (final column stays clear)
    var maxw   = fieldW - 1;        // typed-char limit keeps the cursor off the final column
    if (maxw > 200) maxw = 200;
    // Instruction on the key-hints row.
    console.putmsg(gotoxy(1, ROWS - 1) + "\x1b[2K" + COL_HILITE
        + " Search -- type a title or keywords, then ENTER  (blank to cancel)" + COL_RESET);
    // Paint a full-width input field, then drop the cursor at its start. getstr
    // types on top of this bar, so the field stays full width regardless of how
    // wide getstr would otherwise draw its own highlight.
    console.putmsg(gotoxy(1, ROWS) + "\x1b[2K"
        + COL_KEY + "> " + COL_RESET
        + COL_INPUT + repeat(" ", fieldW) + COL_RESET
        + gotoxy(start, ROWS) + COL_INPUT);
    var input = console.getstr(maxw, K_LINE);
    console.putmsg(COL_RESET);
    return input ? input.trim() : "";
}

// ---------------------------------------------------------------------------
// Show "fetching..." message
// ---------------------------------------------------------------------------
function showFetching(msg) {
    drawStatusBar(0, 0, msg || "Fetching from Wikipedia... Please wait.");
}

// Update a single in-place progress line at the bottom (no full status bar and
// no last-cell write, so it never scrolls). Used while loading images.
function showProgress(msg) {
    if (!msg) msg = "";
    if (msg.length > COLS - 3) msg = msg.substring(0, COLS - 3);
    console.putmsg(gotoxy(1, ROWS) + "\x1b[2K" + COL_STATUS_BG + padRight(" " + msg, COLS - 1) + COL_RESET);
}

// Build a full-width (COLS visible columns) string for one body row, with color.
// Overwriting full-width rows lets us repaint WITHOUT an erase (\x1b[2K) per
// line -- the erase-then-write flash is the main source of scroll flicker.
function rowString(line, selIdx) {
    if (!line || line.blank || line.isImg) return COL_BODY_BG + repeat(" ", COLS) + COL_RESET;
    if (line.heading) {
        var h = line.text;
        if (h.length > COLS - 1) h = h.substring(0, COLS - 1);
        return COL_HILITE + " " + h + repeat(" ", Math.max(0, COLS - 1 - h.length)) + COL_RESET;
    }
    var vis = line.text.length;
    if (vis > COLS - 1) vis = COLS - 1;
    return COL_BODY_BG + " " + lineToAnsi(line, selIdx) + repeat(" ", Math.max(0, COLS - 1 - vis)) + COL_RESET;
}

// ---------------------------------------------------------------------------
// Show the help overlay
// ---------------------------------------------------------------------------
function showHelp() {
    console.putmsg(cls());
    drawStdHeader("Help & Key Reference");

    var K  = COL_KEY;
    var B  = COL_BODY_BG;
    var HB = COL_HEADER_BG;
    var HI = COL_HILITE;
    var LI = COL_LINK;
    var R  = COL_RESET;

    var helpLines = [
        HI + center("CONVOLUTION WIKIPEDIA ENCYCLOPEDIA  --  Key Reference", 76) + R,
        "",
        HB + "  SCROLLING & READING" + repeat(" ", 56) + R,
        "",
        K+"  \x18 Up arrow  "+B+"  Scroll up one line"+R,
        K+"  \x19 Down arrow"+B+"  Scroll down one line"+R,
        K+"  Left / Right  "+B+"  Scroll up / down about 2/3 of a page"+R,
        K+"  PgUp / PgDn   "+B+"  Jump a full page up or down"+R,
        K+"  Home / End    "+B+"  Jump to the top / bottom of the article"+R,
        "",
        HB + "  LINK NAVIGATION" + repeat(" ", 59) + R,
        "",
        K+"  TAB           "+B+"  Jump to next article link (highlighted in cyan)"+R,
        K+"  Shift+Tab     "+B+"  Jump to previous link (if terminal supports it)"+R,
        K+"  Backspace     "+B+"  Jump to previous link (reliable fallback)"+R,
        K+"  ENTER         "+B+"  Follow the highlighted link / open article"+R,
        "",
        HB + "  GENERAL" + repeat(" ", 68) + R,
        "",
        K+"  [S] or [/]   "+B+"  Search Wikipedia by keyword or title"+R,
        K+"  [R]          "+B+"  View related articles for current article"+R,
        K+"  [B]          "+B+"  Go back to the previous article"+R,
        K+"  [M]          "+B+"  Bookmark / un-bookmark this article ([B] on menu opens saved)"+R,
        K+"  [C]          "+B+"  Change color palette (cycles 256-color themes)"+R,
        K+"  [H]          "+B+"  This help screen"+R,
        K+"  [Q] or ESC   "+B+"  Quit to BBS main menu"+R,
    ];

    for (var i = 0; i < helpLines.length && i < CONTENT_ROWS; i++) {
        console.putmsg(gotoxy(2, CONTENT_TOP + i) + " " + helpLines[i]);
    }

    drawStatusBar(1, 1, "Press any key to continue...");
    console.getkey();
}

// ---------------------------------------------------------------------------
// Show related articles picker
// ---------------------------------------------------------------------------
function showRelated(currentTitle) {
    showFetching("Fetching related articles...");
    var related = wikiRelated(currentTitle);

    if (!related || related.length === 0) {
        drawStatusBar(1, 1, "No related articles found. Press any key...");
        console.getkey();
        return null;
    }

    return showSearchResults(related, "Related: " + currentTitle);
}

// ---------------------------------------------------------------------------
// User identity + per-user bookmarks
//
// The username comes from the Synchronet user record when available, falling
// back to standard BBS drop files (DOOR32.SYS, DOOR.SYS, DORINFO?.DEF,
// CHAIN.TXT) read from the node directory. Bookmarks are stored one file per
// user under the BBS data directory and persist between calls.
// ---------------------------------------------------------------------------
function bmTrim(s) { return (s || "").toString().replace(/^\s+/, "").replace(/\s+$/, ""); }

function readDropFile(name) {
    var p = system.node_dir + name;
    if (!file_exists(p)) return null;
    var f = new File(p);
    if (!f.open("r")) return null;
    var lines = f.readAll();
    f.close();
    return lines;
}

function getUserName() {
    try {
        if (typeof user !== "undefined" && user) {
            if (bmTrim(user.alias)) return bmTrim(user.alias);
            if (bmTrim(user.name))  return bmTrim(user.name);
        }
    } catch (eU) {}
    try { if (bmTrim(bbs.username)) return bmTrim(bbs.username); } catch (eB) {}

    var L, nm, i;
    L = readDropFile("door32.sys");                 // line 7 = handle, line 6 = real name
    if (L) { nm = bmTrim(L[6]) || bmTrim(L[5]); if (nm) return nm; }
    L = readDropFile("door.sys");                   // line 10 = user name
    if (L) { nm = bmTrim(L[9]); if (nm) return nm; }
    var dor = ["dorinfo1.def"];                     // line 7 = first, line 8 = last
    try { if (typeof bbs !== "undefined" && bbs.node_num) dor.unshift("dorinfo" + bbs.node_num + ".def"); } catch (eN) {}
    for (i = 0; i < dor.length; i++) {
        L = readDropFile(dor[i]);
        if (L) { nm = bmTrim(bmTrim(L[6]) + " " + bmTrim(L[7])); if (nm) return nm; }
    }
    L = readDropFile("chain.txt");                  // line 2 = alias (WWIV)
    if (L) { nm = bmTrim(L[1]); if (nm) return nm; }
    return "User";
}

function getUserKey() {
    try { if (typeof user !== "undefined" && user && user.number) return "u" + user.number; } catch (eK) {}
    var L = readDropFile("door32.sys");             // line 5 = user record number
    if (L) { var n = parseInt(bmTrim(L[4]), 10); if (n) return "u" + n; }
    var nm = getUserName().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (nm.length > 40) nm = nm.substring(0, 40);
    return "n" + (nm || "user");
}

function bookmarkDir() {
    var d = system.data_dir + "wiki_encyclopedia";
    if (!file_isdir(d)) mkdir(d);
    return d + "\\";
}
function bookmarkPath() { return bookmarkDir() + getUserKey() + ".bmk"; }

function loadBookmarks() {
    var p = bookmarkPath();
    if (!file_exists(p)) return [];
    var f = new File(p);
    if (!f.open("r")) return [];
    var lines = f.readAll();
    f.close();
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var ln = bmTrim(lines[i]);
        if (!ln) continue;
        var tab = ln.indexOf("\t");
        if (tab >= 0) out.push({ title: bmTrim(ln.substring(0, tab)), description: bmTrim(ln.substring(tab + 1)) });
        else out.push({ title: ln, description: "" });
    }
    return out;
}
function saveBookmarks(list) {
    var f = new File(bookmarkPath());
    if (!f.open("w")) return false;
    for (var i = 0; i < list.length; i++)
        f.writeln(list[i].title + "\t" + (list[i].description || ""));
    f.close();
    return true;
}
function findBookmark(list, title) {
    var t = (title || "").toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i].title.toLowerCase() === t) return i;
    return -1;
}
function toggleBookmark(title, description) {
    var list = loadBookmarks();
    var idx = findBookmark(list, title);
    if (idx >= 0) { list.splice(idx, 1); saveBookmarks(list); return false; }
    list.push({ title: title, description: description || "" });
    saveBookmarks(list);
    return true;
}

// Draw one selectable list row (shared by search results and bookmarks).
function drawResultRow(index, result, isSelected) {
    var row  = CONTENT_TOP + index;
    var num  = (index < 9) ? ((index + 1) + ".") : (index === 9 ? "0." : "  ");
    var text = " " + num + " " + translit(result.title || "");
    if (result.description) text += "  - " + translit(result.description);
    var maxw = COLS - 3;
    if (text.length > maxw) text = text.substring(0, maxw);
    var col = isSelected ? COL_SEL : COL_BODY_BG;
    console.putmsg(gotoxy(2, row) + col + padRight(text, maxw) + COL_RESET);
}

// Browse this user's bookmarks; returns a chosen title (to open) or null.
function showBookmarks() {
    var list = loadBookmarks();
    console.putmsg(cls());
    drawStdHeader("Your Bookmarks");
    if (!list.length) {
        console.putmsg(gotoxy(2, CONTENT_TOP + 1) + COL_BODY_BG
            + "  No bookmarks yet -- press [M] while reading an article to save it." + COL_RESET);
        drawStatusBar(0, 0, "No bookmarks.  Press any key to go back.");
        console.getkey(K_NOECHO);
        return null;
    }
    var pick = runListPicker(list, "Your Bookmarks", "SAVED", true, function () { saveBookmarks(list); });
    return (pick >= 0) ? list[pick].title : null;
}

// Draw the full welcome screen (also used to repaint after returning).
function drawWelcome(userName) {
    console.putmsg(cls());
    drawStdHeader("Welcome");
    var W = COLS - 4;
    var welcomeLines = [
        "",
        COL_TITLE_BG + center(" CONVOLUTION WIKIPEDIA ENCYCLOPEDIA ", W) + COL_RESET,
        "",
        COL_BODY_BG + center("The World's Knowledge at Your Fingertips", W) + COL_RESET,
        "",
        COL_BORDER  + "  " + repeat("\xC4", W - 2) + COL_RESET,
        "",
        COL_BODY_BG + "  Welcome, " + COL_BWHITE + (userName || "User") + COL_RESET + COL_BODY_BG + "!" + COL_RESET,
        "",
        COL_BODY_BG + "  Browse Wikipedia in a classic CD-ROM encyclopedia interface." + COL_RESET,
        COL_BODY_BG + "  While reading, press [M] to bookmark an article; press [B]" + COL_RESET,
        COL_BODY_BG + "  here to reopen anything you have saved." + COL_RESET,
        "",
        COL_BORDER  + "  " + repeat("\xC4", W - 2) + COL_RESET,
        "",
        COL_HILITE  + center("[S] Search    [B] Bookmarks    [H] Help    [Q] Quit", W) + COL_RESET
    ];
    for (var i = 0; i < welcomeLines.length && i < CONTENT_ROWS; i++)
        console.putmsg(gotoxy(2, CONTENT_TOP + i) + " " + welcomeLines[i]);
    drawStatusBar(0, 0, "[S] Search   [B] Bookmarks   [H] Help   [Q] Quit");
}

// ---------------------------------------------------------------------------
// MAIN PROGRAM
// ---------------------------------------------------------------------------
function main() {
    // K_ flag constants in Synchronet

    // Detect terminal size and capabilities
    initTerminal();

    // State
    var currentArticle  = null;   // { title, description, extract, links, imageUrl }

    // Welcome screen
    var sessionUser = getUserName();
    drawWelcome(sessionUser);

    // Look up the user's local weather (by profile zip) once, after the welcome
    // screen is already on-screen, then repaint the header so it appears.
    WEATHER_STR = fetchWeather();
    drawHeaderClock();

    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // Welcome screen key loop — article display handled inside loadArticle()
    // ---------------------------------------------------------------------------
    while (true) {
        var key = console.inkey(K_NOECHO, 1000);
        if (!key) { drawHeaderClock(); continue; }
        var keyUp = (key.length === 1) ? key.toUpperCase() : key;

        if (keyUp === "Q" || key === "\x1b") {
            console.putmsg(cls() + COL_RESET);
            console.putmsg("\r\n" + COL_BWHITE + "Thank you for using Convolution Wikipedia Encyclopedia!" + COL_RESET + "\r\n\r\n");
            break;
        }
        if (keyUp === "S") {
            var title = promptSearch();
            if (title) loadArticle(title);
            drawWelcome(sessionUser);
        } else if (keyUp === "B") {
            var bmTitle = showBookmarks();
            if (bmTitle) loadArticle(bmTitle);
            drawWelcome(sessionUser);
        } else if (keyUp === "H") {
            showHelp();
            drawWelcome(sessionUser);
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
main();
