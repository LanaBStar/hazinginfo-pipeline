# HazingInfo data check system (Apps Script)

**What this is:** the reference for the Google Apps Script project that keeps HazingInfo.org's school links current. It's written for two readers: a person maintaining the system, and an AI assistant being handed the work. Read it top to bottom once. After that, the tables are the quick reference.

**Last updated 2026-09-26** (Pacific), when the project moved to the HazingInfo Google account and went onto a schedule.

**The running code is in the Apps Script editor, not here.** This folder is a copy for history and review. A change here does nothing until someone pastes it into the editor. After any paste, check that file's line count in the editor, by name.

---

## 1. Where it lives

| What | Where |
|---|---|
| The Apps Script project (**this is what runs**) | **"PROD - HazingInfo Candidate URLs/Live Link Checks"**, owned by the HazingInfo Gmail account (hazingtracking@gmail.com). All triggers belong to this account and run as it. |
| The old copy | Lana's personal account, renamed "OLD - do not run …". **Never add triggers to it.** Two copies writing to Airtable at once would fight. |
| Working data | Airtable **PAGES** base `appEvOdPi94MzZ6Db`. Its tables: Candidate URLs, Live URL Checks, Institutions (a synced copy of 50 States), Ownership exceptions. |
| Published data | Airtable **50 States** base `appJbAvuFOxhWOID2`. Its tables: 50 States (drives HazingInfo.org), U.S. Hazing Deaths, U.S. Hazing Death Sources. |
| Rules and vocabulary | Airtable **CHTR Data Dictionary** base `app21HOC4olcnMVZC`, which holds the Data Dictionary and the Controlled Vocabularies. |

Each school has **two fields per category** in 50 States:

- the **record** field: the best page found, whatever its quality (`chtr_index_url`, `located_hazing_policy_url`, `located_report_form_url`);
- the **published** (compliance) field, which puts the checkmark on the public site (`Transparency Report`, `Hazing Policy`, `Report Form`).

The published field is filled only when the page meets HazingInfo's standard, and then it holds the same URL as the record field.

---

## 2. The workflow

```
FIND                          JUDGE                        PUBLISH                 WATCH
discovery (weekly-ish) ─┐
  cross-seed            ├─► Candidate URLs ─► AI field + ─► Promote ─► 50 States ─► Live URL Checks
  sitemap search        │   (page text        human review   (nightly)               (every ~10 days)
  search probe (manual) ┘    captured)        (Accept/Hold/                              │
                                               Reject…)                                  ▼
                                                                          human review of flagged links
                                                                                         │
                                                              Write-back (nightly) ◄─────┘
                                                              applies Fixed / Confirmed broken to 50 States

HAZING DEATHS (separate): U.S. Hazing Death Sources ─► link check (daily, each source every 30 days)
                          + archive lookup (daily) ─► auto-swap dead links to archived copies ─► email when a person is needed
```

---

## 3. The files

