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
// AMENDED 2026-10-06: that still holds for every row WITH a determination.
// On rows with NO determination there is no verdict to re-baseline, and the
// script now writes the trio there as the page's "before" copy. See
// "PAGE-CHANGE WATCHING, STEP 1" below.
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
// 2026-10-04: below-standard reasons came back to Live URL Checks in a new
// form -- three tick fields that write-back applies to 50 States (see
// WriteBack.gs). This file never reads them; it only empties them when it
// clears a stale review (LUC_F_BELOW_TICKS).
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
//
// -------------------------------------------------------------------------
// PAGE-CHANGE WATCHING, STEP 1  (added 2026-10-06, tracker #36)
// -------------------------------------------------------------------------
// Three changes, so that a later step can act when a page changes:
//
// 1. BELOW-STANDARD PAGES ARE WATCHED. A school's record field (chtr_index_url,
//    located_hazing_policy_url, located_report_form_url) can hold the right
//    page while the published field is blank or different, because the page
//    falls short of the standard. Those pages were never checked. They now
//    get their own rows, under three "(below standard)" Tracked options. The
//    rule, not a list, decides which: a row exists while the record field
//    holds a URL that differs from the published field (337 on 2026-10-06:
//    328 record-only, 9 where the two fields differ). When the two become the
//    same, or the record goes blank, the row is kept but marked "Not watched"
//    (blank Link status) and no longer fetched, so a published page is not
//    watched twice. Write-back skips these rows (it only knows the three
//    published options), and the review email leaves them out.
//
// 2. THE "BEFORE" COPY. To notice a change, each address needs a fingerprint
//    taken at a known point. That is the snapshot trio (Checked URL snapshot,
//    Checked status snapshot, Content hash snapshot). Until now only the
//    reviewer automation wrote it, so an unreviewed row had nothing to compare
//    against. Now, on a row with NO Reviewer determination, this script takes
//    the trio itself the first time it reads the address with a readable
//    body, and takes it again when the address changes or the page crosses
//    between there and gone. "Page changed since review" therefore also works
//    on unreviewed rows: it means "changed since the before copy".
//    On a REVIEWED row the automation still owns the trio; the script only
//    fills a missing Content hash snapshot while the review is still valid
//    (same address, same status class), exactly as lucRestampSnapshots did.
//    The script writes all three together on unreviewed rows: writing the
//    address without the status would make every sweep look like a status
//    change.
//
// 3. REDIRECTS ARE FOLLOWED. A link that forwards elsewhere stays "Redirected",
//    but the page it lands on is now fetched and fingerprinted, so a moved
//    page with new content (or a redirect to a home page) shows as a change,
//    and one that only moved from http to https does not. If the landing page
//    is a sign-in page, the row becomes "Login required".
//
// -------------------------------------------------------------------------
// PAGE-CHANGE ROWS, STEP 2  (added 2026-10-06, tracker #36)
// -------------------------------------------------------------------------
// When a check reads a page whose fingerprint differs from its before copy,
// this file creates a new Candidate URLs row for the address being checked,
// with Source "Page change", so the pre-filter and the AI check can judge the
// page again. The original candidate row, if any, is left alone as history.
//
// ONE CHANGE, ONE ROW. "Page change reported fingerprint" remembers which
// version was sent. A row is created only when the new fingerprint differs
// from the before copy AND from the last one reported. The before copy is not
// moved, so "Page changed since review" stays on until someone reviews again.
//
// WHEN NOTHING IS SENT: no readable page this check; no before copy yet; the
// before copy was for a different address or status class (that is a new
// page, not a changed one); or a review was cleared this check.
//
// CAPTURED AT ONCE. At the end of each slice, Page change rows still "Not yet
// fetched" are read with the capture code in SitemapFinder.gs (capOneRow_),
// which also sets Pre-filter result. Otherwise they would wait for the
// pipeline's capture stage, which can be weeks away. Capture is told the row
// has a decision so its stub chase never moves the address off the published
// page. Rows not reached stay "Not yet fetched"; the next slice, or the
// pipeline, reads them.
//
// WHO LOOKS: the "Re-check outcome" formula in Candidate URLs (named "Page
// change outcome" until 2026-10-06) says "Needs a person", "No review
// needed", "Waiting for AI" or "Waiting for capture". The AI check is run by
// hand on Passed rows. The sweep email counts rows needing a person and rows
// waiting for the AI.
//
// -------------------------------------------------------------------------
// MANUAL ENTRY ROWS, STEP 4  (added 2026-10-06, tracker #36)
// -------------------------------------------------------------------------
// A CHTR or hazing policy address can reach 50 States without anyone judging
// it against the standard: typed in by hand, or applied by write-back from a
// reviewer's "Fixed - new URL". When a check finds such an address, this file
// creates a Candidate URLs row for it with Source "Manual entry", which then
// goes through capture, the pre-filter and the AI check like a Page change row.
//
// WHAT COUNTS AS A NEW ADDRESS:
//   - a row whose snapshot address differs from its Current URL (the address
//     changed since the before copy or the review), or
//   - a row created after LUC_MANUAL_SINCE that is being read for the first
//     time (a school gained a link, or a page was moved to its record field).
//   Rows that existed before LUC_MANUAL_SINCE and have no snapshot yet are
//   NOT new: their first before copy is just catching up.
// WHAT IS SKIPPED: report forms (trusted as entered; the AI does not judge
// them), and any address an accepted candidate row already backs (Accept or
// Hold on a Candidate URLs row for the same school and category, matching its
// Candidate URL, Reviewer-proposed URL or Review URL). Promote's own writes
// are always backed this way.
//
// UNREADABLE PAGES: so that a new address on a page this checker can never
// read (403 and similar) is still noticed, an unreviewed row with no readable
// page now records the address and status in the snapshot fields with a blank
// Content hash snapshot. "Page changed since review" needs a fingerprint on
// both sides, so it is unaffected.
//
// If the row cannot be created, the snapshot is left as it was, so the next
// check sees the same new address and tries again.
//
// -------------------------------------------------------------------------
// CHTR DATE CHECKS, STEP 5  (added 2026-10-06, tracker #36)
// -------------------------------------------------------------------------
// People record each published CHTR's date on the CHTR links page ("CHTR
// update date", "Date is on"); formulas turn it into "Date check due" and the
// "Needs a date" / "Freshness check" labels in "Why it's here". This file does
// two small things for it (lucNoteChtrAddress_): on a published CHTR row that
// is new or whose address changed, it sets "First date check" to today so the
// row comes up as "Needs a date" at once, and on an address change it empties
// the old page's date. Existing CHTRs are released by the backlog step. The
// sweep email also counts yearly report form checks and CHTR date checks due
// (lucCountDueLooks_).
//
// -------------------------------------------------------------------------
// THE BACKLOG, STEP 6  (added 2026-10-06, tracker #36)
// -------------------------------------------------------------------------
// Many existing pages were added by hand and never judged against the current
// standard. Once a day, lucRunBacklog_ sends LUC_BACKLOG_PER_DAY of them as
// "Backlog check" rows in Candidate URLs (published CHTRs, then published
// policies, then below-standard ones), marks them in "Standard last judged",
// and releases each published CHTR's date check. Page change and Manual entry
// rows fill "Standard last judged" too, so nothing is checked twice. It stops
// by itself when no page is left.
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

