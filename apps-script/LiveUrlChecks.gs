// =========================================================================
// LiveUrlChecks.gs -- per-URL liveness checking, written to PAGES
// =========================================================================
//
// WHAT THIS REPLACES. LinkChecker.gs checks three URLs per school and
// writes the results back onto the 50 States row in twenty-one fields --
// seven per category, triplicated. That shape has three costs the project
// has been paying for months:
//
//   1. Adding a fourth category means adding seven more fields and seven
//      more branches of near-identical code. The located_* fields made
//      that a live problem: two new categories would have been fourteen
//      new fields on a table that already carries them for three.
//   2. One Reviewer Determination per category means a reviewer looking
//      at a school sees three unrelated verdicts side by side, and a
//      filtered "everything needing review" view has to OR across three
//      sets of fields.
//   3. There is nowhere to record WHEN a particular URL was checked --
//      only one Link Last Checked for the whole row -- so a URL added
//      yesterday looks as freshly verified as one checked in March.
//
// The Live URL Checks table in PAGES turns the wide form into the long
// form: one row per (institution, tracked field). Category becomes data,
// not schema. One determination field, one notes field, one date, one
// status -- covering however many categories the vocabulary grows to.
// Adding a seventh category is a new option on a single-select.
//
// WHY THIS FILE IS SELF-CONTAINED. It carries its own LUC_ copies of the
// browser headers, the retry lists, the fetch helpers and the response
// interpreter rather than calling LinkChecker.gs's. That is deliberate,
// and the reason is not "avoid coupling" in the abstract: LinkChecker.gs
// is the file this one is written to retire. Depending on it would mean
// deleting it later breaks this, which is the opposite of the point.
// CheckChtrDates.gs and CheckFormUrls.gs are self-contained for the same
// reason and can stay that way.
//
// The one thing it does share is Apps Script's single global scope, so
// every constant and function here is prefixed LUC_ / luc. Duplicate
// const declarations across .gs files are a hard error at load time, and
// duplicate function names silently override -- one file's version wins
// and nothing tells you which.
//
// -------------------------------------------------------------------------
// WHICH ROWS EXIST, AND WHY BLANK URLS DO NOT GET ONE
// -------------------------------------------------------------------------
// lucReconcile() creates a row for an (institution, tracked field) pair
// only when that field currently holds a URL. 1,480 institutions times three
// tracked fields is 4,440 possible rows; 2,632 exist, so roughly 1,800 would
// be permanently empty -- carrying nothing a reviewer can act on and nothing
// the checker can fetch. The ratio was worse still at six tracked fields,
// which is when this rule was written.
//
// "This school has no Report Form" is a real and important fact, but it is
// already recorded where it belongs: as a blank compliance field on the
// institution, which is exactly what the published site reads as
// non-compliant. Restating it as a row here would be a second copy of a
// fact with no second source of truth.
//
// A row whose URL LATER goes blank is a different case entirely and is
// kept: the field held something, someone may have judged it, and the
// disappearance is itself a change worth seeing. Those rows get
// Link status = "No URL", and the determination clears like any other
// change to what the verdict was formed against.
//
// -------------------------------------------------------------------------
// HOW A DETERMINATION SURVIVES, AND WHEN IT DOES NOT
// -------------------------------------------------------------------------
// The problem this solves is the one the old checker solved with the
// Confirmed URL / Confirmed Status snapshot pair: a reviewer looks at a
// 403, decides the page is fine, and should not be shown that same 403
// again on every sweep for the rest of the year.
//
// A determination is formed against three things -- the URL, the HTTP
// status, and the page body. Each is snapshotted at the moment the human
// decides, by the "Snapshot URL + status when a determination is made"
// automation (wflPC5zF6hqFqeKjt). THIS SCRIPT NEVER WRITES THE SNAPSHOT
// FIELDS. It cannot: the snapshot has to capture what the reviewer saw,
// and the script does not know when that was. Writing them here would let
// a sweep silently re-baseline a verdict against a page the reviewer never
// looked at.
//
// THE PENDING_VERIFICATION SENTINEL WAS REMOVED ON 2026-08-27, and the
// reason is worth keeping because the sentinel was right for the system it
// was written for.
//
// In 50 States, "the reviewer supplied a replacement" meant they edited the
// compliance field DIRECTLY. The URL formula moved the instant they
// decided, so the snapshotted HTTP code had been measured against the OLD
// address while the snapshotted URL already held the NEW one. If the new
// URL answered with the same code -- 200 against 200, the common case --
// the pair matched, nothing cleared, and a verdict survived having never
// been tested against the page it now pointed at. The sentinel wrote the
// literal string PENDING_VERIFICATION as the status snapshot to guarantee
// a mismatch and force a real re-verification.
//
// That situation cannot arise here. A reviewer now types a replacement
// into Reviewer-proposed URL, which the URL formula does not read. The URL
// formula therefore does NOT move when they decide, so the URL snapshot
// and the status snapshot describe the same page and the pair is honest.
//
// Keeping the sentinel would have been actively destructive. It guarantees
// staleness on the next sweep, and lucClearIfStale_ clears the
// determination, the notes, the review date and -- on a URL change --
// Reviewer-proposed URL itself. Every sweep would therefore wipe exactly
// the rows where a human did the most work, and do it before the write-back
// that would have applied their fix has even been built.
//
// Re-verification is not lost, only moved to the correct moment. When the
// write-back script promotes Reviewer-proposed URL into the Institutions
// field, the URL formula changes, and the ordinary URL-mismatch test in
// lucClearIfStale_ clears the determination then -- against the page that
// is actually there. The sentinel only made that happen early, against a
// page nobody had fetched.
//
// The three signals are not interchangeable, which is why all three are
// kept:
//
//   URL      the only signal that fires when someone edits the compliance
//            field -- and now, the signal that fires when write-back
//            promotes a proposed replacement. Status and body may be
//            identical at the new address.
//   Status   the only signal available at all for the 401/403/5xx bucket,
//            where no body is ever read. In the August 2026 data that
//            bucket was 195 flags -- not a corner case.
//   Hash     the only signal when URL and status are both unchanged and
//            the page content has been rewritten underneath them, which is
//            precisely how a compliant CHTR page silently stops being one.
//
// URL or status changing CLEARS the determination: both are exact, and a
// changed one means the verdict was formed against something that is no
// longer there. A changed hash only RAISES A FLAG ("Page changed since
// review"). Normalised page text still moves for rotating banners, news
// blocks and random quotes, so clearing on it would throw away human work
// at a rate nobody has measured. Flag first; if the flag turns out to be
// reliable in practice, promoting it to a clear is a one-line change.
//
// WHAT CLEARS, AND WHAT DOES NOT. A review is one human's answer about one
// page. When the page moves or answers differently, the whole answer goes,
// not selected parts of it -- a reviewer opening a flagged row should find
// it empty and ready, not carrying one field's worth of last time's work.
//
//   Reviewer determination   clears on a URL or status change.
//   Reviewer notes           clears on a URL or status change. Added to
//                            this list 2026-08-28; see below.
//   Review date              clears on a URL or status change. The most
//                            misleading of the three if left: it sits next
//                            to a blank determination reading as "reviewed
//                            recently" when nobody has, and "Review age"
//                            measures a review that no longer exists.
//   Reviewer-proposed URL    clears ONLY on a URL change, never on a status
//                            change. A changed URL means the proposal was
//                            about an address that is no longer there, and
//                            is also exactly the case where write-back has
//                            just applied it. But status is the least
//                            reliable of the three signals -- WAFs answer
//                            403 one sweep and 200 the next -- and
//                            discarding a human's replacement URL because
//                            Cloudflare had a mood would throw away the
//                            most expensive thing a reviewer produces.
//
// STANDARDS WAS REMOVED FROM THIS FILE ENTIRELY ON 2026-08-28, one day
// after it was added to the clear list. Nothing about the clearing argument
// turned out to be wrong; the field itself left this table's scope.
//
// Live URL Checks now answers ONE question: is this link reachable, and if
// not, what replaced it. Whether the page behind a working link meets
// HazingInfo's checkmark standard is a separate judgment, on a different
// cadence, and is moving to the AI standards pass. Asking reviewers for both
// at once was the review bottleneck -- it is why Standards was decoupled
// from Review resolved on 2026-08-27, and removing it is the end of that
// same change rather than a new decision.
//
// THE READ LIST IS WHY THIS MATTERS MORE THAN A STRAY WRITE. LUC_READ_FIELDS
// is the fields[] array sent with every listRecords call. Naming a field
// that no longer exists makes Airtable answer 422, lucList_ throws on any
// non-200, and the slice dies before it fetches a single URL. Deleting the
// column in Airtable while this file still named it would not have degraded
// the sweep, it would have stopped it. Deploy this file BEFORE deleting the
// field.
//
// The 47 below-standard verdicts that existed when this was written are not
// discarded: they were exported before the field was removed, and they are
// the validation set for the AI pass that replaces them. Nothing in this
// file reads or writes them any more.
//
// NOTES WERE EXEMPT UNTIL 2026-08-28, and the reason they no longer are is
// worth recording, because the old reason looked strong. On 2026-08-23
// twenty-nine below-standard URLs were recovered out of reviewer notes and
// written into the located_* fields, which read as proof that notes hold
// irreplaceable findings. It was a first-run artefact: located_* did not
// exist yet, so notes were the only place those URLs could go. They have a
// proper home now, and notes carry no unique record -- so they clear with
// the rest of the review rather than sitting stale beside it.
//
// NOTHING SURVIVES A CLEAR, so lucClearIfStale_ logs every discarded field
// to the execution log. That log is the only remaining trace that a human
// verdict existed, and it is what answers "why is a row I reviewed back in
// the queue?"
//
// REVIEW DATE IS WRITTEN BY THE AUTOMATION, NOT BY THIS SCRIPT, for the
// same reason as the snapshots: only the automation fires at the moment a
// human decides. Before 2026-08-28 nothing wrote it at all -- the values
// in it were a one-time bulk set from the 08-23 pass -- so any review after
// that date left it blank and "Review age" had nothing to measure.
//
// TIME does not clear anything either. The "Review age" formula flags
// determinations older than twelve months so they can be re-looked at
// deliberately. Auto-clearing on age would dump hundreds of rows back into
// the queue on an arbitrary anniversary with no new information to justify
// re-asking, which is the exact cost this whole snapshot design exists to
// avoid.
// =========================================================================


// ---- Where everything lives ---------------------------------------------
const LUC_BASE_ID       = 'appEvOdPi94MzZ6Db';   // PAGES
const LUC_CHECKS_TABLE  = 'tblgX19rRaysxSlNu';   // Live URL Checks
const LUC_INST_TABLE    = 'tblpgBmu7r8kQA6b5';   // Institutions (synced from 50 States)

// ---- Live URL Checks fields ---------------------------------------------
const LUC_F_UNITID       = 'fldGOVUMJzFHLoeel';
const LUC_F_INSTITUTION  = 'fldYW3m4G4NqzMb6b';  // link -> Institutions
const LUC_F_TRACKED      = 'fldyJWzzbTwWPI141';  // single select
const LUC_F_URL          = 'fldJQVVn8G9xw004a';  // formula, read-only
const LUC_F_STATUS       = 'fldxZG1KeYOYJqXlW';
const LUC_F_CODE         = 'fldU8cGgeZwFa7Muu';
const LUC_F_REDIRECT     = 'fldqMVflVfvdpzdRw';
const LUC_F_LAST_CHECKED = 'fldgsBLdEw5YHuzMk';
const LUC_F_HASH         = 'fldixWKjidD1eEfPC';

// Renamed in Airtable on 2026-08-28: "Last updated date found" -> "CHTR last
// updated date", "Date check result" -> "CHTR date check result". Nothing
// broke, because every reference in this file is by field ID -- which is
// exactly the reason lucBuildDueFormula_ uses IDs in filterByFormula too.
// Only the constant names changed here, to keep the code readable against
// the base.
const LUC_F_CHTR_LAST_UPDATED = 'fldfFB8XvOTuISf5p';
const LUC_F_CHTR_DATE_RESULT  = 'fld6BX7MLCOLbCK9R';

// Human columns. The script reads them to decide a clear and writes them
// only ever to empty. Which ones clear, and on which signal, is the
// "WHAT CLEARS, AND WHAT DOES NOT" section of the header.
const LUC_F_DETERMINATION = 'fld2QJ1NPuP2hvHzx';
// LUC_F_STANDARDS ('fldhkfZwKWy3zx79n') was removed 2026-08-28 along with
// every read and write of it. See the header. The id is recorded here and
// nowhere else, so a future restore has something to start from.
const LUC_F_PROPOSED_URL  = 'fld4T5J23Tqm2rj9m';  // url
const LUC_F_NOTES         = 'fldUWo0jlZFkRw2Yl';  // long text
const LUC_F_REVIEW_DATE   = 'flddBv57mYSa4jIcM';  // date, written by wflPC5zF6hqFqeKjt
const LUC_F_SNAP_URL      = 'fldVmX5yeRqTZuqDX';
const LUC_F_SNAP_STATUS   = 'fldjle8wd4pEcRpzv';
const LUC_F_SNAP_HASH     = 'fldcxODB0EsN4pvOg';

// ---- Institutions fields (synced -- read only, never written) -----------
const LUC_I_UNITID = 'fldGREvzCIme6HXfl';
const LUC_I_NAME   = 'fldHvefXrrPxibBsZ';

/**
 * THE CATALOG. Every tracked field, the Institutions column it reads, and
 * whether the CHTR "last updated" date check applies.
 *
 * `name` must match the Live URL Checks single-select option EXACTLY. The
 * script does not pass typecast, so Airtable rejects the whole write batch
 * for an option it does not have -- nine good rows lost with the bad one.
 *
 * `check: false` would keep a category in the vocabulary (so rows, notes
 * and determinations keep a home) while leaving it out of the liveness
 * sweep. Nothing uses it today -- all three live categories are on -- but
 * the flag and its guards are kept, because the way to retire a category
 * safely is to switch it off here first and delete it later, never the
 * other way round.
 *
 * THIS ARRAY WAS REVERSED ON 2026-08-28, LATER THE SAME DAY. The three
 * compliance categories had been retired that morning in favour of the
 * located_* fields, on the reasoning that a compliance field holds either
 * the same URL as its located_* counterpart or nothing, so a liveness check
 * on it could learn nothing new.
 *
 * That reasoning was sound and answered the wrong question. It asked what
 * the CHECKER learns. The binding cost is what a REVIEWER spends, and a
 * reviewer working a located_* row whose compliance sibling is blank is
 * checking a URL the site does not publish. Measured against live data:
 * 71 of 2,612 rows were in exactly that state -- 11 policy, 40 CHTR, 20
 * report form -- residue from the era when a "Below standard" verdict wrote
 * located_* and cleared the sibling.
 *
 * The reverse direction was smaller and worse: 7 URLs across 3 institutions
 * (207306, 207847, 188304) sat in compliance fields with a blank located_*,
 * so they were PUBLISHED AND NEVER CHECKED -- lucReconcile_ only creates a
 * row where the tracked field holds a URL. Those three were corrected by
 * hand before this change; tracking the published field is what stops the
 * class of problem rather than the instance.
 *
 * So: check what is published. The located_* fields remain the research
 * record and the write-back target, and nothing checks them any more.
 *
 * `dateCheck` marks the categories where the CHTR "last updated" read
 * applies. Only Transparency Report qualifies: a hazing policy page and a
 * report form have no freshness standard to test.
 *
 * NOTE FOR THE FRESHNESS FINDING: this now reads 841 published CHTRs, not
 * the 885 chtr_index_url pages the "only 25% publish a date" measurement was
 * taken across on 2026-08-28. The ~44 difference is CHTRs that were found
 * but are not published. Re-derive the ratio on 841 before quoting it.
 *
 * THIS ARRAY IS THE ONLY PLACE THAT DECIDES WHICH CATEGORIES ARE LIVE.
 * lucReconcile_ gates row creation on `check`, and lucBuildDueFormula_ and
 * lucTopUpNewRows_ both filter on it via lucCheckedTrackedNames_. Adding a
 * category is a new option on the select plus a line here; nothing else
 * needs to change.
 */
const LUC_TRACKED = [
  { name: 'Transparency Report', instField: 'fldGJPC0iyuPcWtlK', check: true, dateCheck: true  },
  { name: 'Hazing Policy',       instField: 'fldD9gEpDcw2l35II', check: true, dateCheck: false },
  { name: 'Report Form',         instField: 'fldIrTzWzi87nD7EU', check: true, dateCheck: false }
];

// THE located_* ENTRIES WERE REMOVED FROM THIS ARRAY ON 2026-08-28, after
// their 2,702 rows were deleted and the table settled at 2,632 -- one row per
// published URL, verified against the compliance fields at 841 / 1,148 / 643.
//
// Rows first, entries second, and that ordering is a habit rather than a
// hazard. An earlier version of this comment claimed removing an entry while
// its rows survived would let them loop forever in the due set. That is
// wrong: lucCheckedClause_ builds an ALLOWLIST of checked names, so a row in
// a category the array has never heard of fails to match and is excluded
// either way. What the ordering actually buys is lucReconcile_'s orphan
// count, which iterates this array and stops seeing a category the moment it
// leaves. Worth keeping, worth not overstating.

function lucTrackedByName_(name) {
  for (let i = 0; i < LUC_TRACKED.length; i++) {
    if (LUC_TRACKED[i].name === name) return LUC_TRACKED[i];
  }
  return null;
}

/**
 * Names of tracked fields whose `check` flag is on -- the single source of
 * truth for "which categories does the liveness sweep actually fetch."
 *
 * Added 2026-08-27 alongside turning three categories off. Before this,
 * `check: false` only stopped lucCheckBatch_ from processing a row AFTER
 * it was already pulled into a fetch batch -- the due-query itself had no
 * idea the flag existed. See lucCheckedClause_ for why that was a real bug
 * waiting to happen, not just an inefficiency. Every category is on today,
 * so this currently returns all three; it is kept for the next time one is
 * switched off.
 */
function lucCheckedTrackedNames_() {
  return LUC_TRACKED.filter(function (t) { return t.check; })
    .map(function (t) { return t.name; });
}

/**
 * An Airtable formula clause matching only rows whose Tracked field is one
 * of the checked categories. AND this into any query that decides what is
 * "due" or "never checked."
 *
 * Why this has to exist: a check:false row's Last Checked can never get
 * stamped, because lucCheckBatch_ skips it before writing. Without this
 * clause, once such a row's Last Checked ages past a sweep's cutoff (or
 * forever, for a row created after check went false), it would come back
 * "due" on every single fetch, get skipped again, and never leave the due
 * set. lucRunSlice_'s stall guard would eventually park it as "stuck" --
 * but located_hazing_policy_url alone was roughly 1,147 rows when it was
 * tracked, ten times LUC_MAX_STUCK_ROWS, so the sweep would have thrown and
 * stopped outright long before it finished parking them all.
 *
 * Every category is check:true today, so the clause matches everything the
 * table legitimately holds. It is not dead weight even so: it still
 * excludes rows whose Tracked field is blank or holds a value no longer in
 * the catalog, which is precisely what a deleted select option leaves
 * behind if one is ever removed before its rows are.
 */
