# SCHEDULING.md

**What this is.** Everything known about running these passes on a schedule, and the failures
that knowledge was bought with. Written 2026-09-10.

**Read this before adding any trigger to this project.** Most of what follows was learned by
something breaking silently, which is the characteristic failure mode here: Apps Script's
limits do not raise errors you can catch, they end the execution.

---

## 1. Current state: nothing is scheduled

**No pass in this project runs on a schedule today.** Every one is started by a person from
the editor's Run dropdown or the web app. That is deliberate for now, not an oversight.

Three files nevertheless contain trigger-installing functions, left over from earlier work:

| File | Function | Status |
|---|---|---|
| `SitemapFinder.gs` | `installPipelineSchedule()`, `removeScheduledSitemapTrigger()` | present, not installed |
| `SiteCensus.gs` | `scInstallTrigger()`, `scDeleteTrigger()`, `scTriggerStatus()` | present, not installed |
| `archive/Scheduler.gs` | `installLivenessSchedule()`, `removeLivenessSchedule()` | **superseded — do not run** |

**The intended structural rule, not yet implemented: no file installs its own trigger. One
scheduler owns all of them.** Trigger-installing functions scattered across files mean nobody
can answer "what is scheduled?" without reading every file, and two files can install
overlapping triggers that fight for the same lock. Until that consolidation happens, treat the
functions above as inert and check the Triggers panel as the source of truth.

---

## 2. The six-minute cap, and why it is not an ordinary error

An Apps Script execution is killed at six minutes. **It does not throw.** No `catch` block
runs, no `finally` runs, no "write what I have so far" line at the bottom of the function is
ever reached. The execution simply stops and the log says *Exceeded maximum execution time*.

Three consequences, all of which have bitten this project:

**Anything held in memory when the cap fires is lost.** On 2026-09-10 the hazing-deaths link
checker wrote results in batches of ten. Every run died at the cap partway through a batch,
so every run threw away everything it had done. The status showed 154 rows due before and
after each run, for hours. **The fix is to write as you go** — see §4.

**A cleanup or unlock at the end of a function is not guaranteed to run.** Anything that must
happen for the next run to work correctly has to happen *before* the risky work, not after.

**A self-chaining sweep must schedule its successor BEFORE doing any work.** `Scheduler.gs`
got this right and the comment is worth preserving verbatim: scheduling the next slice after
the work means one timeout silently ends the sweep with no error and no email. Scheduling it
first means the worst a timeout costs is the in-flight batch and one wait.

---

## 3. Progress lives in the data, never in a cursor

**Do not use Airtable's `offset` pagination token as a resume point.** It expires, and an
expired token forces a restart from record 1. With a person watching that is annoying;
unattended it is a restart loop that runs all day and nobody notices.

Every pass here tracks progress in something durable instead:

| Pass | Resume marker | Where it lives |
|---|---|---|
| Hazing deaths link check | `link_last_checked` date per row | the record itself |
| Hazing deaths archive lookup | `HDL_PROP_ARCH_AFTER` (record id) | Script Properties |
| Cross-seed | `XS_PROP_AFTER` (UNITID watermark) | Script Properties |
| Search probe | `SP_PROP_AFTER` (UNITID watermark) | Script Properties |
| Sitemap discovery | the gate itself — a filled field leaves the queue | the data |
| Live URL checks | sweep state + per-row check date | Script Properties + the data |

**A watermark must name a place in a sort order, not a position in an array.** CrossSeed
originally stored an index into its target list. The list *shrinks while the run works* —
creating a candidate row removes that school from the list — so a slice that examined schools
0..N and created rows for k of them left the cursor at N, and on the next slice positions
N-k..N-1 had shifted behind it and were never examined. Nothing reported it; the log's
"cursor at N of TOTAL" was true about a list that no longer existed. It was replaced with
"resume after this UNITID", which survives the list changing underneath it.

---

## 4. Write as you go, not in batches