// LUC_F_CHTR_LAST_UPDATED ('fldfFB8XvOTuISf5p') and LUC_F_CHTR_DATE_RESULT
// ('fld6BX7MLCOLbCK9R') were removed 2026-10-04 with the CHTR date read.
// The date read never worked reliably enough to use; a person judges the
// 12-month rule instead. Delete the two Airtable fields only AFTER this file
// is deployed -- the old code writes them, and a write to a deleted field
// fails the whole batch.

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
// Lookups of the three PUBLISHED Institutions fields, already on this table.
// Read only to decide whether a below-standard row is still watched (its
// address must differ from the published one). Added 2026-10-06.
const LUC_F_SRC_CHTR      = 'fldBiCRimNasigH0O';   // src Transparency Report
const LUC_F_SRC_POLICY    = 'fldVLVitM6kQOrSOO';   // src Hazing Policy
const LUC_F_SRC_FORM      = 'fldiDcJy8vyOhxkYv';   // src Report Form
// Which page version was last sent to Candidate URLs (added 2026-10-06).
const LUC_F_CHANGE_FP     = 'fldb9cXfQiKeHAxVV';   // Page change reported fingerprint
const LUC_F_CHANGE_DATE   = 'fldhAVUhmffZQpjEZ';   // Page change reported date
// CHTR date checks (added 2026-10-06, step 5). Typed by reviewers on the CHTR
// links page; this file only clears the first two when a CHTR row's address
// changes, and sets First date check on a new or changed CHTR row.
const LUC_F_CHTR_DATE     = 'fldBTIggpm9UTeQyC';   // CHTR update date (text)
const LUC_F_DATE_ON       = 'fldaD7TWCyznzbkNV';   // Date is on (single select)
const LUC_F_FIRST_DATE    = 'fldp2DeV1IN3MiORF';   // First date check (date)
const LUC_F_WHY           = 'fldSBlEfYkBLqST4F';   // Why it's here (formula)
// Backlog (added 2026-10-06, step 6).
const LUC_F_STD_JUDGED    = 'fldKCwXLVg3tpcHpX';   // Standard last judged (date)

// ---- Candidate URLs, for Page change rows (added 2026-10-06) ------------
const LUC_CAND_TABLE      = 'tblIL5opnHj0lhvvg';
const LUC_C_UNITID        = 'fldRicdqQxfBxUGBH';
const LUC_C_INSTITUTION   = 'fldhbnSdGI8PFQQc7';   // link -> Institutions (same table as ours)
const LUC_C_CATEGORY      = 'fld5QoBkGbSZNla35';
const LUC_C_URL           = 'fldzInwsPk3pI4PoT';   // Candidate URL
const LUC_C_SOURCE        = 'fldDgMOzWYGMEL4Xd';
const LUC_C_FETCH         = 'fldhrl2Cfiiw8pAng';   // Fetch status
const LUC_C_DETERMINATION = 'flds5qRgFKkdvLjK0';
const LUC_C_OUTCOME       = 'fldZsxzEJBKBQhiKI';   // Re-check outcome (formula; was Page change outcome)
// Must match the Source option and the Fetch status option EXACTLY: rows are
// created without typecast, so a missing option fails the batch (logged).
const LUC_SOURCE_PAGE_CHANGE = 'Page change';
const LUC_SOURCE_MANUAL      = 'Manual entry';   // step 4, 2026-10-06
const LUC_SOURCE_BACKLOG     = 'Backlog check';  // step 6, 2026-10-06
// THE BACKLOG PACE: how many existing pages are sent for a standards check
// each day. One number; change it here. At 3 a day the ~1,800 CHTR and policy
// pages take about 18 months.
const LUC_BACKLOG_PER_DAY    = 3;
// Most rows a backlog run will look at before giving up for the day, so a long
// run of already-backed pages cannot eat a slice. Backed rows are marked
// judged, so the next day starts past them.
const LUC_BACKLOG_MAX_LOOKS  = 30;
const LUC_BACKLOG_DAY_KEY    = 'LUC_BACKLOG_LAST_DAY';
// Order: published CHTRs, then published hazing policies, then below-standard.
const LUC_BACKLOG_ORDER = [
  ['Transparency Report'],
  ['Hazing Policy'],
  ['Transparency Report (below standard)', 'Hazing Policy (below standard)']
];
// Rows created before this moment are never treated as a new address on their
// first read (midnight 2026-10-07 Pacific). See "MANUAL ENTRY ROWS, STEP 4".
const LUC_MANUAL_SINCE       = '2026-10-07T07:00:00.000Z';
// Only these Candidate URLs categories get Manual entry rows.
const LUC_MANUAL_CATEGORIES  = ['CHTR', 'Hazing Policy'];
const LUC_C_PROPOSED_URL     = 'fldnX2cl803TQJrNY';   // Reviewer-proposed URL
const LUC_C_REVIEW_URL       = 'fld91PUEMATcrMOWU';   // Review URL (formula)
const LUC_DET_ACCEPT         = 'Accept - meets standard';
const LUC_DET_HOLD           = 'Hold - correct page below standard';
const LUC_FETCH_NOT_YET      = 'Not yet fetched';
const LUC_CAPTURE_MIN_MS     = 30000;   // below this, leave capture to the next slice
// The reviewer's below-standard ticks, one per category (added 2026-10-04).
// Write-back reads them; this file only ever empties them, alongside the
// determination, when a review goes stale -- so a ticked reason can never be
// carried over onto a new page. Not in LUC_READ_FIELDS: never read here.
const LUC_F_BELOW_TICKS   = ['fldgfMu6RujSpxcSn',   // CHTR below standard
                             'fldjIEUMM0ers0Z4Q',   // Hazing policy below standard
                             'fldjEkPZeBaqGDyac'];  // Report form below standard

// ---- Institutions fields (synced -- read only, never written) -----------
const LUC_I_UNITID = 'fldGREvzCIme6HXfl';
const LUC_I_NAME   = 'fldHvefXrrPxibBsZ';

/**
 * THE CATALOG. Every tracked field and the Institutions column it reads.
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
 * `dateCheck` (the CHTR "last updated" read) was removed 2026-10-04.
 *
 * THIS ARRAY IS THE ONLY PLACE THAT DECIDES WHICH CATEGORIES ARE LIVE.
 * lucReconcile_ gates row creation on `check`, and lucBuildDueFormula_ and
 * lucTopUpNewRows_ both filter on it via lucCheckedTrackedNames_. Adding a
 * category is a new option on the select plus a line here; nothing else
 * needs to change.
 */