function lucCheckedClause_() {
  const names = lucCheckedTrackedNames_();
  return 'OR(' + names.map(function (n) {
    return '{' + LUC_F_TRACKED + '} = "' + n + '"';
  }).join(', ') + ')';
}

// ---- Sizes and budgets --------------------------------------------------
// One row is one URL, where a LinkChecker record was up to three, so 30
// rows per wave keeps the fetch wave the same size it has always been.
// Bigger waves are what put a scheduled slice over the six-minute cap on
// 2026-08-20; UrlFetchApp has no timeout parameter, so a slow site blocks
// for as long as it likes and small waves are the only real defence.
const LUC_ROWS_PER_FETCH = 30;

// =========================================================================
// KNOWN-UNFETCHABLE HOSTS
// =========================================================================
/**
 * Hosts this checker can never reach, listed so their URLs are never sent.
 *
 * THESE ARE NOT BROKEN LINKS. Every page below loads normally in a browser.
 * What they have in common is a network-level block on Google's IP ranges,
 * which is a different failure from the 403s LUC_USER_AGENT was written
 * for: a WAF answering 403 lets the connection complete, so a
 * browser-shaped request can talk it round. These never complete at all --
 * UrlFetchApp neither answers nor refuses, it hangs until something kills
 * it, and no header we send can change that.
 *
 * WHAT ONE COSTS UNLISTED. A hanging URL fails alone in 51 to 200 seconds.
 * Inside a wave of thirty it is far worse: fetchAll throws for the whole
 * wave, lucFetchAllSafe_ bisects to find the culprit, and a bisect that
 * runs out of budget marks EVERY request in the group "Bisect abandoned" --
 * pages that were never tried, sitting in the review queue asserting
 * nothing was established. The 2026-09-01 sweep produced 60 such rows from
 * five bad hosts, 46 of them with no determination. That is roughly three
 * innocent rows queued, and a slice's whole budget spent, per bad host per
 * sweep.
 *
 * MATCHING IS HOST-SUFFIX. An entry matches that exact host and anything
 * under it, so "usu.edu" covers www.usu.edu -- correct there, because Utah
 * State threw on two unrelated paths on two different subdomains. List the
 * narrowest host that covers the failures actually seen: "hazing.uci.edu",
 * not "uci.edu", because the rest of uci.edu has never failed.
 *
 * ADDING TO THIS LIST IS A CLAIM, AND IT SHOULD BE EARNED. Confirm two
 * things first: findPoison() shows the URL throwing on a lone fetch, and a
 * person has opened it in a browser and seen a real page. A host listed on
 * a guess silently stops being checked, which is the failure this file
 * works hardest everywhere else to avoid.
 *
 * WHAT HAPPENS TO A LISTED ROW. It is stamped Unconfirmed with the code
 * "Known unfetchable" and nothing else is touched -- no fetch, no hash
 * change, and no staleness clear, because we chose not to look rather than
 * looked and failed. A reviewer marking such a row "Working as-is" settles
 * it for good: lucStatusClass_ counts Unconfirmed and Unreachable alike as
 * 'present', so the verdict never goes stale and the row never returns.
 *
 * RE-TEST OCCASIONALLY. A block can be lifted, and nothing here will
 * notice. Paste the list into findPoison() every few sweeps; anything that
 * now answers should come off.
 *
 * Seeded 2026-09-01 from that sweep -- 7 rows across 5 schools, all five
 * confirmed by findPoison() and all five opened in a browser.
 */
const LUC_UNFETCHABLE_HOSTS = [
  'hazing.uci.edu',                 // UC Irvine        110653  Hazing Policy
  'hazing.ucsc.edu',                // UC Santa Cruz    110714  Hazing Policy + Transparency Report
  'unlreport.unl.edu',              // Nebraska         181464  Report Form
  'usu.edu',                        // Utah State       230728  Transparency Report + Hazing Policy
  'osccr.sites.northeastern.edu'    // Northeastern     167358  Hazing Policy
];

