"""Off-domain link rule: unit checks on 02-archive's link-selection logic.

The rule lives entirely in _candidate_links (same-domain) and _offdomain_leads (off-domain),
so it can be checked directly against synthetic link lists — no network, no fixtures, no
archive. test_phase2_archive.py covers the crawl end to end, but every fixture there is
served from one local host, so it cannot exercise this rule at all.

What the rule is:
  - Neither: an href holding a bare email address, which resolves to a path that 404s.
  - Same domain: keyword-matching links first, then PDFs when the page has a hazing signal.
  - Off domain, from the source page only, capped, never expanded:
      a PDF on any domain, or an HTML page on another .edu. Nothing else.

Run with: python tests/test_offdomain_rule.py
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_run_module():
    """jobs/02-archive/run.py can't be `import`ed by its hyphenated/digit-leading dir name."""
    spec = importlib.util.spec_from_file_location(
        "job_02_archive_run", ROOT / "jobs" / "02-archive" / "run.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _link(url: str, text: str = "") -> dict:
    return {"url": url, "text": text}


def main() -> int:
    run = _load_run_module()
    failures: list[str] = []

    def check(label: str, got, expected):
        if got != expected:
            failures.append(f"{label}\n        expected: {expected}\n        got:      {got}")

    # ── Same-domain ordering is unchanged: keyword links, then PDFs ──────────────
    links = [
        _link("https://albion.edu/students", "Student life"),
        _link("https://albion.edu/files/report-2025.pdf", "2025"),
        _link("https://albion.edu/hazing-transparency", "Hazing transparency report"),
    ]
    check(
        "same-domain: keyword links come before signal-page PDFs",
        run._candidate_links(links, True, "albion.edu"),
        ["https://albion.edu/hazing-transparency", "https://albion.edu/files/report-2025.pdf"],
    )
    check(
        "same-domain: a non-keyword, non-PDF link is never followed",
        run._candidate_links([_link("https://albion.edu/students", "Student life")], True, "albion.edu"),
        [],
    )
    check(
        "same-domain: PDFs are not followed when the page has no hazing signal",
        run._candidate_links([_link("https://albion.edu/files/x.pdf", "x")], False, "albion.edu"),
        [],
    )

    # ── An email address in an href is not a page ────────────────────────────────
    # McNeese's hazing-education page links studentservices@mcneese.edu with no mailto:,
    # which resolves as a relative path. It was followed because "hazing" is a substring
    # of "hazinged" in that path, and cost three fetches plus six seconds of backoff for
    # a guaranteed 404.
    email_href = [
        _link("https://www.mcneese.edu/campus-life/hazinged/studentservices@mcneese.edu",
              "studentservices@mcneese.edu"),
        _link("https://www.mcneese.edu/campus-life/hazinged/", "Hazing education"),
    ]
    check(
        "email href: an un-schemed address is dropped, the real hazing link is kept",
        run._candidate_links(email_href, True, "mcneese.edu"),
        ["https://www.mcneese.edu/campus-life/hazinged/"],
    )
    check(
        "email href: dropped off-domain too, not just same-domain",
        run._offdomain_leads(
            [_link("https://ulsystem.edu/hazing/transparency@ulsystem.edu", "Hazing contact")],
            True, "uno.edu"),
        [],
    )
    check(
        "email href: an @ that is not a trailing address does not disqualify a URL",
        run._candidate_links(
            [_link("https://albion.edu/hazing/@media/report.pdf", "Hazing report")],
            True, "albion.edu"),
        ["https://albion.edu/hazing/@media/report.pdf"],
    )

    # ── A campus subdomain is the same domain, not an off-domain lead ────────────
    subdomain = [_link("https://hunter.cuny.edu/hazing-log", "Hazing incident log")]
    check(
        "subdomain: hunter.cuny.edu counts as same-domain when home is cuny.edu",
        run._candidate_links(subdomain, True, "cuny.edu"),
        ["https://hunter.cuny.edu/hazing-log"],
    )
    check(
        "subdomain: and is therefore not also queued as an off-domain lead",
        run._offdomain_leads(subdomain, True, "cuny.edu"),
        [],
    )

    # ── Off-domain: the advocacy sites that filled the live archive are excluded ──
    junk = [
        _link("https://stophazing.org/resources", "Hazing resources"),
        _link("https://hazingpreventionnetwork.org/news/", "Hazing news"),
        _link("https://clerycenter.org/hazing", "Hazing and the Clery Act"),
        _link("https://insidehazing.com/article", "hazing article"),
        _link("https://antihazingcoalition.org/", "anti-hazing coalition"),
        _link("https://www.congress.gov/bill/118th", "Stop Campus Hazing Act"),
        _link("https://docs.google.com/document/d/abc", "hazing report"),
        _link("https://cm.maxient.com/reportingform.php", "Report hazing"),
        _link("https://clery.memberclicks.net/x", "hazing"),
    ]
    check(
        "off-domain: every non-.edu HTML source of junk is excluded outright",
        run._offdomain_leads(junk, True, "aamu.edu"),
        [],
    )

    # ── Off-domain: a PDF is allowed from any domain ─────────────────────────────
    hosted_pdfs = [
        _link("https://svdcdn.com/files/chtr.pdf", "Download"),
        _link("https://s3.amazonaws.com/msmc/hazing.pdf", "file"),
        _link("https://pcdn.co/assets/report.pdf", ""),
    ]
    check(
        "off-domain: PDFs on delivery hosts are kept, link text irrelevant",
        run._offdomain_leads(hosted_pdfs, True, "mcneese.edu"),
        [
            "https://svdcdn.com/files/chtr.pdf",
            "https://s3.amazonaws.com/msmc/hazing.pdf",
            "https://pcdn.co/assets/report.pdf",
        ],
    )

    # ── Off-domain: a link claiming to BE a transparency report is followed ──────
    # Measured: 37 such documents at 35 institutions, incl. cm.maxient.com/chtr.php for
    # 102 schools. A .edu-only rule would have lost every one.
    hosted_reports = [
        _link("https://cm.maxient.com/chtr.php?GeorgiaStateUniv", "No Hazing @ State"),
        _link("https://cm.maxient.com/chtr.php?UnivofFlorida", "Transparency"),
        _link("https://cm.maxient.com/reportingform.php?UnivofFlorida", "Report hazing"),
        _link("https://someplatform.com/transparency-report/2025", "2025 disclosures"),
        _link("https://stophazing.org/resources", "Hazing resources"),
    ]
    check(
        "off-domain: chtr/transparency-report links kept, reporting forms and advocacy dropped",
        run._offdomain_leads(hosted_reports, True, "gsu.edu"),
        [
            "https://cm.maxient.com/chtr.php?GeorgiaStateUniv",
            "https://cm.maxient.com/chtr.php?UnivofFlorida",
            "https://someplatform.com/transparency-report/2025",
        ],
    )

    # ── Off-domain: a PDF with a query string is still a PDF ─────────────────────
    # Shape taken from Georgia State's former conduct page: a Dropbox link whose query
    # string follows the .pdf. Checking the whole URL rather than its path treated every
    # such link as HTML.
    dropbox = [_link("https://www.dropbox.com/scl/fi/x/2018_Kappa_Sigma_Results.pdf"
                     "?rlkey=abc&st=def&dl=0", "2018 results")]
    check(
        "off-domain: a .pdf link carrying a query string is treated as a document",
        run._offdomain_leads(dropbox, True, "gsu.edu"),
        ["https://www.dropbox.com/scl/fi/x/2018_Kappa_Sigma_Results.pdf?rlkey=abc&st=def&dl=1"],
    )

    # ── Off-domain: HTML is allowed only from another .edu ───────────────────────
    edu_html = [
        _link("https://ulsystem.edu/hazing-transparency", "Hazing transparency"),
        _link("https://lsuneworleans.edu/hazing/transparency", "Transparency report"),
        _link("https://stophazing.org/resources", "Hazing resources"),
    ]
    check(
        # "Transparency report" is a chtr signal, so that link outranks one that merely
        # says "Hazing transparency" — documents ahead of mentions, as intended.
        "off-domain: .edu HTML kept (system office, rebranded campus), .org dropped",
        run._offdomain_leads(edu_html, True, "uno.edu"),
        [
            "https://lsuneworleans.edu/hazing/transparency",
            "https://ulsystem.edu/hazing-transparency",
        ],
    )
    check(
        "off-domain: a .edu page with no hazing keyword is still not followed",
        run._offdomain_leads([_link("https://ulsystem.edu/about", "About the system")], True, "uno.edu"),
        [],
    )

    # ── Off-domain: PDFs take the cap before .edu pages ──────────────────────────
    cap = run.MAX_OFFDOMAIN_LEADS
    many = [_link(f"https://cdn{i}.com/r{i}.pdf", "") for i in range(cap)]
    many += [_link(f"https://sys{i}.edu/hazing", "Hazing report") for i in range(4)]
    leads = run._offdomain_leads(many, True, "example.edu")
    check("off-domain: capped at MAX_OFFDOMAIN_LEADS", len(leads), cap)
    check(
        "off-domain: documents claim the cap ahead of .edu pages",
        leads,
        [f"https://cdn{i}.com/r{i}.pdf" for i in range(cap)],
    )

    # ── The Alabama A&M shape: one own-domain report, a wall of advocacy links ────
    aamu = [_link("https://aamu.edu/hazing-transparency-report", "Hazing Transparency Report")]
    aamu += [_link(f"https://stophazing.org/page{i}", "Hazing information") for i in range(20)]
    aamu += [_link(f"https://hazingpreventionnetwork.org/p{i}", "Hazing prevention") for i in range(10)]
    check(
        "regression (Alabama A&M shape): the school's own report is still found",
        run._candidate_links(aamu, True, "aamu.edu"),
        ["https://aamu.edu/hazing-transparency-report"],
    )
    check(
        "regression (Alabama A&M shape): 30 advocacy links now yield zero fetches",
        run._offdomain_leads(aamu, True, "aamu.edu"),
        [],
    )

    if failures:
        print("FAIL")
        for f in failures:
            print(f"      {f}")
        return 1
    print("ok    same-domain ordering unchanged (keyword links, then signal-page PDFs)")
    print("ok    un-schemed email addresses in hrefs are never followed")
    print("ok    campus subdomains count as same-domain, not off-domain leads")
    print("ok    non-.edu off-domain HTML excluded outright (advocacy, news, legislature, forms)")
    print("ok    off-domain PDFs kept from any host; .edu HTML kept for system offices/rebrands")
    print("ok    chtr/transparency-report links kept off-domain; reporting forms excluded")
    print("ok    a .pdf link with a query string is a document, and dropbox dl=0 becomes dl=1")
    print("ok    off-domain leads capped, PDFs claiming the cap ahead of .edu pages")
    print("ok    Alabama A&M shape: own report still found, 30 advocacy links yield nothing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