const LUC_TRACKED = [
  // `candCategory` is the Candidate URLs Category a Page change row gets.
  { name: 'Transparency Report', instField: 'fldGJPC0iyuPcWtlK', check: true, srcField: LUC_F_SRC_CHTR,
    candCategory: 'CHTR' },
  { name: 'Hazing Policy',       instField: 'fldD9gEpDcw2l35II', check: true, srcField: LUC_F_SRC_POLICY,
    candCategory: 'Hazing Policy' },
  { name: 'Report Form',         instField: 'fldIrTzWzi87nD7EU', check: true, srcField: LUC_F_SRC_FORM,
    candCategory: 'Report Form' },

  // BELOW-STANDARD PAGES (added 2026-10-06). `watchOf` names the published
  // entry this one shadows. instField is the RECORD field. A row exists and
  // is fetched only while the record URL differs from the published URL --
  // see "PAGE-CHANGE WATCHING, STEP 1" in the header. `email: false` keeps
  // them out of the sweep email until they have a review workflow.
  // The Current URL formula must read the record-field lookup for each of
  // these names, or every one of these rows reads as "Not watched". Those
  // lookups (added 2026-10-06): src chtr_index_url fldDP0cUAhDifB8gd,
  // src located_hazing_policy_url fld1udS45mefOcflr, src located_report_form_url
  // fldxMck8O1gNpEdDF. The names below must also exist as Tracked field
  // options, or lucCreateRows_ fails (no typecast).
  { name: 'Transparency Report (below standard)', instField: 'fldqQrSD83OVoteFx', check: true,
    watchOf: 'Transparency Report', email: false, candCategory: 'CHTR' },
  { name: 'Hazing Policy (below standard)',       instField: 'fldKyIAd65Yfn5g0V', check: true,
    watchOf: 'Hazing Policy',       email: false, candCategory: 'Hazing Policy' },
  { name: 'Report Form (below standard)',         instField: 'fldeBRiCU8dnIKsYk', check: true,
    watchOf: 'Report Form',         email: false, candCategory: 'Report Form' }
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

/**
 * Same shape as lucCheckedClause_, but only the categories counted in the
 * sweep email. Below-standard rows are checked but not emailed (2026-10-06).
 */
function lucEmailClause_() {
  const names = LUC_TRACKED.filter(function (t) { return t.check && t.email !== false; })
    .map(function (t) { return t.name; });
  return 'OR(' + names.map(function (n) {
    return '{' + LUC_F_TRACKED + '} = "' + n + '"';
  }).join(', ') + ')';
}

/** The published entry a below-standard entry shadows, or null. */
function lucPublishedOf_(tracked) {
  return (tracked && tracked.watchOf) ? lucTrackedByName_(tracked.watchOf) : null;
}

/**
 * The watch rule for a below-standard row: watched while the record URL is
 * present and differs from the published URL. Both are compared as stored
 * (trimmed), the same way each row's own URL is fetched.
 */
function lucIsWatched_(recordUrl, publishedUrl) {
  const r = String(recordUrl || '').trim();
  const p = String(publishedUrl || '').trim();
  return !!r && r !== p;
}

// What a below-standard row records when the rule says it is no longer
// watched. Link status is left BLANK, so the email, the review views and
// lucStatusClass_ all ignore the row; the code says why.
const LUC_NOT_WATCHED_CODE = 'Not watched: record field blank or same as published';

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
  'osccr.sites.northeastern.edu',    // Northeastern     167358  Hazing Policy
  'hazefree.mit.edu'                // MIT              166683  Transparency Report + Hazing Policy (hangs ~100s in a batch, 2026-10-06)
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
 * SET TO 7 DAYS ON 2026-09-26 (was a 90-day placeholder; Jolayne had asked
 * for quarterly, biweekly was the counter-proposal). Reason: HazingInfo
 * publishes these links, so a link that stops working should be caught
 * within days, not months. A full sweep of ~2,600 links took 12 slices
 * (2026-08-28), about 3 days on the 4-hourly trigger, so every link is
 * rechecked roughly every 10 days. The gap is counted from when the last
 * sweep FINISHED. Whatever is settled, it is this one number, not an
 * emergent side effect of when someone last pressed a button.
 */
const LUC_MIN_SWEEP_INTERVAL_DAYS = 7;

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

// DATE EXTRACTION WAS HERE, REMOVED 2026-10-04. It read a "last updated"
// date off CHTR pages so the 12-month rule could be a formula. It never
// worked reliably enough to use: most pages state no date in a readable
// form, and incident dates were mistaken for page dates. People judge the
// 12-month rule now. The full code is in the GitHub history before this date.

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
        let url = lucFirstUrl_(inst.fields[t.instField]);
        // Below-standard entries: only while the record differs from the
        // published field (2026-10-06). An existing row that no longer
        // qualifies is kept and counted below as "no longer watched".
        const pub = lucPublishedOf_(t);
        if (pub && !lucIsWatched_(url, lucFirstUrl_(inst.fields[pub.instField]))) url = '';
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
        ' -- kept, and the next check slice will mark them "No URL" (below-standard ' +
        'rows: "Not watched"). Not deleted: the field held something once and ' +
        'somebody may have judged it.');
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

// The CHTR-only date re-sweep (lucChtrDateResweep and friends) was removed
// 2026-10-04 along with the date read. See LUC_F_CHTR_LAST_UPDATED's note.

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

        // Read any Page change rows still waiting (2026-10-06).
        lucRunBacklog_(pat, budgetMs - (Date.now() - toppedStartedAt));
        lucCapturePageChanges_(pat, budgetMs - (Date.now() - toppedStartedAt));

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
    // Read the Page change rows this slice created, with what is left of its
    // budget (2026-10-06). Before the email, so its counts are current.
    lucRunBacklog_(pat, budgetMs - (Date.now() - startedAt));
    lucCapturePageChanges_(pat, budgetMs - (Date.now() - startedAt));

    if (done) {
      lucCleanUpAbandoned_(budgetMs - (Date.now() - startedAt), 'after the sweep');
      // ONE EMAIL PER FINISHED SWEEP, and only if a person has something to
      // do (added 2026-09-26). Placed after the clean-up so the counts are
      // the queue someone will actually open.
      lucEmailReviewQueue_(pat, state);
    }

    return { done: done, processed: state.processed, summary: state.summary };
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// THE REVIEW-QUEUE EMAIL  (added 2026-09-26)
// =========================================================================
// Sent once, when a sweep finishes, and only when there is work. Counts,
// not a list: the table is the list. Work = a link that is not Live and has
// no settled review (blank, or "Needs second opinion"), counted by Link
// status. Only the three tracked fields the sweep checks are counted (see
// lucCheckedClause_); the retired located_* rows are not.
//
// "Page changed since review" rows are not counted as Live URL Checks work.
// A changed page becomes a "Page change" row in Candidate URLs (see the
// header), and the email counts those instead: rows needing a person and rows
// waiting for the AI check (lucCountPageChanges_).
const LUC_REVIEW_VIEW_URL =
  'https://airtable.com/appEvOdPi94MzZ6Db/tblgX19rRaysxSlNu/viwnFpM7grpz26dpi';
const LUC_STATUS_ORDER = ['Dead link', 'Site error', 'Unconfirmed', 'Login required',
  'Redirected', 'No URL'];
const LUC_STATUS_MEANING = {
  'Dead link':      'the server says the page is not there',
  'Site error':     'the server failed, or the request never landed',
  'Unconfirmed':    'the server refused us; says nothing about whether the page exists',
  'Login required': 'the page exists but is behind a sign-in',
  'Redirected':     'it forwards somewhere else; see Redirect target',
  'No URL':         'the tracked column has gone blank since this row was created'
};

function lucEmailReviewQueue_(pat, state) {
  try {
    // lucEmailClause_, not lucCheckedClause_: below-standard rows are checked
    // but not counted here (2026-10-06).
    const formula = 'AND(' + lucEmailClause_() + ', ' +
      '{' + LUC_F_STATUS + '} != "Live", {' + LUC_F_STATUS + '} != "", ' +
      'OR({' + LUC_F_DETERMINATION + '} = "", {' + LUC_F_DETERMINATION +
      '} = "Needs second opinion"))';
    const rows = lucListAll_(pat, LUC_CHECKS_TABLE, [LUC_F_STATUS], formula);

    const byStatus = {};
    rows.forEach(function (r) {
      const st = (r.fields || {})[LUC_F_STATUS] || '';
      if (st) byStatus[st] = (byStatus[st] || 0) + 1;
    });
    const toReview = rows.length;

    // Page change rows in Candidate URLs (2026-10-06): undecided rows that
    // need a person, and rows waiting for someone to run the AI check.
    const pc = lucCountPageChanges_(pat);

    Logger.log('Review queue after the sweep: ' + toReview + ' link(s) to check; ' +
      'page changes: ' + pc.needsPerson + ' need a person, ' + pc.waitingForAi +
      ' waiting for the AI check.');
    // Yearly report form looks and CHTR date checks due (2026-10-06).
    const due = lucCountDueLooks_(pat);
    const dueTotal = due.yearly + due.needsDate + due.freshness;
    Logger.log('Due for a look: ' + due.yearly + ' yearly report form check(s), ' +
      due.needsDate + ' CHTR(s) needing a date, ' + due.freshness + ' CHTR freshness check(s).');

    if (!toReview && !pc.needsPerson && !pc.waitingForAi && !dueTotal) {
      Logger.log('Nothing needs a person -- no email sent.');
      return;
    }

    let body = '<p>The Live URL Checks sweep finished' +
      (state && state.finishedAt ? ' (' + state.finishedAt.slice(0, 10) + ')' : '') + '.</p>';

    if (dueTotal) {
      body += '<p><b>Due for a look</b> (Live URL Checks, \"To review\" on each link page):</p><ul>' +
        (due.needsDate ? '<li><b>CHTRs needing a date: ' + due.needsDate + '</b> &mdash; ' +
          'record CHTR update date and Date is on (CHTR links page).</li>' : '') +
        (due.freshness ? '<li><b>CHTR freshness checks: ' + due.freshness + '</b> &mdash; ' +
          'the recorded date is 12 months old: type the newer date, or tick ' +
          '\"CHTR older than 12 months\".</li>' : '') +
        (due.yearly ? '<li><b>Yearly report form checks: ' + due.yearly + '</b> &mdash; ' +
          'open the form, then tick \"Yearly report form check\" (Report form links page).</li>' : '') +
        '</ul>';
    }

    if (pc.needsPerson || pc.waitingForAi) {
      body += '<p><b>Pages to re-check against the standard</b> (Candidate URLs, Source ' +
        '"Page change" or "Manual entry"):</p><ul>' +
        (pc.waitingForAi ? '<li><b>Waiting for the AI check: ' + pc.waitingForAi + '</b> &mdash; ' +
          'open the rows whose Re-check outcome is "Waiting for AI" and run the AI ' +
          'Review field on them.</li>' : '') +
        (pc.needsPerson ? '<li><b>Need a person: ' + pc.needsPerson + '</b> &mdash; ' +
          'Re-check outcome "Needs a person" with no Reviewer determination. Review them ' +
          'in Candidate URL Review like any other candidate.</li>' : '') +
        '</ul>';
    }

    if (!toReview) {
      lucNotify_('Live URL Checks: ' + (pc.needsPerson + pc.waitingForAi + dueTotal) +
        ' item(s) to look at', body);
      return;
    }

    body += '<p><b>' + toReview + ' link(s) need checking:</b></p><ul>';
    const seen = {};
    LUC_STATUS_ORDER.concat(Object.keys(byStatus)).forEach(function (st) {
      if (!byStatus[st] || seen[st]) return;
      seen[st] = true;
      body += '<li><b>' + st + ': ' + byStatus[st] + '</b>' +
        (LUC_STATUS_MEANING[st] ? ' &mdash; ' + LUC_STATUS_MEANING[st] : '') + '</li>';
    });
    body += '</ul>';
    body += '<p><b>Where to check:</b> PAGES base &rarr; <b>Live URL Checks</b> table &rarr; ' +
      '<a href="' + LUC_REVIEW_VIEW_URL + '">Needs review</a> view. Open each link in a ' +
      'browser, then set <b>Reviewer determination</b>: <i>Working as-is</i>, ' +
      '<i>Fixed - new URL</i> (with Reviewer-proposed URL), or <i>Confirmed broken - no ' +
      'replacement found</i>. Write-back publishes Fixed and Confirmed broken to 50 States ' +
      'the next night.</p>';

    lucNotify_('Live URL Checks: ' + toReview + ' link(s) to check', body);
  } catch (e) {
    // Never let the email take down the slice that finished the sweep.
    Logger.log('Review-queue email skipped: ' + e);
  }
}