/** The host part of a URL, lowercased, or '' if it cannot be read. */
function lucHostOf_(url) {
  const m = /^https?:\/\/([^\/?#:]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Is this URL on a host we already know we cannot reach? */
function lucIsKnownUnfetchable_(url) {
  const host = lucHostOf_(url);
  if (!host) return false;
  for (let i = 0; i < LUC_UNFETCHABLE_HOSTS.length; i++) {
    const h = String(LUC_UNFETCHABLE_HOSTS[i]).toLowerCase();
    if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
  }
  return false;
}
const LUC_CHECK_BATCH    = 30;
const LUC_WRITE_BATCH    = 10;   // Airtable's hard cap per PATCH/POST
const LUC_CREATE_BATCH   = 10;

const LUC_SLICE_BUDGET_MANUAL_MS    = 240000;  // 4 min of a 6 min cap
const LUC_SLICE_BUDGET_SCHEDULED_MS = 180000;  // 3 min, leaves room for a slow tail
const LUC_MAX_STUCK_ROWS = 50;

const LUC_STATE_KEY = 'LUC_SWEEP_STATE';
const LUC_LAST_SWEEP_KEY = 'LUC_LAST_SWEEP';

/**
 * HOW OFTEN A NEW SWEEP MAY OPEN ITSELF. This is the check cadence, and it
 * is the ONLY place it is expressed.
 *
 * It exists because of a real failure on 2026-08-23. lucRunSlice_ used to
 * start a fresh sweep whenever the stored status was not 'running', so the
 * one extra lucCheckSlice() run after a sweep reported complete silently
 * opened a second sweep, found nothing due, closed it, and overwrote the
 * finished sweep's counters with zeroes.
 *
 * Harmless by hand. Not harmless on a trigger: lucCheckSliceScheduled()
 * would have opened a brand-new sweep on its first firing every day and
 * re-fetched all 3,546 URLs daily, forever, consuming the whole 90-minute
 * trigger budget for no new information.
 *
 * 90 days is a placeholder for the open cadence question -- Jolayne wants
 * quarterly, biweekly was the counter-proposal. Whatever is settled, it is
 * this one number, not an emergent side effect of when someone last
 * pressed a button.
 */
const LUC_MIN_SWEEP_INTERVAL_DAYS = 90;

/**
 * WHETHER A SWEEP MAY CLEAR A HUMAN REVIEW. Switched back ON 2026-08-28,
 * after the first full sweep measured what it actually costs.
 *
 * IT WAS OFF FOR ONE SWEEP, DELIBERATELY, and the reason it is on again is
 * a measurement rather than a change of mind.
 *
 * WRITE-BACK SHIPPED LATER ON 2026-08-28 (WriteBack.gs), which changes this
 * argument without overturning it. When it was written, a reviewer's
 * replacement URL existed nowhere but this table, so a clear destroyed the
 * only copy. Now an applied proposal lives in 50 States, where the site
 * reads it -- so for those rows a clear costs the determination and the
 * notes, not the finding.
 *
 * It costs MORE for a row whose proposal has not been applied yet. Those are
 * still single-copy, and they are the expensive ones: a Reviewer-proposed
 * URL is the most costly thing a human produces here. Run write-back before
 * a sweep, not after, and the exposure is close to nil.
 *
 * The fear was spurious clears. On 2026-08-28, 102 of the 189 reviewed rows
 * were sitting on Unconfirmed or Site error -- the 401/403/5xx bucket this
 * file's own header describes as unreliable, where WAFs answer 403 on one
 * sweep and 200 on the next. Under an exact-code comparison, more than half
 * the reviewed rows could have been wiped by a sweep that learned nothing.
 *
 * THE FULL SWEEP OF 2,612 ROWS PRODUCED FIVE CLEARS. Every one was real:
 * three URL changes in 50 States, and two genuine dead-to-alive crossings
 * (a 404 that came back as 200, and a 404 that came back as 302). Not one
 * came from status flapping. That is what lucStatusClass_ was built to do,
 * and the number says it works: roughly 0.2% of rows, all of them things a
 * reviewer would want to look at again.
 *
 * Leaving it off had its own cost, which is why it is not the safe default
 * it looks like. Those five rows were asserting things that are no longer
 * true -- one read 'Confirmed broken - no replacement found' against a URL
 * that now exists. A base that preserves a stale verdict is worse than one
 * that admits a row needs another look, particularly for a project whose
 * product is transparency.
 *
 * SET THIS TO false AGAIN to re-enter dry-run mode: staleness is still
 * detected and logged as 'WOULD CLEAR', every machine-written field still
 * refreshes, and only the five human fields are left alone. That is the
 * mode to use before any change to lucStatusClass_ or lucClearIfStale_,
 * because it measures the blast radius without paying for it.
 *
 * A FULL BACKUP OF ALL 275 REVIEWS WAS TAKEN BEFORE THIS WAS SWITCHED ON
 * (LiveUrlChecks_reviews_backup_2026-08-28_post-sweep.csv), including the
 * 33 rows carrying a Reviewer-proposed URL, which are the most expensive
 * thing in the table and the least recoverable. Take a fresh one before any
 * sweep that follows a change to the clearing rules.
 */
const LUC_CLEAR_STALE_REVIEWS = true;

// ---- Identifying ourselves ----------------------------------------------
// UrlFetchApp's default User-Agent says Google, and university WAFs
// (Cloudflare, Imperva) answer it with a 403. In the August 2026 review
// data that was 118 of 195 "Needs Review" flags, of which exactly one was
// a genuinely dead link -- false alarms at roughly 99:1, and it blinded
// the date check on ~49 pages it could otherwise have read.
//
// Browser-shaped so those WAFs answer, with a product token and contact
// URL on the end so any admin reading their logs can see who this is.
// Appending a product token like this is well-formed per RFC 7231.
//
// This reads public pages at a few requests per second. It does not, and
// must not, be used to get past logins, paywalls, or anything not already
// public.
const LUC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 ' +
  'HazingInfoLinkChecker/1.0 (+https://hazinginfo.org)';

const LUC_BROWSER_HEADERS = {
  'User-Agent': LUC_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// A second attempt, for codes where the first one plausibly failed for a
// reason that will not repeat: timeouts, rate limits and 5xx.
//
// THERE IS NO HEAD RETRY, AND THERE NEVER WAS ONE THAT WORKED. Until
// 2026-08-28 this file carried LUC_RETRY_WITH_HEAD_CODES = ['403', '405']
// and re-requested those with method 'head'. Apps Script's UrlFetchApp
// does not support HEAD -- its methods are get, delete, patch, post and
// put -- so every one of those retries threw
// "Attribute provided with invalid value: method". The throw was caught by
// lucFetchAllSafe_, which could not tell a bad method from a bad URL and
// bisected the whole wave looking for a culprit that did not exist. Three
// 403s in a 30-row sample were enough to trigger it.
//
// So the documented "retry a 403 with HEAD" behaviour never happened. What
// happened instead was a silent tax on every wave containing a 403, which
// in this data is most of them: the 401/403/5xx bucket was 195 flags in the
// August 2026 review.
//
// 403 AND 405 NOW GET NO RETRY, which is the honest version of what the
// code was already doing, minus the wasted work. A 403 answered to a
// browser-shaped User-Agent is a considered refusal, and re-sending an
// identical GET would only ask the same question twice. Those rows land on
// Unconfirmed and go to a reviewer, which is where they were landing
// anyway.
const LUC_RETRY_WITH_GET_CODES  = ['408', '425', '429', '500', '502', '503', '504'];
const LUC_RETRY_PAUSE_MS = 1000;

// UrlFetchApp accepts only these. Guarded in lucRequest_ so a future edit
// cannot reintroduce the HEAD bug: an unsupported value throws for the
// entire fetchAll wave, not just its own request, and the resulting bisect
// hides the cause behind a URL that is perfectly fine.
const LUC_VALID_FETCH_METHODS = ['get', 'delete', 'patch', 'post', 'put'];

// -------------------------------------------------------------------------
// LOGIN WALLS THAT ANSWER 200 -- added 2026-08-28
// -------------------------------------------------------------------------
// lucInterpret_ derived every status from the HTTP code alone, so the only
// login wall it could ever see was a 401. Measured against the five known
// login cases in the base on 2026-08-28, that caught two and missed three:
//
//   102270  Google Form, restricted     401  ->  Login required   correct
//   168342  Google Form, restricted     401  ->  Login required   correct
//   219277  SharePoint -> Microsoft     302  ->  Redirected       missed
//   110574  Shibboleth SAML2            ---  ->  Site error       missed
//   130226  Maxient sign-in page        200  ->  Unconfirmed      missed
//
// The pattern is not random. Google refuses a restricted form with a real
// 4xx. Shibboleth, ADFS, Microsoft and Maxient do the opposite: they SERVE a
// login page, successfully, with 200 -- or bounce to one with a 302. The
// wall is in the body and the address, never in the status line, so no
// amount of code-mapping can reach it.
//
// This matters more now than it did a week ago. With Standards gone, Link
// status IS the answer to "does this link work", and a hazing reporting form
// behind an SSO wall is the single failure a parent is most likely to hit.
// Recording it as Live is not a cosmetic mislabel.
//
// THREE SIGNALS, DELIBERATELY UNEQUAL. The first two are conclusive; the
// third is the one that could over-fire, so it is fenced.
//
//   1. The redirect target, or the requested URL itself, matches a known
//      identity-provider shape. A URL containing /idp/profile/ or
//      /Shibboleth.sso/ or login.microsoftonline.com is not a hazing policy
//      page under any circumstances. No body read needed, and it fires even
//      when the fetch threw -- which is what 110574 needs.
//
//   2. The body carries a SAMLRequest/SAMLResponse field or a form posting
//      to an IdP path. Those appear only on SSO bounce pages.
//
//   3. A password input on a SHORT page. The length fence is the whole
//      point: hundreds of legitimate campus pages carry a portal login box
//      in the header, and matching a bare password field would have marked
//      every one of them Login required and dumped them into the review
//      queue. A real policy page or reporting form runs to thousands of
//      characters of visible text; a bare sign-in page does not. If this
//      still over-fires in practice, raise the bar or drop signal 3 --
//      1 and 2 stand on their own.
//
// MEASURED AGAINST THE NINE KNOWN CASES ON 2026-08-28. Five walls, four
// controls. Result: 6 OK, 3 MISMATCH -- and all three were informative.
//
//   * 110574's SSO URL answered 500 and was never examined. Fixed by the
//     gate change in lucInterpret_ (see there).
//   * 219277's SharePoint link redirects within SharePoint before reaching
//     Microsoft. Fixed by the _layouts pattern above.
//   * The "control" that was supposed to be an open Maxient form,
//     cm.maxient.com/reportingform.php?CSUEastBay&layout_id=2, turned out to
//     303 straight to Shibboleth. The detector was right and the test's
//     expectation was wrong -- the reviewer's replacement for an SSO wall
//     was a different route to the same wall, and it had already been
//     published to the live site. That single line is what this whole
//     feature is for.
//
// Signal 3 fired on nothing in a 30-row live sample (24 of them Live), so
// the length fence is holding. Keep reading the log lines before tuning it.
//
// EVERY DETECTION IS LOGGED WITH WHICH SIGNAL FIRED, so one sweep's log
// answers whether signal 3 is earning its place before anyone tunes it.
//
// THIS CANNOT CLEAR A REVIEW. lucStatusClass_ reads the HTTP CODE, not this
// label, and an SSO page answering 200 or 302 is 'present' either way. A row
// that flips from Live to Login required raises no staleness and wipes no
// human work -- see lucStatusClass_ for why that separation exists.
//
// Two consequences fall out of it, both wanted. The content hash is only
// taken on Live, so a login page can no longer overwrite the stored hash of
// the real page and fire a spurious "Page changed since review". And a CHTR
// behind a wall now records "Unable to check" rather than "Date not found on
// page" -- the honest answer, since nobody read the page.
//
// Set LUC_DETECT_LOGIN_WALLS to false to restore the pure code-based
// behaviour without removing any of this.
// -------------------------------------------------------------------------

const LUC_DETECT_LOGIN_WALLS = true;

// Visible-text length at or below which a password input is taken as
// evidence the page IS the login, rather than merely carrying one.
const LUC_LOGIN_MAX_PAGE_CHARS = 4000;

// Identity-provider shapes. Matched against the redirect target first, then
// the requested URL. The last entry -- a bare /login or /signin path
// SEGMENT -- is the loosest and the first thing to drop if this over-fires;
// the boundary requirement is what stops it matching /student-login-help.
const LUC_LOGIN_URL_PATTERNS = [
  /\/idp\/profile\//i,
  /\/idp\/[^\/]*sso/i,
  /SAML2\/(?:Redirect|POST|SSO|Unsolicited)/i,
  /\/Shibboleth\.sso\//i,
  /\/samlsso(?:[\/?#]|$)/i,
  /\/adfs\/ls(?:[\/?#]|$)/i,
  /login\.microsoftonline\.com/i,
  /\/cas\/login(?:[\/?#]|$)/i,
  /accounts\.google\.com\/(?:ServiceLogin|signin|AccountChooser)/i,
  /\.okta(?:preview)?\.com\//i,
  /\.auth0\.com\//i,
  /\/oauth2?\/authorize(?:[\/?#]|$)/i,
  // SharePoint's application path. Added 2026-08-28 after 219277 slipped
  // through: its first-hop redirect goes to
  // sharepoint.com/sites/.../_layouts/15/Doc.aspx, and the Microsoft login
  // is only on the SECOND hop, which followRedirects:false never sees.
  // Anonymous sharing links also land on _layouts/15/Doc.aspx, so this can
  // flag a genuinely public SharePoint document -- the cost is one review,
  // and SharePoint-hosted policies are rare enough (1 in 2,612 here) that
  // the trade is worth it. Drop this line first if that stops being true.
  /\/_layouts\/1?5?\//i,
  /\/(?:login|signin|sign-in|sign_in)(?:[\/?#]|$)/i
];

// Body markers that only ever appear on an SSO bounce page. No /g flag on
// any of these: a global regex carries lastIndex between .test() calls and
// would skip every second page.
const LUC_LOGIN_BODY_PATTERNS = [
  /name\s*=\s*["']?SAMLRequest["']?/i,
  /name\s*=\s*["']?SAMLResponse["']?/i,
  /<form[^>]+action\s*=\s*["'][^"']*\/(?:idp|adfs|cas|samlsso)\//i
];

const LUC_LOGIN_PASSWORD_INPUT = /<input[^>]+type\s*=\s*["']?password\b/i;

// -------------------------------------------------------------------------
// DATE EXTRACTION -- rewritten 2026-08-28
// -------------------------------------------------------------------------
// The standard is an EXPLICIT last-updated date: a specific day. A season
// ("updated Fall 2025"), a month and year alone ("updated October 2025"),
// an academic year, or the period the incidents cover do not qualify. Every
// pattern below therefore requires day, month and year. Nothing else can
// match, which is the point.
//
// WHAT THE PREVIOUS VERSION DID, measured against the live base on
// 2026-08-28 across all 226 rows then marked "Date found":
//
//   It accepted `[A-Za-z]+\s+\d{4}` as a date. That is any word followed by
//   four digits, so "Fall 2025" matched -- and new Date("Fall 2025") does
//   not fail. V8 discards the word it cannot read and keeps the year,
//   returning 1 January 2025. Sixteen rows sat on 01-01, and a seasonal
//   page was being recorded as a hard January date roughly nine months
//   EARLIER than the page actually meant. Under a twelve-month freshness
//   window that turns a fresh page stale.
//
//   The same pattern matched page furniture. Five rows carried impossible
//   years -- four Ohio institutions on 2903 and one on 3345 -- from a room
//   number or extension sitting after the word "updated".
//
//   Fifty-four of 226 landed on the first of some month, i.e. were month
//   precision at best while being stored as a specific day.
//
//   And .match() returns only the FIRST hit, so "Updated Fall 2025" earlier
//   in the page silently shadowed a real "Last updated: October 5, 2025"
//   further down.
//
// FOUR CHANGES FOLLOW FROM THAT:
//
//   1. Month names are an explicit alternation, never [A-Za-z]+. A season
//      is not a month, so it cannot match at all rather than matching and
//      being silently coerced.
//   2. Dates are built from captured parts with Date.UTC and verified to
//      round-trip. new Date(string) is never used on page text again --
//      its leniency is what produced every bad row above. This also
//      rejects impossible calendar days like 31 February.
//   3. The year must be between 2000 and next year. 2903 and 3345 die here
//      even if some future pattern lets them through.
//   4. ALL matches are scanned, not the first, and the most recent valid
//      date wins. A stale coverage date or a leftover notice can no longer
//      hide a real one.
//
// A LABEL IS STILL REQUIRED. A bare date somewhere on the page is not
// evidence of anything -- it could be an event, a news item, a copyright
// line. If the audit of the "Date not found on page" rows shows unlabeled
// dates appearing in a consistent position worth trusting, that is a
// deliberate addition to make then, with evidence.
//
// NUMERIC DATES ARE READ AS US MONTH/DAY/YEAR. Every institution in this
// base is a US college. A day-first reading would silently swap the two on
// the ~40% of numeric dates where the day is 12 or lower.
// -------------------------------------------------------------------------

const LUC_MONTH_NUMBERS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

// -------------------------------------------------------------------------
// TWO LABEL TIERS, because a CHTR index page is mostly incident content
// -------------------------------------------------------------------------
// A CHTR page is a page-update statement wrapped around a table of
// incidents, and incident rows carry dates of their own -- occurrence,
// notice, investigation start and end, sanction. Scanning the whole page
// for "a label followed by a date" can therefore pick up an incident date
// and record it as the page's last-updated date. Taking the most recent
// match makes that worse, not better: a recent incident outranks an older
// but correct page statement.
//
// The 26 verbatim strings hand-coded in CHTR Field Analysis / Review
// (field: Verbatim "Last Updated" text) settle which labels are actually
// needed. Every real statement in that sample uses a form of "updated",
// "last review", or "published". NONE uses "effective date", "as of",
// "current as of", "revised", "date posted" or "revision date" -- and
// those are exactly the phrasings most likely to head an incident row
// ("sanction effective date", "chapter status as of"). They are dropped:
// they buy nothing on real pages and cost false matches on every one.
//
// TIER 1 is unambiguous about the page or report itself. A match here is
// trusted outright.
//
// TIER 2 is the bare verbs. Six of the twenty real statements in the
// sample are a bare "Updated <date>", so tier 2 cannot be dropped -- but
// "status updated" and "sanction revised" live in incident rows using the
// same words. Tier 2 is therefore only consulted when tier 1 found
// nothing, AND it must be UNANIMOUS: if two different dates both match a
// tier-2 label, the page is showing a table rather than a statement, and
// nothing is recorded. A genuine page-update statement appears once.
// -------------------------------------------------------------------------

const LUC_DATE_LABEL_TIER1 =
  '(?:this\\s+page\\s+was\\s+last\\s+updated|page\\s+last\\s+updated|' +
  'report\\s+last\\s+updated|last\\s+updated|last\\s+modified|' +
  'last\\s+review(?:ed)?|page\\s+updated|information\\s+updated|' +
  'updated\\s+on|modified\\s+on|reviewed\\s+on|date\\s+posted|' +
  'date\\s+published|posted\\s+on|published\\s+on)';

// "AS OF" WAS ADDED HERE, NOT TO TIER 1 (2026-09-01).
//
// It earned its place: in a 23-page audit of rows reading "Date not found
// on page", four carried an explicit labelled day-exact date and THREE of
// the four used this exact wording -- "As of September 1, 2026, there are
// no adjudications, convictions or incidents of hazing to report"
// (Georgia Gwinnett), and the same shape at UW-Superior and UW-Eau Claire.
// That is roughly 17% of the not-found rows, or ~95 of 552.
//
// It belongs in tier 2 because it is exactly as ambiguous as the other
// tier-2 words. UW-Madison (240444) carries "as of July 1, 2026" INSIDE a
// per-year row of its incident table, beside other dates. Tier 1 would take
// the most recent and record an incident-table date as the page's update
// date; tier 2's unanimity rule sees two different dates and correctly
// records nothing. The guard that already exists for "updated" is the guard
// this needs.
//
// \b guards the front of this alternative only. Without it "as of" matches
// inside "was of", which the single-word terms cannot do to themselves.
//
// "Current as of" needs no separate entry -- "as of" is a substring of it,
// and the \b sits before "as" either way. "Effective" and "date of last
// revision" were looked for in the same audit and did not appear once.
const LUC_DATE_LABEL_TIER2 = '(?:updated|modified|published|revised|\\bas\\s+of)';

// Separator between label and date. Absorbs whitespace, colons, dashes and
// an optional connecting "on", so "Last updated on May 6, 2026",
// "Last Updated: June 30, 2026" and "Updated - March 18, 2026" all read the
// same. It can only cross whitespace and punctuation, never a word, so it
// cannot bridge a label to an unrelated date further along the page.
const LUC_DATE_SEPARATOR = '[\\s:.\\-\\u2013]*(?:on[\\s:.\\-\\u2013]+)?';

const LUC_MONTH_ALT =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|' +
  'jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|' +
  'dec(?:ember)?)';

// Four day-exact shapes, in capture-group order:
//   1-3   October 5, 2025 / Oct. 5th 2025
//   4-6   5 October 2025 / 5th Oct 2025
//   7-9   10/5/2025, 10-5-2025, 10.5.2025 (US month/day)
//   10-12 2025-10-05
const LUC_DATE_SHAPES =
  '(?:(' + LUC_MONTH_ALT + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})' +
  '|(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + LUC_MONTH_ALT + ')\\.?\\s*,?\\s*(\\d{4})' +
  '|(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{4}|\\d{2})' +
  '|(\\d{4})-(\\d{2})-(\\d{2}))';

// A page with thousands of label-like hits is a catalogue or a log, not a
// CHTR page. Stop rather than spend the execution on it.
const LUC_MAX_DATE_MATCHES = 200;

// LUC_HASH_MAX_CHARS WAS HERE, REMOVED 2026-09-01. The cap it held (200,000
// characters) moved to HAZ_HASH_MAX_CHARS in ContentHash.gs, along with the
// rest of the hashing, so that Candidate URLs and Live URL Checks cannot
// drift apart on it. Same value, one owner.


// =========================================================================
// RECONCILE -- make sure every URL we hold has a row
// =========================================================================
/**
 * Reports what lucReconcile() would do. Writes nothing.
 *
 * Worth running first every time: this is the function that decides how
 * many rows the table has, and getting the catalog wrong (a renamed
 * Institutions field, a mistyped select option) shows up here as a wildly
 * wrong count rather than as 2,000 bad rows.
 */
function lucReconcileDryRun() {
  return lucReconcile_(true);
}

/**
 * Creates a Live URL Checks row for every (institution, tracked field)
 * pair that holds a URL, does not have one yet, AND belongs to a category
 * whose `check` flag is on in LUC_TRACKED.
 *
 * Idempotent by construction -- it recomputes the missing set from what is
 * actually in both tables -- so if a run hits the six-minute cap partway
 * through, just run it again. There is no cursor to corrupt.
 *
 * Safe to run on a schedule after the initial fill: new schools, and any
 * institution that gains a published Hazing Policy, Transparency Report or
 * Report Form, get rows without anyone thinking about it.
 */
function lucReconcile() {
  return lucReconcile_(false);
}

function lucReconcile_(dryRun, callerHoldsLock) {
  const lock = callerHoldsLock ? null : LockService.getScriptLock();
  if (lock && !lock.tryLock(1000)) {
    Logger.log('Another LiveUrlChecks run holds the lock. Nothing done.');
    return { blocked: true };
  }
  try {
    const pat = lucRequirePat_();
    const startedAt = Date.now();

    const institutions = lucAllInstitutions_(pat);
    Logger.log('Institutions read: ' + institutions.length);

    const existing = lucExistingRowKeys_(pat);
    Logger.log('Live URL Checks rows already present: ' + existing.count);

    const missing = [];
    const perField = {};
    const orphans = {};   // row exists, URL now blank -- reported, never deleted
    LUC_TRACKED.forEach(function (t) { perField[t.name] = 0; orphans[t.name] = 0; });

    institutions.forEach(function (inst) {
      LUC_TRACKED.forEach(function (t) {
        const url = lucFirstUrl_(inst.fields[t.instField]);
        const key = inst.id + '|' + t.name;
        const has = existing.keys[key];
        // t.check gates row CREATION here, not just the sweep, so a
        // category switched off stops growing immediately rather than
        // accumulating rows nothing will ever fetch. Orphan detection
        // below still runs across every category regardless of `check`:
        // it is purely a log line about rows that already exist, never a
        // write, so there is no reason to blind it to any category.
        if (url && !has && t.check) {
          missing.push({ inst: inst, tracked: t });
          perField[t.name]++;
        } else if (!url && has) {
          orphans[t.name]++;
        }
      });
    });

    Logger.log('--- rows to create, by tracked field ---');
    LUC_TRACKED.forEach(function (t) {
      Logger.log('  ' + t.name + (t.check ? '' : ' (check disabled -- never created)') +
        ': ' + perField[t.name]);
    });
    Logger.log('TOTAL to create: ' + missing.length);

    const orphanTotal = LUC_TRACKED.reduce(function (n, t) { return n + orphans[t.name]; }, 0);
    if (orphanTotal) {
      Logger.log('Rows whose URL has since gone blank: ' + orphanTotal +
        ' -- kept, and the next check slice will mark them "No URL". Not deleted: ' +
        'the field held something once and somebody may have judged it.');
    }

    if (dryRun) {
      Logger.log('DRY RUN -- nothing written.');
      return { dryRun: true, toCreate: missing.length, perField: perField, orphans: orphans };
    }

    let created = 0;
    let outOfTime = false;

    for (let i = 0; i < missing.length; i += LUC_CREATE_BATCH) {
      if (Date.now() - startedAt > LUC_SLICE_BUDGET_MANUAL_MS) {
        outOfTime = true;
        break;
      }
      const batch = missing.slice(i, i + LUC_CREATE_BATCH);
      const ok = lucCreateRows_(pat, batch);
      if (ok) created += batch.length;
    }

    Logger.log('Rows created: ' + created +
      (outOfTime ? ' -- ran out of time, ' + (missing.length - created) +
        ' left. Run lucReconcile() again; it recomputes what is missing.' : ' -- complete.'));

    return { created: created, remaining: missing.length - created, orphans: orphans };
  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * The Institutions columns are multilineText, and some of them have picked
 * up trailing notes over the years. Take the first whitespace-delimited
 * token and require it to look like a URL -- the same test CrossSeed.gs
 * uses, for the same reason: a cell reading "TBD" or "see note" is
 * non-blank but is not something to fetch.
 */
function lucFirstUrl_(raw) {
  if (!raw) return '';
  const first = String(raw).trim().split(/\s+/)[0];
  return /^https?:\/\/\S+$/i.test(first) ? first : '';
}

function lucAllInstitutions_(pat) {
  const fields = [LUC_I_UNITID, LUC_I_NAME].concat(
    LUC_TRACKED.map(function (t) { return t.instField; }));
  return lucListAll_(pat, LUC_INST_TABLE, fields, '');
}

/**
 * Builds the "already has a row" index, keyed on the Institutions RECORD
 * ID rather than on UNITID.
 *
 * UNITID is the join key everywhere else in this project, and it is the
 * right one when a join crosses bases -- WriteBack.gs matches on it for
 * exactly that reason. Here both sides are in PAGES and the link field
 * already holds the record id, so using it removes a whole class of failure:
 * a row whose UNITID text got edited, or was never written, still matches.
 */
function lucExistingRowKeys_(pat) {
  const rows = lucListAll_(pat, LUC_CHECKS_TABLE, [LUC_F_INSTITUTION, LUC_F_TRACKED], '');
  const keys = {};
  rows.forEach(function (r) {
    const link = r.fields[LUC_F_INSTITUTION];
    const tracked = r.fields[LUC_F_TRACKED];
    if (!link || !link.length || !tracked) return;
    keys[link[0] + '|' + tracked] = true;
  });
  return { keys: keys, count: rows.length };
}

function lucCreateRows_(pat, batch) {
  const payload = {
    records: batch.map(function (m) {
      const fields = {};
      fields[LUC_F_INSTITUTION] = [m.inst.id];
      fields[LUC_F_TRACKED] = m.tracked.name;
      fields[LUC_F_UNITID] = String(m.inst.fields[LUC_I_UNITID] || '');
      return { fields: fields };
    })
  };
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CHECKS_TABLE,
    {
      method: 'post',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  Utilities.sleep(210);  // Airtable's 5 req/sec
  if (resp.getResponseCode() !== 200) {
    Logger.log('Create batch failed (HTTP ' + resp.getResponseCode() + '): ' + resp.getContentText());
    return false;
  }
  return true;
}


// =========================================================================
// WHAT USED TO BE HERE
//
// lucMigrateReviewsDryRun() and lucMigrateReviews(), removed 2026-08-28
// within hours of being written. They moved 251 human reviews off the
// located_* rows and onto the compliance rows that replaced them, refusing
// 33 whose compliance field was blank -- reviews of URLs the site does not
// publish, which stayed behind and went with the rows when those were
// deleted. Nothing was carried onto a different page: the run reported zero
// rows where the published URL differed from the one reviewed.
//
// Deleted rather than kept, for the same reason the previous migration was
// deleted the same morning: dead code that names a retired vocabulary reads
// as evidence the vocabulary is still live. It also cannot run again -- its
// source rows no longer exist -- so leaving it in would be an invitation to
// a no-op. Recover it from git history if the shape is ever needed again.
// =========================================================================


// =========================================================================
// THE SWEEP
// =========================================================================
/**
 * Starts a fresh sweep. Everything checked before today becomes due again.
 * Run this, then lucCheckSlice() until it reports done -- or let the
 * scheduled trigger work through it.
 *
 * This is the ONLY way to force a sweep early. Neither lucCheckSlice() nor
 * lucCheckSliceScheduled() will open one before
 * LUC_MIN_SWEEP_INTERVAL_DAYS has passed.
 *
 * Archives the outgoing sweep's counters to LUC_LAST_SWEEP first, so
 * starting a new one no longer destroys the record of the previous one --
 * read it back with lucLastSweep().
 */
function lucStartSweep() {
  // RECONCILE FIRST, ALWAYS. A sweep that checks every row but never asks
  // whether a row is missing is a sweep that reports success while ignoring
  // URLs nobody has ever looked at. Making this a separate button was a
  // design mistake: it invented a step the user has to know about, and the
  // penalty for forgetting it is silent.
  // `true` = the caller already holds the script lock. lucRunSlice_ takes it
  // before calling this, and re-acquiring it from the same execution is not
  // something to rely on -- so say so explicitly rather than letting
  // lucReconcile_ quietly return "blocked" and skip the reconcile.
  const added = lucReconcile_(false, true);
  if (added && added.created) Logger.log('Added ' + added.created + ' new row(s) before starting.');

  const previous = lucReadState_();
  if (previous && previous.status === 'complete') {
    PropertiesService.getScriptProperties()
      .setProperty(LUC_LAST_SWEEP_KEY, JSON.stringify(previous));
  }

  const state = {
    status: 'running',
    startedAt: new Date().toISOString(),
    cutoffDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    processed: 0,
    slices: 0,
    summary: {},
    writeErrors: [],
    stuckIds: [],
    inFlightId: '',      // see the auto-park block in lucRunSlice_
    failCounts: {},
    lastFetchSig: '',
    lastFetchRepeats: 0
  };
  lucWriteState_(state);
  const pat = lucRequirePat_();
  state.totalAtStart = lucCountDue_(pat, state.cutoffDate);
  lucWriteState_(state);
  Logger.log('Sweep started. Rows due: ' + state.totalAtStart);
  return state;
}

/**
 * One slice, hand-run. Continues a sweep in flight; opens a new one only if
 * the last finished more than LUC_MIN_SWEEP_INTERVAL_DAYS ago. Otherwise it
 * says so and does nothing -- run lucStartSweep() to override.
 */
function lucCheckSlice() {
  return lucRunSlice_(LUC_SLICE_BUDGET_MANUAL_MS);
}

/** The function to point the time-driven trigger at. Same rule. */
function lucCheckSliceScheduled() {
  return lucRunSlice_(LUC_SLICE_BUDGET_SCHEDULED_MS);
}

/** The counters from the last completed sweep, archived by lucStartSweep(). */
function lucLastSweep() {
  const raw = PropertiesService.getScriptProperties().getProperty(LUC_LAST_SWEEP_KEY);
  if (!raw) { Logger.log('No archived sweep.'); return null; }
  const s = JSON.parse(raw);
  Logger.log('last sweep: started ' + s.startedAt + ' | finished ' + s.finishedAt +
    ' | processed ' + s.processed + ' of ' + s.totalAtStart +
    ' | slices ' + s.slices);
  Logger.log('by status: ' + JSON.stringify(s.summary || {}));
  return s;
}

/**
 * Days since the stored sweep finished, or null if none has.
 */
function lucDaysSinceLastSweep_(state) {
  if (!state || state.status !== 'complete' || !state.finishedAt) return null;
  const finished = new Date(state.finishedAt).getTime();
  if (isNaN(finished)) return null;
  return (Date.now() - finished) / (1000 * 60 * 60 * 24);
}

/**
 * Checks at most 30 rows and stops. The proving run: it exercises fetch,
 * interpret, hash, staleness and write end to end for the cost of one
 * batch, so a mistake in any of them costs 30 rows instead of 2,700.
 */
function lucCheckSample30() {
  const pat = lucRequirePat_();
  const cutoff = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rows = lucFetchDue_(pat, cutoff, 30, []);
  if (!rows.length) {
    Logger.log('Nothing due. Run lucStartSweep() first if you want to re-check everything.');
    return { checked: 0 };
  }
  const results = lucCheckBatch_(rows, Date.now() + LUC_SLICE_BUDGET_MANUAL_MS);
  const write = lucWriteBack_(pat, results);
  const summary = {};
  results.forEach(function (r) {
    const s = r.fields[LUC_F_STATUS];
    if (s) summary[s] = (summary[s] || 0) + 1;
  });
  Logger.log('Sample of ' + results.length + ': ' + JSON.stringify(summary));
  if (write.failedIds.length) Logger.log('Would not save: ' + write.failedIds.join(', '));
  return { checked: results.length, summary: summary, failed: write.failedIds };
}

// =========================================================================
// RE-STAMPING THE CONTENT HASH SNAPSHOT  (one-time, 2026-09-01)
// =========================================================================
/**
 * Puts the current Content hash into Content hash snapshot on rows whose
 * determination is still valid.
 *
 * WHY IT IS NEEDED ONCE. Content hash changed format on 2026-09-01: both
 * tables now hash through ContentHash.gs instead of each growing its own.
 * Old values were in a different unit, so both hash columns were blanked
 * and refilled by a full sweep. That leaves the snapshots empty -- and an
 * empty snapshot means "Page changed since review" can never fire on that
 * row, so a page could be rewritten under a settled verdict and nothing
 * would say so.
 *
 * RUN THIS ONLY AFTER A FULL SWEEP HAS COMPLETED. Mid-sweep, unswept rows
 * still have a blank hash, so they would simply be skipped -- not harmful,
 * just a wasted pass. lucStatus() shows whether a sweep is running.
 *
 * WHAT "STILL VALID" MEANS, and why it is checked rather than assumed:
 * exactly the test lucClearIfStale_ applies -- the URL is unchanged since
 * the review, and the status CLASS is unchanged. A row failing that test is
 * one whose determination the next sweep would clear anyway; snapshotting a
 * hash onto it would freeze the page a reviewer never saw and make a stale
 * verdict look freshly grounded.
 *
 * IT DOES NOT STAMP LAST CHECKED, which is why it writes through its own
 * PATCH rather than lucPatch_. Last checked means "when the script last
 * read this URL", and this reads nothing -- it copies a value the sweep
 * already established. Stamping it would push the row out of the next
 * sweep's due set on the strength of a fetch that never happened.
 *
 * IT ALSO DOES NOT TOUCH Reviewer determination, so the snapshot automation
 * (wflPC5zF6hqFqeKjt) never fires and Review date is not disturbed. The
 * date belongs to the human decision, not to this repair.
 *
 * Safe to re-run: rows whose snapshot already matches are skipped.
 */
function lucRestampSnapshotsDryRun() { return lucRestampSnapshots_(true); }
function lucRestampSnapshots()       { return lucRestampSnapshots_(false); }

function lucRestampSnapshots_(dryRun) {
  const pat = lucRequirePat_();

  const state = lucReadState_();
  if (state && state.status === 'running') {
    Logger.log('WARNING: a sweep is still running (' + state.processed + ' of ' +
      state.totalAtStart + '). Rows it has not reached yet have a blank Content hash ' +
      'and will be skipped. Finish the sweep, then run this again.');
  }

  const formula = 'AND({' + LUC_F_DETERMINATION + '} != "", {' + LUC_F_HASH + '} != "")';
  const rows = lucListAll_(pat, LUC_CHECKS_TABLE,
    [LUC_F_UNITID, LUC_F_TRACKED, LUC_F_URL, LUC_F_CODE, LUC_F_HASH,
     LUC_F_SNAP_URL, LUC_F_SNAP_STATUS, LUC_F_SNAP_HASH, LUC_F_DETERMINATION],
    formula);

  const updates = [];
  let already = 0, stale = 0, noSnapshot = 0;

  rows.forEach(function (r) {
    const f = r.fields;
    const hash = String(f[LUC_F_HASH] || '');
    const snapHash = String(f[LUC_F_SNAP_HASH] || '');
    if (snapHash === hash) { already++; return; }

    // A row that never had URL/status snapshots was determined before the
    // automation stamped them. There is nothing to test "still valid"
    // against, so there is no honest basis for freezing a hash onto it.
    // Left alone; it re-snapshots properly the next time someone touches
    // its determination.
    const snapUrl = String(f[LUC_F_SNAP_URL] || '');
    const snapStatus = String(f[LUC_F_SNAP_STATUS] || '');
    if (!snapUrl && !snapStatus) { noSnapshot++; return; }

    const urlChanged = snapUrl !== String(f[LUC_F_URL] || '');
    const statusChanged =
      lucStatusClass_(snapStatus) !== lucStatusClass_(String(f[LUC_F_CODE] || ''));
    if (urlChanged || statusChanged) { stale++; return; }

    const fields = {};
    fields[LUC_F_SNAP_HASH] = hash;
    updates.push({ id: r.id, fields: fields,
                   label: (f[LUC_F_UNITID] || r.id) + ' / ' + (f[LUC_F_TRACKED] || '?') });
  });

  Logger.log(
    '\n======== CONTENT HASH SNAPSHOT RE-STAMP' + (dryRun ? ' DRY RUN' : '') + ' ========\n' +
    rows.length + ' row(s) have both a determination and a content hash.\n' +
    updates.length + ' would be stamped.\n' +
    already + ' already match -- nothing to do.\n' +
    stale + ' skipped: URL or status has moved since the review, so the next sweep\n' +
    '  clears the determination anyway. Snapshotting them would make a stale\n' +
    '  verdict look freshly grounded.\n' +
    noSnapshot + ' skipped: no URL or status snapshot to test validity against\n' +
    '  (determined before the snapshot automation stamped those fields).\n' +
    (dryRun ? '\nNothing written. Run lucRestampSnapshots() to apply.\n' : ''));

  if (dryRun) {
    updates.slice(0, 20).forEach(function (u) { Logger.log('  would stamp ' + u.label); });
    if (updates.length > 20) Logger.log('  ... and ' + (updates.length - 20) + ' more');
    return { total: rows.length, wouldStamp: updates.length, already: already,
             stale: stale, noSnapshot: noSnapshot };
  }

  let written = 0;
  for (let i = 0; i < updates.length; i += LUC_WRITE_BATCH) {
    const batch = updates.slice(i, i + LUC_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CHECKS_TABLE,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch.map(function (u) {
          return { id: u.id, fields: u.fields };
        }) }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) written += batch.length;
    else Logger.log('Write failed for ' + batch.length + ' row(s): ' +
      resp.getContentText().slice(0, 300));
    Utilities.sleep(210);
  }
  Logger.log('Stamped ' + written + ' of ' + updates.length + '.');
  return { stamped: written, total: updates.length };
}

// =========================================================================
// RE-CHECKING ROWS AN ABANDONED BISECT NEVER FETCHED
// =========================================================================
/**
 * Re-checks only the rows carrying the HTTP code "Bisect abandoned".
 *
 * WHAT THOSE ROWS ARE. When one hanging URL poisons a wave,
 * lucFetchAllSafe_ bisects to isolate it; if the bisect runs out of budget
 * first, every request in the group comes back null and is recorded
 * Unconfirmed / "Bisect abandoned". That code means precisely "this page
 * was never fetched" -- honest, but most of those pages are fine, and each
 * one sits in the review queue costing a person time for nothing. The
 * 2026-09-01 sweep left 60 of them, 46 with no determination, from five bad
 * hosts.
 *
 * WHY THIS EXISTS RATHER THAN JUST RE-SWEEPING. A full sweep re-checks
 * 2,600 rows to fix 60. This re-checks the 60.
 *
 * RUN IT AFTER THE OFFENDING HOSTS ARE IN LUC_UNFETCHABLE_HOSTS, not
 * before. Otherwise the same URLs poison the same waves and produce the
 * same abandoned rows -- with the list in place they are never sent, so the
 * rows around them get real answers.
 *
 * Resumable by re-running: each pass writes what it managed, and rows that
 * got a real status no longer carry the code, so the next pass sees fewer.
 * If a pass reports the same count twice, a hanging host is still getting
 * through -- read the log for the "ONE OF THESE THREW" line and add it.
 *
 * A ROW THAT IS STILL UNREACHABLE ON THE RE-CHECK gets an honest answer
 * this time: it was fetched alone or in a small wave, so Site error or
 * Unconfirmed here reflects a real attempt rather than a skipped one.
 */
function lucRecheckAbandoned() {
  return lucRecheckAbandoned_(LUC_SLICE_BUDGET_MANUAL_MS);
}

/**
 * The pass itself, with the budget passed in.
 *
 * SPLIT FROM THE ENTRY POINT 2026-09-01 so lucRunSlice_ can call it with
 * whatever is left of its own budget. Hand-running it should not have to
 * think about that; the scheduled caller must.
 *
 * Returns { checked, summary, remaining } -- `remaining` is how many rows
 * still carry the code when it stops, which is what tells the caller
 * whether to say "clean" or "more to do". Counted with a page-1 query
 * rather than inferred, because "the budget ran out" and "there was nothing
 * left" are different facts and this file's whole habit is not to collapse
 * those.
 */
function lucRecheckAbandoned_(budgetMs) {
  const pat = lucRequirePat_();
  const startedAt = Date.now();
  const formula = 'AND({' + LUC_F_CODE + '} = "Bisect abandoned", ' + lucCheckedClause_() + ')';

  let checked = 0;
  const summary = {};

  while (Date.now() - startedAt < budgetMs) {
    const json = lucList_(pat, LUC_CHECKS_TABLE, {
      pageSize: LUC_ROWS_PER_FETCH,
      returnFieldsByFieldId: true,
      fields: LUC_READ_FIELDS,
      filterByFormula: formula
    });
    Utilities.sleep(210);

    const rows = (json.records || []).slice(0, LUC_ROWS_PER_FETCH);
    if (!rows.length) {
      Logger.log('Nothing left carrying "Bisect abandoned".');
      break;
    }

    const results = lucCheckBatch_(rows, startedAt + budgetMs);
    const write = lucWriteBack_(pat, results);

    const saved = results.length - write.failedIds.length;
    if (!saved) {
      Logger.log('None of these ' + rows.length + ' rows would save. Stopping.');
      break;
    }

    results.forEach(function (r) {
      const st = r.fields[LUC_F_STATUS];
      if (st) summary[st] = (summary[st] || 0) + 1;
    });
    checked += saved;

    // The same rows coming back means they are not leaving the filter --
    // either still abandoned (another hanging host) or not saving. Either
    // way, looping costs the whole budget for nothing.
    if (results.every(function (r) { return r.fields[LUC_F_CODE] === 'Bisect abandoned'; })) {
      Logger.log('Every row in that batch came back "Bisect abandoned" again -- a hanging ' +
        'host is still getting through. Read the log above for "ONE OF THESE THREW", ' +
        'confirm with findPoison(), and add it to LUC_UNFETCHABLE_HOSTS before re-running.');
      break;
    }
  }

  // One cheap page-1 read to say what is left. Costs a single request and
  // turns "it stopped" into either "it finished" or "it ran out of time",
  // which is the difference between needing a person and not.
  let remaining = 0;
  try {
    const tail = lucList_(pat, LUC_CHECKS_TABLE, {
      pageSize: LUC_ROWS_PER_FETCH,
      returnFieldsByFieldId: true,
      fields: [LUC_F_UNITID],
      filterByFormula: formula
    });
    remaining = (tail.records || []).length;
  } catch (e) {
    remaining = -1;   // unknown; say so rather than claiming zero
  }

  Logger.log('\n======== RE-CHECK OF ABANDONED ROWS ========\n' +
    checked + ' row(s) re-checked. Results: ' + JSON.stringify(summary) + '\n' +
    (remaining < 0 ? 'Could not count what is left.\n'
      : remaining === 0 ? 'Nothing left carrying "Bisect abandoned".\n'
      : 'At least ' + remaining + ' row(s) still carry the code -- run again.\n'));
  return { checked: checked, summary: summary, remaining: remaining };
}

// =========================================================================
// CHTR-ONLY DATE RE-SWEEP  (2026-09-01)
// =========================================================================
/**
 * Re-reads the last-updated date on CHTR pages, and touches NOTHING ELSE.
 *
 * WHY THIS EXISTS. Two date-extraction fixes shipped 2026-09-01: zero-width
 * characters are now stripped before matching (see lucExtractDate_ -- one
 * U+200B was hiding "Updated: June 15, 2026" on UW-Stevens Point), and
 * "as of" was added to the tier-2 label list. Neither takes effect on a row
 * until that row is fetched again. A full sweep would do it, but a full
 * sweep is 2,600 rows, re-judges every status, and can clear reviews on
 * pages that have moved -- an enormous side effect for a date fix.
 *
 * This reads only the ~550 CHTR rows that currently say "Date not found on
 * page", and writes only the two date fields.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   Last checked      -- it is the sweep's cursor. Stamping it here would
 *                        pull these rows out of the next real sweep's due
 *                        set on the strength of a fetch that judged nothing
 *                        but a date.
 *   Link status, HTTP code, Redirect target -- not re-judged. A row that
 *                        404s during this pass keeps its Live status until
 *                        a real sweep says otherwise; a date pass is not
 *                        evidence about liveness.
 *   Content hash      -- not rewritten. Same reason.
 *   Any review field  -- lucClearIfStale_ is NEVER called from here. A
 *                        determination cannot go stale because we re-read a
 *                        date.
 *
 * IT ONLY EVER IMPROVES A ROW. A row where a date is now found flips to
 * "Date found" with the date. A row where nothing is found is left exactly
 * as it was -- no write at all, which also makes a re-run cheap. So this
 * cannot turn a found date into a lost one.
 *
 * RESUMABLE BY UNITID WATERMARK, the same shape CrossSeed.gs uses and for
 * the same reason: the candidate list SHRINKS as the pass works, because a
 * row that finds a date leaves the filter. A positional cursor into a
 * shrinking list silently skips rows -- that bug cost this project a full
 * cross-seed run on 2026-08-29. A watermark names a place in the sort
 * order and survives the list changing underneath it.
 *
 * The whole matching set is listed and sorted in code every slice rather
 * than sorted server-side. It is ~550 rows of id + UNITID + URL, which is
 * cheap, and it removes any dependence on Airtable returning a stable order
 * for an unsorted filtered query.
 *
 * RUN: lucChtrDateResweep() until it says FINISHED.
 *      lucChtrDateResweepStatus() to see where it is, without fetching.
 *      lucChtrDateResweepReset() to start over from the top.
 */
const LUC_CHTR_DATE_PROP  = 'luc_chtr_date_after';
const LUC_CHTR_DATE_BATCH = 10;   // small: a bisect over a bad wave is the
                                  // main cost here and it scales with wave size

function lucChtrDateResweep()       { return lucChtrDateResweep_(LUC_SLICE_BUDGET_MANUAL_MS); }
function lucChtrDateResweepScheduled() { return lucChtrDateResweep_(LUC_SLICE_BUDGET_SCHEDULED_MS); }

function lucChtrDateResweepReset() {
  PropertiesService.getScriptProperties().deleteProperty(LUC_CHTR_DATE_PROP);
  Logger.log('CHTR date re-sweep reset. The next run starts from the top.');
}

function lucChtrDateResweepStatus() {
  const pat = lucRequirePat_();
  const after = PropertiesService.getScriptProperties().getProperty(LUC_CHTR_DATE_PROP) || '';
  const rows = lucChtrDateRows_(pat);
  let remaining = 0;
  rows.forEach(function (r) { if (!after || r.unitid > after) remaining++; });
  Logger.log('CHTR date re-sweep: ' + rows.length + ' row(s) still say "Date not found on page". ' +
    (after ? 'Resume after UNITID ' + after + ' -- ' + remaining + ' left to try.'
           : 'Not started.'));
  return { total: rows.length, after: after, remaining: remaining };
}

/**
 * Every CHTR row that was read successfully and still has no date.
 *
 * Link status Live is part of the filter on purpose. A row that is Dead,
 * Login required or Unconfirmed did not fail the DATE check, it failed the
 * FETCH -- its result is "Unable to check", not "Date not found on page" --
 * so it is out of scope here and re-fetching it would be a liveness check
 * wearing a date check's clothes.
 */
function lucChtrDateRows_(pat) {
  const formula =
    'AND({' + LUC_F_TRACKED + '} = "Transparency Report", ' +
        '{' + LUC_F_STATUS  + '} = "Live", ' +
        '{' + LUC_F_CHTR_DATE_RESULT + '} = "Date not found on page")';

  const raw = lucListAll_(pat, LUC_CHECKS_TABLE,
    [LUC_F_UNITID, LUC_F_URL, LUC_F_TRACKED], formula);

  const out = [];
  raw.forEach(function (r) {
    const unitid = String(r.fields[LUC_F_UNITID] || '').trim();
    const url = String(r.fields[LUC_F_URL] || '').trim();
    if (!unitid || !url) return;
    out.push({ id: r.id, unitid: unitid, url: url });
  });

  // Same comparator shape as CrossSeed's xsUnitidCmp_ -- plain string order,
  // defined in exactly one place so the sort and the watermark test cannot
  // disagree about what "after" means.
  out.sort(function (a, b) { return a.unitid < b.unitid ? -1 : (a.unitid > b.unitid ? 1 : 0); });
  return out;
}

function lucChtrDateResweep_(budgetMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another run holds the lock. Nothing done.');
    return { blocked: true };
  }
  try {
    const pat = lucRequirePat_();
    const startedAt = Date.now();
    const props = PropertiesService.getScriptProperties();
    let after = props.getProperty(LUC_CHTR_DATE_PROP) || '';

    const rows = lucChtrDateRows_(pat);
    if (!rows.length) {
      Logger.log('Nothing to do: no CHTR row currently reads "Date not found on page".');
      return { done: true, found: 0 };
    }

    let i = 0;
    while (i < rows.length && after && rows[i].unitid <= after) i++;
    if (i >= rows.length) {
      Logger.log('FINISHED. Every row past the watermark has been tried. ' +
        'lucChtrDateResweepReset() to run it again from the top.');
      return { done: true, found: 0 };
    }

    let tried = 0, found = 0, skipped = 0, unreadable = 0;
    const foundList = [];

    while (i < rows.length && Date.now() - startedAt < budgetMs) {
      const batch = [];
      while (batch.length < LUC_CHTR_DATE_BATCH && i < rows.length) {
        const row = rows[i++];
        // Both guards mirror the main sweep's. A host we know hangs must
        // not be entered into a wave here either -- one of them would cost
        // this whole slice, and it would cost it every run.
        if (lucIsKnownUnfetchable_(row.url) || !lucIsFetchableUrl_(row.url)) {
          skipped++;
          after = row.unitid;
          continue;
        }
        batch.push(row);
      }
      if (!batch.length) { props.setProperty(LUC_CHTR_DATE_PROP, after); continue; }

      const responses = lucFetchAllSafe_(
        batch.map(function (r) { return lucRequest_(r.url); }),
        startedAt + budgetMs);

      const updates = [];
      batch.forEach(function (row, k) {
        tried++;
        const resp = responses[k];
        // No response, or not a 200: nothing to read. Left untouched --
        // this pass does not get to say anything about liveness.
        if (!resp) { unreadable++; return; }
        let code;
        try { code = resp.getResponseCode(); } catch (e) { unreadable++; return; }
        if (code < 200 || code >= 300) { unreadable++; return; }

        const iso = lucExtractDate_(resp);
        if (!iso) return;   // still nothing -- no write, so a re-run is cheap

        found++;
        foundList.push(row.unitid + '  ' + iso + '  ' + row.url);
        const f = {};
        f[LUC_F_CHTR_LAST_UPDATED] = iso;
        f[LUC_F_CHTR_DATE_RESULT] = 'Date found';
        updates.push({ id: row.id, fields: f });
      });

      if (updates.length) lucChtrDateWrite_(pat, updates);

      // Watermark AFTER the write, and to the LAST row of the batch -- the
      // one just finished, never the next one. Writing the next row's id is
      // the off-by-one that skips a school on resume.
      after = batch[batch.length - 1].unitid;
      props.setProperty(LUC_CHTR_DATE_PROP, after);
    }

    const done = i >= rows.length;
    Logger.log(
      '\n======== CHTR DATE RE-SWEEP ========\n' +
      (done ? 'FINISHED. ' : 'Time budget reached. ') +
      tried + ' page(s) fetched this run, ' +
      found + ' date(s) newly found, ' +
      unreadable + ' page(s) could not be read (left untouched), ' +
      skipped + ' skipped as known-unfetchable or malformed.\n' +
      'Resume after UNITID ' + after + '.\n' +
      (done ? 'lucChtrDateResweepReset() to run it again from the top.\n'
            : 'Run lucChtrDateResweep() again to continue.\n'));

    if (foundList.length) {
      Logger.log('--- dates found ---');
      foundList.forEach(function (l) { Logger.log('  ' + l); });
    }

    return { done: done, tried: tried, found: found,
             unreadable: unreadable, skipped: skipped, after: after };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Writes ONLY the two date fields. Its own PATCH rather than lucPatch_,
 * because lucPatch_ stamps Last checked on every record it touches and that
 * is precisely what this pass must not do.
 */
function lucChtrDateWrite_(pat, updates) {
  for (let i = 0; i < updates.length; i += LUC_WRITE_BATCH) {
    const batch = updates.slice(i, i + LUC_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CHECKS_TABLE,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch, typecast: true }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('Date write failed for ' + batch.length + ' row(s): ' +
        resp.getContentText().slice(0, 300));
    }
    Utilities.sleep(210);
  }
}

function lucStatus() {
  const state = lucReadState_();
  if (!state) { Logger.log('No sweep state stored.'); return null; }
  Logger.log('status ' + state.status +
    ' | started ' + state.startedAt +
    ' | slices ' + state.slices +
    ' | processed ' + state.processed + ' of ' + (state.totalAtStart || '?') +
    ' | parked ' + (state.stuckIds || []).length +
    (state.inFlightId ? ' | IN FLIGHT (will auto-park next slice): ' + state.inFlightId : '') +
    ' | write errors ' + (state.writeErrors || []).length);
  Logger.log('by status: ' + JSON.stringify(state.summary || {}));

  const age = lucDaysSinceLastSweep_(state);
  if (age !== null) {
    const due = LUC_MIN_SWEEP_INTERVAL_DAYS - age;
    Logger.log(due <= 0
      ? 'Next sweep is DUE -- the next lucCheckSlice() will open one.'
      : 'Next sweep due in ' + Math.ceil(due) + ' days. lucStartSweep() forces one now.');
  }
  return state;
}

/**
 * Works through due rows until Airtable reports nothing left or the budget
 * runs out. Mutates state in place and saves after every batch, so an
 * execution killed mid-flight loses at most one batch.
 *
 * budgetMs governs when we stop STARTING work, not a hard stop -- a wave
 * already in flight always finishes. That is why the budgets sit well
 * below the six-minute cap rather than near it.
 */
function lucRunSlice_(budgetMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another LiveUrlChecks run holds the lock. Nothing done.');
    return { blocked: true, done: false };
  }
  try {
    const pat = lucRequirePat_();
    let state = lucReadState_();

    // DO NOT SILENTLY OPEN A NEW SWEEP. See LUC_MIN_SWEEP_INTERVAL_DAYS for
    // what that cost on 2026-08-23 and what it would have cost on a trigger.
    if (!state || !state.status) {
      Logger.log('No sweep has ever run. Starting one.');
      state = lucStartSweep();
    } else if (state.status !== 'running') {
      const age = lucDaysSinceLastSweep_(state);
      if (age === null || age >= LUC_MIN_SWEEP_INTERVAL_DAYS) {
        Logger.log('Last sweep finished ' + (state.finishedAt || 'unknown') +
          '; the ' + LUC_MIN_SWEEP_INTERVAL_DAYS + '-day interval has passed. Starting a new one.');
        state = lucStartSweep();
      } else {
        // NOT DUE FOR A FULL SWEEP -- but never-checked rows are a different
        // question and must not wait 90 days for an answer.
        //
        // lucReconcile creates a row the moment a school gains a URL. Without
        // this branch that row would sit with a blank Last checked until the
        // next sweep opened, so a URL added the day after a sweep finished
        // would go unchecked for a full quarter while the page cheerfully
        // reported "Finished". Same invisible-failure shape as forgetting to
        // reconcile at all.
        const toppedStartedAt = Date.now();
        const topped = lucTopUpNewRows_(pat, budgetMs);

        // SECOND CHANCE FOR ABANDONED ROWS. The sweep-completing slice tries
        // this first; if it had no budget left, or a hanging host was found
        // and listed afterwards, the rows are still sitting there. This
        // branch runs on every scheduled firing between sweeps and costs one
        // Airtable read when there is nothing to do, so it keeps trying
        // until the queue is clean without anyone remembering to.
        const cleaned = lucCleanUpAbandoned_(
          budgetMs - (Date.now() - toppedStartedAt), 'between sweeps');

        Logger.log('No full sweep due for ' +
          Math.ceil(LUC_MIN_SWEEP_INTERVAL_DAYS - age) + ' more days (last finished ' +
          state.finishedAt + ').' +
          (topped ? ' Checked ' + topped + ' newly added URL(s).' : ' No new URLs waiting.') +
          ' Run lucStartSweep() to force a full sweep.');
        return { done: true, skipped: true, toppedUp: topped,
                 abandonedRechecked: cleaned.checked,
                 abandonedRemaining: cleaned.remaining,
                 daysUntilDue: LUC_MIN_SWEEP_INTERVAL_DAYS - age };
      }
    }

    const startedAt = Date.now();
    state.slices = (state.slices || 0) + 1;
    state.lastSliceAt = new Date().toISOString();

    // ---- AUTO-PARK WHATEVER KILLED THE LAST SLICE (added 2026-09-01) ----
    //
    // THE HOLE THIS FILLS. lucMarkStuck_ parks a row only after its WRITE
    // has failed three times. A URL whose host does not resolve never
    // reaches a write: UrlFetchApp neither answers nor fails fast, it
    // hangs, and exceeding the six-minute cap does not throw -- the
    // execution is killed outright, so no catch block runs and nothing is
    // saved. The row is due again on the next slice, degraded mode puts it
    // first, and the next slice dies identically. Unattended that is an
    // infinite loop with zero progress, no error and no alert.
    //
    // Two such URLs turned up in one afternoon on 2026-09-01
    // (hazing.uci.edu, unlreport.unl.edu), both bare subdomains that have
    // stopped resolving. Neither is exotic and neither is a checker fault,
    // so this will recur.
    //
    // HOW IT WORKS. In degraded mode -- one row at a time, which is exactly
    // when we know which row we are on -- the row's id is written to state
    // BEFORE the fetch. If the fetch returns, it is cleared. So an id still
    // sitting here at the start of a slice means the previous execution
    // died with that row in flight, and nothing else can produce that.
    //
    // WHY IT PARKS ON THE FIRST KILL, NOT THE THIRD. A hang is not
    // transient the way a 429 is: the host either resolves or it does not,
    // and every retry costs a full execution and a chunk of the day's ~90
    // minutes of trigger runtime. Two more attempts buy no information and
    // could lose most of a night's sweeping. Parking is also cheap to be
    // wrong about -- the row is skipped for this sweep only, keeps its
    // data, and is checked again by the next lucStartSweep().
    //
    // The retry-skip in lucRetryFailures_ is the first line of defence and
    // handles the common case, where one hang fits inside the cap. This is
    // the backstop for when it does not.
    if (state.inFlightId) {
      const killer = state.inFlightId;
      state.inFlightId = '';
      lucMarkStuck_(state, [killer]);
      lucWriteState_(state);
      Logger.log('AUTO-PARKED ' + killer + ' -- the previous slice was killed with this ' +
        'row in flight, almost certainly a URL whose host does not resolve and which ' +
        'UrlFetchApp hangs on rather than refusing. Skipped for the rest of this sweep; ' +
        'the next lucStartSweep() will try it again. It needs a reviewer determination, ' +
        'not a re-run. Total parked: ' + (state.stuckIds || []).length + '.');
    }

    let done = false;

    while (true) {
      const rows = lucFetchDue_(pat, state.cutoffDate, LUC_ROWS_PER_FETCH, state.stuckIds || []);
      if (!rows.length) { done = true; break; }

      // Stall guard. The same rows coming back fetch after fetch means
      // checking them is not removing them from the filter, so continuing
      // would loop forever. Two identical repeats are tolerated -- a
      // transient Airtable 429 or 500 on the write is normal and worth
      // retrying -- and the third parks them. This is the only thing that
      // catches a "write reported success but the row did not leave the
      // filter" failure; the per-row tracking below cannot see it.
      const signature = rows.map(function (r) { return r.id; }).join(',');
      if (signature === state.lastFetchSig) {
        state.lastFetchRepeats = (state.lastFetchRepeats || 0) + 1;
      } else {
        state.lastFetchSig = signature;
        state.lastFetchRepeats = 0;
      }

      if (state.lastFetchRepeats >= 2) {
        Logger.log('Stall: the same ' + rows.length + ' rows came back three fetches running. Parking them.');
        lucMarkStuck_(state, rows.map(function (r) { return r.id; }));
        state.lastFetchSig = '';
        state.lastFetchRepeats = 0;
        lucWriteState_(state);
        if ((state.stuckIds || []).length >= LUC_MAX_STUCK_ROWS) {
          throw new Error('Parked ' + state.stuckIds.length + ' rows that would not clear the ' +
            '"due" filter after being written. Stopping rather than looping.');
        }
        continue;
      }

      // PERSIST THE GUARD BEFORE DOING THE WORK. Exceeding the six-minute
      // cap does not throw, it just ends -- so anything saved only after
      // the batch is never saved at all when a batch is what kills the
      // execution. That is how the old checker got into a loop where every
      // slice re-read the same stale state, re-fetched the same rows and
      // died the same way, with the stall guard permanently on zero.
      const degraded = (state.lastFetchRepeats || 0) >= 1;
      lucWriteState_(state);

      const chunkSize = degraded ? 1 : LUC_CHECK_BATCH;
      if (degraded) Logger.log('This batch killed a previous slice -- isolating, one row at a time.');

      const deadlineAt = startedAt + budgetMs;

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);

        // ONLY IN DEGRADED MODE, where the chunk is a single row and the id
        // therefore names the culprit. Recording all thirty ids of a normal
        // batch would park twenty-nine innocent rows for one bad one -- the
        // isolation pass exists precisely to avoid that, and this waits for
        // it. See the auto-park block at the top of this function.
        //
        // Written before the fetch and cleared after it, so the value can
        // only survive into another execution if this one was killed while
        // that row was in flight.
        if (degraded && chunk.length === 1) {
          state.inFlightId = chunk[0].id;
          lucWriteState_(state);
        }

        const results = lucCheckBatch_(chunk, deadlineAt);

        if (state.inFlightId) {
          state.inFlightId = '';
          lucWriteState_(state);
        }

        const write = lucWriteBack_(pat, results);

        // Only rows that actually saved count as processed. A failed write
        // means the row is still due as far as Airtable is concerned and
        // will come back on the next fetch; counting it here would inflate
        // progress past the total and hide the failure.
        const failed = write.failedIds;
        const saved = results.filter(function (r) { return failed.indexOf(r.id) === -1; });

        saved.forEach(function (r) {
          const s = r.fields[LUC_F_STATUS];
          if (s) state.summary[s] = (state.summary[s] || 0) + 1;
        });
        state.writeErrors = (state.writeErrors || []).concat(write.writeErrors);
        state.processed += saved.length;

        state.failCounts = state.failCounts || {};
        failed.forEach(function (id) {
          state.failCounts[id] = (state.failCounts[id] || 0) + 1;
          if (state.failCounts[id] >= 3) {
            lucMarkStuck_(state, [id]);
            delete state.failCounts[id];
          }
        });

        lucWriteState_(state);
      }

      if (Date.now() - startedAt > budgetMs) break;
    }

    if (done) {
      state.status = 'complete';
      state.finishedAt = new Date().toISOString();
    }
    lucWriteState_(state);

    Logger.log((done ? 'SWEEP COMPLETE. ' : 'Slice done, more to do. ') +
      state.processed + ' of ' + (state.totalAtStart || '?') + ' processed.');
    Logger.log('by status: ' + JSON.stringify(state.summary));

    // ---- CLEAN UP AFTER THE SWEEP (added 2026-09-01) --------------------
    //
    // Rows an abandoned bisect never fetched carry the code "Bisect
    // abandoned" and sit in the review queue asserting that nothing was
    // established. Most are healthy pages that a hanging URL took down with
    // it -- 60 of them after the 2026-09-01 sweep, 46 with no determination.
    // Left alone they cost a reviewer's time for no finding.
    //
    // WHY HERE. This is the moment the queue a person opens is created, and
    // the moment there is budget left: the slice ended because nothing was
    // due, not because it ran out of time. Doing it now means the queue is
    // already clean when someone looks. Unattended, nothing else would --
    // lucRecheckAbandoned() is hand-run, and a scheduled sweep that produced
    // abandoned rows would leave them indefinitely with no alert.
    //
    // IT CANNOT LOOP. A re-checked row gets Last checked stamped with
    // today's date, and the due filter is IS_BEFORE(lastChecked, cutoff) --
    // today is not before today, so nothing it writes comes back as due.
    //
    // IT IS BOUNDED BY WHAT IS LEFT OF THIS SLICE, never a fresh budget. A
    // sweep-completing slice usually has minutes spare; when it does not,
    // this is skipped and the not-due branch below picks it up on the next
    // scheduled run. Either way one execution is one execution.
    if (done) {
      lucCleanUpAbandoned_(budgetMs - (Date.now() - startedAt), 'after the sweep');
    }

    return { done: done, processed: state.processed, summary: state.summary };
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// PARKING A ROW BY HAND  (added 2026-09-01)
// =========================================================================
/**
 * WHAT PARKING IS. lucBuildDueFormula_ excludes any record id in
 * state.stuckIds from every fetch for the rest of the sweep. The row is
 * skipped, not changed: nothing is written to it, its determination and
 * notes are untouched, and it comes back on the next sweep because a new
 * sweep starts with an empty stuckIds list.
 *
 * WHY THIS EXISTS. lucMarkStuck_ parks a row automatically only after its
 * WRITE has failed three times. A URL whose host does not resolve never
 * reaches a write -- UrlFetchApp hangs, the six-minute cap kills the
 * execution mid-fetch, and state is never saved. So the one failure mode
 * that most needs parking is the one that could not park itself, and the
 * sweep repeated it every slice. That is what hazing.uci.edu did on
 * 2026-09-01.
 *
 * The retry-skip in lucRetryFailures_ halves the cost of such a URL and
 * usually lets the slice survive it. This is the escape hatch for when it
 * does not.
 *
 * NOT A SUBSTITUTE FOR FIXING THE DATA. A parked row is a row nobody is
 * checking. If the URL is genuinely dead, the answer is a reviewer marking
 * it and write-back clearing it in 50 States -- parking only buys the sweep
 * enough room to reach everything else first.
 */

/**
 * Park the rows whose URL appears in the blob below. Paste the addresses
 * from a "POISON URL" or "ONE OF THESE THREW" log line, separated however
 * they came out -- same shape as findPoison() in FindPoison.gs, so the two
 * take the same paste.
 */
function lucPark() {
  const blob = `
    https://hazing.uci.edu/definitions/
  `;

  const urls = blob.split(/[\s|,]+/).filter(function (u) { return /^https?:\/\//i.test(u); });
  if (!urls.length) { Logger.log('No URLs in the blob. Nothing parked.'); return []; }

  const state = lucReadState_();
  if (!state || state.status !== 'running') {
    Logger.log('No sweep is running, so there is nothing to park against. ' +
      'stuckIds lives in sweep state and is cleared by lucStartSweep().');
    return [];
  }

  const pat = lucRequirePat_();
  const found = [];

  urls.forEach(function (url) {
    // The URL field is a formula, which filterByFormula can still compare
    // against. Quoted with double quotes because a URL may contain an
    // apostrophe far more plausibly than a double quote.
    const formula = '{' + LUC_F_URL + '} = "' + url.replace(/"/g, '\\"') + '"';
    const rows = lucListAll_(pat, LUC_CHECKS_TABLE, [LUC_F_URL, LUC_F_UNITID, LUC_F_TRACKED], formula);
    if (!rows.length) { Logger.log('  no row found for ' + url); return; }
    rows.forEach(function (r) {
      found.push(r.id);
      Logger.log('  parking ' + (r.fields[LUC_F_UNITID] || '?') + ' / ' +
        (r.fields[LUC_F_TRACKED] || '?') + '  ' + url);
    });
  });

  if (!found.length) { Logger.log('Nothing matched. Nothing parked.'); return []; }

  lucMarkStuck_(state, found);
  lucWriteState_(state);
  Logger.log('Parked ' + found.length + ' row(s). Total parked this sweep: ' +
    (state.stuckIds || []).length + ' of a ' + LUC_MAX_STUCK_ROWS + ' limit.');
  Logger.log('These rows are skipped for the REST OF THIS SWEEP only. The next ' +
    'lucStartSweep() clears the list and checks them again.');
  return found;
}

/** What is currently parked, and why you should care that it is. */
function lucParked() {
  const state = lucReadState_();
  const ids = (state && state.stuckIds) || [];
  if (!ids.length) { Logger.log('Nothing parked.'); return []; }
  Logger.log(ids.length + ' row(s) parked this sweep -- skipped by every fetch until ' +
    'the sweep ends. Record ids:');
  ids.forEach(function (id) { Logger.log('  ' + id); });
  return ids;
}

/** Unpark everything, so the rest of the sweep sees those rows again. */
function lucUnparkAll() {
  const state = lucReadState_();
  if (!state) { Logger.log('No sweep state.'); return; }
  const n = (state.stuckIds || []).length;
  state.stuckIds = [];
  lucWriteState_(state);
  Logger.log('Unparked ' + n + ' row(s).');
}

function lucMarkStuck_(state, ids) {
  state.stuckIds = state.stuckIds || [];
  ids.forEach(function (id) {
    if (state.stuckIds.indexOf(id) === -1) state.stuckIds.push(id);
  });
}

function lucReadState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(LUC_STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function lucWriteState_(state) {
  PropertiesService.getScriptProperties().setProperty(LUC_STATE_KEY, JSON.stringify(state));
}

function lucRequirePat_() {
  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) throw new Error('Set AIRTABLE_PAT in Script Properties first.');
  return pat;
}


// =========================================================================
// FINDING WHAT IS DUE
// =========================================================================
/**
 * "Never checked, or checked before this sweep started", optionally minus
 * the rows we have parked -- and, always, restricted to categories whose
 * `check` flag is on.
 *
 * filterByFormula ACCEPTS FIELD IDS -- settled 2026-08-23 by measurement,
 * not argument. Using the id is strictly safer than resolving the name:
 * renaming the field in Airtable cannot break it.
 *
 * THE CHECKED-CATEGORY CLAUSE IS NOT OPTIONAL. Added 2026-08-27 when three
 * categories went check:false. A row in a check:false category can never
 * get its Last Checked stamped (lucCheckBatch_ skips it before writing), so
 * without this clause it would come back "due" on every fetch forever. See
 * lucCheckedClause_.
 */
function lucBuildDueFormula_(cutoffDate, stuckIds) {
  const due =
    'OR({' + LUC_F_LAST_CHECKED + '} = BLANK(), ' +
    "IS_BEFORE({" + LUC_F_LAST_CHECKED + "}, DATETIME_PARSE('" + cutoffDate + "', 'YYYY-MM-DD')))";

  const clauses = [due, lucCheckedClause_()];

  // One FIND against a comma-joined list rather than a RECORD_ID() != ...
  // clause per parked row. The per-clause form grew the formula by ~60
  // URL-encoded characters each and blew Apps Script's ~2KB URL cap at
  // about 25 parked records. Record ids are fixed-length and unique, so a
  // comma-delimited substring test cannot collide.
  if (stuckIds && stuckIds.length) {
    clauses.push("FIND(RECORD_ID(), '" + stuckIds.join(',') + "') = 0");
  }

  return clauses.length > 1 ? 'AND(' + clauses.join(', ') + ')' : due;
}

// Every field a clear touches is read first, not because the comparison
// needs them -- only the two snapshots decide that -- but because
// lucClearIfStale_ logs what it discarded, and a cleared review is gone
// from the row for good. The execution log is the only place it survives.
const LUC_READ_FIELDS = [
  LUC_F_URL, LUC_F_TRACKED, LUC_F_UNITID, LUC_F_INSTITUTION,
  LUC_F_SNAP_URL, LUC_F_SNAP_STATUS, LUC_F_DETERMINATION,
  LUC_F_PROPOSED_URL, LUC_F_NOTES
];

/**
 * Lists via Airtable's POST /listRecords rather than a GET query string.
 *
 * Airtable documents the POST variant precisely for requests whose encoded
 * parameters would be too long for a URL, and it takes identical
 * parameters in a JSON body. Apps Script caps a fetch URL at roughly 2KB,
 * far below Airtable's own 16,000, and this request carries seven fields[]
 * entries plus a filterByFormula that grows as rows get parked. The
 * equivalent GET failed a live sweep on 2026-08-21 with "Limit Exceeded:
 * URLFetch URL Length" at 73 records.
 */
function lucList_(pat, tableId, body) {
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + tableId + '/listRecords',
    {
      method: 'post',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    }
  );
  if (resp.getResponseCode() !== 200) {
    throw new Error('Airtable list error (HTTP ' + resp.getResponseCode() + '): ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

function lucListAll_(pat, tableId, fields, formula) {
  const out = [];
  let offset = null;
  let guard = 0;
  do {
    const body = { pageSize: 100, returnFieldsByFieldId: true, fields: fields };
    if (formula) body.filterByFormula = formula;
    if (offset) body.offset = offset;
    const json = lucList_(pat, tableId, body);
    (json.records || []).forEach(function (r) { out.push(r); });
    offset = json.offset || null;
    Utilities.sleep(210);
  } while (offset && ++guard < 400);
  return out;
}

/**
 * There is no cursor to carry between calls. The filter itself shrinks as
 * rows get checked, so "the first page of what is left" is always the
 * right next thing to work on.
 */
function lucFetchDue_(pat, cutoffDate, maxRows, stuckIds) {
  const json = lucList_(pat, LUC_CHECKS_TABLE, {
    pageSize: Math.min(100, maxRows),
    returnFieldsByFieldId: true,
    fields: LUC_READ_FIELDS,
    filterByFormula: lucBuildDueFormula_(cutoffDate, stuckIds)
  });
  Utilities.sleep(210);
  return (json.records || []).slice(0, maxRows);
}

/**
 * Checks rows that have NEVER been checked, between full sweeps.
 *
 * Deliberately holds no state. A row leaves the never-checked set the moment
 * its result is written, so this is idempotent, self-limiting, and safe to
 * call from any slice: if there is nothing new it costs one Airtable read
 * and returns 0.
 *
 * "Never checked" is not the same question as "due for a re-check", which is
 * why this is separate from the sweep rather than folded into it. A re-check
 * is a cadence decision; a first check is not optional at any cadence.
 *
 * ANDs in lucCheckedClause_ for the same reason lucBuildDueFormula_ does: a
 * check:false row is created with a blank Last Checked and can never earn
 * one, so without this it would show up here on every call, forever, for no
 * result. Added 2026-08-27.
 */
/**
 * Runs the abandoned-row re-check with whatever budget is left, and says
 * plainly what happened. Called from two places in lucRunSlice_ -- see
 * either call site for why.
 *
 * NEVER THROWS. A cleanup pass must not be able to turn a finished sweep
 * into a failed execution: the sweep's own state is already saved by the
 * time this runs, and losing the cleanup costs one deferred pass, while
 * losing the completion would cost a person working out what state the
 * sweep is in. Errors are logged and swallowed on purpose.
 *
 * SKIPS ITSELF BELOW A MINUTE. Under that, one batch of thirty barely
 * starts, and a half-finished batch is worse than none: the fetch time is
 * spent, the writes may not land, and the next caller starts over anyway.
 */
function lucCleanUpAbandoned_(remainingMs, whenLabel) {
  const budget = Math.floor(remainingMs || 0);
  if (budget < 60000) {
    Logger.log('Abandoned-row re-check skipped ' + whenLabel + ' -- only ' +
      Math.max(0, Math.round(budget / 1000)) + 's of budget left. The next ' +
      'scheduled run picks it up.');
    return { checked: 0, remaining: -1, skipped: true };
  }

  try {
    const r = lucRecheckAbandoned_(budget);
    if (r.checked || r.remaining > 0) {
      Logger.log('Abandoned-row re-check ' + whenLabel + ': ' + r.checked +
        ' re-checked' +
        (r.remaining > 0 ? ', at least ' + r.remaining + ' still to do -- ' +
          'if this number is not falling, a hanging host is still getting ' +
          'through and belongs in LUC_UNFETCHABLE_HOSTS.'
          : ', none left.'));
    }
    return r;
  } catch (e) {
    Logger.log('Abandoned-row re-check ' + whenLabel + ' failed, ignored: ' + e);
    return { checked: 0, remaining: -1, failed: true };
  }
}

function lucTopUpNewRows_(pat, budgetMs) {
  const startedAt = Date.now();
  const formula = 'AND({' + LUC_F_LAST_CHECKED + '} = BLANK(), ' + lucCheckedClause_() + ')';
  let checked = 0;

  while (Date.now() - startedAt < budgetMs) {
    const json = lucList_(pat, LUC_CHECKS_TABLE, {
      pageSize: LUC_ROWS_PER_FETCH,
      returnFieldsByFieldId: true,
      fields: LUC_READ_FIELDS,
      filterByFormula: formula
    });
    Utilities.sleep(210);

    const rows = (json.records || []).slice(0, LUC_ROWS_PER_FETCH);
    if (!rows.length) break;

    const results = lucCheckBatch_(rows, startedAt + budgetMs);
    const write = lucWriteBack_(pat, results);

    // If nothing saved, the same rows come back next loop -- stop rather
    // than spin. The sweep's stall guard does the same job for the same
    // reason; this path has no state to hang a counter off, so it simply
    // gives up and lets the next firing try again.
    const saved = results.length - write.failedIds.length;
    if (!saved) {
      Logger.log('Top-up: ' + rows.length + ' new row(s) would not save. Leaving them.');
      break;
    }
    checked += saved;
  }

  return checked;
}

function lucCountDue_(pat, cutoffDate) {
  const rows = lucListAll_(pat, LUC_CHECKS_TABLE, [LUC_F_TRACKED],
    lucBuildDueFormula_(cutoffDate, []));
  return rows.length;
}


// =========================================================================
// CHECKING
// =========================================================================
/**
 * UrlFetchApp.fetchAll throws for the ENTIRE batch if any single request
 * is malformed -- one bad URL poisons twenty-nine good ones. Falling back
 * to serial fetching would blow the six-minute cap on its own, so bisect
 * until the offender is alone and return null only for that one.
 */
function lucFetchAllSafe_(requests, deadlineAt) {
  if (!requests.length) return [];
  try {
    return UrlFetchApp.fetchAll(requests);
  } catch (e) {
    if (requests.length === 1) {
      try {
        return [UrlFetchApp.fetch(requests[0].url, requests[0])];
      } catch (err) {
        // THE ONLY PLACE THE POISON URL IS EVER NAMED. A throw from
        // fetchAll costs the whole wave a bisect -- up to five extra
        // rounds of re-fetching the good URLs alongside the bad one --
        // and before 2026-08-28 nothing recorded which URL caused it, so
        // the cost was invisible and unfixable. Log it loudly: one line
        // here is what lets a bad value be corrected at source in 50
        // States instead of taxing every future sweep.
        Logger.log('POISON URL (threw on fetch, forced a bisect): "' +
          requests[0].url + '" -- ' + err);
        return [null];
      }
    }
    // Bisecting re-fetches the good requests in each half, so a batch with
    // several throwing URLs can cost far more than one pass. Past the
    // deadline, stop splitting and report the rest as unreachable rather
    // than spending the whole execution isolating them.
    if (deadlineAt && Date.now() > deadlineAt) {
      // NAME THEM. Until 2026-08-28 this logged only a count, which made the
      // most expensive failure in the file also the least diagnosable: a
      // bisect that reaches a single request logs POISON URL and identifies
      // the culprit, but a bisect that runs out of budget first returns
      // nulls anonymously. The first slice of the 2026-08-28 sweep spent
      // three and a half of its four minutes inside one such recovery and
      // processed 120 rows instead of several hundred, with nothing in the
      // log to say which URL caused it.
      //
      // The offender is one of the URLs on this line. Re-run the slice and
      // the surviving half narrows; or hand them to lwcCheckOne() and find
      // it directly. Either beats re-paying three minutes every slice.
      Logger.log('Past deadline mid-bisect; giving up on ' + requests.length +
        ' request(s). ONE OF THESE THREW -- ' +
        requests.map(function (r) { return r.url; }).join('  |  '));
      return requests.map(function () { return null; });
    }
    const mid = Math.floor(requests.length / 2);
    return lucFetchAllSafe_(requests.slice(0, mid), deadlineAt)
      .concat(lucFetchAllSafe_(requests.slice(mid), deadlineAt));
  }
}

/**
 * Is this safe to hand to UrlFetchApp?
 *
 * WHY THIS GATE EXISTS. UrlFetchApp.fetchAll throws for the ENTIRE wave if
 * any single request is malformed. lucFetchAllSafe_ recovers by bisecting,
 * but a bisect re-fetches the good URLs at every level -- roughly five
 * extra rounds for a wave of thirty. On 2026-08-27 a 30-row sample burned
 * its whole four-minute budget inside that recovery and still did not
 * finish, which extrapolates to about six hours for a full sweep. One bad
 * value taxes every good one beside it.
 *
 * So the cheapest fix is to never let a bad value into the wave. A URL that
 * fails here is recorded as needing human eyes and skipped, costing one row
 * instead of twenty-nine.
 *
 * The test is deliberately strict rather than clever: scheme, a host with a
 * dot, and no whitespace or control characters anywhere. It is not trying
 * to decide whether a URL will RESOLVE -- that is what the fetch is for --
 * only whether it is well-formed enough to send. Anything rejected here is
 * a data-entry problem in 50 States, not a dead link, and the two should
 * not be reported as the same thing.
 */
function lucIsFetchableUrl_(url) {
  if (!url) return false;
  if (url.length > 2000) return false;
  if (/[\s ​-‍﻿]/.test(url)) return false;  // any whitespace, NBSP, zero-width
  if (/[\x00-\x1f\x7f]/.test(url)) return false;                // control characters
  return /^https?:\/\/[^\/\s:]+\.[^\/\s:]+(?::\d+)?(?:[\/?#]|$)/i.test(url);
}

function lucRequest_(url, method) {
  const m = String(method || 'get').toLowerCase();
  const safe = LUC_VALID_FETCH_METHODS.indexOf(m) === -1 ? 'get' : m;
  if (safe !== m) {
    Logger.log('Unsupported fetch method "' + method + '" requested for ' + url +
      '; using GET. UrlFetchApp supports only ' + LUC_VALID_FETCH_METHODS.join(', ') + '.');
  }
  return {
    url: url,
    method: safe,
    followRedirects: false,
    muteHttpExceptions: true,
    headers: LUC_BROWSER_HEADERS
  };
}

function lucResponseCode_(resp) {
  return resp ? String(resp.getResponseCode()) : 'Unreachable';
}

/**
 * How good an outcome is, so a retry only replaces the first attempt when
 * it says something better. Without this, a server that answers a first
 * request with 200 and a retry with 500 would end up recorded as broken.
 */
function lucOutcomeRank_(resp) {
  if (!resp) return 0;
  const c = resp.getResponseCode();
  if (c >= 200 && c < 300) return 5;  // definitively alive
  if (c >= 300 && c < 400) return 4;  // alive, moved
  if (c === 404) return 3;            // definitive answer: it is gone
  if (c >= 400 && c < 500) return 2;  // refused us, tells us little
  return 1;                           // 5xx
}

/**
 * One extra batched round for the requests that did not get a usable
 * answer. Batched, not serial: a whole retry wave costs about as long as
 * one slow request, which matters because these runs are unattended and
 * capped at six minutes.
 *
 * 403 and 405 are deliberately absent from the retry list. See
 * LUC_RETRY_WITH_GET_CODES: the HEAD retry those codes used to get never
 * worked, and an identical GET would only ask the same question twice. The
 * browser-shaped User-Agent is what actually moves 403s, and it is applied
 * on the FIRST attempt, where it belongs.
 */
function lucRetryFailures_(jobs, responses, deadlineAt) {
  const retries = [];
  jobs.forEach(function (j, i) {
    // A NULL RESPONSE IS NOT RETRIED (added 2026-09-01). null comes from
    // exactly two places, both in lucFetchAllSafe_: a request that THREW on
    // a lone fetch, and a bisect abandoned past the deadline. Neither is a
    // server answer, and re-sending either asks the same question at the
    // same price.
    //
    // That price is the whole point. On 2026-09-01 a slice met
    // hazing.uci.edu, whose host does not resolve: UrlFetchApp neither
    // answers nor fails fast, it hangs. The first attempt spent minutes,
    // the throw was caught and logged as POISON URL, and then this function
    // saw 'Unreachable' and sent it again -- a second multi-minute hang
    // that killed the execution before anything could be written. The row
    // was never marked, so the next slice repeated it exactly.
    //
    // UrlFetchApp offers no per-request timeout, so a hang cannot be capped
    // -- only not paid twice. Skipping the retry halves the cost of a
    // hanging URL and lets the slice reach the write that records it as
    // unreachable, which is what finally takes it out of the queue.
    //
    // A genuine 'Unreachable' from a real response object still retries;
    // this only skips the ones that came back as null.
    if (responses[i] === null || responses[i] === undefined) return;

    const code = lucResponseCode_(responses[i]);
    if (code === 'Unreachable' || LUC_RETRY_WITH_GET_CODES.indexOf(code) !== -1) {
      retries.push({ i: i, method: 'get' });
    }
  });
  if (!retries.length) return responses;

  if (deadlineAt && Date.now() > deadlineAt) {
    Logger.log('Past deadline; skipping the retry wave for ' + retries.length + ' request(s).');
    return responses;
  }

  Logger.log('Retrying ' + retries.length + ' of ' + jobs.length + ' requests.');
  Utilities.sleep(LUC_RETRY_PAUSE_MS);

  const retryResponses = lucFetchAllSafe_(
    retries.map(function (r) { return lucRequest_(jobs[r.i].url, r.method); }), deadlineAt);

  const out = responses.slice();
  retries.forEach(function (r, k) {
    const better = retryResponses[k];
    if (better && lucOutcomeRank_(better) > lucOutcomeRank_(out[r.i])) out[r.i] = better;
  });
  return out;
}

/**
 * Maps an HTTP result to the controlled vocabulary. These labels are what
 * a reviewer sees, so they name the state of the link, not what someone
 * should do about it.
 *
 * Unconfirmed is the one that replaced real work. It used to be "Needs
 * Review", which lumped together three unrelated situations: the site
 * refused our checker, the page needs a login, and the server is broken.
 * In the August 2026 data that single bucket was 195 flags, of which one
 * was a genuinely dead link.
 *
 * Unconfirmed is deliberately NOT a discard pile. A 403 proves the server
 * answered and refused us; it does not prove the page is gone. These still
 * need human eyes -- just different work from a Dead link.
 *
 * Everything reaching here has already been through lucRetryFailures_, so
 * a 403 means the server refused a browser-shaped request, and a 405 means
 * it will not serve GET at this address at all.
 */
function lucInterpret_(resp, requestUrl) {
  const code = resp.getResponseCode();
  let status, redirectTarget = '';

  if (code >= 200 && code < 300) {
    status = 'Live';
  } else if (code >= 300 && code < 400) {
    const headers = resp.getAllHeaders();
    const rawLocation = headers['Location'] || headers['location'] || '';
    redirectTarget = lucResolveRedirect_(requestUrl, rawLocation);
    status = 'Redirected';
  } else if (code === 404 || code === 410) {
    status = 'Dead link';         // the server says it is not there
  } else if (code === 401) {
    status = 'Login required';    // exists, but behind a sign-in
  } else if (code >= 400 && code < 500) {
    status = 'Unconfirmed';       // refused us; says nothing about the page
  } else {
    status = 'Site error';        // 5xx
  }

  // EVERY STATUS EXCEPT A DEFINITIVE 404/410 IS RE-EXAMINED. This was
  // 2xx and 3xx only until 2026-08-28, on the reasoning that a 5xx was never
  // read so there is nothing to inspect. That confused the two kinds of
  // signal. The BODY signals do need a readable response; the ADDRESS signal
  // does not -- a URL containing /idp/profile/ is a login wall whatever the
  // server says about it, including nothing.
  //
  // The case that proved it: 110574's stored form URL,
  // vince.csueastbay.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s2,
  // answers 500 (the execution token is a dead session), so it landed on
  // Site error and the address check never ran on the most obviously
  // SSO-shaped URL in the base.
  //
  // Dead link still wins: a page the server says is gone is gone, and that
  // is more useful to a reviewer than knowing it used to be a login.
  if (status !== 'Dead link') {
    const signal = lucLoginWallSignal_(resp, requestUrl, redirectTarget, status);
    if (signal) {
      Logger.log('LOGIN WALL (' + signal + ') -- ' + requestUrl +
        ' answered ' + code + ', recorded as Login required' +
        (redirectTarget ? ' (redirects to ' + redirectTarget + ')' : '') + '.');
      status = 'Login required';
    }
  }

  return { status: status, redirectTarget: redirectTarget, code: String(code) };
}

/**
 * Which login-wall signal fired, or '' for none. See the LOGIN WALLS block
 * for what each one is and why signal 3 is fenced by page length.
 *
 * Returns a short label rather than a boolean so the caller can log WHICH
 * test fired. That log line is the only way to find out, after a sweep,
 * whether the password-field heuristic is pulling its weight or quietly
 * mislabelling nav bars.
 */
function lucLoginWallSignal_(resp, requestUrl, redirectTarget, status) {
  if (!LUC_DETECT_LOGIN_WALLS) return '';

  // 1. Address. Checked before any body read, and the only signal available
  // for a redirect we deliberately did not follow.
  if (lucMatchesAny_(LUC_LOGIN_URL_PATTERNS, redirectTarget)) return 'redirect target';
  if (lucMatchesAny_(LUC_LOGIN_URL_PATTERNS, requestUrl)) return 'request URL';

  // Nothing below can apply to a 3xx: followRedirects is false, so the body
  // of a redirect is an empty stub, not the page.
  if (status !== 'Live' || !resp) return '';

  let text;
  try { text = resp.getContentText(); } catch (e) { return ''; }  // binary/PDF
  if (!text) return '';

  // 2. SSO bounce markup.
  if (lucMatchesAny_(LUC_LOGIN_BODY_PATTERNS, text)) return 'SSO form in body';

  // 3. Password input, only on a page too short to be anything else.
  if (LUC_LOGIN_PASSWORD_INPUT.test(text)) {
    const visible = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (visible.length <= LUC_LOGIN_MAX_PAGE_CHARS) {
      return 'password field on a ' + visible.length + '-char page';
    }
  }

  return '';
}

/** True if any pattern matches. Patterns must not carry /g -- see above. */
function lucMatchesAny_(patterns, subject) {
  if (!subject) return false;
  const s = String(subject);
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(s)) return true;
  }
  return false;
}

// Some servers send a relative path in Location instead of a full URL.
// Browsers resolve those against the site being redirected from; do the
// same, so Redirect target is always a clickable link. It is a url-typed
// field, and Airtable rejects a bare path.
function lucResolveRedirect_(requestUrl, location) {
  if (!location) return '';
  if (/^https?:\/\//i.test(location)) return location;

  const originMatch = requestUrl.match(/^(https?:)\/\/([^\/]+)/i);
  if (!originMatch) return '';

  const scheme = originMatch[1];
  const host = originMatch[2];

  if (location.indexOf('//') === 0) return scheme + location;
  if (location.charAt(0) === '/') return scheme + '//' + host + location;

  const pathMatch = requestUrl.match(/^https?:\/\/[^\/]+(\/.*)?$/i);
  let basePath = (pathMatch && pathMatch[1]) || '/';
  basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1) || '/';
  return scheme + '//' + host + basePath + location;
}

/**
 * A fingerprint of the page's visible text.
 *
 * THE HASHING ITSELF LIVES IN ContentHash.gs AS OF 2026-09-01. This is now
 * only the response-to-text step: pull the body, hand it to hazHashHtml_.
 *
 * Read that file before changing anything here. The short version: this
 * used to be MD5 over its own mild strip, truncated to 16 characters, while
 * SitemapFinder.gs used unnormalised SHA-256 over a different strip. Two
 * fingerprints for one page, incomparable, so nothing could ask whether a
 * page had changed since a human approved it. One shared normaliser fixes
 * that; the price is that every hash stored before the change is in a
 * different unit and has to be regenerated. See hazHashRegenerationNotes().
 *
 * TWO BEHAVIOUR CHANGES WORTH KNOWING. The shared strip removes <nav>,
 * <header>, <footer> and <aside>, which this function used to keep -- so a
 * school editing its site-wide menu no longer registers as a changed page,
 * and these hashes are less twitchy than they were. And the result is the
 * full 64-character SHA-256 rather than 16 characters of MD5.
 *
 * Normalisation is still deliberately mild. It is NOT aggressive enough to
 * make the hash stable across rotating banners, news feeds or "quote of the
 * day" blocks, and no amount of tuning would make it so without also hiding
 * the edits we care about. That is exactly why a hash change only raises
 * the "Page changed since review" flag and never clears a determination.
 * See the header.
 *
 * Returns '' when there is no readable body -- a 403, a redirect, a binary
 * PDF that throws on getContentText. Callers must treat '' as "no
 * information", not as "the page is empty", and leave any stored hash alone
 * rather than clearing it. Clearing on an unreadable fetch would make the
 * flag blink on and off with the weather.
 */
function lucContentHash_(resp) {
  let text;
  try { text = resp.getContentText(); } catch (e) { return ''; }
  return hazHashHtml_(text);
}

/**
 * Records an OBSERVATION, not a judgment: a date was found, or the page
 * was read and none matched, or we never got to read it, or there is no
 * URL. Whether a date is recent enough is a HazingInfo policy question --
 * settled 2026-08-19 as "updated within the 12 months before the data
 * check date", anchored on September 1 -- and deriving it in Airtable from
 * the stored date means changing the standard is a formula edit that
 * reapplies to every row instantly, instead of a code change plus a full
 * re-sweep during which the base holds a mix of verdicts from two
 * standards with nothing saying which is which.
 */
function lucExtractDate_(resp) {
  let text;
  try {
    text = resp.getContentText().substring(0, 2000000);
  } catch (e) {
    return null;
  }
  if (!text) return null;

  // Decode common entities before matching. A literal "&nbsp;" between a
  // label and its date -- "Last updated:&nbsp;6/22/2026", very common from
  // WYSIWYG editors -- survives tag-stripping as literal text and blocks
  // the regex separator even though the two are adjacent on the page.
  // Whitespace is collapsed last so a label and its date split across two
  // lines or table cells still read as adjacent.
  // ZERO-WIDTH CHARACTERS ARE REMOVED, NOT COLLAPSED (added 2026-09-01).
  //
  // THE BUG THIS FIXES, found on UW-Stevens Point (240480). The page says
  // "Updated: June 15, 2026." and the row read "Date not found on page" for
  // months. The reason is that the page carries U+200B ZERO WIDTH SPACE
  // between the day and the comma, and again after the year -- the classic
  // signature of text pasted out of Word or a WYSIWYG editor.
  //
  // JavaScript's \s DOES NOT MATCH U+200B. It matches U+00A0 (NBSP) and
  // U+FEFF, which is why the entity decoding below was enough for the
  // &nbsp; case and is NOT enough for this one. Verified rather than
  // assumed: /\s/.test('\u200B') is false, /\s/.test('\u00A0') is true.
  //
  // One such character anywhere between the label and the end of the year
  // breaks the whole match -- LUC_DATE_SHAPES uses \s* between the day, the
  // comma and the year, and \s* cannot cross it. The failure is silent and
  // indistinguishable from a page that genuinely has no date.
  //
  // REMOVED rather than replaced with a space, because these are joiners
  // and separators with no width: "20\u200B26" is the year 2026, and
  // turning it into "20 26" would be a different kind of wrong.
  //
  // The entity spellings are handled here too. Airtable's own tag-stripping
  // never sees them; they arrive as literal text like any other entity.
  //
  // NOTE: ContentHash.gs deliberately does NOT do this. A zero-width
  // character is part of the page's text, and stripping it there would
  // change every stored hash for no gain -- the hash only has to be
  // consistent with itself, whereas this regex has to match human wording.
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8203;|&#x200B;|&zwnj;|&#8204;|&zwj;|&#8205;|&#65279;|&#xFEFF;/gi, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#8212;|&mdash;/gi, '-')
    .replace(/\s+/g, ' ');

  const maxYear = new Date().getFullYear() + 1;

  // Tier 1 is trusted outright. Tier 2 is only consulted if tier 1 found
  // nothing, and only if every tier-2 hit agrees -- see the tier comments.
  return lucScanForDate_(plain, LUC_DATE_LABEL_TIER1, maxYear, false) ||
         lucScanForDate_(plain, LUC_DATE_LABEL_TIER2, maxYear, true);
}

/**
 * Every "<label> <day-exact date>" hit in the page text, reduced to one
 * date, or null.
 *
 * requireUnanimous is what makes the tier-2 fallback safe. A real page
 * statement says "Updated June 30, 2026" once. An incident table says
 * "status updated ..." on every row, with a different date each time. So
 * when a tier-2 scan turns up two or more DIFFERENT dates, the page is
 * showing a table rather than making a statement, and the honest answer is
 * that no page-update date was found.
 *
 * Otherwise the most recent valid date wins. String comparison is exact on
 * zero-padded ISO, so no date parsing is needed to order them.
 */
function lucScanForDate_(plain, labelAlt, maxYear, requireUnanimous) {
  // Fresh RegExp per call: a /g regex carries lastIndex between uses, and a
  // shared one would resume mid-page on the next row and skip matches.
  const re = new RegExp(labelAlt + LUC_DATE_SEPARATOR + LUC_DATE_SHAPES, 'gi');
  const distinct = {};
  let best = null;
  let seen = 0;
  let m;

  while ((m = re.exec(plain)) !== null) {
    if (++seen > LUC_MAX_DATE_MATCHES) break;

    let y, mo, d;
    if (m[1] !== undefined) {                    // October 5, 2025
      mo = LUC_MONTH_NUMBERS[m[1].toLowerCase()];
      d = Number(m[2]);
      y = Number(m[3]);
    } else if (m[4] !== undefined) {             // 5 October 2025
      d = Number(m[4]);
      mo = LUC_MONTH_NUMBERS[m[5].toLowerCase()];
      y = Number(m[6]);
    } else if (m[7] !== undefined) {             // 10/5/2025 -- US order
      mo = Number(m[7]);
      d = Number(m[8]);
      y = Number(m[9]);
      if (y < 100) y += 2000;
    } else if (m[10] !== undefined) {            // 2025-10-05
      y = Number(m[10]);
      mo = Number(m[11]);
      d = Number(m[12]);
    } else {
      continue;
    }

    const iso = lucValidIsoDate_(y, mo, d, maxYear);
    if (!iso) continue;
    distinct[iso] = true;
    if (!best || iso > best) best = iso;
  }

  if (requireUnanimous && Object.keys(distinct).length > 1) return null;
  return best;
}

/**
 * Returns yyyy-MM-dd if these parts are a real calendar date inside the
 * plausible range, or null.
 *
 * Built with Date.UTC and round-trip verified rather than parsed from a
 * string. new Date("Fall 2025") returning 1 January 2025 is what put
 * sixteen fabricated dates into the base; nothing here can repeat that,
 * because nothing here parses prose. The round-trip check is what rejects
 * 31 February and 31 April, which Date.UTC would otherwise roll forward
 * into March and May rather than refusing.
 *
 * The lower bound is 2000 rather than the Stop Campus Hazing Act's 2025:
 * a genuinely old "last updated" date is a real and reportable finding
 * about a stale page, and discarding it as noise would hide exactly the
 * schools the freshness standard exists to catch. Only impossible years
 * are rejected.
 */
function lucValidIsoDate_(y, mo, d, maxYear) {
  if (!(y >= 2000 && y <= maxYear)) return null;
  if (!(mo >= 1 && mo <= 12)) return null;
  if (!(d >= 1 && d <= 31)) return null;

  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }

  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return y + '-' + pad(mo) + '-' + pad(d);
}

/**
 * Is this page THERE or GONE? The only distinction between HTTP results
 * that a human review can go stale against.
 *
 * Added 2026-08-28, replacing an exact comparison of HTTP codes.
 *
 * WHY CLASSES AND NOT CODES. Comparing raw codes meant 403 -> 200 cleared a
 * review, and that is the single most common transition in this data for
 * reasons that have nothing to do with the page. This file's own header
 * records the measurement: the 401/403/5xx bucket was 195 flags, of which
 * exactly one was a genuinely dead link. University WAFs answer 403 to one
 * sweep and 200 to the next. On 2026-08-28, 102 of the 189 reviewed rows
 * sat on Unconfirmed or Site error -- so an exact-code rule put more than
 * half the reviewer's work at the mercy of a firewall's mood.
 *
 * Nothing inside PRESENT changes what a reviewer would conclude. They
 * opened the page, judged it, and recorded a verdict; whether the checker
 * was let through on this particular sweep is a fact about the checker.
 *
 * CROSSING BETWEEN PRESENT AND ABSENT IS REAL, IN BOTH DIRECTIONS. Present
 * to absent is the page dying, which is exactly what a re-review is for.
 * Absent to present matters just as much and is easy to overlook: a row
 * marked "Confirmed broken - no replacement found" against a 404 is simply
 * wrong once the school puts the page back, and nothing else would ever
 * catch it.
 *
 * A DELIBERATE OMISSION: a wobble inside PRESENT raises no flag either. A
 * flag nobody acts on is noise competing with the flags that matter -- a
 * row either needs a human or it does not. "Page changed since review"
 * stays, because a rewritten page is a real change to what was judged.
 *
 * "Unreachable" counts as PRESENT. A fetch that failed outright is usually
 * transient, and the two states that mean the page is genuinely gone are
 * the ones the checker can actually distinguish: a server saying 404/410,
 * or the field holding no URL at all.
 */
function lucStatusClass_(code) {
  const c = String(code === null || code === undefined ? '' : code).trim();
  if (c === '') return 'absent';                  // No URL
  const n = parseInt(c, 10);
  if (n === 404 || n === 410) return 'absent';    // the server says it is gone
  return 'present';
}

/**
 * Clears a review whose grounds no longer hold.
 *
 * Only the URL and the status CLASS decide staleness -- see
 * lucStatusClass_ for why the class rather than the code. A hash change is
 * handled by the "Page changed since review" formula, not here.
 *
 * WHAT CLEARS ON WHICH SIGNAL, and why they differ:
 *
 *   Reviewer determination, Reviewer notes, Review date -- either signal.
 *     All three describe one review of one page. When the
 *     address moves or the HTTP result changes, that page is not what is
 *     there now, and every part of the review goes with it. A reviewer
 *     opening a flagged row should find it empty and ready, not carrying
 *     one field's worth of last time's answer.
 *
 *     Review date matters most of the three. Left behind, it sits next to a
 *     blank determination reading as "reviewed recently" when nobody has,
 *     and "Review age" measures a review that no longer exists.
 *
 *   Reviewer-proposed URL -- URL change ONLY. A changed URL means the
 *     proposal was about an address that is no longer there, and is also
 *     precisely the case where the write-back script has just applied the
 *     proposal, making it spent. But status is the least reliable of the
 *     three signals: university WAFs answer 403 on one sweep and 200 on
 *     the next, and the retry wave reduces that without eliminating it.
 *     Discarding a human's replacement URL on a flapping status would
 *     throw away the single most expensive thing a reviewer produces, so
 *     it survives a status change and is re-judged with the row.
 *
 * NOTES USED TO BE EXEMPT, AND ARE NOT ANY MORE (changed 2026-08-28). The
 * argument for keeping them was that on 2026-08-23 twenty-nine
 * below-standard URLs were recovered out of reviewer notes. That was a
 * first-run artefact: the located_* fields did not exist yet, so notes were
 * the only place those URLs could go. They have a proper home now, so notes
 * carry no unique record and clear with the rest of the review.
 *
 * The determination is set to null, NOT ''. Empty string on
 * a single select tries to create an option named "" and gets rejected,
 * which fails the whole write batch rather than the one row. The same is
 * true of Review date as a date field. Notes and the proposed URL are text
 * and url fields, where '' is the correct clear.
 */
// The determination that means "this link is dead and there is no
// replacement". Named as a constant rather than typed inline, for the same
// reason WriteBack.gs names its two: a rename in Airtable should be a
// one-line fix here, not a guard that silently stops matching. Must equal
// the Reviewer determination option EXACTLY.
const LUC_DET_BROKEN = 'Confirmed broken - no replacement found';

/**
 * A URL that has gone BLANK after a confirmed-broken determination is that
 * determination taking effect, not evidence it has gone stale.
 *
 * THE LOOP THIS CLOSES (found live 2026-09-01). A reviewer confirms a link
 * is dead with no replacement. WriteBack.gs then clears both the compliance
 * field and located_* in 50 States -- deliberately, so discovery starts
 * hunting again. The Live URL Checks URL formula reads the compliance
 * field, so it goes blank. The next sweep sees "URL changed" and wipes the
 * determination, the review date and the notes.
 *
 * The row is then unreviewed, with no URL to open, sitting in the queue
 * forever. Confirming a link is dead caused the system to forget anyone had
 * confirmed it -- and MCLA (167288) lost the only record of WHY: "I only
 * found this form students sign to say they won't haze, but I couldn't find
 * a hazing policy." That note survived nowhere but the execution log.
 *
 * SCOPED AS NARROWLY AS IT CAN BE. Only a blank current URL, only that one
 * determination. Every other clear still happens:
 *   - a URL that changed to a DIFFERENT address still clears, because the
 *     verdict was about the old page;
 *   - a blank URL under any other determination still clears, because
 *     "working as-is" about nothing is not a judgment worth keeping;
 *   - a status change on a still-present URL still clears.
 *
 * WHY NOT DELETE THE ROW INSTEAD. lucReconcile_ creates a row only where
 * the tracked field holds a URL, so a deleted row would come back on its
 * own the day the school publishes a policy -- which sounds clean until you
 * notice it also throws away the finding. Keeping the row keeps the verdict
 * and the notes, and Review resolved stays true, so it reads as finished
 * rather than pending. A finished row costs nothing; a lost finding costs a
 * reviewer's afternoon.
 *
 * WHAT THIS DOES NOT DO. It does not stop the row being re-judged if the
 * school later publishes something: a URL reappearing is a change from ''
 * to an address, which clears normally and puts the row back in the queue
 * against the new page. That is the correct moment to look again.
 */
function lucBrokenAndNowBlank_(prev, currentUrl) {
  return !String(currentUrl || '').trim() && prev.determination === LUC_DET_BROKEN;
}

function lucClearIfStale_(entry, prev, currentUrl, currentCode) {
  const hadSnapshot = !!(prev.snapUrl || prev.snapStatus);
  if (!hadSnapshot) return false;

  // See lucBrokenAndNowBlank_. Logged rather than silent: a review that
  // survives a staleness test for a stated reason should be as visible in
  // the log as one that gets discarded, or the next person debugging this
  // has no way to tell the guard from a bug.
  if (lucBrokenAndNowBlank_(prev, currentUrl)) {
    Logger.log('Kept review on ' + entry.label + ' -- URL is now blank, which is ' +
      'this determination ("' + LUC_DET_BROKEN + '") being applied by write-back, ' +
      'not the review going stale. Determination, notes and review date left alone.');
    return false;
  }

  const urlChanged    = (prev.snapUrl || '') !== (currentUrl || '');
  const statusChanged =
    lucStatusClass_(prev.snapStatus) !== lucStatusClass_(currentCode);
  if (!urlChanged && !statusChanged) return false;

  // Staleness is always DETECTED. Whether it is acted on is a separate
  // question -- see LUC_CLEAR_STALE_REVIEWS. Reporting without writing
  // turns a sweep into a dry run of the clearing logic: the log says how
  // many reviews would have gone, and against which signal, which is the
  // number worth seeing before this is ever switched on.
  if (!LUC_CLEAR_STALE_REVIEWS) {
    Logger.log('WOULD CLEAR (clearing disabled) ' + entry.label + ' -- ' +
      (urlChanged ? 'URL changed (was "' + prev.snapUrl + '", now "' + currentUrl + '")' : '') +
      (urlChanged && statusChanged ? '; ' : '') +
      (statusChanged ? 'status changed (was "' + prev.snapStatus + '", now "' + currentCode + '")' : '') +
      '. Review kept: "' + prev.determination + '"' +
      (prev.proposedUrl ? ' + proposed URL' : ''));
    return false;
  }

  entry.fields[LUC_F_SNAP_URL] = '';
  entry.fields[LUC_F_SNAP_STATUS] = '';
  entry.fields[LUC_F_SNAP_HASH] = '';
  entry.fields[LUC_F_DETERMINATION] = null;
  entry.fields[LUC_F_NOTES] = '';
  entry.fields[LUC_F_REVIEW_DATE] = null;  // date field: null, '' is a 422

  if (urlChanged && prev.proposedUrl) {
    entry.fields[LUC_F_PROPOSED_URL] = '';
  }

  // Log what was discarded. Nothing here is recoverable from the row once
  // written, so the execution log is the only record that a human verdict
  // existed at all -- worth having when someone asks why a row they
  // reviewed is back in the queue.
  Logger.log('Cleared review on ' + entry.label + ' -- ' +
    (urlChanged ? 'URL changed (was "' + prev.snapUrl + '", now "' + currentUrl + '")' : '') +
    (urlChanged && statusChanged ? '; ' : '') +
    (statusChanged ? 'status changed (was "' + prev.snapStatus + '", now "' + currentCode + '")' : '') +
    '. Discarded: determination "' + prev.determination + '"' +
    (urlChanged && prev.proposedUrl ? ', proposed URL "' + prev.proposedUrl + '"' : '') +
    (prev.notes ? ', notes "' + String(prev.notes).slice(0, 200) + '"' : ''));

  return true;
}

function lucCheckBatch_(rows, deadlineAt) {
  const results = [];
  const jobs = [];

  rows.forEach(function (r, idx) {
    const trackedName = r.fields[LUC_F_TRACKED] || '';
    const tracked = lucTrackedByName_(trackedName);
    const url = (r.fields[LUC_F_URL] || '').trim();

    const entry = {
      id: r.id,
      label: (r.fields[LUC_F_UNITID] || r.id) + ' / ' + (trackedName || '(no tracked field)'),
      tracked: tracked,
      fields: {},
      prev: {
        snapUrl: r.fields[LUC_F_SNAP_URL] || '',
        snapStatus: r.fields[LUC_F_SNAP_STATUS] || '',
        determination: r.fields[LUC_F_DETERMINATION] || '',
        proposedUrl: r.fields[LUC_F_PROPOSED_URL] || '',
        notes: r.fields[LUC_F_NOTES] || ''
      }
    };
    results.push(entry);

    // A row whose Tracked field is blank or off the catalog cannot be
    // checked and must not be silently stamped as checked -- that would
    // hide it from the due filter forever. Leave every field untouched so
    // it stays visible, and say so in the log.
    if (!tracked) {
      entry.skip = true;
      Logger.log('Row ' + entry.label + ' has an unrecognised Tracked field; skipped.');
      return;
    }
    // Unreachable while lucBuildDueFormula_ and lucTopUpNewRows_ both
    // filter on lucCheckedClause_ -- kept as a backstop in case a row
    // reaches here some other way, such as a stuck id parked before the
    // clause existed.
    if (!tracked.check) {
      entry.skip = true;
      return;
    }

    if (!url) {
      entry.fields[LUC_F_STATUS] = 'No URL';
      entry.fields[LUC_F_CODE] = '';
      entry.fields[LUC_F_REDIRECT] = '';
      entry.fields[LUC_F_HASH] = '';
      if (tracked.dateCheck) {
        entry.fields[LUC_F_CHTR_DATE_RESULT] = 'No URL';
        entry.fields[LUC_F_CHTR_LAST_UPDATED] = null;  // date field: null, not ''
      }
      lucClearIfStale_(entry, entry.prev, '', '');
      return;
    }

    // Malformed values never reach the fetch wave -- see lucIsFetchableUrl_
    // for what one bad URL costs the twenty-nine good ones beside it.
    // Recorded as Unconfirmed rather than Dead link on purpose: nobody has
    // established that the page is gone, only that what is stored cannot be
    // requested. That is a data-entry problem in 50 States, and it belongs
    // in front of a reviewer, which Unconfirmed puts it.
    if (!lucIsFetchableUrl_(url)) {
      entry.fields[LUC_F_STATUS] = 'Unconfirmed';
      entry.fields[LUC_F_CODE] = 'Malformed URL';
      entry.fields[LUC_F_REDIRECT] = '';
      if (tracked.dateCheck) lucMarkDateUnchecked_(entry);
      Logger.log('MALFORMED URL, not fetched -- ' + entry.label + ': "' + url + '"');
      return;
    }

    // KNOWN-UNFETCHABLE HOSTS NEVER ENTER THE WAVE. See
    // LUC_UNFETCHABLE_HOSTS for what one costs if it does, and for the
    // evidence required before adding to the list.
    //
    // Deliberately does NOT call lucClearIfStale_, unlike the other
    // non-fetch outcomes below. Those describe something we observed; this
    // one describes a decision not to look. A choice of ours must never
    // discard a human's verdict -- and the whole point of listing a host is
    // that its rows settle once, on a reviewer's judgment, and stay settled.
    //
    // The stored Content hash is left alone for the same reason: no page
    // was read, so there is nothing to say about whether it changed.
    if (lucIsKnownUnfetchable_(url)) {
      entry.fields[LUC_F_STATUS] = 'Unconfirmed';
      entry.fields[LUC_F_CODE] = 'Known unfetchable';
      entry.fields[LUC_F_REDIRECT] = '';
      if (tracked.dateCheck) lucMarkDateUnchecked_(entry);
      Logger.log('KNOWN UNFETCHABLE, not fetched -- ' + entry.label + ': ' + url);
      return;
    }

    jobs.push({ idx: idx, url: url });
  });

  const firstPass = lucFetchAllSafe_(
    jobs.map(function (j) { return lucRequest_(j.url); }), deadlineAt);

  // Anything still null after a deadline give-up was never tried. Flag those
  // rows so the write below leaves them alone -- see the note there.
  const abandoned = (deadlineAt && Date.now() > deadlineAt);
  if (abandoned) {
    jobs.forEach(function (j, i) {
      if (!firstPass[i]) results[j.idx].abandonedBisect = true;
    });
  }

  const responses = lucRetryFailures_(jobs, firstPass, deadlineAt);

  // Pass 1: status for every URL, and collect the CHTR redirect targets
  // that still need a date read.
  const redirectFollowUps = [];

  jobs.forEach(function (j, i) {
    const resp = responses[i];
    const entry = results[j.idx];
    // A fetch that threw never reaches lucInterpret_, so the address check
    // is applied here too -- same reasoning as the gate in lucInterpret_:
    // an IdP-shaped URL is a login wall even when nothing answered.
    const interpreted = resp
      ? lucInterpret_(resp, j.url)
      : { status: (LUC_DETECT_LOGIN_WALLS && lucMatchesAny_(LUC_LOGIN_URL_PATTERNS, j.url))
            ? 'Login required' : 'Site error',
          redirectTarget: '', code: 'Unreachable' };

    // AN ABANDONED BISECT IS NOT A RESULT, AND IT IS NOT A SITE ERROR EITHER.
    // Added 2026-08-28, corrected the same hour -- the first version of this
    // was wrong in an instructive way and the wrong version is recorded here
    // because the reasoning that produced it is tempting.
    //
    // THE PROBLEM. When lucFetchAllSafe_ runs out of budget mid-bisect it
    // returns null for every request in the group. Most of those URLs are
    // fine and were never actually tried. Recording them as
    // "Site error / Unreachable" stamps Last checked, drops them out of the
    // due set, and leaves them asserting a server failure nobody observed --
    // for 90 days, until the next sweep. First slice of the 2026-08-28 sweep:
    // 15 of 120 rows.
    //
    // THE FIRST FIX WAS TO SKIP THEM, leaving them due so the next slice
    // would retry. The stall guard was supposed to be the backstop against a
    // permanent loop. IT IS NOT: the guard compares the signature of the
    // whole 30-row fetch, and two sticky rows ride along with twenty-eight
    // fresh ones every time, so the signature never repeats and the guard
    // never fires. The poison URL simply re-poisoned every wave. Slice 1
    // processed 120 rows; slice 2, with the skip, processed 28.
    //
    // WHAT IT DOES NOW. Records Unconfirmed with the code "Bisect abandoned"
    // -- the same shape as the malformed-URL path above, and for the same
    // reason. Unconfirmed means "we established nothing, a human should
    // look," which is exactly true, where Site error claims a server failed
    // when no server was ever reached. The row leaves the due set so it
    // cannot re-poison the sweep, and the code makes every such row findable
    // in one filter afterwards.
    //
    // THE WORKED EXAMPLE, 2026-08-28: https://www.usu.edu/policies/2406/
    // (Utah State, 230728, Hazing Policy) threw "Address unavailable" after
    // 51 seconds. Five bisect levels re-fetch it, which is four minutes --
    // an entire slice budget. The page loads fine in a browser. The likely
    // cause is a network-level block on Google's IP ranges, which is a
    // different failure from the 403s LUC_USER_AGENT was written for: a WAF
    // answering 403 lets the connection complete, so a browser-shaped
    // request can talk it round, while this one never completes at all and
    // no header we send can reach it.
    //
    // Such a URL is permanently good and permanently unfetchable by this
    // checker. Nothing in code fixes that. What handles it is a reviewer
    // marking the row Working as-is once: lucStatusClass_ counts Unreachable
    // as 'present', so the verdict never goes stale and never returns. If
    // these accumulate, a known-unfetchable list checked before the fetch
    // wave would be worth the code. At one URL costing four minutes every 90
    // days, it is not.
    if (!resp && entry.abandonedBisect) {
      entry.fields[LUC_F_STATUS]   = 'Unconfirmed';
      entry.fields[LUC_F_CODE]     = 'Bisect abandoned';
      entry.fields[LUC_F_REDIRECT] = '';
      if (entry.tracked.dateCheck) lucMarkDateUnchecked_(entry);
      lucClearIfStale_(entry, entry.prev, j.url, 'Unreachable');
      return;
    }

    entry.fields[LUC_F_STATUS] = interpreted.status;
    entry.fields[LUC_F_CODE] = interpreted.code;
    entry.fields[LUC_F_REDIRECT] = interpreted.redirectTarget;

    // Hash only where there is a readable body. Redirects, 401/403/5xx and
    // unreachable leave the stored hash alone -- see lucContentHash_.
    if (interpreted.status === 'Live' && resp) {
      const h = lucContentHash_(resp);
      if (h) entry.fields[LUC_F_HASH] = h;
    } else if (interpreted.status === 'Dead link') {
      entry.fields[LUC_F_HASH] = '';
    }

    lucClearIfStale_(entry, entry.prev, j.url, interpreted.code);

    if (!entry.tracked.dateCheck) return;

    // "Date not found on page" means something precise: we read the page
    // and nothing matched. If we never got a readable page -- blocked,
    // dead, behind a login, server down -- that is "Unable to check",
    // because claiming we looked would be false.
    if (interpreted.status === 'Redirected' && interpreted.redirectTarget) {
      redirectFollowUps.push({ idx: j.idx, url: interpreted.redirectTarget });
    } else if (resp && interpreted.status === 'Live') {
      lucApplyDate_(entry, lucExtractDate_(resp));
    } else {
      lucMarkDateUnchecked_(entry);
    }
  });

  // Pass 2: one batched round of redirect destinations for the date read.
  // Skipped when the slice is out of time -- the statuses are already
  // recorded by this point, so only the date is lost, which beats starting
  // a third unbounded wave and having the execution killed with the
  // statuses still unwritten.
  if (redirectFollowUps.length && deadlineAt && Date.now() > deadlineAt) {
    // Skipping the fetch is fine. Skipping the WRITE is not: leaving the
    // field alone lets a previous sweep's verdict sit there looking
    // current, because Last checked gets stamped either way.
    Logger.log('Past deadline; ' + redirectFollowUps.length +
      ' redirect target(s) marked Unable to check without being read.');
    redirectFollowUps.forEach(function (f) { lucMarkDateUnchecked_(results[f.idx]); });
  } else if (redirectFollowUps.length) {
    const destResponses = lucFetchAllSafe_(redirectFollowUps.map(function (f) {
      return Object.assign(lucRequest_(f.url), { followRedirects: true });
    }), deadlineAt);

    redirectFollowUps.forEach(function (f, i) {
      const destResp = destResponses[i];
      lucApplyDate_(results[f.idx], destResp ? lucExtractDate_(destResp) : null);
    });
  }

  return results.filter(function (e) { return !e.skip; });
}

/**
 * Writes BOTH date fields, always. Never one without the other.
 *
 * Leaving the found date untouched when this run found nothing would put a
 * stale date next to a fresh "Date not found on page" and a fresh Last
 * checked, which together read as "we just verified this date". Clearing
 * it is the only honest option: we did look, and there was nothing there.
 */
function lucApplyDate_(entry, isoDate) {
  if (isoDate) {
    entry.fields[LUC_F_CHTR_LAST_UPDATED] = isoDate;
    entry.fields[LUC_F_CHTR_DATE_RESULT] = 'Date found';
  } else {
    entry.fields[LUC_F_CHTR_LAST_UPDATED] = null;  // date field: null, '' is a 422
    entry.fields[LUC_F_CHTR_DATE_RESULT] = 'Date not found on page';
  }
}

function lucMarkDateUnchecked_(entry) {
  entry.fields[LUC_F_CHTR_LAST_UPDATED] = null;
  entry.fields[LUC_F_CHTR_DATE_RESULT] = 'Unable to check';
}


// =========================================================================
// WRITING BACK
// =========================================================================
function lucPatch_(pat, entries, today) {
  const payload = {
    records: entries.map(function (e) {
      const fields = {};
      for (const k in e.fields) fields[k] = e.fields[k];
      fields[LUC_F_LAST_CHECKED] = today;  // stamped every run, always
      return { id: e.id, fields: fields };
    })
  };
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CHECKS_TABLE,
    {
      method: 'patch',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  Utilities.sleep(210);
  return { ok: resp.getResponseCode() === 200, error: resp.getContentText() };
}

// =========================================================================
// WHAT USED TO BE HERE
//
// Roughly 280 lines of one-time migration removed 2026-08-28:
// lucMigrateReviews_, lucDeleteMigratedComplianceRows_,
// lucCheckTransparencyReportSafe and lucDeleteAllTransparencyReportRows_.
//
// They existed to move human reviews off the raw compliance-field rows
// (Transparency Report, Hazing Policy, Report Form) and onto the located_*
// rows that replaced them, then delete the originals once the move was
// verified.
//
// THAT DIRECTION WAS REVERSED LATER THE SAME DAY. This note used to end
// "those three categories held zero rows, and their options have been
// deleted from the Tracked field select, so nothing can create another one."
// Every clause of that is now false: the options were re-added, the three
// categories are the only ones tracked, and they hold all 2,632 rows. The
// sentence survived about six hours.
//
// It is left here, corrected rather than deleted, as the clearest example in
// this file of why the project's first rule is to check the base instead of
// trusting a comment. A confident note about a vocabulary is exactly the
// thing that goes stale first, and it reads as authoritative the whole time
// it is wrong.
//
// The code itself is still gone, for the original reason: dead code naming a
// retired vocabulary reads as evidence the vocabulary is live. Git history
// has it if the shape is ever needed.
// =========================================================================


/**
 * Returns { writeErrors, failedIds }. failedIds matters: the caller needs
 * to know exactly which rows did NOT save, because an unsaved row is still
 * due and will come back around. Counting it as processed would inflate
 * progress past the total and hide the failure.
 */
function lucWriteBack_(pat, results) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const writeErrors = [];
  const failedIds = [];

  for (let i = 0; i < results.length; i += LUC_WRITE_BATCH) {
    const batch = results.slice(i, i + LUC_WRITE_BATCH);
    const first = lucPatch_(pat, batch, today);
    if (first.ok) continue;

    // Airtable's PATCH is all-or-nothing per batch: one row with a bad
    // value takes its nine batch-mates down with it and their good results
    // are lost. Unattended that quietly discards up to nine good checks
    // per bad row, so retry one at a time to isolate the real offender.
    // Costs ten extra calls, and only when something is already wrong.
    Logger.log('Write batch at ' + i + ' failed; retrying individually. ' + first.error);

    batch.forEach(function (entry) {
      const retry = lucPatch_(pat, [entry], today);
      if (!retry.ok) {
        failedIds.push(entry.id);
        writeErrors.push({ row: entry.label, airtableError: retry.error });
        Logger.log('Row ' + entry.label + ' would not save: ' + retry.error);
      }
    });
  }

  return { writeErrors: writeErrors, failedIds: failedIds };
}