A row is durable only once it reaches Airtable. Batching writes trades durability for API
calls, and at these volumes that is the wrong trade: one extra PATCH per row costs about
210 ms, while one killed execution costs everything in the buffer.

**Rule: flush after each unit of work that a person would call "done".** For the link checker
that is one row; for discovery it is one school.

---

## 5. Budgets, headroom, and why `UrlFetchApp` sets the ceiling

Every pass takes a time budget and stops *starting* new work when it expires. Work already in
flight always finishes, so the real worst case is **budget + one whole unit of work**, and
that total must land under six minutes.

**`UrlFetchApp` cannot be given a timeout.** It does give up eventually — measured at
**~6 minutes** on 2026-09-10, when it threw `Exception: Timeout` on `washingtonpost.com` — but
that is *at* the execution cap, not before it, and no parameter shortens it. The throw is
therefore worthless: the execution is killed in the same moment the exception would have been
caught. `fetchAll` additionally retries internally on its own schedule. The duration of one
unit of work is genuinely not under our control; the only levers are a smaller budget and
smaller units.

Current settings:

| Pass | Budget | Headroom | Notes |
|---|---|---|---|
| Hazing deaths link check | 4.5 min | 1.5 min | ~15 s per row; a row is up to 1.7 URLs × up to 6 fetches |
| Search probe | 4.5 min | 1.5 min | one Apify run per school, run-and-wait |
| Cross-seed | 4.5 min | 1.5 min | |
| Live URL checks (scheduled slice, historical) | 1 min | | small on purpose — see `Scheduler.gs` |
| Live URL checks (manual slice, historical) | 30 s | | keeps the web UI feeling responsive |

**Headroom should be sized against what one killed unit costs, not against fear.** The link
checker ran a 2-minute budget with 4 minutes of headroom while it wrote in batches of ten —
sensible then, because a kill cost nine rows. Once it wrote per row, a kill cost one row, and
the 2-minute budget was simply wasting two-thirds of every execution. It was raised to 4.5
only after that was noticed, hours later. **When you change how much a failure costs, re-check
the budget in the same edit.**

---

## 6. Third-party services belong in their own pass

The link checker used to look up a Wayback snapshot for every URL inline, on the grounds that
the availability endpoint "answers in well under a second." It does not. archive.org routinely
takes tens of seconds and sometimes never answers, and with no timeout available those
lookups consumed entire executions. After several full-length runs only 14 of 276 URLs had a
snapshot recorded, and the link check — the thing anyone was waiting for — never finished.

**A slow, unreliable third party starves whatever shares an execution with it.** Archive
lookups now live in `hdlFindArchives()`, their own hand-run pass, where being slow costs only
that pass. Save Page Now submissions live in `hdlArchiveMissing()` for the same reason.

---

## 6a. One unresponsive host can stop everything — plan for it

The worst failure of 2026-09-10, and the one most likely to recur. A single row carried a
`washingtonpost.com` URL that accepted the connection and never replied. Because the execution
was killed before that row could be stamped, the row was first in the queue again on the next
run — and the next. **146 rows sat untouched across four consecutive six-minute runs**, with
nothing in the log but *Exceeded maximum execution time*. Every run looked busy and did
nothing.

Note what did *not* save it: writing per row, a 4.5-minute budget, 90 seconds of headroom, and
a lock all behaved exactly as designed. The queue still could not move, because **nothing in
the design made progress past a unit of work that never completes.**

Two defences, and a scheduled pass needs both:

**A host skip list** (`HDL_UNFETCHABLE_HOSTS`, `LUC_UNFETCHABLE_HOSTS`). A host on it is not
fetched at all and its URL is recorded as unverifiable. Precise, and it leaves the other URLs
on the same row still checked. Its limit is that it can only ever name hosts somebody already
diagnosed.