/**
 * Counts Live URL Checks rows due a yearly report form check or a CHTR date
 * check, from the "Why it's here" labels (added 2026-10-06). Never throws.
 */
function lucCountDueLooks_(pat) {
  const out = { yearly: 0, needsDate: 0, freshness: 0 };
  try {
    const formula = 'OR(FIND("Yearly look", {' + LUC_F_WHY + '}), ' +
      'FIND("Needs a date", {' + LUC_F_WHY + '}), FIND("Freshness check", {' + LUC_F_WHY + '}))';
    lucListAll_(pat, LUC_CHECKS_TABLE, [LUC_F_WHY], formula).forEach(function (r) {
      const w = String((r.fields || {})[LUC_F_WHY] || '');
      if (w.indexOf('Yearly look') === 0) out.yearly++;
      else if (w.indexOf('Needs a date') === 0) out.needsDate++;
      else if (w.indexOf('Freshness check') === 0) out.freshness++;
    });
  } catch (e) {
    Logger.log('Could not count due looks: ' + e);
  }
  return out;
}

/**
 * Airtable formula clause matching the rows this file creates in Candidate
 * URLs to re-check a page: Source "Page change" or "Manual entry".
 */
function lucRecheckSourceClause_() {
  return 'OR({' + LUC_C_SOURCE + '} = "' + LUC_SOURCE_PAGE_CHANGE + '", ' +
    '{' + LUC_C_SOURCE + '} = "' + LUC_SOURCE_MANUAL + '", ' +
    '{' + LUC_C_SOURCE + '} = "' + LUC_SOURCE_BACKLOG + '")';
}

/**
 * Counts Page change rows by what they are waiting for (added 2026-10-06).
 * Reads the "Re-check outcome" formula. Never throws: on an error it
 * returns zeros and logs, so the sweep email still goes out.
 */
function lucCountPageChanges_(pat) {
  const out = { needsPerson: 0, waitingForAi: 0 };
  try {
    const formula = 'AND(' + lucRecheckSourceClause_() + ', ' +
      '{' + LUC_C_DETERMINATION + '} = "", ' +
      'OR({' + LUC_C_OUTCOME + '} = "Needs a person", {' + LUC_C_OUTCOME + '} = "Waiting for AI"))';
    lucListAll_(pat, LUC_CAND_TABLE, [LUC_C_OUTCOME], formula).forEach(function (r) {
      const o = (r.fields || {})[LUC_C_OUTCOME] || '';
      if (o === 'Needs a person') out.needsPerson++;
      else if (o === 'Waiting for AI') out.waitingForAi++;
    });
  } catch (e) {
    Logger.log('Could not count Page change rows: ' + e);
  }
  return out;
}

function lucNotify_(subject, htmlBody) {
  const override = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  const to = (override && override.trim()) || Session.getEffectiveUser().getEmail();
  try {
    MailApp.sendEmail({
      to: to,
      subject: '[HazingInfo] ' + subject,
      htmlBody: htmlBody +
        '<hr><p style="color:#666;font-size:12px">Sent by LiveUrlChecks.gs. ' +
        'Change the recipient with the NOTIFY_EMAIL script property.</p>'
    });
  } catch (e) {
    Logger.log('Could not send notification email: ' + e);
  }
}

/**
 * Hand-run: logs what the review-queue email would say right now, and sends
 * it if there is anything to report. Safe to run any time; writes nothing.
 */