| File | What it does | Runs |
|---|---|---|
| `SitemapFinder.gs` | **Discovery.** Finds candidate pages for each school that still needs one, through cross-seed (links on a school's other confirmed pages), the school's sitemap, page capture (saving page text for the AI) and the Report Form link pass. Also owns shared helpers other files use. | `pipelineDailyTick`, daily ~3am (installed by `installPipelineSchedule`) |
| `CrossSeed.gs` | The cross-seed stage of discovery. | inside discovery |
| `SearchProbe.gs` | Paid Google search (Apify) for schools discovery couldn't solve. Also holds the old "site census" code (`SC_`/`sc` names). | **by hand only**; it costs money |
| `PreFilterResult.gs` | A cheap filter that drops obvious non-matches before the AI and a person see them. | inside discovery |
| `ContentHash.gs` | The single definition of a page's content fingerprint. **Editing it invalidates every stored fingerprint.** | shared |
| `Promote.gs` | Publishes reviewers' Candidate URL decisions to 50 States: URLs, below-standard reasons, hotline and contact details. | nightly |
| `LiveUrlChecks.gs` | Checks every published link, flags problems for a person, and emails the review count after each sweep. | every 4 hours |
| `WriteBack.gs` | Publishes reviewers' Live URL Checks decisions ("Fixed - new URL", "Confirmed broken") to 50 States. | nightly |
| `HazingDeathsLinks.gs` | Checks the news sources on the hazing-deaths pages, swaps dead ones to archived copies, finds archive copies, and emails when a person is needed. | daily (two triggers) |
| `WebApp.gs` | A small web page for running Live URL Checks by hand. | only when opened |
| `FindPoison.gs`, `RobotsProbe.gs` | Diagnostics, run by hand: "which URL is hanging?" and "which vendor forms block robots?" | by hand |

`archive/Scheduler.gs` (GitHub only) is **retired and broken; don't install it.** It was deleted from the project on 2026-09-26, after discovery got its own email function.

---

## 4. The schedule

| Trigger function | When | What it does |
|---|---|---|
| `wbApplyForReal` | daily, 1–2am | Live URL Checks decisions → 50 States. Runs before the checks, so they see the latest decisions. |
| `promoteApplyForReal` | daily, 2–3am | Candidate URL decisions → 50 States. |
| `pipelineDailyTick` | daily, ~3am | Discovery. Starts a new round **7 days after the last one finished** (`PIPELINE_REST_DAYS`), and restarts a round that stalled. A round spreads over about 3–4 days at 8 slices a day. |
| `promoteHotlineContactApplyForReal` | daily, 4–5am | Hotline and contact details → 50 States. |
| `hdlRun` | daily, 5–6am | Hazing-death link check. Each source is rechecked 30 days after its last check. |
| `hdlFindArchives` | daily, 6–7am | Looks up existing Wayback copies for sources that have none. Resumes where it stopped. |
| `lucCheckSliceScheduled` | every 4 hours | Live URL Checks. A full sweep starts **7 days after the last finished** (`LUC_MIN_SWEEP_INTERVAL_DAYS`) and takes about 3 days (about 2,600 links). Between sweeps, each run checks only newly added links and retries stuck ones. |

`pipelineChainRun` triggers appear and disappear on their own while a discovery round is running. That's normal.

**The daily limit is the hard constraint.** A regular Gmail account gets **90 minutes a day** of triggered run time, shared by everything. When it runs out, Google **silently** skips the rest of that day. The schedule above uses about 75 minutes in the worst case, and any new pass has to fit. Jobs share one lock, so two never run at once; one waits or skips its turn.

**Failure emails:** each trigger has a "Failure notification settings" choice. Use **weekly** normally, and **immediately** only when watching something new.

---

## 5. How each pass handles problems, and how it avoids nagging

The design rule throughout: **a person decides once. The system remembers that decision until the thing it was about changes, then asks again.** Nothing is re-flagged just because time passed, and nothing stays quiet after the facts change.

### 5.1 Discovery → Candidate URLs

- **A rejected URL is never proposed again** for that school and category. The row itself is the blocklist. **Reject, don't delete.** Deleting a row un-blocks its URL. The one exception is rows filed against the wrong school, which are deleted.
- **A school is skipped** while its published field is filled, or while it still has unreviewed candidates.
- **Most rounds find nothing new.** That's expected, and it creates no review work. The email comes only when a round finds new candidates, or aborts.

### 5.2 Promote (Candidate URLs → 50 States)

- **Each decision is published once.** A row stamped **Promoted** is never read again, so later corrections made in 50 States stay put.
- **To re-publish a row after changing its decision,** clear its Promote status.
- Rows that are **refused** (a contradiction, such as Accept with below-standard reasons) or **skipped** (for example, an ownership check) are rechecked every night. Their reason is in Promote note, and they don't publish until fixed.
- **Email only when something changed:** a school written, a write failed, or a row newly refused or flagged.

### 5.3 Live URL Checks

**Link statuses:**

| Status | Meaning |
|---|---|
| Live | The page loaded. |
| Redirected | It forwards somewhere else; see Redirect target. |
| Dead link | The server says the page isn't there. |
| Login required | The page exists but is behind a sign-in. |
| Unconfirmed | The server refused us. This says nothing about whether the page exists, so it needs a person. |
| Site error | The server failed, or the request never landed. |
| No URL | The tracked field has gone blank since the row was created. |

**Reviewer determinations:** Working as-is, Fixed - new URL (with a Reviewer-proposed URL), Confirmed broken - no replacement found, Needs second opinion.

**A reviewed row stays quiet until one of these happens:**

| What changes | What happens |
|---|---|
| **The link itself changes** | The review is wiped, and the row returns to Needs review. |
| **The page appears or disappears** ("not found", or the field emptied, versus anything else) | The review is wiped, and the row returns to Needs review. |
| **A different error of the same kind** (for example "blocked" becomes "server error") | Nothing changes. |
| **The page content changes** | The review stays, and the row gets "⚠ page changed". |

**When a sweep finishes**, one email gives counts by status of links that need a person, with a link to the **Needs review** view (PAGES → Live URL Checks → Needs review). It is sent only if the count isn't zero. `lucEmailReviewQueueNow` sends it by hand.

**"Page changed since review" is recorded but not acted on yet.** Acting on content changes is the future content-change phase (target-state spec phase 3), so the email leaves it out.

**A known limit for that phase:** a reviewer can't re-confirm an unchanged verdict. The snapshot automation only fires when the determination's value changes, so picking the same value again records nothing.

### 5.4 Write-back (Live URL Checks → 50 States)

It acts only on **Fixed - new URL** and **Confirmed broken**, with three guards:

1. **Only the page the reviewer judged.** That page is the snapshot of the URL taken when the review was made (field `fldVmX5yeRqTZuqDX`), because the Live URL Checks URL column always shows the *current* link. If the published link has changed since, the review is skipped as "needs re-review".
2. **Field by field.** A 50 States field changes only if it holds that exact page, or already holds the answer. A record field holding a different page is left alone.
3. **Once.** Applied reviews are remembered in the `wb_applied_*` Script Properties. An old decision never overwrites a later correction.
   - A new or changed review applies once.
   - Entries tidy themselves when Live URL Checks wipes a review.
   - If that record is ever damaged, write-back stops and says so rather than re-applying everything.

**Write-back doesn't email.** Its skips are in the run log.

### 5.5 Hazing-death sources

- **Link status:** Live, Broken, Unverifiable, Not checked. **Status detail** says why.
- **Muted** means "a person checked this result and it's fine". It stays ticked **only while the check keeps finding the same problem:** the same Link status and the same kind of error, meaning the part of Status detail before " - ", such as "Blocked" or "Dead link".
  - A different error, a new URL, or the page working again clears the tick.
  - A working page isn't flagged. The cleared tick just means a future break will be reported.
- **Automatic swap to the archive:** the dead address moves to **Original URL** and the **Archive URL** moves into **URL**. Any row with Original URL filled has been swapped. It happens only when all three are true:
  1. the page answers **"not found"** (404/410), **or** a deep link now lands on the site's **homepage**;
  2. the row has an **Archive URL**;
  3. **Original URL** is empty (it has never been swapped).
- **Everything else goes to a person:** blocked, site error, no response, login or paywall, dead but no archive, or an archive copy that has itself failed.
- **Archive copies:** `hdlFindArchives` finds existing Wayback copies automatically. **Apps Script can't create new ones.** A person uses web.archive.org/save while the page still works. Some sites, such as Ancestry, can't be archived.
- **Email** comes only when a source *newly* needs a person, or when swaps happened. It gives counts by error type, the total waiting, working sources with no archive, and a link to 50 States → U.S. Hazing Death Sources.

### 5.6 Who gets email

Every email goes to the `NOTIFY_EMAIL` Script Property if it's set, otherwise the HazingInfo Gmail. Promote reads the same property (since 2026-09-26), unless `PR_EMAIL_TO` inside `Promote.gs` is filled in; normally it's blank.

---

## 6. Script Properties (Project Settings → Script Properties)

| Key | What it is |
|---|---|
| `AIRTABLE_PAT` | Airtable token. Everything needs it. |
| `APIFY_TOKEN` | Search probe (Apify) token. |
| `NOTIFY_EMAIL` | Optional email recipient. |
| `LUC_SWEEP_STATE`, `LUC_LAST_SWEEP` | When the last Live URL sweep finished. |
| `luc_chtr_date_after` | Where the CHTR date recheck stopped. |
| `wb_applied_0`, `wb_applied_1`, … | Write-back's record of applied reviews. |
| `candidatePipelineState` and other `candidatePipeline…`, `sitemap…`, `xs_…` keys | Discovery progress. It resets itself at the start of each round. |
| `sp_…`, `hdl_…` | Search probe and hazing-death progress. |

**If the project is ever copied or moved again:**

1. **Script Properties do not copy.** Re-enter `AIRTABLE_PAT`, `APIFY_TOKEN`, `NOTIFY_EMAIL` and the two `LUC_*` keys. Copy the `wb_applied_*` keys, or run **`wbMarkAllApplied`** once before any real write-back run.
2. **Triggers don't copy.** Add them again from section 4. Run `installPipelineSchedule` for discovery.
3. **Don't copy an old `candidatePipelineState`** that says "running". It would try to resume a stale round.
4. **Leave the old copy without triggers.**
5. **The first run in a new copy asks for permission.** Choose the account, then **Advanced → Go to … (unsafe) → Allow**. This is normal for an unpublished script.
6. **The web app page, if anyone uses it:** Deploy → New deployment → Web app, with **Execute as: Me** and **Who has access: Only myself**. Archive the old deployment. (Before 2026-09-26 it was open to anyone with the link.)

---

## 7. Checking that it's working

- **Executions** (left sidebar) lists every run and whether it completed. Triggered runs never appear in the editor's log.
- `pipelineStatus` shows discovery's state, and `lucStatus` shows Live URL Checks'. `hdlStatus` shows hazing-death sources. `spStatus` shows the search probe.
- Dry runs write nothing: `wbDryRun`, `promoteDryRun`, `hdlDryRun10`.

---

## 8. Traps

- **Pasting:** click into the file, press Cmd+A, then Delete, then paste. Without the select-all, the paste *inserts*. All files share one global scope, so a duplicated `const` breaks **the whole project**.
- **The Run dropdown decides what runs,** not where your cursor is. A function ending in `_` can't be run or used as a trigger.
- **The six-minute cap doesn't throw.** Anything after the cut is lost, which is why every pass writes as it goes.
- **Airtable single-selects:** writing a name that doesn't exist creates a new option silently. `null` clears a field; `''` doesn't.
- **Renaming an Airtable choice is safe. Deleting one strips it from every row.** Rename in both bases at the same sitting, because the below-standard vocabularies must match exactly.
- **Pre-filter drops and rejections are the blocklist.** Don't delete them.

---

## 9. Known gaps (2026-09-26)

- **Live URL Checks watches only the published fields.** Record-only pages (below standard) aren't watched. This is phase 2 of the target-state spec.
- **A Live URL Checks "Fixed - new URL" can publish a page nobody judged against the standard.** This is spec §9.2.
- **Write-back clears links but never below-standard reasons,** so a cleared school can keep reasons about a page that's gone.
- **Open Candidate URL skips:**
  - 220598 is Accept with a below-standard reason.
  - 175342 (Alcorn) needs an Ownership exception.
  - 199272 needs a `/viewform` link.
- The project's own design notes live in the HazingInfo Claude project: `target-state-spec` (plus its 2026-09-26 v3 update), `data-check-reference` and `apps-script-move-and-schedule`.