**Attempt counting**, the backstop behind it. Count the attempt *before* the work and write it
to Script Properties immediately — a property write commits at once and survives the kill,
which is the entire trick. After two killed runs, set the row aside with the reason recorded
and let the queue move. Report set-aside rows in the run summary; a silent give-up is how a
bad row becomes a quietly wrong number.

**Diagnosing a hanging host:** `diagnostics/FindPoison.gs` fetches URLs one at a time and logs
each as it completes, so the one it never logs is the culprit. Let it hit the cap — the
timeout *is* the measurement.

---

## 7. Locks

Any pass that writes takes `LockService.getScriptLock()` before working and releases it in a
`finally`. A second execution that cannot get the lock logs *"Another slice is already
running"* and exits without doing anything.

This makes a short trigger interval safe: a 5-minute trigger against a 4.5-minute budget will
occasionally overlap, and the overlapping run does nothing rather than double-processing.

**Caveat:** because a six-minute kill runs no `finally`, a lock can in principle outlive the
execution that took it. Apps Script expires locks on its own, but if runs start reporting
"already running" when nothing is running, that is the reason — wait it out rather than
adding retries.

---

## 8. Two Apps Script behaviours that waste an afternoon

**The Run dropdown runs the selected function, not the one your cursor is in.** Check the
dropdown before concluding a function is broken. The Executions panel in the left sidebar
lists the function name for every run and is the definitive record of what actually ran.

**A function whose name ends in `_` is private and cannot be selected** — not in the Run
dropdown and not in the trigger function picker. `hdlRunScheduled_` was written specifically
to be a trigger target and, with that underscore, could never be chosen. Use the public
equivalent (`hdlRun`), or drop the underscore when you next touch the file.

---

## 9. Test mode, worth copying

`Scheduler.gs` shrinks a sweep so the *scheduling machinery* can be exercised in minutes on 20
records instead of an hour on 1,500, via two Script Properties that are no-ops when unset:

- `TEST_MAX_RECORDS` — stop the sweep after this many records
- `TEST_SLICE_SECONDS` — shorten each slice, forcing the chain to hand off

A sweep run with either set is stamped `testMode: true` and its emails are prefixed `[TEST]`,
so a shrunken run can never be mistaken for a real one. **The sizing matters**: the budget is
checked *after* each batch, so a 1-second budget means exactly one batch per slice, and 60
records is three slices — two of them driven by chained triggers. A cap of 20 would fit in a
single execution and never exercise the chain at all, which is the entire point of the test.

It also carries a `testTriggerPlumbing()` step that proves triggers fire and mail sends under
this account, touching no Airtable data. Those are the two things most likely to be blocked by
a missing authorization and the two you cannot discover by pressing Run.

---

## 10. Notifications

Passes that find something email via `MailApp`, to `NOTIFY_EMAIL` in Script Properties or the
script owner if unset. **A mail failure must never take down a run that has already written
its findings** — the table is the record, the email is a convenience.

Notify on a *change into* a bad state, not on every sweep. A link dead last month and dead
this month is not news, and a checker that mails the same list every run stops being read.

Expect a burst on any first sweep: a trigger clearing a backlog will send one email per run
that finds something newly broken.

---

## 11. About `archive/Scheduler.gs`

**It does not work and must not be installed.** It calls `runLivenessSlice_`, `checkBatch_`,
`interpretResponse_` and other functions from `LinkChecker.gs`, which was replaced by
`LiveUrlChecks.gs` and deleted. Every function it depends on is gone.

**It is kept because the design is right and is the best worked example in the repo** of a
sweep that survives the six-minute cap: quarterly-via-monthly triggers with a month filter
(Apps Script has no quarterly trigger), self-chaining slices, the watchdog scheduled before
the work, data-resident progress, the run lock, error backoff with `MAX_CONSECUTIVE_ERRORS`,
a `MAX_SLICES_PER_SWEEP` backstop, abandoned-sweep detection after 12 hours, and the test
mode above.

When this project does get a real scheduler, start from this file's structure and repoint it
at the current passes. Do not start from scratch, and do not run it as it stands.