function lucEmailReviewQueueNow() {
  lucEmailReviewQueue_(lucRequirePat_(), lucReadState_());
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
// The snapshot hash and the three published lookups were added 2026-10-06:
// the first for the before copy, the others for the below-standard watch rule.
const LUC_READ_FIELDS = [
  LUC_F_URL, LUC_F_TRACKED, LUC_F_UNITID, LUC_F_INSTITUTION,
  LUC_F_SNAP_URL, LUC_F_SNAP_STATUS, LUC_F_SNAP_HASH, LUC_F_DETERMINATION,
  LUC_F_PROPOSED_URL, LUC_F_NOTES,
  LUC_F_SRC_CHTR, LUC_F_SRC_POLICY, LUC_F_SRC_FORM,
  LUC_F_CHANGE_FP   // added 2026-10-06, for Page change rows
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

function lucRequest_(url, method, followRedirects) {
  const m = String(method || 'get').toLowerCase();
  const safe = LUC_VALID_FETCH_METHODS.indexOf(m) === -1 ? 'get' : m;
  if (safe !== m) {
    Logger.log('Unsupported fetch method "' + method + '" requested for ' + url +
      '; using GET. UrlFetchApp supports only ' + LUC_VALID_FETCH_METHODS.join(', ') + '.');
  }
  return {
    url: url,
    method: safe,
    // false for the status check, so a redirect is seen as a redirect;
    // true only for the landing-page fetch (lucFollowRedirects_).
    followRedirects: !!followRedirects,
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

  // NO DETERMINATION, NO REVIEW TO CLEAR (added 2026-10-06). Since this script
  // now writes the snapshot trio on unreviewed rows as their before copy, a
  // snapshot no longer proves a review exists. Without this guard a moved
  // address would wipe notes and a proposed URL a reviewer had started but not
  // yet decided. The before copy itself is retaken by lucTakeBeforeCopy_.
  if (!prev.determination) return false;

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
  LUC_F_BELOW_TICKS.forEach(function (f) { entry.fields[f] = []; });  // multiple select: [] empties

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
        snapHash: r.fields[LUC_F_SNAP_HASH] || '',
        determination: r.fields[LUC_F_DETERMINATION] || '',
        proposedUrl: r.fields[LUC_F_PROPOSED_URL] || '',
        notes: r.fields[LUC_F_NOTES] || '',
        changeFp: r.fields[LUC_F_CHANGE_FP] || ''
      },
      // For a Page change or Manual entry row (2026-10-06).
      createdTime: r.createdTime || '',
      unitid: String(r.fields[LUC_F_UNITID] || ''),
      instId: ((r.fields[LUC_F_INSTITUTION] || [])[0]) || ''
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

    // BELOW-STANDARD ROW THAT THE RULE NO LONGER WATCHES (2026-10-06): the
    // record field went blank, or now holds the published address (which its
    // published row already checks). Not fetched. Link status blank, so it
    // drops out of the email and the review views; the stored hash is left
    // alone; the before copy is discarded so a fresh one is taken if the row
    // is ever watched again. Last checked is still stamped by lucPatch_, so
    // the row leaves the due set.
    const pub = lucPublishedOf_(tracked);
    if (pub) {
      // A lookup comes back as an array; join it the way the Current URL
      // formula does (ARRAYJOIN with ""). Compared on the first URL token, the
      // same test lucReconcile_ uses, so the two can never disagree.
      const src = r.fields[pub.srcField];
      const publishedUrl = Array.isArray(src) ? src.join('') : String(src || '');
      if (!lucIsWatched_(lucFirstUrl_(url), lucFirstUrl_(publishedUrl))) {
        entry.fields[LUC_F_STATUS] = null;   // single select: null, '' is a 422
        entry.fields[LUC_F_CODE] = LUC_NOT_WATCHED_CODE;
        entry.fields[LUC_F_REDIRECT] = '';
        lucDropBeforeCopy_(entry);
        Logger.log('NOT WATCHED -- ' + entry.label + ': record field ' +
          (url ? 'now matches the published field' : 'is blank') + '.');
        return;
      }
    }

    if (!url) {
      entry.fields[LUC_F_STATUS] = 'No URL';
      entry.fields[LUC_F_CODE] = '';
      entry.fields[LUC_F_REDIRECT] = '';
      entry.fields[LUC_F_HASH] = '';
      const clearedBlank = lucClearIfStale_(entry, entry.prev, '', '');
      lucTakeBeforeCopy_(entry, '', '', '', clearedBlank);
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

  // Status for every URL. (A second pass that followed CHTR redirects for
  // the date read was removed 2026-10-04 with the date read. Redirects are
  // followed again from 2026-10-06, for the fingerprint -- see the landing
  // wave after this loop.)
  const landings = [];   // { j, entry, target } for the landing-page wave

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
      lucClearIfStale_(entry, entry.prev, j.url, 'Unreachable');
      // No before copy: nothing was read. An existing one is left alone.
      return;
    }

    entry.fields[LUC_F_STATUS] = interpreted.status;
    entry.fields[LUC_F_CODE] = interpreted.code;
    entry.fields[LUC_F_REDIRECT] = interpreted.redirectTarget;

    // Hash only where there is a readable body. 401/403/5xx and unreachable
    // leave the stored hash alone -- see lucContentHash_. Redirects get their
    // hash from the landing page, in the wave below.
    if (interpreted.status === 'Live' && resp) {
      const h = lucContentHash_(resp);
      if (h) entry.fields[LUC_F_HASH] = h;
    } else if (interpreted.status === 'Dead link') {
      entry.fields[LUC_F_HASH] = '';
    }

    entry.cleared = lucClearIfStale_(entry, entry.prev, j.url, interpreted.code);
    entry.checkedUrl = j.url;

    if (interpreted.status === 'Redirected' && interpreted.redirectTarget) {
      landings.push({ entry: entry, target: interpreted.redirectTarget });
    } else {
      const fresh = entry.fields[LUC_F_HASH] || '';
      lucNotePageChange_(entry, j.url, interpreted.code, fresh, entry.cleared);
      lucNoteManualEntry_(entry, j.url);
      lucNoteChtrAddress_(entry, j.url);
      lucTakeBeforeCopy_(entry, j.url, interpreted.code, fresh, entry.cleared);
    }
  });

  // ---- THE LANDING-PAGE WAVE (added 2026-10-06) --------------------------
  lucFollowRedirects_(landings, deadlineAt);
  landings.forEach(function (l) {
    const e = l.entry;
    lucNotePageChange_(e, e.checkedUrl, e.fields[LUC_F_CODE], e.landingHash || '', e.cleared);
    lucNoteManualEntry_(e, e.checkedUrl);
    lucNoteChtrAddress_(e, e.checkedUrl);
    lucTakeBeforeCopy_(e, e.checkedUrl, e.fields[LUC_F_CODE],
      e.landingHash || '', e.cleared);
  });

  return results.filter(function (e) { return !e.skip; });
}

/**
 * Fetches the page each redirect lands on, following every hop, and
 * fingerprints it. Tracker #36 part 3: a redirect to the same content (http to
 * https) is not a change; a redirect to different content (a moved page with
 * new text, or the home page) is.
 *
 * Link status stays "Redirected" -- a reviewer still checks where it lands --
 * with two exceptions: a landing page that is a sign-in page becomes "Login
 * required" (this is what catches SharePoint's second hop, which the
 * status check never sees), and nothing else about the row changes.
 *
 * WHAT IS NOT FETCHED: a target that is malformed, on a known-unfetchable host,
 * or login-shaped by address (already Login required). And nothing at all
 * once the slice's deadline has passed -- those rows keep their old hash and
 * get a landing fetch on the next check.
 *
 * Sets entry.landingHash when the landing page answered 2xx with a readable
 * body that is not a sign-in page. Otherwise the stored Content hash is left
 * alone: no information, not "the page is empty".
 *
 * Costs one extra request per redirected row (57 of 2,721 on 2026-10-06), in
 * one batched wave, so about as long as the slowest of them.
 */
function lucFollowRedirects_(landings, deadlineAt) {
  const todo = landings.filter(function (l) {
    if (!lucIsFetchableUrl_(l.target)) return false;
    if (lucIsKnownUnfetchable_(l.target)) {
      Logger.log('Redirect target on a known-unfetchable host, not followed -- ' +
        l.entry.label + ': ' + l.target);
      return false;
    }
    if (l.entry.fields[LUC_F_STATUS] === 'Login required') return false;
    return true;
  });
  if (!todo.length) return;

  if (deadlineAt && Date.now() > deadlineAt) {
    Logger.log('Past deadline; ' + todo.length + ' redirect(s) not followed this time. ' +
      'Their stored fingerprint is left alone.');
    return;
  }

  const resps = lucFetchAllSafe_(
    todo.map(function (l) { return lucRequest_(l.target, 'get', true); }), deadlineAt);

  todo.forEach(function (l, i) {
    const resp = resps[i];
    const e = l.entry;
    if (!resp) {
      Logger.log('REDIRECT not followed (no answer) -- ' + e.label + ' -> ' + l.target);
      return;
    }
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('REDIRECT lands on HTTP ' + code + ' -- ' + e.label + ' -> ' + l.target +
        '. Fingerprint left alone.');
      return;
    }
    const signal = lucLoginWallSignal_(resp, l.target, '', 'Live');
    if (signal) {
      Logger.log('LOGIN WALL (' + signal + ', after following the redirect) -- ' +
        e.label + ' -> ' + l.target + ', recorded as Login required.');
      e.fields[LUC_F_STATUS] = 'Login required';
      return;
    }
    const h = lucContentHash_(resp);
    if (h) {
      e.fields[LUC_F_HASH] = h;
      e.landingHash = h;
    }
  });
}

/**
 * Takes, keeps or discards the before copy for one checked row. Tracker #36
 * part 2; see "PAGE-CHANGE WATCHING, STEP 1" in the header for why the
 * snapshot trio is used and why all three are written together.
 *
 *   url, code    what this check read (code is the HTTP code, or 'Unreachable')
 *   freshHash    the fingerprint taken THIS check, or '' if none
 *   cleared      true if lucClearIfStale_ just cleared the review
 *
 * REVIEWED ROW (has a determination, not cleared): the automation owns the
 * trio. The only write is filling a blank Content hash snapshot while the
 * review is still valid -- the same rule lucRestampSnapshots used. A review
 * with no URL/status snapshot at all (from before the automation) is left
 * alone: there is nothing to test "still valid" against.
 *
 * UNREVIEWED ROW (or one whose review was just cleared):
 *   - existing copy still describes this address and status class: kept;
 *   - otherwise, with a fresh fingerprint: a new copy is taken now;
 *   - otherwise (unreadable this time): the address and status are recorded
 *     with a blank fingerprint, so a later change of address is still seen;
 *     a blank address empties the copy.
 */
