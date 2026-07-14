#!/usr/bin/env python3
"""Check CI status for each open PR in greysquirr3l/mightymax-vscode."""
import json
import urllib.request

REPO = "greysquirr3l/mightymax-vscode"
HDR = {"Accept": "application/vnd.github+json", "User-Agent": "copilot"}


def get(url):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


prs = get(f"https://api.github.com/repos/{REPO}/pulls?state=open&per_page=50")

print(f"{'#':>4}  {'branch':52s}  CI verdict")
print("-" * 110)
for p in prs:
    sha = p["head"]["sha"]
    try:
        checks = get(f"https://api.github.com/repos/{REPO}/commits/{sha}/check-runs")["check_runs"]
    except Exception as e:
        verdict = f"check error: {e}"
        print(f"{p['number']:>4}  {p['head']['ref']:52s}  {verdict}")
        continue
    n_total = len(checks)
    n_pass = sum(1 for c in checks if c.get("conclusion") == "success")
    n_fail = sum(1 for c in checks if c.get("conclusion") == "failure")
    n_pending = sum(1 for c in checks if c.get("conclusion") is None)
    n_other = n_total - n_pass - n_fail - n_pending
    names = ", ".join(
        f"{c['name']}={c.get('conclusion') or c.get('status')}" for c in checks
    )
    print(
        f"{p['number']:>4}  {p['head']['ref']:52s}  "
        f"{n_pass}\u2713 {n_fail}\u2717 {n_pending}\u2026 {n_other}? ({n_total} total)  "
        f"head_sha={sha[:7]}  [{names}]"
    )
