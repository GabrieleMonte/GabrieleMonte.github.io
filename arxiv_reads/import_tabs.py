#!/usr/bin/env python3
"""
Import arXiv papers from open Chromium PDF tabs into the arxiv_reads pages.

Workflow:
  1. Run this script.
  2. In Chromium, focus the window you want to import from and click the
     "arxiv_reads tab exporter" extension (or press Ctrl+Shift+Y).
  3. The extension sends that window's tabs in visual (left-to-right) order
     to this script.

Logic:
  - Read tabs left-to-right.
  - Include arxiv /pdf/ tabs (these are the papers you've opened).
  - Stop at the first tab that is not an arxiv /pdf/ (abs pages, listings,
    or anything else mark the boundary between read and unread).
  - Skip papers already present in the reads HTML files.

Usage:
    python3 import_tabs.py
"""

import json
import os
import re
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("TAB_EXPORTER_PORT", "9223"))

MONTH_NAMES = {
    1: "January", 2: "February", 3: "March", 4: "April",
    5: "May", 6: "June", 7: "July", 8: "August",
    9: "September", 10: "October", 11: "November", 12: "December",
}


class _TabsHandler(BaseHTTPRequestHandler):
    received = None

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path != "/tabs":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        try:
            _TabsHandler.received = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args, **kwargs):
        return  # silence default access log


def get_chrome_tabs():
    """Run a one-shot HTTP server and wait for the extension to POST tabs."""
    try:
        server = HTTPServer(("localhost", PORT), _TabsHandler)
    except OSError as e:
        print(f"Could not bind localhost:{PORT}: {e}")
        sys.exit(1)

    print(f"Waiting for tab_exporter on localhost:{PORT}...")
    print("Focus the Chromium window you want to import from, then click the")
    print('"arxiv_reads tab exporter" extension icon (or press Ctrl+Shift+Y).')
    while _TabsHandler.received is None:
        server.handle_request()
    server.server_close()

    tabs = _TabsHandler.received
    tabs.sort(key=lambda t: t.get("index", 0))
    return [t["url"] for t in tabs]


def extract_pdf_ids(urls):
    """Return arXiv IDs from consecutive /pdf/ tabs, stopping at the first miss."""
    ids = []
    for url in urls:
        m = re.search(r"arxiv\.org/pdf/(\d{4}\.\d{4,5})", url)
        if m:
            ids.append(m.group(1))
        else:
            break
    return ids


def already_recorded(arxiv_ids):
    """Return the set of IDs that already appear in any *_reads.html file."""
    existing = set()
    for fname in os.listdir(SCRIPT_DIR):
        if fname.endswith("_reads.html"):
            with open(os.path.join(SCRIPT_DIR, fname)) as f:
                content = f.read()
            for aid in arxiv_ids:
                if aid in content:
                    existing.add(aid)
    return existing


def fetch_title(arxiv_id):
    """Fetch the paper title from the arXiv abstract page."""
    url = f"https://arxiv.org/abs/{arxiv_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8")
        m = re.search(r"<title>\[.*?\]\s*(.*?)</title>", html, re.DOTALL)
        if m:
            return re.sub(r"\s+", " ", m.group(1).strip())
    except Exception as e:
        print(f"  Warning: could not fetch title for {arxiv_id}: {e}")
    return None


def year_month(arxiv_id):
    """Parse arXiv ID into (year, month)."""
    return 2000 + int(arxiv_id[:2]), int(arxiv_id[2:4])


def make_li(arxiv_id, title):
    return (
        f'        <li><a href="https://arxiv.org/abs/{arxiv_id}" '
        f'target="_blank">arXiv{arxiv_id}</a>: {title}</li>'
    )


def reads_file(year):
    return os.path.join(SCRIPT_DIR, f"{year}_reads.html")


def write_papers(papers_by_month):
    """Insert papers into the appropriate reads files."""
    for (year, month), papers in sorted(papers_by_month.items(), reverse=True):
        path = reads_file(year)
        month_name = MONTH_NAMES[month]
        entries = "\n".join(make_li(aid, t) for aid, t in papers)

        if os.path.exists(path):
            with open(path) as f:
                content = f.read()
            pat = (
                r"(<summary class=\"subheading mb-3\"><span class=\"arrow\"></span>\s*"
                + re.escape(month_name)
                + r"\s+"
                + str(year)
                + r"\s*</summary>\s*<ul>)(.*?)(</ul>)"
            )
            m = re.search(pat, content, re.DOTALL)
            if m:
                new = content[: m.end(2)] + "\n" + entries + content[m.end(2):]
                with open(path, "w") as f:
                    f.write(new)
                print(f"  Appended {len(papers)} paper(s) to {month_name} {year}")
            else:
                section = (
                    f'<details class="month">\n'
                    f'    <summary class="subheading mb-3">'
                    f'<span class="arrow"></span> {month_name} {year} </summary>\n'
                    f"    <ul>\n{entries}\n    </ul>\n  </details>\n"
                )
                with open(path, "w") as f:
                    f.write(section + content)
                print(f"  Created {month_name} {year} section with {len(papers)} paper(s)")
        else:
            content = (
                f'<details class="month">\n'
                f'    <summary class="subheading mb-3">'
                f'<span class="arrow"></span> {month_name} {year} </summary>\n'
                f"    <ul>\n{entries}\n    </ul>\n  </details>\n"
            )
            with open(path, "w") as f:
                f.write(content)
            print(f"  Created {path} with {month_name} {year} ({len(papers)} paper(s))")


def main():
    urls = get_chrome_tabs()
    print(f"Received {len(urls)} tab(s) from the extension.")
    arxiv_ids = extract_pdf_ids(urls)

    if not arxiv_ids:
        print("No arXiv /pdf/ tabs at the start of the tab strip.")
        sys.exit(0)

    existing = already_recorded(arxiv_ids)
    new_ids = [aid for aid in arxiv_ids if aid not in existing]

    if existing:
        print(f"Skipping {len(existing)} paper(s) already recorded: {', '.join(sorted(existing))}")
    if not new_ids:
        print("All papers are already in the reads files. Nothing to do.")
        sys.exit(0)

    print(f"Found {len(new_ids)} new paper(s). Fetching titles...\n")

    papers = []
    for aid in new_ids:
        title = fetch_title(aid)
        if title:
            papers.append((aid, title))
            print(f"  {aid}: {title}")
        else:
            papers.append((aid, "[Title not found]"))
            print(f"  {aid}: [Title not found]")

    last_id, last_title = papers[-1]
    print(f"\nYou are about to upload {len(papers)} paper(s).")
    print(f'The last one is: "{last_title}" ({last_id})')
    response = input("Should I proceed? [y/N] ").strip().lower()
    if response != "y":
        print("Aborted.")
        sys.exit(0)

    by_month = {}
    for aid, title in papers:
        key = year_month(aid)
        by_month.setdefault(key, []).append((aid, title))

    print()
    write_papers(by_month)
    print("\nDone!")


if __name__ == "__main__":
    main()