function lucTakeBeforeCopy_(entry, url, code, freshHash, cleared) {
  const p = entry.prev;
  const det = cleared ? '' : p.determination;
  const snapUrl    = cleared ? '' : p.snapUrl;
  const snapStatus = cleared ? '' : p.snapStatus;
  const snapHash   = cleared ? '' : p.snapHash;

  const sameUrl   = snapUrl === (url || '');
  const sameClass = lucStatusClass_(snapStatus) === lucStatusClass_(code);

  if (det) {
    if (!snapHash && freshHash && snapUrl && sameUrl && sameClass) {
      entry.fields[LUC_F_SNAP_HASH] = freshHash;
      Logger.log('Before copy: filled the missing Content hash snapshot on reviewed row ' +
        entry.label + '.');
    }
    return;
  }

  const hasCopy = !!(snapUrl || snapStatus || snapHash);
  if (snapHash && sameUrl && sameClass) return;   // still valid, keep it

  if (freshHash) {
    entry.fields[LUC_F_SNAP_URL]    = url;
    entry.fields[LUC_F_SNAP_STATUS] = String(code || '');
    entry.fields[LUC_F_SNAP_HASH]   = freshHash;
    Logger.log('Before copy ' + (hasCopy ? 'RETAKEN' : 'taken') + ' -- ' + entry.label +
      (hasCopy && !sameUrl ? ' (address changed)' : '') +
      (hasCopy && sameUrl && !sameClass ? ' (page came back)' : '') + '.');
    return;
  }

  // No readable page this time. A blank address (No URL) empties the copy.
  // Otherwise the address and status are recorded with a blank fingerprint
  // (added 2026-10-06, step 4), so a later change of address is still noticed
  // on a page this checker cannot read. The next readable check fills in the
  // fingerprint.
  if (!url) {
    if (hasCopy) {
      lucDropBeforeCopy_(entry);
      Logger.log('Before copy discarded -- ' + entry.label + ': the address is now blank.');
    }
    return;
  }
  if (!hasCopy || !sameUrl || !sameClass) {
    entry.fields[LUC_F_SNAP_URL]    = url;
    entry.fields[LUC_F_SNAP_STATUS] = String(code || '');
    entry.fields[LUC_F_SNAP_HASH]   = '';
    Logger.log('Before copy: address recorded without a fingerprint (page not readable) -- ' +
      entry.label + (hasCopy && !sameUrl ? ' (address changed)' : '') + '.');
  }
}

/**
 * Empties the before copy on an UNREVIEWED row. Never touches a reviewed row's
 * snapshots -- those belong to the review and are cleared only by
 * lucClearIfStale_.
 */
function lucDropBeforeCopy_(entry) {
  const p = entry.prev;
  if (p.determination) return;
  if (!(p.snapUrl || p.snapStatus || p.snapHash)) return;
  entry.fields[LUC_F_SNAP_URL]    = '';
  entry.fields[LUC_F_SNAP_STATUS] = '';
  entry.fields[LUC_F_SNAP_HASH]   = '';
}

// =========================================================================
// PAGE-CHANGE ROWS  (added 2026-10-06, tracker #36 step 2)
// =========================================================================
/**
 * Decides whether this check found a changed page, and if so marks the entry
 * so lucWriteBack_ creates a Candidate URLs row for it. See "PAGE-CHANGE ROWS,
 * STEP 2" in the header. Must be called BEFORE lucTakeBeforeCopy_, because it
 * compares against the before copy as it stood when the row was read.
 */
function lucNotePageChange_(entry, url, code, freshHash, cleared) {
  if (!freshHash || cleared || !entry.tracked) return;
  const p = entry.prev;
  if (!p.snapHash) return;                                   // no before copy
  if (p.snapUrl !== url) return;                             // a different page
  if (lucStatusClass_(p.snapStatus) !== lucStatusClass_(code)) return;
  if (freshHash === p.snapHash) return;                      // unchanged
  if (freshHash === p.changeFp) return;                      // already sent
  if (!entry.tracked.candCategory || !entry.instId) {
    Logger.log('PAGE CHANGED but no Candidate row made -- ' + entry.label +
      ': ' + (!entry.instId ? 'no Institution link on the row' : 'no category mapping') + '.');
    return;
  }
  entry.pageChange = { url: url, category: entry.tracked.candCategory };
  entry.fields[LUC_F_CHANGE_FP]   = freshHash;
  entry.fields[LUC_F_CHANGE_DATE] =
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Decides whether this check found a NEW CHTR or hazing policy address, and if
 * so marks the entry so lucWriteBack_ can create a Manual entry row (after
 * checking that no accepted candidate row backs it). See "MANUAL ENTRY ROWS,
 * STEP 4" in the header. Compares against the snapshot as it was when the row
 * was read, so it must be called BEFORE lucTakeBeforeCopy_.
 */
function lucNoteManualEntry_(entry, url) {
  const t = entry.tracked;
  if (!url || !t || LUC_MANUAL_CATEGORIES.indexOf(t.candCategory) === -1) return;
  if (!entry.instId) return;
  const p = entry.prev;
  let reason = '';
  if (p.snapUrl) {
    if (p.snapUrl !== url) reason = 'address changed (was ' + p.snapUrl + ')';
  } else if (!p.snapStatus && entry.createdTime && entry.createdTime > LUC_MANUAL_SINCE) {
    reason = 'new link, first read';
  }
  if (!reason) return;
  entry.manualEntry = { url: url, category: t.candCategory, reason: reason };
}

/**
 * CHTR date checks (step 5, 2026-10-06). On a published CHTR row that is new
 * (created after LUC_MANUAL_SINCE, read for the first time) or whose address
 * changed, sets First date check to today so it comes up as "Needs a date" at
 * once. On an address change it also empties CHTR update date and Date is on,
 * because they described the old page. Uses the same test for "new or changed"
 * as lucNoteManualEntry_, so it must also run BEFORE lucTakeBeforeCopy_.
 */
function lucNoteChtrAddress_(entry, url) {
  if (!url || !entry.tracked || entry.tracked.name !== 'Transparency Report') return;
  const p = entry.prev;
  const changed = !!p.snapUrl && p.snapUrl !== url;
  const isNew = !p.snapUrl && !p.snapStatus && entry.createdTime &&
                entry.createdTime > LUC_MANUAL_SINCE;
  if (!changed && !isNew) return;
  entry.fields[LUC_F_FIRST_DATE] =
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (changed) {
    entry.fields[LUC_F_CHTR_DATE] = '';
    entry.fields[LUC_F_DATE_ON]   = null;   // single select: null, '' is a 422
  }
  Logger.log('CHTR date check -- ' + entry.label + ': ' +
    (changed ? 'address changed, old date cleared' : 'new CHTR') +
    '; comes up as "Needs a date" today.');
}

/** The address in the forms a stored copy may use: as is, and with or without a trailing slash. */
function lucUrlVariants_(url) {
  const u = String(url || '').trim();
  const out = [u];
  if (/\/$/.test(u)) out.push(u.replace(/\/+$/, ''));
  else out.push(u + '/');
  return out;
}

/** Escapes a value for a double-quoted Airtable formula string. */
function lucFormulaString_(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * True if an accepted candidate row (Accept or Hold) for this school and
 * category already backs this address. Throws on an Airtable error, so the
 * caller can treat "could not tell" as "try again next check".
 */
function lucManualEntryIsBacked_(pat, entry) {
  const m = entry.manualEntry;
  const urlTests = [];
  lucUrlVariants_(m.url).forEach(function (u) {
    [LUC_C_URL, LUC_C_PROPOSED_URL, LUC_C_REVIEW_URL].forEach(function (f) {
      urlTests.push('{' + f + '} = ' + lucFormulaString_(u));
    });
  });
  const formula = 'AND(' +
    '{' + LUC_C_UNITID + '} = ' + lucFormulaString_(entry.unitid) + ', ' +
    '{' + LUC_C_CATEGORY + '} = ' + lucFormulaString_(m.category) + ', ' +
    'OR({' + LUC_C_DETERMINATION + '} = ' + lucFormulaString_(LUC_DET_ACCEPT) + ', ' +
       '{' + LUC_C_DETERMINATION + '} = ' + lucFormulaString_(LUC_DET_HOLD) + '), ' +
    'OR(' + urlTests.join(', ') + '))';
  const json = lucList_(pat, LUC_CAND_TABLE, {
    pageSize: 1, returnFieldsByFieldId: true, fields: [LUC_C_UNITID], filterByFormula: formula });
  Utilities.sleep(210);
  return (json.records || []).length > 0;
}

/**
 * Creates Manual entry rows for entries marked by lucNoteManualEntry_ that no
 * accepted candidate row backs. Runs BEFORE the Live URL Checks write. If a
 * row cannot be created (or backing cannot be checked), the snapshot writes
 * for that entry are withdrawn, so the next check sees the same new address
 * and tries again.
 */
function lucCreateManualEntryRows_(pat, results) {
  const todo = [];
  results.forEach(function (e) {
    if (!e.manualEntry) return;
    try {
      if (lucManualEntryIsBacked_(pat, e)) {
        Logger.log('New address backed by an accepted candidate row, no Manual entry row -- ' +
          e.label + ': ' + e.manualEntry.url + '.');
        e.fields[LUC_F_STD_JUDGED] = lucToday_();
        e.manualEntry = null;
        return;
      }
      todo.push(e);
    } catch (err) {
      Logger.log('Could not check candidate rows for ' + e.label + ' (' + err +
        '); will try again next check.');
      lucWithdrawSnapshotWrites_(e);
      e.manualEntry = null;
    }
  });
  if (!todo.length) return 0;

  let created = 0;
  for (let i = 0; i < todo.length; i += LUC_CREATE_BATCH) {
    const batch = todo.slice(i, i + LUC_CREATE_BATCH);
    const payload = { records: batch.map(function (e) {
      const f = {};
      f[LUC_C_UNITID]      = e.unitid;
      f[LUC_C_INSTITUTION] = [e.instId];
      f[LUC_C_CATEGORY]    = e.manualEntry.category;
      f[LUC_C_URL]         = e.manualEntry.url;
      f[LUC_C_SOURCE]      = LUC_SOURCE_MANUAL;
      f[LUC_C_FETCH]       = LUC_FETCH_NOT_YET;
      return { fields: f };
    }) };
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CAND_TABLE,
      { method: 'post',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true });
    Utilities.sleep(210);

    if (resp.getResponseCode() === 200) {
      created += batch.length;
      batch.forEach(function (e) {
        e.fields[LUC_F_STD_JUDGED] = lucToday_();
        Logger.log('MANUAL ENTRY -- ' + e.label + ': ' + e.manualEntry.reason +
          '; Candidate URLs row created (' + e.manualEntry.category + ', ' +
          e.manualEntry.url + ').');
      });
    } else {
      Logger.log('Could not create ' + batch.length + ' Manual entry row(s) (HTTP ' +
        resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300) +
        ' -- if this names an option, check that Source has "' + LUC_SOURCE_MANUAL +
        '". They will be tried again on the next check.');
      batch.forEach(function (e) {
        lucWithdrawSnapshotWrites_(e);
        e.manualEntry = null;
      });
    }
  }
  return created;
}

