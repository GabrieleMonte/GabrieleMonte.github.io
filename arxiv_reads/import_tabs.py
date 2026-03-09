#!/usr/bin/env python3
"""
Import arXiv papers from open Chrome PDF tabs into the arxiv_reads pages.

Reads tabs left-to-right, stopping at the first non-PDF tab.
Skips papers already present in the reads files.
Prompts for confirmation before writing.

Usage:
    python3 import_tabs.py
"""

import subprocess
import urllib.request
import re
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

MONTH_NAMES = {
    1: "January", 2: "February", 3: "March", 4: "April",
    5: "May", 6: "June", 7: "July", 8: "August",
    9: "September", 10: "October", 11: "November", 12: "December",
}


def get_chrome_tabs():
    """Get URLs of all open Chrome tabs via AppleScript (left-to-right order)."""
    result = subprocess.run(
        ["osascript", "-e",
         'tell application "Google Chrome" to get URL of every tab of every window'],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Error getting Chrome tabs: {result.stderr}")
        sys.exit(1)
    return [u.strip() for u in result.stdout.strip().split(", ")]


def extract_pdf_ids(urls):
    """Return arXiv IDs from consecutive /pdf/ tabs, stopping at the first non-PDF."""
    ids = []
    for url in urls:
        if "/pdf/" in url:
            m = re.search(r"(\d{4}\.\d{4,5})", url)
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
            content = open(os.path.join(SCRIPT_DIR, fname)).read()
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
            content = open(path).read()
            # Try to find an existing month section
            pat = (
                r"(<summary class=\"subheading mb-3\"><span class=\"arrow\"></span>\s*"
                + re.escape(month_name)
                + r"\s+"
                + str(year)
                + r"\s*</summary>\s*<ul>)(.*?)(</ul>)"
            )
            m = re.search(pat, content, re.DOTALL)
            if m:
                # Append inside existing <ul>
                new = content[: m.end(2)] + "\n" + entries + content[m.end(2) :]
                open(path, "w").write(new)
                print(f"  Appended {len(papers)} paper(s) to {month_name} {year}")
            else:
                # Prepend a new month section at the top of the file
                section = (
                    f'<details class="month">\n'
                    f'    <summary class="subheading mb-3">'
                    f'<span class="arrow"></span> {month_name} {year} </summary>\n'
                    f"    <ul>\n{entries}\n    </ul>\n  </details>\n"
                )
                open(path, "w").write(section + content)
                print(f"  Created {month_name} {year} section with {len(papers)} paper(s)")
        else:
            # Brand-new year file
            content = (
                f'<details class="month">\n'
                f'    <summary class="subheading mb-3">'
                f'<span class="arrow"></span> {month_name} {year} </summary>\n'
                f"    <ul>\n{entries}\n    </ul>\n  </details>\n"
            )
            open(path, "w").write(content)
            print(f"  Created {path} with {month_name} {year} ({len(papers)} paper(s))")


def main():
    print("Fetching Chrome tabs...")
    urls = get_chrome_tabs()
    arxiv_ids = extract_pdf_ids(urls)

    if not arxiv_ids:
        print("No arXiv PDF tabs found (or the first tab is not a PDF).")
        sys.exit(0)

    # Filter out duplicates
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

    # Confirmation prompt
    last_id, last_title = papers[-1]
    print(f"\nYou are about to upload {len(papers)} paper(s).")
    print(f'The last one is: "{last_title}" ({last_id})')
    response = input("Should I proceed? [y/N] ").strip().lower()
    if response != "y":
        print("Aborted.")
        sys.exit(0)

    # Group by (year, month) and write
    by_month = {}
    for aid, title in papers:
        key = year_month(aid)
        by_month.setdefault(key, []).append((aid, title))

    print()
    write_papers(by_month)
    print("\nDone!")


if __name__ == "__main__":
    main()
