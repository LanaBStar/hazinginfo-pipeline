# HazingInfo — Apps Script pipeline

Google Apps Script project **PROD - HazingInfo Candidate URL Pipeline**, owned by Lana's
personal Google account. This repo is a copy of its files for review and history; **the Apps
Script project is the running system**, and a change here does not reach it until someone
pastes it in.

**Read [SCHEDULING.md](SCHEDULING.md) before adding any trigger.** Everything painful about
this environment is documented there.

---

## What this system does

Finds and evaluates three kinds of page for ~1,477 US institutions — a **Campus Hazing
Transparency Report**, a **hazing policy**, and a **hazing reporting form** — and keeps the
URLs of record current.

```
DISCOVERY                     REVIEW                      MAINTENANCE
sitemap crawl  ─┐
cross-seed     ─┼─► Candidate URLs ─► human review ─► promote ─► 50 States
search probe   ─┘   (PAGES base)      + AI triage              (live site)
                                                                    │
                                          live URL checks ◄─────────┘
```

Two Airtable bases:

- **PAGES** `appEvOdPi94MzZ6Db` — working data. `Candidate URLs`, plus an `Institutions` table
  synced one-way from 50 States.
- **50 States** `appJbAvuFOxhWOID2` — production. Drives the live site.

Every institution has **two URL fields per category**: a *record* field holding the best page
found regardless of quality (`located_hazing_policy_url`, `located_report_form_url`,
`chtr_index_url`), and a *compliance* field that drives the public checkmark (`Hazing Policy`,
`Report Form`, `Transparency Report`). **A filled compliance field must hold the same URL as
its record field.** Blank compliance means the school still needs a page meeting the standard,
whether none was found or the one found fell short.

---

## Files

### Pipeline

| File | What it does | Start with |
|---|---|---|
| `SitemapFinder.gs` | Stage 1 discovery: crawls each school's sitemap for likely pages, creates Candidate URLs rows. Also owns the shared helpers most other files use — `CATEGORIES`, `CF`, `capPat_`, `rankCandidates_`, `pipelineExistingKeys_`. | `smGateCheck()`, `sitemapSweepStatus()` |
| `CrossSeed.gs` | Stage 2: crawls a school's *confirmed* page in one category for links to the others. | `xsStatus()`, `xsDryRunChtr10()` |
| `SearchProbe.gs` | Stage 3: paid Google search (Apify) only where stages 1–2 provably failed. Daily query budget. | `spStatus()`, `spDryRun10()` |
| `SiteCensus.gs` | Measures sitemap reachability and coverage per school. SearchProbe reads its results **and its constants at load time** — deleting this file breaks the project. | `scStatus()`, `scDryRun10()` |
| `PreFilterResult.gs` | Cheap pre-filter before the AI pass. | — |
| `ContentHash.gs` | The single definition of the page-content hash, shared by candidate capture and live checks. **Editing it invalidates every stored hash in both tables.** | `hazHashRegenerationNotes()` |
| `LiveUrlChecks.gs` | Re-checks promoted URLs for liveness and content drift. | `lucStatus()` |
| `WriteBack.gs` | Applies reviewer-proposed URLs. Two-function arming: report, then act. | `wbDryRun()` then `wbApply()` |
| `HazingDeathsLinks.gs` | Independent of the above: checks the media links in **50 States → U.S. Hazing Deaths** and records Wayback snapshots. | `hdlStatus()` |
| `WebApp.gs` | The web app UI. | — |

### diagnostics/ — hand-run, read-only, not part of any schedule

| File | Answers |
|---|---|
| `FindPoison.gs` | *Which URL is hanging?* Fetches one at a time, logging each as it completes — the one it never logs is the culprit. Let it hit the cap; the timeout is the measurement. |
| `RobotsProbe.gs` | *Can we fetch the vendor report forms?* Measured 2026-08-30: **180 of 220 blocked** by a readable robots.txt, Maxient blocking all 111 of its URLs. This is the evidence behind "Report Form standards are a human pass." Re-run if a vendor's policy changes. |

### archive/ — kept for reference, does not run

| File | Why it is here |
|---|---|
| `Scheduler.gs` | **Broken — do not install.** Calls `runLivenessSlice_` and friends from `LinkChecker.gs`, which was replaced by `LiveUrlChecks.gs` and deleted. Kept because its *design* is the best worked example in the repo of a sweep that survives the six-minute cap. See SCHEDULING.md §11. |

---

## Setup

Script Properties (Project Settings → Script Properties):

| Key | Needed by |
|---|---|
| `AIRTABLE_PAT` | everything |
| `APIFY_TOKEN` | SearchProbe only |
| `NOTIFY_EMAIL` | optional — defaults to the script owner |

---

## Things that will bite you

**One shared global scope.** Apps Script concatenates every `.gs` file into one namespace.
Redeclaring a `const` that exists in another file fails **the entire project** — every
function, not just that file — with `Identifier 'X' has already been declared`. The error
names whichever file it noticed second, which is usually not the one you edited. Each file
prefixes its own names (`sm`/`xs`/`sp`/`sc`/`luc`/`hdl`/`rbt`) to keep out of each other's way.

**Pasting is replacing.** Click into the file, **Cmd+A**, Delete, then paste. Without the
select-all the paste *inserts*, you get two copies of the file, and you are in the failure
above. Check the last line number against the file here afterwards.

**The Run dropdown, not your cursor,** decides which function runs. The **Executions** panel is
the definitive record of what actually ran — triggered runs never appear in the editor log.

**A function ending in `_` is private** and cannot be selected in the Run dropdown or the
trigger picker.

**`filterByFormula` addresses fields by NAME.** Most reads here fetch everything and filter in
code instead, because `Institutions` is a synced table whose names are inherited from 50
States — a rename there would break a formula silently and return a smaller result, which
looks like a finding rather than a fault.

**`typecast: true` on an empty select value mints a nameless choice.** It happened once, to
Form link tier, on 32 rows.

**Rejections are the blocklist.** Discovery dedupes against every existing Candidate URLs row
including rejected ones, so a rejected URL is never re-proposed. **Reject, don't delete** —
deleting un-blocks the URL and it comes back on the next sweep.

---

## Where the rules live

Field definitions, controlled vocabulary terms and extraction rules are **owned in the Airtable
Data Dictionary**, not here. The below-standard vocabularies on `Candidate URLs` and `50 States`
must stay **identical term for term**: the promote step writes a term by name from one base to
the other, and a mismatch fails the whole row's write.