/**
 * Removes this check's writes to the three snapshot fields from an entry, so
 * the row keeps the snapshot it had and the next check repeats the decision.
 */
function lucWithdrawSnapshotWrites_(entry) {
  delete entry.fields[LUC_F_SNAP_URL];
  delete entry.fields[LUC_F_SNAP_STATUS];
  delete entry.fields[LUC_F_SNAP_HASH];
}

/**
 * Creates the Candidate URLs rows for every entry marked by lucNotePageChange_.
 * Runs BEFORE the Live URL Checks write, so a row that could not be created
 * does not record its fingerprint as reported, and is tried again next check.
 * The reverse failure (row created, Live URL Checks write lost) can make one
 * duplicate row; that is the cheaper way to fail.
 */
function lucCreatePageChangeRows_(pat, results) {
  const todo = results.filter(function (e) { return e.pageChange; });
  if (!todo.length) return 0;
  let created = 0;

  for (let i = 0; i < todo.length; i += LUC_CREATE_BATCH) {
    const batch = todo.slice(i, i + LUC_CREATE_BATCH);
    const payload = { records: batch.map(function (e) {
      const f = {};
      f[LUC_C_UNITID]      = e.unitid;
      f[LUC_C_INSTITUTION] = [e.instId];
      f[LUC_C_CATEGORY]    = e.pageChange.category;
      f[LUC_C_URL]         = e.pageChange.url;
      f[LUC_C_SOURCE]      = LUC_SOURCE_PAGE_CHANGE;
      f[LUC_C_FETCH]       = LUC_FETCH_NOT_YET;
      return { fields: f };
    }) };
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CAND_TABLE,
      { method: 'post',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true });
    Utilities.sleep(210);

    if (resp.getResponseCode() === 200) {
      created += batch.length;
      batch.forEach(function (e) {
        e.fields[LUC_F_STD_JUDGED] = lucToday_();
        Logger.log('PAGE CHANGED -- ' + e.label + ': Candidate URLs row created (' +
          e.pageChange.category + ', ' + e.pageChange.url + ').');
      });
    } else {
      Logger.log('Could not create ' + batch.length + ' Page change row(s) (HTTP ' +
        resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300) +
        ' -- if this names an option, check that Source has "' + LUC_SOURCE_PAGE_CHANGE +
        '". They will be tried again on the next check.');
      batch.forEach(function (e) {
        delete e.fields[LUC_F_CHANGE_FP];
        delete e.fields[LUC_F_CHANGE_DATE];
        e.pageChange = null;
      });
    }
  }
  return created;
}

/** Today's date in the script's time zone, as YYYY-MM-DD. */
function lucToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// =========================================================================
// THE BACKLOG  (added 2026-10-06, tracker #36 step 6)
// =========================================================================
/**
 * Once a day, sends LUC_BACKLOG_PER_DAY existing CHTR and hazing policy pages
 * for a standards check, as "Backlog check" rows in Candidate URLs. Called from
 * every scheduled slice; does nothing after the day's quota is met.
 *
 * WHICH ROWS: watched (Link status not blank), with an address, no "Standard
 * last judged" date, and created before LUC_MANUAL_SINCE (later rows are
 * judged as they arrive, by Manual entry or their own candidate row). Taken in
 * LUC_BACKLOG_ORDER. A row whose address an accepted candidate row already
 * backs is marked judged and skipped, so no AI check is spent on it.
 *
 * EACH ROW SENT: a Candidate URLs row is created (Source "Backlog check",
 * "Not yet fetched"; the end of the slice captures it), then the Live URL
 * Checks row gets Standard last judged = today, and a published CHTR also gets
 * First date check = today, so its date check comes up the same day.
 *
 * If the Candidate URLs rows cannot be created, nothing is marked and the day
 * is not counted as done, so the next slice tries again. Never throws.
 */
