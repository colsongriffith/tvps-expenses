#!/usr/bin/env python3
"""Parse a contractor editing invoice (invoicely.com layout) and check its math.

Usage: python3 parse_invoice.py invoice.pdf > invoice.json
Prints JSON: {invoice_no, invoice_date, vendor, lines:[{n, date, description, qty, unit_cents, total_cents, calc_cents, ok}],
              subtotal_cents, total_cents, sum_lines_cents, problems:[...]}
Every line is checked (qty x unit = line total, to the cent) and the line totals are checked against Subtotal and Total.
"""
import json, re, subprocess, sys
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

def cents(s): return int((Decimal(s.replace(",", "")) * 100).quantize(Decimal("1"), ROUND_HALF_UP))

def fix_mojibake(s):
    # invoicely PDFs carry UTF-8 that was read as Windows-1252 ("Sandeepâ€™s"); undo it where that round-trips cleanly.
    for enc in ("cp1252", "latin-1"):
        try: return s.encode(enc).decode("utf-8")
        except Exception: pass
    return s

def main(path):
    raw = subprocess.run(["pdftotext", "-raw", path, "-"], capture_output=True, text=True, check=True).stdout
    lines = [fix_mojibake(l.strip()) for l in raw.splitlines() if l.strip()]
    head = "\n".join(lines[:15])
    inv_no = (re.search(r"Invoice\s*#\s*(\S+)", head) or [None, None])[1]
    m = re.search(r"(\d{1,2})-([A-Za-z]+)-(\d{4})", head)
    inv_date = datetime.strptime(m.group(0), "%d-%B-%Y").date().isoformat() if m else None
    vendor = lines[0].replace("INVOICE", "").strip() if lines else None

    # Item rows start at the header line; a row may wrap: "11" / "Oct 4, 2026 CITGO ... Welcome" / "Reception" / "1.5 60.00 90.00"
    start = next(i for i, l in enumerate(lines) if l.startswith("# Item Description"))
    end = next(i for i, l in enumerate(lines) if l.startswith("Subtotal"))
    tail = re.compile(r"\s*(\d+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$")
    items, buf = [], ""
    for l in lines[start + 1:end]:
        buf = (buf + " " + l).strip()
        t = tail.search(buf)
        if t:
            body = buf[:t.start()].strip()
            mm = re.match(r"(\d+)\s+(.*)", body)
            n, desc = int(mm.group(1)), mm.group(2)
            dm = re.match(r"([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s+(.*)", desc)
            date = datetime.strptime(f"{dm.group(1)} {dm.group(2)} {dm.group(3)}", "%b %d %Y").date().isoformat() if dm else None
            qty = Decimal(t.group(1)); unit = cents(t.group(2)); tot = cents(t.group(3))
            calc = int((qty * unit).quantize(Decimal("1"), ROUND_HALF_UP))
            items.append({"n": n, "date": date, "description": dm.group(4) if dm else desc, "qty": float(qty),
                          "unit_cents": unit, "total_cents": tot, "calc_cents": calc, "ok": calc == tot})
            buf = ""
    money = lambda label: next((cents(re.search(r"([\d,]+\.\d{2})", l).group(1)) for l in lines[end:] if l.startswith(label)), None)
    sub, total = money("Subtotal"), money("Total")
    s = sum(i["total_cents"] for i in items)
    problems = [f"Line {i['n']}: {i['qty']} x ${i['unit_cents']/100:.2f} = ${i['calc_cents']/100:.2f}, invoice says ${i['total_cents']/100:.2f}" for i in items if not i["ok"]]
    if sub is not None and sub != s: problems.append(f"Subtotal ${sub/100:.2f} but lines add to ${s/100:.2f}")
    if total is not None and total != s: problems.append(f"Total ${total/100:.2f} but lines add to ${s/100:.2f}")
    if buf: problems.append(f"Could not read a line: {buf!r}")
    nums = [i["n"] for i in items]
    if nums != list(range(1, len(items) + 1)): problems.append(f"Line numbers skip or repeat: {nums}")
    print(json.dumps({"invoice_no": inv_no, "invoice_date": inv_date, "vendor": vendor, "lines": items,
                      "subtotal_cents": sub, "total_cents": total, "sum_lines_cents": s,
                      "hours": float(sum(Decimal(str(i["qty"])) for i in items)), "problems": problems}, indent=1, ensure_ascii=False))

if __name__ == "__main__":
    main(sys.argv[1])