function lucRunBacklog_(pat, budgetMs) {
  if (budgetMs < LUC_CAPTURE_MIN_MS) return { sent: 0, skipped: true };
  const props = PropertiesService.getScriptProperties();
  const today = lucToday_();
  if (props.getProperty(LUC_BACKLOG_DAY_KEY) === today) return { sent: 0, alreadyToday: true };

  const startedAt = Date.now();
  const picked = [];
  const judgedOnly = [];
  let looks = 0;
  let anyLeft = false;

  try {
    for (let g = 0; g < LUC_BACKLOG_ORDER.length && picked.length < LUC_BACKLOG_PER_DAY; g++) {
      const names = LUC_BACKLOG_ORDER[g];
      const formula = 'AND(OR(' + names.map(function (n) {
          return '{' + LUC_F_TRACKED + '} = ' + lucFormulaString_(n); }).join(', ') + '), ' +
        '{' + LUC_F_STATUS + '} != "", {' + LUC_F_URL + '} != "", ' +
        '{' + LUC_F_STD_JUDGED + '} = BLANK(), ' +
        "IS_BEFORE(CREATED_TIME(), DATETIME_PARSE('" + LUC_MANUAL_SINCE + "')))";
      const json = lucList_(pat, LUC_CHECKS_TABLE, {
        pageSize: Math.min(100, LUC_BACKLOG_MAX_LOOKS),
        returnFieldsByFieldId: true,
        fields: [LUC_F_URL, LUC_F_TRACKED, LUC_F_UNITID, LUC_F_INSTITUTION],
        filterByFormula: formula });
      Utilities.sleep(210);
      const rows = json.records || [];
      if (rows.length) anyLeft = true;

      for (let i = 0; i < rows.length && picked.length < LUC_BACKLOG_PER_DAY; i++) {
        if (looks >= LUC_BACKLOG_MAX_LOOKS || Date.now() - startedAt > budgetMs - 20000) break;
        looks++;
        const r = rows[i];
        const tracked = lucTrackedByName_(r.fields[LUC_F_TRACKED] || '');
        const e = {
          id: r.id,
          label: (r.fields[LUC_F_UNITID] || r.id) + ' / ' + (r.fields[LUC_F_TRACKED] || '?'),
          tracked: tracked,
          unitid: String(r.fields[LUC_F_UNITID] || ''),
          instId: ((r.fields[LUC_F_INSTITUTION] || [])[0]) || '',
          manualEntry: { url: String(r.fields[LUC_F_URL] || '').trim(),
                         category: tracked ? tracked.candCategory : '' }
        };
        if (!tracked || !e.instId || !e.manualEntry.url) continue;
        if (lucManualEntryIsBacked_(pat, e)) { judgedOnly.push(e); continue; }
        picked.push(e);
      }
    }

    // Rows already backed: mark judged, no Candidate row.
    lucBacklogMark_(pat, judgedOnly, today, false);

    if (!picked.length) {
      if (!anyLeft) Logger.log('Backlog: finished. No CHTR or policy page is left without a ' +
        'standards check.');
      else Logger.log('Backlog: nothing sent this time (' + judgedOnly.length +
        ' already backed by an accepted candidate row, now marked judged).');
      if (!anyLeft || looks < LUC_BACKLOG_MAX_LOOKS) props.setProperty(LUC_BACKLOG_DAY_KEY, today);
      return { sent: 0, judgedOnly: judgedOnly.length };
    }

    const payload = { records: picked.map(function (e) {
      const f = {};
      f[LUC_C_UNITID]      = e.unitid;
      f[LUC_C_INSTITUTION] = [e.instId];
      f[LUC_C_CATEGORY]    = e.manualEntry.category;
      f[LUC_C_URL]         = e.manualEntry.url;
      f[LUC_C_SOURCE]      = LUC_SOURCE_BACKLOG;
      f[LUC_C_FETCH]       = LUC_FETCH_NOT_YET;
      return { fields: f };
    }) };
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CAND_TABLE,
      { method: 'post',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true });
    Utilities.sleep(210);
    if (resp.getResponseCode() !== 200) {
      Logger.log('Backlog: could not create ' + picked.length + ' row(s) (HTTP ' +
        resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300) +
        ' -- if this names an option, check that Source has "' + LUC_SOURCE_BACKLOG +
        '". Will try again on the next slice.');
      return { sent: 0, failed: true };
    }

    lucBacklogMark_(pat, picked, today, true);
    props.setProperty(LUC_BACKLOG_DAY_KEY, today);
    picked.forEach(function (e) {
      Logger.log('BACKLOG CHECK -- ' + e.label + ': Candidate URLs row created (' +
        e.manualEntry.category + ', ' + e.manualEntry.url + ')' +
        (e.tracked.name === 'Transparency Report' ? '; CHTR date check released' : '') + '.');
    });
    return { sent: picked.length, judgedOnly: judgedOnly.length };
  } catch (err) {
    Logger.log('Backlog step stopped, ignored: ' + err);
    return { sent: 0, failed: true };
  }
}

/**
 * Writes Standard last judged = today on the given Live URL Checks rows, and
 * First date check = today on published CHTR rows when releaseDates is true.
 * Patches only these fields, so Last checked is not touched.
 */
function lucBacklogMark_(pat, entries, today, releaseDates) {
  for (let i = 0; i < entries.length; i += LUC_WRITE_BATCH) {
    const batch = entries.slice(i, i + LUC_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + LUC_BASE_ID + '/' + LUC_CHECKS_TABLE,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch.map(function (e) {
          const f = {};
          f[LUC_F_STD_JUDGED] = today;
          if (releaseDates && e.tracked && e.tracked.name === 'Transparency Report') {
            f[LUC_F_FIRST_DATE] = today;
          }
          return { id: e.id, fields: f };
        }) }),
        muteHttpExceptions: true });
    Utilities.sleep(210);
    if (resp.getResponseCode() !== 200) {
      Logger.log('Backlog: could not mark ' + batch.length + ' row(s) as judged (HTTP ' +
        resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300) +
        '. They may be sent again tomorrow.');
    }
  }
}

/**
 * Reads (captures) Page change rows that are still "Not yet fetched", using
 * SitemapFinder.gs's capture code, until the budget runs out. Never throws:
 * a capture problem must not fail the slice that called it.
 *
 * The record handed to capOneRow_ carries a placeholder determination. That
 * is what stops capture's one-hop stub chase, which on an undecided Hazing
 * Policy or Report Form row would replace Candidate URL with a document the
 * page links to. Here the address must stay the published page, or "Page
 * change outcome" could no longer tell it is the published one. Nothing is
 * written to Reviewer determination.
 */
function lucCapturePageChanges_(pat, budgetMs) {
  if (budgetMs < LUC_CAPTURE_MIN_MS) return { captured: 0, skipped: true };
  if (typeof capOneRow_ !== 'function' || typeof capWriteBack_ !== 'function') {
    Logger.log('Page change capture skipped: capOneRow_ / capWriteBack_ not found ' +
      '(SitemapFinder.gs). The pipeline capture stage will read these rows.');
    return { captured: 0, skipped: true };
  }
  const startedAt = Date.now();
  let captured = 0;
  try {
    const formula = 'AND(' + lucRecheckSourceClause_() + ', ' +
      'OR({' + LUC_C_FETCH + '} = "", {' + LUC_C_FETCH + '} = "' + LUC_FETCH_NOT_YET + '"))';
    while (Date.now() - startedAt < budgetMs - 15000) {
      const json = lucList_(pat, LUC_CAND_TABLE, {
        pageSize: 10, returnFieldsByFieldId: true,
        fields: [LUC_C_URL, LUC_C_CATEGORY], filterByFormula: formula });
      Utilities.sleep(210);
      const rows = json.records || [];
      if (!rows.length) break;

      const results = [];
      for (let i = 0; i < rows.length; i++) {
        if (Date.now() - startedAt >= budgetMs - 15000) break;
        const rec = { id: rows[i].id, fields: {} };
        rec.fields[LUC_C_URL] = rows[i].fields[LUC_C_URL] || '';
        rec.fields[LUC_C_CATEGORY] = rows[i].fields[LUC_C_CATEGORY] || '';
        rec.fields[LUC_C_DETERMINATION] = '(page change: no stub chase)';
        results.push(capOneRow_(rec));
        Utilities.sleep(250);
      }
      if (!results.length) break;
      const failedBatches = capWriteBack_(pat, results);
      captured += results.length;
      if (failedBatches) {
        Logger.log('Page change capture: ' + failedBatches + ' write batch(es) failed; ' +
          'those rows stay "Not yet fetched". Stopping for this slice.');
        break;
      }
    }
  } catch (e) {
    Logger.log('Page change capture stopped, ignored: ' + e);
  }
  if (captured) Logger.log('Page change rows captured: ' + captured + '.');
  return { captured: captured };
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

  // Page change and Manual entry rows first (2026-10-06): see
  // lucCreatePageChangeRows_ and lucCreateManualEntryRows_ for why the order
  // matters.
  lucCreatePageChangeRows_(pat, results);
  lucCreateManualEntryRows_(pat, results);

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
