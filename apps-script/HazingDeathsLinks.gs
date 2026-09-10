// =========================================================================
// HAZING DEATH LINKS  (2026-09-09)  -- NEW FILE
//
// PASTE AS A NEW FILE (File > New > Script, name it HazingDeathsLinks).
// Nothing else in the project changes, and nothing else needs to be
// present: this file is SELF-CONTAINED on purpose (see DEPENDENCIES).
//
// ONE MANUAL STEP BEFORE THE FIRST RUN. Add "Unverifiable" as an option on
// U.S. Hazing Deaths > link_status, by hand in the Airtable field editor.
// Airtable's API cannot add a choice to an existing single-select, and this
// file refuses to mint one -- so without it the first unverifiable row
// stops the run with a message saying exactly this.
//
// RUN, IN THIS ORDER:
//   hdlStatus()      how many rows are outstanding, and what is already
//                    recorded. Reads Airtable, fetches nothing.
//   hdlDryRun(10)    check 10 rows for real and log exactly what would be
//                    written. Writes nothing, emails nothing.
//   hdlRun()         work for ~3 minutes, write, then stop and say what
//                    is left. Run again to continue.
//   hdlRecheckAll()  clear link_last_checked on every row so the next
//                    hdlRun() sweeps from scratch. Two-step, see below.
//
// AND, SEPARATELY, THE ARCHIVE PASS:
//   hdlArchiveMissingDryRun25()  list sources with no Wayback snapshot.
//   hdlArchiveMissing10()        ask the Archive to make snapshots for ten
//                                of them. Slow, capped, hand-run only.
//
// -------------------------------------------------------------------------
// WHY THIS EXISTS
// -------------------------------------------------------------------------
// Sierra asked for it in the 2026-09-02 team meeting: preparing the
// "In Memory Of" material, she kept opening media links from the U.S.
// Hazing Deaths database and finding them gone. Many of these sources are
// a decade or more old and the outlets have reorganised or disappeared.
//
// This answers ONE question -- does the link still resolve -- and records
// WHICH link failed. It makes no editorial judgment, has no review queue,
// and writes nothing anyone's public page reads.
//
// -------------------------------------------------------------------------
// THE URL FIELD HOLDS MORE THAN ONE URL. THIS IS THE WHOLE DESIGN PROBLEM.
// -------------------------------------------------------------------------
// U.S. Hazing Deaths > URL is an Airtable `url` field, but many rows hold
// two or three addresses separated by commas. Verified live 2026-09-09:
// 342 rows, 166 with a URL, a good share of those multi-valued. Example:
//
//   https://www.ajc.com/news/... , https://www.nbcdfw.com/news/...
//
// So a row cannot carry one status, and this file splits the cell and
// checks every address in it. link_status is a SUMMARY across them
// (All working / Some broken / All broken) and broken_links names the
// individual failures -- which is the field a person actually works from,
// because "some broken" does not tell you which source to replace.
//
// THE MUTE IS PER URL, NOT PER ROW, AND THAT IS NOT A DETAIL. The obvious
// design -- an "ignore this row" flag -- is wrong here. A row with a flaky
// newspapers.com link and a working AJC link would go quiet, and when AJC
// died two months later nobody would hear about it. links_to_ignore holds
// individual addresses, so muting one source leaves every other source on
// the row live. An ignored URL is still checked and still written into
// broken_links marked (ignored); the ignore list changes what COUNTS,
// never what is RECORDED.
//
// -------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT DO
// -------------------------------------------------------------------------
// IT ALSO RECORDS A WAYBACK SNAPSHOT FOR EVERY SOURCE, working or not,
// into archive_url. That is not scope creep, it is the actual answer to
// the problem: a link check tells you a source is gone, which is too late,
// while a snapshot taken while the page still works keeps the evidence
// readable afterwards. The original URL stays the source of record and is
// never overwritten -- see the archive_url field description for why.
//
// A snapshot can only be MADE from a live page. Nothing archives a page
// retroactively, which is the argument for archiving a source when it is
// added rather than when it breaks.
//
// IT DOES NOT READ PAGE CONTENT. It follows redirects by hand and judges
// the address it ends on, which catches the common "soft 404" -- an
// article quietly redirected to the site's front page, answering 200 while
// the source is gone. What that cannot catch is a site serving a "story
// not found" PAGE at the original address, or redirecting to a section
// index rather than the root. Both need a judgment about page content,
// which is a much larger job and is not what was asked for.
//
// NO CONTENT HASH. Live URL Checks hashes pages so a reviewer can be told
// when a page changed since they approved it. There is no approval here
// and no standard to drift from -- the question is only whether the
// address resolves. Hashing would add a fetch-shaped cost and answer a
// question nobody asked.
//
// NO SEPARATE TABLE, NO REVIEW FLOW. Live URL Checks is one row per
// (institution, category) built by a reconciler that reads Institutions.
// Deaths rows have a different shape and a different owner, and the job
// has no determination to record beyond "replace this" -- so the fields
// live on the deaths table where Sierra already works.
//
// NO TRIGGER. This file installs nothing. hdlRunScheduled_ exists so a
// trigger CAN be pointed at it later, but adding one is a decision for
// whoever owns the project's ~90 min/day of trigger runtime, not a side
// effect of pasting a file.
//
// -------------------------------------------------------------------------
// PROGRESS LIVES IN THE DATA, NOT IN A CURSOR
// -------------------------------------------------------------------------
// Same principle Scheduler.gs uses, for the same reason: an Airtable
// offset token expires and a saved position goes wrong when the list
// moves. A row needs work when link_last_checked is blank or older than
// HDL_RECHECK_DAYS. Checking it writes today's date, so the row leaves the
// set by being done. A re-run after a timeout costs one read and skips
// everything already written. There is nothing to reset.
//
// -------------------------------------------------------------------------
// DEPENDENCIES: NONE, ON PURPOSE
// -------------------------------------------------------------------------
// Everything here is prefixed hdl / HDL_. It does not call capPat_,
// LUC_BROWSER_HEADERS or anything else in the project.
//
// That is a deliberate second copy of two small things -- the browser
// headers and the login-URL patterns -- and the reasoning is the one
// WriteBack.gs gives for its own copy of the login patterns: the two do
// different jobs, and this file must keep working if the pass it borrowed
// from is ever retired. It also means this file can be reviewed, moved or
// pasted into another project on its own.
//
// Verified 2026-09-09 against SitemapFinder.gs, CrossSeed.gs,
// SiteCensus.gs, SearchProbe.gs, ContentHash.gs, LiveUrlChecks.gs,
// WriteBack.gs, PreFilterResult.gs, WebApp.gs, FindPoison.gs,
// RobotsProbe.gs and Scheduler.gs: no name
// beginning hdl<Capital> or HDL_ is declared in any of them. Apps Script
// does NOT error on a duplicate function name -- the later definition
// silently wins and the caller that wanted the other one breaks with no
// message -- which is why the prefix matters more than it looks.
// =========================================================================

// ---- Where everything lives ---------------------------------------------
const HDL_BASE_ID  = 'appJbAvuFOxhWOID2';   // 50 States Database
const HDL_TABLE_ID = 'tblfKVIPvlHREQGTk';   // U.S. Hazing Deaths

// Read
const HDL_F_URL      = 'fldSMyh66YUt7ApvO';   // URL (holds 1..n, comma separated)
const HDL_F_NAME     = 'fldcLeYzKRWMQmwlp';   // Victim's Name -- for the log and the email
const HDL_F_IGNORE   = 'fldnOrduakrqoxgWR';   // links_to_ignore (hand-edited)

// Write
const HDL_F_STATUS   = 'fldi0cToefdsXYONb';   // link_status
const HDL_F_BROKEN   = 'fldbTnS7kMRKiRoVm';   // broken_links
const HDL_F_CHECKED  = 'fldAnUhZZuCx3tFPX';   // link_last_checked
const HDL_F_ARCHIVE  = 'fldaFpb8p4E6bF8vN';   // archive_url

// Never written by this file. Read only so the email can say whether a
// person has already dealt with a row.
const HDL_F_REVIEW   = 'fldbaDu0TKuu67WXX';   // link_review

// The four link_status choices, spelled exactly as they exist in Airtable.
// WRITTEN WITHOUT typecast, deliberately: typecast:true on a value that
// does not match mints a new choice, and an empty string mints a NAMELESS
// one -- which is how Form link tier ended up with a blank option set on
// 32 rows. Without typecast a mismatch fails loudly instead.
const HDL_ST_OK      = 'All working';
const HDL_ST_SOME    = 'Some broken';
const HDL_ST_ALL     = 'All broken';
const HDL_ST_NONE    = 'Not checked';
// ADD THIS ONE BY HAND IN THE AIRTABLE UI BEFORE THE FIRST RUN. Airtable's
// API cannot add a choice to an existing singleSelect, and this file
// deliberately does not write with typecast:true -- so if the option is
// missing the write FAILS LOUDLY on the first unverifiable row rather than
// minting a stray choice. That is the safer failure: see hdlFlush_.
const HDL_ST_UNVERIF = 'Unverifiable';

// ---- Run shape -----------------------------------------------------------
// STOP STARTING ROWS AFTER THIS. Three minutes of a six-minute cap, which
// looks over-cautious and is not.
//
// UrlFetchApp HAS NO TIMEOUT PARAMETER. There is no way to cap how long one
// request may take, so a single hanging host can run for a minute or more
// and a row with three URLs can hang for several. The budget is not "how
// long the run takes", it is "how late the last row may START" -- and the
// gap between it and the six-minute cap is the only protection against
// being killed mid-row.
//
// WAS 4.5 MINUTES until 2026-09-09 (90 seconds of headroom, killed twice on
// the first real sweep), then 3 minutes, WHICH ALSO WAS NOT ENOUGH -- every
// run on 2026-09-09/10 was killed at the six-minute cap and wrote nothing.
// See HDL_LOOKUP_ARCHIVE for the cause; this is the second half of the fix.
//
// FOUR AND A HALF MINUTES, raised from two on 2026-09-10. The two-minute
// setting was left over from when a flush happened only every ten rows, and
// it should have been raised in the same edit that changed writes to land
// per row. It was not, and the cost was real: measured live, a row takes
// about 15 seconds, so a 2-minute budget did 8 rows per click and turned
// 37 minutes of actual work into 18 separate runs.
//
// WHY BIG HEADROOM IS NO LONGER WORTH BUYING. It used to protect a batch of
// up to nine finished-but-unwritten rows from the six-minute cap, which is
// a lot to lose. Now every row is written the moment it is done, so being
// killed mid-row costs exactly one row, which the next run redoes anyway
// because link_last_checked was never stamped. Ninety seconds of headroom
// is plenty of insurance against a loss that small.
//
// The underlying slowness is not fixable here: a row is up to 1.7 URLs,
// each URL can cost six fetches following a redirect chain by hand, and
// UrlFetchApp has no timeout parameter, so a host that takes nine seconds
// to answer takes nine seconds. The only real lever is how much of each
// six-minute execution is spent working rather than held in reserve.
const HDL_BUDGET_MS    = 4.5 * 60 * 1000;
const HDL_PAUSE_MS     = 250;              // other people's servers
const HDL_WRITE_BATCH  = 10;               // Airtable's hard cap per PATCH
const HDL_PAGE_SIZE    = 100;
const HDL_SLEEP_MS     = 210;              // Airtable's 5 req/sec
const HDL_MAX_URL_LEN  = 2000;

// Redirect hops followed by hand before giving up. Five is generous for a
// news article; a chain longer than that is usually a loop.
//
// REDIRECTS ARE FOLLOWED MANUALLY RATHER THAN BY UrlFetchApp, and the
// reason is the homepage check below: with followRedirects:true the
// response says 200 and gives no reliable way to learn WHERE it landed, so
// an article quietly redirected to the site's front page is
// indistinguishable from the article still being there. Following by hand
// costs the same number of fetches and keeps the final address.
const HDL_MAX_REDIRECTS = 5;

// How stale a check has to be before a row is looked at again. 30 days is
// chosen against what this data is: sources that have survived a decade do
// not usually die this month, and the whole table is ~300 URLs, so a
// monthly sweep costs one run. Lower it and you are paying to re-ask a
// question that rarely changes its answer.
const HDL_RECHECK_DAYS = 30;

// ---- Notification --------------------------------------------------------
// Set NOTIFY_EMAIL in Script Properties to send elsewhere; otherwise the
// script owner. A mail failure never takes down a run -- see hdlNotify_.
const HDL_NOTIFY_PROP  = 'NOTIFY_EMAIL';
// Rows named in one email before it switches to a count. A first sweep can
// legitimately find dozens; a mail with 160 rows in it does not get read.
const HDL_EMAIL_MAX_ROWS = 40;

// ---- The Wayback Machine -------------------------------------------------
// Two different endpoints doing two different jobs, and the difference is
// what decides where each one is allowed to run.
//
// AVAILABILITY is a read. It asks whether a snapshot already exists. This
// comment used to say it "answers in well under a second, so it runs inline
// with the link check". THAT WAS WRONG, and it is what broke the sweep --
// archive.org routinely takes tens of seconds and sometimes never answers,
// and UrlFetchApp cannot be given a timeout. Measured against the table on
// 2026-09-10: after several full-length runs only 14 of 276 URLs had a
// snapshot recorded, because the lookups were not returning. It is a read,
// but it is not a fast one.
//
// SAVE PAGE NOW is a write to somebody else's service. It asks the Archive
// to go and crawl a page, which takes ten to thirty seconds and is rate
// limited. Running it inline would blow the six-minute cap on a handful of
// rows, so it lives in its own capped, hand-run pass -- see
// hdlArchiveMissing.
const HDL_WAYBACK_AVAILABLE = 'https://archive.org/wayback/available?url=';
const HDL_WAYBACK_SAVE      = 'https://web.archive.org/save/';

// OFF SINCE 2026-09-10, and this is the main half of the timeout fix.
//
// With it on, hdlRun did two jobs at once and the slow, unreliable one
// starved the job Sierra actually asked for. Every run died at the cap with
// 154 rows still due and nothing written. Archiving is not urgent; knowing
// which sources are dead is.
//
// NOTHING IS LOST BY TURNING IT OFF. archive_url keeps every snapshot it
// already holds, and the archive work has its own capped, hand-run entry
// points -- hdlArchiveMissingDryRun25() and hdlArchiveMissing10() -- which
// is where a slow third-party service belongs. Run those after the link
// sweep is finished and the table is stable.
//
// Set it back to true only if the Archive is ever reliably fast, and expect
// to re-tune HDL_BUDGET_MS if you do.
const HDL_LOOKUP_ARCHIVE = false;

// Save Page Now is slow enough that a cap is not optional. Each submission
// can take half a minute, so ten is already most of a slice.
const HDL_SAVE_PAUSE_MS = 2000;

/**
 * Hosts that NEITHER ANSWER NOR FAIL. Not the same thing as a refusal.
 *
 * A stubborn host (below) answers 403 in milliseconds and the run moves on.
 * A host on THIS list accepts the connection and then never replies.
 *
 * UrlFetchApp DOES eventually give up -- measured at ~6 minutes on
 * 2026-09-10, when it threw "Exception: Timeout" on washingtonpost.com. But
 * that is AT the execution cap, not before it, and there is no parameter to
 * shorten it. So the throw is worthless: the execution is killed in the same
 * moment the exception would have been caught, no catch and no finally run,
 * and the row is never stamped. It is therefore first in the queue again on the next
 * run, and on the one after that. One such URL stops the entire sweep
 * indefinitely while the log shows nothing but "Exceeded maximum execution
 * time".
 *
 * That is exactly what happened on 2026-09-10: 146 rows sat untouched
 * across four consecutive six-minute runs because the first due row would
 * not complete.
 *
 * A URL on one of these hosts is NOT FETCHED AT ALL and is recorded as
 * unverifiable -- the same treatment as a stubborn host, for the same
 * reason: we cannot tell whether the page is alive, so saying it is dead
 * would be asserting something we do not know.
 *
 * PREFER THIS TO PARKING A ROW. Adding the host here leaves every OTHER URL
 * on the row still checked; stamping the row by hand silently gives up on
 * all of them.
 *
 * The parallel list in LiveUrlChecks.gs is LUC_UNFETCHABLE_HOSTS, which
 * carries the six school hosts that block Google's IP ranges. Keep them
 * separate: these are news and archive hosts and the two passes read
 * different tables.
 */
const HDL_UNFETCHABLE_HOSTS = [
  // MEASURED 2026-09-10, not guessed. findPoison fetched this host alone and
  // it threw "Exception: Timeout" after SIX MINUTES, killing the execution in
  // the same moment. One row carrying this URL -- Terry Ryan Stirling -- had
  // blocked all 146 due rows across four consecutive runs.
  'washingtonpost.com'
  // Add a host here the moment it is confirmed to hang rather than answer.
  // Format: bare registrable host, no scheme, no www -- 'example.com'.
  //
  // valawyersweekly.com sits on the same row and is NOT listed, because it
  // was never reached: the run died on the Post before testing it. Do not
  // add a host on suspicion -- an untested host listed here is a source
  // silently never checked again.
];

/**
 * THE BACKSTOP BEHIND THAT LIST, because the list can only ever name hosts
 * somebody already diagnosed.
 *
 * A row is counted as attempted BEFORE any fetch happens, and the count is
 * written to Script Properties immediately -- a property write commits at
 * once and therefore survives the execution being killed, which is the
 * whole point. A row that has burned this many executions without finishing
 * is set aside as unverifiable, with the reason recorded, so the queue
 * behind it can move.
 *
 * TWO is deliberate. One would set aside rows lost to an ordinary blip --
 * a slow host on a bad afternoon, or a run someone cancelled by closing the
 * editor tab. Three costs eighteen minutes of executions to learn something
 * two already proved.
 *
 * Setting a row aside is not a verdict about the source. It says the
 * checker could not finish, which is what Unverifiable means.
 */
const HDL_MAX_ATTEMPTS = 2;
const HDL_PROP_ATTEMPTS = 'hdl_attempts';   // {recordId: count}

/**
 * Hosts that refuse every automated request whatever you send them.
 *
 * A 401 or 403 FROM ONE OF THESE IS RECORDED AS UNVERIFIABLE RATHER THAN
 * BROKEN, and that distinction is the reason this list exists rather than
 * being cosmetic. newspapers.com answers 403 for a live article and a dead
 * one identically: there is no signal to read. Calling those rows broken
 * would assert something the checker cannot know, and it would put 17 rows
 * in front of Sierra every month that she can do nothing about.
 *
 * WHAT IT COSTS. A genuinely dead URL on one of these hosts stays
 * invisible until a person opens it. That cost is unavoidable, not a
 * choice: the information was never available to an unauthenticated
 * checker. Unverifiable is the honest name for it.
 *
 * A 403 from a host NOT on this list is still reported as Blocked and
 * still counts as a failure, because on an ordinary site a 403 is worth a
 * look. Add a host here only once it is clear it will never answer.
 */
const HDL_STUBBORN_HOSTS = [
  'newspapers.com', 'ancestry.com', 'wsj.com', 'nytimes.com',
  'washingtonpost.com', 'latimes.com', 'bostonglobe.com', 'ft.com',
  'jstor.org', 'proquest.com', 'usnews.com', 'npr.org'
];
// washingtonpost.com is on BOTH lists as of 2026-09-10, and the unfetchable
// check runs first, so its entry here is now dead code for that one host --
// left in place because the two lists mean different things and this one is
// the honest record that the Post is a paywalled archive. If it ever starts
// answering again, remove it from HDL_UNFETCHABLE_HOSTS and this entry
// resumes doing its job.
//
// THE REST OF THIS LIST HAS NOT BEEN TESTED FOR HANGING. The Post was found
// by accident, because its row happened to be first in the queue. Any of
// nytimes.com, wsj.com, ft.com or proquest.com could behave the same way and
// would cost two executions each before the attempt counter sets the row
// aside. That is survivable now, which it was not this morning.

// A browser-shaped request. The default Apps Script User-Agent identifies
// as Google and a large share of news and archive sites reject it
// outright, which manufactures "dead link" readings for pages that open
// perfectly well in a browser. A deliberate copy of the same idea as
// LUC_BROWSER_HEADERS -- see DEPENDENCIES.
const HDL_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Addresses that ARE resolvable but are a sign-in page rather than the
// article. Reported separately from a dead link because the fix is
// different: a dead link needs a replacement source, a login wall usually
// needs a person to decide whether the source is reachable at all.
const HDL_LOGIN_URL_PATTERNS = [
  /\/idp\/profile\//i,
  /\/Shibboleth\.sso\//i,
  /login\.microsoftonline\.com/i,
  /accounts\.google\.com\/(?:ServiceLogin|signin)/i,
  /\/(?:login|signin|sign-in|sign_in)(?:[\/?#]|$)/i,
  /\/subscribe(?:[\/?#]|$)/i,
  /\/paywall(?:[\/?#]|$)/i
];

// =========================================================================
// ENTRY POINTS
// =========================================================================

/** Counts only. Reads Airtable, fetches nothing, writes nothing. */
function hdlStatus() {
  const rows = hdlReadRows_(hdlPat_());
  const cutoff = hdlCutoff_();

  let withUrl = 0, noUrl = 0, due = 0, urls = 0, archived = 0;
  const byStatus = {};
  rows.forEach(function (r) {
    const list = hdlSplitUrls_(r.url);
    if (!list.length) { noUrl++; } else { withUrl++; urls += list.length; }
    const s = r.status || '(blank)';
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (list.length && hdlIsDue_(r.checked, cutoff)) due++;
    const have = String(r.archive || '').toLowerCase();
    if (have) {
      list.forEach(function (u) {
        if (have.indexOf(hdlUrlKey_(u)) !== -1) archived++;
      });
    }
  });

  let out = '\n============ HAZING DEATH LINKS ============\n' +
    '  rows: ' + rows.length + '\n' +
    '  rows with at least one URL: ' + withUrl + '\n' +
    '  rows with no URL (never checked, nothing to check): ' + noUrl + '\n' +
    '  individual URLs across those rows: ' + urls + '\n' +
    '  DUE NOW (never checked, or checked before ' + cutoff + '): ' + due + '\n' +
    '  URLs with a Wayback snapshot recorded: ' + archived + ' of ' + urls + '\n' +
    '  current link_status:\n';
  Object.keys(byStatus).sort().forEach(function (k) {
    out += '     ' + k + ': ' + byStatus[k] + '\n';
  });
  out += '\n  hdlDryRun(10) to see what would be written. hdlRun() to work.\n' +
         '  hdlArchiveMissingDryRun25() to see what has no snapshot yet.\n';
  Logger.log(out);
  return { rows: rows.length, withUrl: withUrl, urls: urls, due: due, archived: archived };
}

/**
 * Check a few rows for real and log what WOULD be written. Writes nothing,
 * emails nothing, and does not stamp link_last_checked -- so a dry run
 * never costs ground on a real one.
 *
 * ALWAYS DO THIS FIRST. The failure this file is most likely to have is
 * calling a live page dead because a site refused the request, and the
 * only place that is visible is in the per-URL log lines.
 */
function hdlDryRun(howMany) {
  return hdlWork_({ write: false, limit: Math.max(1, howMany || 10) });
}

// Zero-argument wrappers, because the editor's Run dropdown calls the
// selected function with no arguments and offers nowhere to type a number.
function hdlDryRun10() { return hdlDryRun(10); }
function hdlDryRun25() { return hdlDryRun(25); }

/** Check and WRITE. Resumable: stops on the time budget. */
function hdlRun() { return hdlWork_({ write: true, limit: 0 }); }

/** For a trigger, if one is ever added. Nothing here installs one. */
function hdlRunScheduled_() { return hdlWork_({ write: true, limit: 0 }); }

/**
 * Clears link_last_checked everywhere, so the next hdlRun() re-checks the
 * whole table.
 *
 * TWO FUNCTIONS RATHER THAN A FLAG, following WriteBack.gs: arming a
 * destructive action should be an explicit act that leaves the file
 * unchanged, so nobody arms it by editing a constant and forgets to put it
 * back. hdlRecheckAll() reports; hdlRecheckAllForReal() does it.
 *
 * It clears ONLY the date. link_status and broken_links are left alone so
 * the table still says what was last known while the new sweep runs.
 */
function hdlRecheckAll() {
  const n = hdlReadRows_(hdlPat_()).filter(function (r) { return r.checked; }).length;
  Logger.log('hdlRecheckAll: ' + n + ' row(s) carry a link_last_checked date.\n' +
    'hdlRecheckAllForReal() clears them, which makes every row due again.\n' +
    'link_status and broken_links are NOT cleared -- the table keeps saying\n' +
    'what was last known until the new sweep overwrites each row.');
  return { wouldClear: n };
}

function hdlRecheckAllForReal() {
  const pat = hdlPat_();
  const rows = hdlReadRows_(pat).filter(function (r) { return r.checked; });
  const updates = rows.map(function (r) {
    const f = {}; f[HDL_F_CHECKED] = null;
    return { id: r.id, fields: f };
  });
  hdlFlush_(pat, updates);
  Logger.log('Cleared link_last_checked on ' + updates.length + ' row(s). ' +
    'Run hdlRun() to sweep.');
  return { cleared: updates.length };
}

// =========================================================================
// THE PASS
// =========================================================================

function hdlWork_(opts) {
  let lock = null;
  if (opts.write) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) {
      Logger.log('Another link-check slice is already running -- this one did nothing.');
      return { done: false, skipped: true };
    }
  }
  try { return hdlWorkLocked_(opts); }
  finally { if (lock) lock.releaseLock(); }
}

function hdlWorkLocked_(opts) {
  const pat = hdlPat_();
  const deadline = Date.now() + HDL_BUDGET_MS;
  const cutoff = hdlCutoff_();
  const today = hdlToday_();

  const all = hdlReadRows_(pat);
  if (!all.length) {
    Logger.log('No rows read. Check AIRTABLE_PAT and that it can see ' + HDL_BASE_ID + '.');
    return { done: true };
  }

  const pending = [];      // Airtable updates waiting to be flushed
  const newlyBroken = [];  // rows that changed INTO a broken state this run
  const lines = [];        // dry-run detail
  let examined = 0, checkedRows = 0, urlsChecked = 0, remaining = 0, archiveHits = 0;
  let setAside = 0;
  const attempts = opts.write ? hdlAttempts_() : {};

  for (let i = 0; i < all.length; i++) {
    const row = all[i];
    const urls = hdlSplitUrls_(row.url);

    // No URL is not a finding and not work. Stamp it once so the row stops
    // appearing in the due count, and move on without fetching.
    if (!urls.length) {
      if (opts.write && row.status !== HDL_ST_NONE) {
        const f = {};
        f[HDL_F_STATUS] = HDL_ST_NONE;
        f[HDL_F_BROKEN] = '';
        pending.push({ id: row.id, fields: f });
      }
      continue;
    }

    if (!hdlIsDue_(row.checked, cutoff)) continue;

    // Stop STARTING a row we may not finish. A row is checked as a unit --
    // half its URLs checked and a status written for all of them would be
    // a claim the run cannot support.
    if (Date.now() > deadline) { remaining++; continue; }
    if (opts.limit && examined >= opts.limit) { remaining++; continue; }

    // HAS THIS ROW ALREADY EATEN ITS EXECUTIONS? See HDL_MAX_ATTEMPTS. On a
    // dry run nothing is counted and nothing is set aside -- a dry run must
    // never change what a later real run will do.
    if (opts.write) {
      const tried = Number(attempts[row.id] || 0);
      if (tried >= HDL_MAX_ATTEMPTS) {
        const f = {};
        f[HDL_F_STATUS]  = HDL_ST_UNVERIF;
        f[HDL_F_BROKEN]  = 'Set aside after ' + tried + ' runs were killed before this ' +
          'row could be checked. One of its URLs accepts the connection and never ' +
          'replies, which no automated check can time out. Open the URLs by hand; if ' +
          'one of them is the cause, add its host to HDL_UNFETCHABLE_HOSTS so the ' +
          'other URLs on this row are still checked.';
        f[HDL_F_CHECKED] = today;
        pending.push({ id: row.id, fields: f });
        setAside++;
        delete attempts[row.id];
        hdlSaveAttempts_(attempts);
        while (pending.length) { hdlFlush_(pat, pending.splice(0, HDL_WRITE_BATCH)); }
        continue;
      }
      // COUNTED BEFORE THE WORK, and saved immediately, so the count exists
      // even if this execution is killed in the middle of the next fetch.
      attempts[row.id] = tried + 1;
      hdlSaveAttempts_(attempts);
    }

    examined++;

    const ignore = hdlIgnoreSet_(row.ignore);
    const results = [];
    const archives = [];
    for (let u = 0; u < urls.length; u++) {
      const r = hdlCheckOne_(urls[u], ignore);
      results.push(r);
      urlsChecked++;

      // THE ARCHIVE LOOKUP RUNS WHATEVER THE LINK DID, and that is the
      // point rather than an oversight. A snapshot of a page that is
      // working today is the thing that saves this record when the page
      // goes tomorrow -- waiting until a link breaks is waiting until it
      // is too late to archive it.
      if (HDL_LOOKUP_ARCHIVE) {
        // ALREADY RECORDED? DON'T ASK AGAIN. A Wayback URL contains the
        // address it archived, so the stored text answers this without a
        // fetch. On a re-run of an already-archived table this halves the
        // work, which is the difference between one slice and two.
        const known = hdlKnownSnapshot_(row.archive, urls[u]);
        if (known) {
          archives.push(known);
        } else {
          const snap = hdlWayback_(urls[u]);
          if (snap) { archives.push(snap); archiveHits++; }
        }
      }
      Utilities.sleep(HDL_PAUSE_MS);
    }

    const verdict = hdlSummarise_(results);

    if (!opts.write) {
      lines.push(hdlDescribe_(row, results, verdict, archives));
      continue;
    }

    const f = {};
    f[HDL_F_STATUS]  = verdict.status;
    f[HDL_F_BROKEN]  = verdict.report;
    f[HDL_F_CHECKED] = today;
    // ONLY WRITTEN WHEN SOMETHING WAS FOUND. Writing '' on a run where the
    // Archive was unreachable would erase snapshots recorded on an earlier
    // run and look exactly like "no snapshot exists" -- a silent downgrade
    // of a real finding to a blank.
    if (HDL_LOOKUP_ARCHIVE && archives.length) f[HDL_F_ARCHIVE] = archives.join('\n');
    pending.push({ id: row.id, fields: f });
    checkedRows++;

    // NOTIFY ON A CHANGE INTO A BROKEN STATE, not on every sweep. A link
    // that was dead last month and is dead this month is not news, and a
    // checker that mails the same list every run stops being read.
    // A row checked for the first time counts as a change, because its
    // previous state was "nobody had looked".
    const wasBroken = (row.status === HDL_ST_SOME || row.status === HDL_ST_ALL);
    const isBroken  = (verdict.status === HDL_ST_SOME || verdict.status === HDL_ST_ALL);
    if (isBroken && !wasBroken) {
      newlyBroken.push({
        name: row.name || '(unnamed)',
        status: verdict.status,
        first: !row.status,
        review: row.review || '',
        report: verdict.report
      });
    }

    // WRITE THIS ROW NOW. Was "flush once ten have piled up", which is the
    // other reason nothing survived the killed runs: a row is only durable
    // once it reaches Airtable, and a batch of nine sitting in memory when
    // the six-minute cap fires is nine rows of work thrown away. Since the
    // cap kills the execution outright, no catch block and no final flush
    // ever runs -- there is no cleanup path to rely on.
    //
    // The cost is one PATCH per row instead of one per ten. At ~154 rows
    // that is ~150 extra calls at HDL_SLEEP_MS each, well under a minute
    // spread across the sweep, and it buys the guarantee that a killed run
    // loses at most the single row it was in the middle of. Any queued
    // no-URL stamps ride along in the same call.
    while (pending.length) {
      hdlFlush_(pat, pending.splice(0, HDL_WRITE_BATCH));
    }

    // The row finished. Drop its attempt count so an unrelated failure
    // months from now starts from zero rather than inheriting this one.
    if (attempts[row.id]) {
      delete attempts[row.id];
      hdlSaveAttempts_(attempts);
    }
  }

  if (opts.write) hdlFlush_(pat, pending);

  // ---- report ----------------------------------------------------------
  if (!opts.write) {
    let s = '\n======== HAZING DEATH LINKS -- DRY RUN ========\n' +
      'Nothing was written, nothing was emailed, no date was stamped.\n' +
      examined + ' row(s) checked, ' + urlsChecked + ' URL(s) fetched.\n';
    lines.forEach(function (l, n) { s += '\n' + (n + 1) + '. ' + l; });
    s += '\nREAD THE FAILURES ABOVE before running hdlRun(). A site that ' +
         'refuses\nautomated requests looks exactly like a dead page here, ' +
         'and the difference\nmatters: one needs a new source, the other ' +
         'needs a line in links_to_ignore.\n';
    Logger.log(s);
    return { dryRun: true, examined: examined, urls: urlsChecked };
  }

  const done = remaining === 0;
  Logger.log(
    '\n======== HAZING DEATH LINKS ========\n' +
    (done ? 'FINISHED -- nothing left due. ' : 'Time budget reached. ') +
    'This run: ' + checkedRows + ' row(s), ' + urlsChecked + ' URL(s).\n' +
    // NEVER SILENT. Setting a row aside is the script giving up on it, and
    // that has to be visible in the same place as the ordinary counts --
    // an invisible give-up is how a bad row becomes a quietly wrong number.
    (setAside
      ? 'SET ASIDE: ' + setAside + ' row(s) marked Unverifiable after repeated ' +
        'killed runs. Filter link_status = Unverifiable and read broken_links; ' +
        'each names what to do.\n'
      : '') +
    (HDL_LOOKUP_ARCHIVE
      ? 'Wayback snapshots found: ' + archiveHits + ' of ' + urlsChecked + ' URL(s).\n'
      : 'Archive lookup is OFF (HDL_LOOKUP_ARCHIVE).\n') +
    (remaining ? remaining + ' row(s) still due. Run hdlRun() again to continue.\n' : '') +
    'Newly broken rows this run: ' + newlyBroken.length + '\n' +
    'Rows are re-checked when their link_last_checked is more than ' +
    HDL_RECHECK_DAYS + ' days old.\n'
  );

  if (newlyBroken.length) hdlEmail_(newlyBroken);

  return { done: done, checked: checkedRows, urls: urlsChecked,
           newlyBroken: newlyBroken.length, remaining: remaining };
}

// =========================================================================
// CHECKING ONE URL
// =========================================================================

/**
 * Fetches one address, following redirects by hand, and says what
 * happened.
 *
 * A MOVED ARTICLE IS NOT A BROKEN LINK. A redirect that lands on a real
 * page is a pass, and the chain itself is not a finding anyone would act
 * on.
 *
 * A REDIRECT TO THE SITE'S FRONT PAGE IS A DIFFERENT MATTER -- the "soft
 * 404". A large news site that has retired an article often answers with
 * a 302 to its homepage and a cheerful 200, which reads as working while
 * the source is in fact gone. Comparing the final path against the one
 * asked for catches the common shape of that for free: a request for
 * /news/2017/some-article that ends at / has not found the article.
 *
 * WHAT THIS STILL MISSES, and it is worth knowing when a row says All
 * working and Sierra says otherwise: a site that serves a "story not
 * found" PAGE at the original address with a 200, and a site that
 * redirects to a section index rather than the root (/news/ rather than
 * /). Both need a judgment about page content, which is a much larger job
 * than this and is not what was asked for. Only redirects to the ROOT are
 * flagged, because that is the shape that can be recognised without
 * reading anything.
 */
function hdlCheckOne_(url, ignoreSet) {
  const out = { url: url, ok: false, code: 0, label: '', ignored: false,
                unverifiable: false, landed: '' };
  out.ignored = !!ignoreSet[hdlUrlKey_(url)];

  if (url.length > HDL_MAX_URL_LEN) {
    out.label = 'Not checked - address is longer than ' + HDL_MAX_URL_LEN + ' characters';
    return out;
  }

  // NOT FETCHED, ON PURPOSE. See HDL_UNFETCHABLE_HOSTS: this host hangs
  // rather than answering, and there is no way to time a request out.
  // Unverifiable rather than broken -- we cannot see the page, which is not
  // the same as the page being gone.
  if (hdlIsUnfetchable_(url)) {
    out.unverifiable = true;
    out.label = 'Not checked - this host accepts the connection and never replies, ' +
                'so it cannot be checked automatically. Open it by hand.';
    return out;
  }

  // A STUBBORN HOST IS NO LONGER FETCHED EITHER (2026-09-10). It used to be
  // fetched and its 401/403 classified as unverifiable. That was pointless
  // and, as the Post proved, dangerous.
  //
  // Pointless: this list exists precisely because these hosts "answer 403 for
  // a live article and a dead one identically" -- see HDL_STUBBORN_HOSTS. The
  // best outcome a fetch can produce is therefore Unverifiable, which is what
  // skipping produces, at no cost and with no wait.
  //
  // Dangerous: washingtonpost.com is on this list and does not answer 403 at
  // all -- it accepts the connection and never replies, killing the execution
  // and blocking every row behind it. newspapers.com carries ~17 rows here and
  // nytimes, wsj, ft, latimes, bostonglobe, jstor and proquest are all the same
  // shape. Fetching them was buying a hang risk for an answer we would discard.
  //
  // WHAT THIS GIVES UP: a stubborn host that unexpectedly returns 200 would
  // have been recorded as working. Accepted -- by this list's own definition
  // that does not happen, and if one of these ever opens up, take it off the
  // list deliberately rather than paying for the possibility on every run.
  if (hdlIsStubborn_(url)) {
    out.unverifiable = true;
    out.label = 'Not fetched - this host refuses every automated request and answers ' +
                'the same whether or not the page still exists, so an automated check ' +
                'cannot tell you anything. Open it by hand.';
    return out;
  }

  let current = url;
  let code = 0;
  let hops = 0;

  while (true) {
    let resp = null;
    try {
      resp = UrlFetchApp.fetch(current, {
        headers: HDL_BROWSER_HEADERS,
        muteHttpExceptions: true,
        followRedirects: false,       // see HDL_MAX_REDIRECTS
        validateHttpsCertificates: true
      });
    } catch (err) {
      // DNS failure, TLS failure, timeout. NOT reported as a 404: "the site
      // would not answer" and "the site answered, the page is gone" are
      // different facts, and only the second is a reason to go find a new
      // source.
      out.code = 0;
      out.landed = current;
      out.label = 'No response - the site could not be reached (DNS, TLS or timeout)';
      return out;
    }

    code = resp.getResponseCode();
    if (code < 300 || code > 399) break;

    const next = hdlLocationOf_(resp, current);
    if (!next) {
      // A 3xx with no usable Location. Nothing to follow, and calling it
      // working would be a guess about where it meant to go.
      out.code = code;
      out.landed = current;
      out.label = 'Redirect with no destination - ' + code + ', nowhere to follow';
      return out;
    }
    if (++hops > HDL_MAX_REDIRECTS) {
      out.code = code;
      out.landed = next;
      out.label = 'Redirect loop - more than ' + HDL_MAX_REDIRECTS + ' hops';
      return out;
    }
    current = next;
    Utilities.sleep(HDL_PAUSE_MS);
  }

  out.code = code;
  out.landed = current;

  if (code === 200) {
    if (hdlIsLoginUrl_(current)) {
      out.label = 'Login or paywall - resolves, but lands on a sign-in page';
      return out;
    }
    // THE HOMEPAGE CHECK. Only fires when the address asked for had a real
    // path and the one we ended on does not -- so a link that was always
    // the site root is never flagged, and neither is a redirect that keeps
    // any path at all.
    if (hops > 0 && !hdlIsRootish_(url) && hdlIsRootish_(current)) {
      out.label = 'Redirected to homepage - the article is probably gone. ' +
                  'Landed on ' + current;
      return out;
    }
    out.ok = true;
    out.label = hops > 0 ? 'Working - redirected to ' + current : 'Working';
    return out;
  }

  if (code === 404 || code === 410) {
    out.label = 'Dead link - ' + code + ', the page is gone';
    return out;
  }
  if (code === 401 || code === 403) {
    if (hdlIsStubborn_(url)) {
      // NOT COUNTED EITHER WAY. This host answers 403 for a live page and
      // a dead one alike, so there is nothing here to judge. See
      // HDL_STUBBORN_HOSTS.
      out.unverifiable = true;
      out.label = 'Unverifiable - ' + code + ', this host refuses all automated ' +
                  'requests. Live and dead pages look identical from here; ' +
                  'open it by hand to tell';
      return out;
    }
    out.label = 'Blocked - ' + code +
      '. May well open fine in a browser - check by hand before replacing it';
    return out;
  }
  if (code >= 500) {
    out.label = 'Site error - ' + code + ', probably temporary';
    return out;
  }
  out.label = 'Unexpected response - ' + code;
  return out;
}

/**
 * The row-level summary, and the one place the ignore list is applied.
 *
 * THREE POPULATIONS, NOT TWO, and keeping them apart is what makes this
 * field honest:
 *
 *   IGNORED    - a person muted this address. Reported, never counted.
 *   UNVERIFIABLE - the host refuses all automated requests, so there is no
 *                answer to read. Reported, and it does not VOTE: it
 *                neither passes nor fails the row.
 *   JUDGEABLE  - everything else. These decide the status.
 *
 * A row reads Unverifiable only when NOTHING on it was judgeable. One
 * newspapers.com link beside a working link reads All working; beside a
 * dead one it reads All broken. The unverifiable link simply abstains.
 *
 * EVERYTHING IS REPORTED WHATEVER ITS CLASS. The ignore list and the
 * stubborn-host list change what COUNTS, never what is RECORDED -- so a
 * person reading broken_links sees the whole picture even where the status
 * field is deliberately quiet.
 */
function hdlSummarise_(results) {
  let counted = 0, unverifiable = 0, failures = 0;
  const report = [];

  results.forEach(function (r) {
    if (!r.ignored) {
      counted++;
      if (r.unverifiable) unverifiable++;
      else if (!r.ok) failures++;
    }
    if (!r.ok) {
      const tag = r.ignored ? '(ignored) ' : (r.unverifiable ? '(unverifiable) ' : '');
      report.push(tag + r.url + '\n    ' + r.label);
    }
  });

  const judgeable = counted - unverifiable;

  let status;
  if (counted === 0) {
    // Every URL on the row is muted. Not a failure and not a pass -- there
    // is nothing left this check is allowed to have an opinion about.
    status = HDL_ST_NONE;
  } else if (judgeable === 0) {
    status = HDL_ST_UNVERIF;
  } else if (failures === 0) {
    status = HDL_ST_OK;
  } else if (failures === judgeable) {
    status = HDL_ST_ALL;
  } else {
    status = HDL_ST_SOME;
  }

  return { status: status, report: report.join('\n') };
}

function hdlDescribe_(row, results, verdict, archives) {
  let s = (row.name || '(unnamed)') + '  ->  ' + verdict.status + '\n';
  results.forEach(function (r) {
    const mark = r.ok ? 'OK  ' : (r.unverifiable ? '????' : 'FAIL');
    s += '     ' + mark + (r.ignored ? ' (ignored)' : '') +
         '  ' + r.url.slice(0, 100) + '\n' +
         '           ' + r.label + '\n';
  });
  if (HDL_LOOKUP_ARCHIVE) {
    s += '     archive: ' + (archives && archives.length
      ? archives.length + ' snapshot(s)\n' +
        archives.map(function (a) { return '           ' + a.slice(0, 110); }).join('\n') + '\n'
      : 'none found\n');
  }
  return s;
}

// =========================================================================
// URLS
// =========================================================================

/**
 * Splits the URL cell into individual addresses.
 *
 * Commas, semicolons, newlines and bare whitespace all separate, because
 * the field is hand-entered and all four occur. Anything that is not an
 * absolute http(s) address is dropped rather than fetched -- a fragment of
 * a citation is not a link, and trying to fetch it buys a confident
 * failure against something that was never a URL.
 */
function hdlSplitUrls_(raw) {
  const out = [];
  const seen = {};
  String(raw || '').split(/[\s,;]+/).forEach(function (piece) {
    let u = String(piece || '').trim().replace(/[),.;]+$/, '');
    if (!u || !/^https?:\/\//i.test(u)) return;
    const key = hdlUrlKey_(u);
    if (seen[key]) return;            // the same source listed twice
    seen[key] = true;
    out.push(u);
  });
  return out;
}

/**
 * The comparison key for the ignore list.
 *
 * Scheme, www and trailing slashes are dropped so http/https and www
 * variants of one address all match a single line in links_to_ignore --
 * a person muting a link should not have to guess which spelling the
 * field holds. Query strings are KEPT: on archive sites they are the
 * article, not decoration.
 */
function hdlUrlKey_(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function hdlIgnoreSet_(raw) {
  const set = {};
  String(raw || '').split(/[\s,;]+/).forEach(function (piece) {
    const k = hdlUrlKey_(piece);
    if (k) set[k] = true;
  });
  return set;
}

/**
 * The Location header of a 3xx, resolved against the address it came from.
 *
 * Servers are allowed to send a relative Location and plenty do, so a bare
 * "/" or "/news/" has to be joined to the current origin -- left raw it
 * would be handed to UrlFetchApp as a malformed URL and read as a dead
 * link. Header names are matched case-insensitively because Apps Script
 * returns whatever casing the server used.
 */
function hdlLocationOf_(resp, fromUrl) {
  let loc = '';
  try {
    const all = resp.getAllHeaders() || {};
    Object.keys(all).forEach(function (k) {
      if (String(k).toLowerCase() === 'location' && !loc) {
        const v = all[k];
        loc = String(Array.isArray(v) ? v[0] : v).trim();
      }
    });
  } catch (e) { /* headers are best-effort only */ }
  if (!loc) return '';

  if (/^https?:\/\//i.test(loc)) return loc;

  const m = /^(https?:\/\/[^\/]+)(\/[^?#]*)?/i.exec(String(fromUrl));
  if (!m) return '';
  const origin = m[1];
  if (loc.charAt(0) === '/') return origin + loc;

  // A relative hop with no leading slash, resolved against the current
  // directory. Rare, but a wrong join here invents a URL and then reports
  // it as broken.
  const dir = (m[2] || '/').replace(/[^\/]*$/, '');
  return origin + dir + loc;
}

/** The path of a URL, '' or '/' meaning the site's front page. */
function hdlPath_(url) {
  const m = /^https?:\/\/[^\/?#]+([^?#]*)/i.exec(String(url || ''));
  return m ? m[1] : '';
}

/**
 * True when this address is the site's front page.
 *
 * Deliberately strict. Only an empty path, "/", and the handful of index
 * filenames a server serves at the root count -- a redirect to /news/ is
 * NOT treated as a homepage, because a section index is sometimes where an
 * archived story genuinely lives and guessing wrong here would call a
 * working source dead.
 */
function hdlIsRootish_(url) {
  const p = hdlPath_(url).toLowerCase().replace(/\/+$/, '');
  return p === '' || /^\/(?:index|home|default)\.(?:html?|php|aspx?)$/.test(p);
}

function hdlIsLoginUrl_(url) {
  const s = String(url || '');
  for (let i = 0; i < HDL_LOGIN_URL_PATTERNS.length; i++) {
    if (HDL_LOGIN_URL_PATTERNS[i].test(s)) return true;
  }
  return false;
}

function hdlIsUnfetchable_(url) {
  const m = /^(?:https?:\/\/)?([^\/\?#]+)/i.exec(String(url || ''));
  if (!m) return false;
  const host = m[1].toLowerCase().replace(/^www\d*\./, '');
  for (let i = 0; i < HDL_UNFETCHABLE_HOSTS.length; i++) {
    const v = HDL_UNFETCHABLE_HOSTS[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) return true;
  }
  return false;
}

function hdlIsStubborn_(url) {
  const m = /^(?:https?:\/\/)?([^\/\?#]+)/i.exec(String(url || ''));
  if (!m) return false;
  const host = m[1].toLowerCase().replace(/^www\d*\./, '');
  for (let i = 0; i < HDL_STUBBORN_HOSTS.length; i++) {
    const v = HDL_STUBBORN_HOSTS[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) return true;
  }
  return false;
}

// =========================================================================
// THE WAYBACK MACHINE
// =========================================================================

/**
 * The closest existing snapshot of this URL, or '' if there is none.
 *
 * A READ, NOT A REQUEST TO ARCHIVE. It asks what the Archive already has;
 * it never asks it to go and crawl anything. Making a snapshot is
 * hdlArchiveMissing's job and is deliberately kept out of the main run.
 *
 * FAILS SOFT, ALWAYS. Every error path returns '' and the run carries on.
 * The Archive being slow or down must never fail a link check that has
 * already been done, and hdlWorkLocked_ only WRITES archive_url when
 * something was found -- so an empty answer here leaves whatever was
 * recorded on a previous run untouched rather than erasing it.
 *
 * The returned URL contains the original address inside it, which is what
 * lets archive_url hold one line per source with no dependence on order.
 */
function hdlWayback_(url) {
  try {
    const resp = UrlFetchApp.fetch(
      HDL_WAYBACK_AVAILABLE + encodeURIComponent(url),
      { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) return '';

    const j = JSON.parse(resp.getContentText());
    const snap = j && j.archived_snapshots && j.archived_snapshots.closest;
    if (!snap || !snap.available || !snap.url) return '';

    // The API answers http:// even for pages archived over https. Normalise
    // so the stored links do not trip modern browsers' mixed-content and
    // upgrade rules.
    return String(snap.url).replace(/^http:\/\/web\.archive\.org/i,
                                    'https://web.archive.org');
  } catch (e) {
    return '';
  }
}

/**
 * The snapshot already recorded for this URL on this row, or ''.
 *
 * A Wayback URL contains the address it archived, so the stored archive_url
 * text answers "do we already have this one" with no fetch at all. Matching
 * on the normalised key rather than the raw string, so an http/https or www
 * difference does not read as "not archived" and buy a needless lookup.
 */
function hdlKnownSnapshot_(stored, url) {
  const key = hdlUrlKey_(url);
  if (!key) return '';
  const lines = String(stored || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && line.toLowerCase().indexOf(key) !== -1) return line;
  }
  return '';
}

/**
 * Asks the Wayback Machine to archive live sources that have no snapshot.
 *
 * CAPPED AND HAND-RUN, and the cap is required rather than polite. Save
 * Page Now asks the Archive to go and crawl a page: it takes ten to thirty
 * seconds each, it is rate limited, and it is a write to somebody else's
 * infrastructure. Ten at a time is most of a slice.
 *
 * IT ONLY WORKS ON PAGES THAT ARE STILL LIVE. Nothing can archive a page
 * retroactively -- once a source is gone it is gone, and that is the whole
 * argument for archiving a link at the moment it is added rather than
 * waiting until the checker finds it broken.
 *
 * It does not write to Airtable. The snapshot it creates is picked up by
 * the next hdlRun(), which is the one place archive_url is written -- one
 * writer per field, so the two passes cannot disagree about what a row
 * holds.
 *
 * hdlArchiveMissingDryRun(n) lists what it would submit and sends nothing.
 */
function hdlArchiveMissing(howMany) {
  return hdlArchive_({ save: true, limit: Math.max(1, howMany || 10) });
}
function hdlArchiveMissingDryRun(howMany) {
  return hdlArchive_({ save: false, limit: Math.max(1, howMany || 25) });
}
function hdlArchiveMissing10()       { return hdlArchiveMissing(10); }
function hdlArchiveMissingDryRun25() { return hdlArchiveMissingDryRun(25); }

function hdlArchive_(opts) {
  const pat = hdlPat_();
  const rows = hdlReadRows_(pat);
  const deadline = Date.now() + HDL_BUDGET_MS;

  const candidates = [];
  rows.forEach(function (row) {
    const have = String(row.archive || '');
    hdlSplitUrls_(row.url).forEach(function (u) {
      // Already archived? The snapshot line contains the original address,
      // so a substring test on the stored text is enough and costs no
      // fetch. Matching on the key rather than the raw string so an
      // http/https or www difference does not read as "not archived".
      if (have && have.toLowerCase().indexOf(hdlUrlKey_(u)) !== -1) return;
      candidates.push({ name: row.name, url: u });
    });
  });

  Logger.log('\n======== ARCHIVE MISSING ========\n' +
    candidates.length + ' URL(s) have no snapshot recorded.\n' +
    (opts.save ? 'Submitting up to ' + opts.limit + '.\n'
               : 'DRY RUN -- listing up to ' + opts.limit + ', sending nothing.\n'));

  let sent = 0, failed = 0;
  for (let i = 0; i < candidates.length && sent + failed < opts.limit; i++) {
    if (Date.now() > deadline) {
      Logger.log('Time budget reached. Run again to continue.');
      break;
    }
    const c = candidates[i];

    if (!opts.save) {
      Logger.log('  would submit: ' + c.url.slice(0, 120) +
                 '   (' + String(c.name).slice(0, 40) + ')');
      sent++;
      continue;
    }

    try {
      const resp = UrlFetchApp.fetch(HDL_WAYBACK_SAVE + c.url,
        { muteHttpExceptions: true, followRedirects: true });
      const code = resp.getResponseCode();
      // 200 and 302 both mean accepted. Anything else is usually the
      // Archive declining -- a page it cannot reach, or one whose
      // robots/terms it will not crawl. Not an error worth stopping for.
      if (code === 200 || code === 302) { sent++; Logger.log('  saved: ' + c.url.slice(0, 110)); }
      else { failed++; Logger.log('  declined (' + code + '): ' + c.url.slice(0, 100)); }
    } catch (e) {
      failed++;
      Logger.log('  failed: ' + c.url.slice(0, 100) + '  ' + e);
    }
    Utilities.sleep(HDL_SAVE_PAUSE_MS);
  }

  Logger.log('\n' + (opts.save
    ? 'Submitted ' + sent + ', declined or failed ' + failed + '.\n' +
      'SUBMITTING IS NOT RECORDING. This asks the Archive to go and crawl the\n' +
      'page; it writes nothing to archive_url. Run hdlFindArchives() afterwards\n' +
      'to look the snapshots up and record them -- give the Archive a few\n' +
      'minutes first, since a submitted crawl is not instantly available.\n' +
      '(This used to say the snapshots appear on the next hdlRun(). That was\n' +
      'true until 2026-09-10, when the availability lookup was taken out of\n' +
      'the link sweep -- see HDL_LOOKUP_ARCHIVE.)\n' +
      'A decline is normal for paywalled or bot-blocked sources -- ' +
      'those cannot be archived at all.'
    : 'Listed ' + sent + '. hdlArchiveMissing(10) to submit.'));

  return { candidates: candidates.length, sent: sent, failed: failed };
}

// =========================================================================
// RECORDING EXISTING SNAPSHOTS
// =========================================================================
/**
 * Fill archive_url with the Wayback snapshots that ALREADY EXIST.
 *
 * THE DIFFERENCE FROM hdlArchiveMissing, which is the whole reason both
 * exist. That one SUBMITS a page to Save Page Now and asks the Archive to
 * crawl it; it records nothing. This one ASKS whether a snapshot exists and
 * writes down the answer. Submitting without recording leaves archive_url
 * empty forever; recording without submitting simply finds nothing for
 * pages nobody ever archived. The order is: link sweep, then this, then
 * hdlArchiveMissing for whatever came back with nothing, then this again a
 * few minutes later to pick the new snapshots up.
 *
 * WHY THIS IS A SEPARATE PASS AND NOT PART OF hdlRun. It used to be part of
 * it. archive.org's availability endpoint routinely takes tens of seconds
 * and cannot be given a timeout, so it ate the entire six-minute execution
 * and the link sweep -- the thing anyone was actually waiting for -- never
 * finished. Slow third-party reads belong in their own hand-run pass where
 * being slow costs nothing but that pass. See HDL_LOOKUP_ARCHIVE.
 *
 * RUN:
 *   hdlFindArchivesDryRun25()  ask about 25 URLs and log the answers.
 *                              Writes nothing, moves no cursor.
 *   hdlFindArchives()          work for one budget and write. Run again to
 *                              continue; it resumes where it stopped.
 *   hdlFindArchivesReset()     start the sweep over from the top.
 *
 * IT NEVER ERASES. A URL that already has a snapshot recorded is skipped
 * without a fetch, and a lookup that comes back empty writes nothing at
 * all -- so a slow day at the Archive can never downgrade a real finding
 * to a blank. New snapshots are merged into whatever the row already held.
 *
 * A URL WITH NO SNAPSHOT IS ASKED AGAIN ON THE NEXT FULL SWEEP, deliberately.
 * There is no "we asked and there was none" marker, because that answer goes
 * stale the moment anyone archives the page -- including hdlArchiveMissing
 * doing exactly that. Re-asking is the point.
 */
const HDL_PROP_ARCH_AFTER = 'hdl_arch_after';   // last record id completed

function hdlFindArchives()         { return hdlFindArchives_({ write: true,  limit: 0  }); }
function hdlFindArchivesDryRun25() { return hdlFindArchives_({ write: false, limit: 25 }); }

function hdlFindArchivesReset() {
  PropertiesService.getScriptProperties().deleteProperty(HDL_PROP_ARCH_AFTER);
  Logger.log('Archive lookup cursor cleared. The next hdlFindArchives() starts\n' +
    'from the top. Nothing in archive_url is touched -- URLs that already\n' +
    'have a snapshot recorded are still skipped without a fetch, so a fresh\n' +
    'sweep only re-asks about the ones that came back empty.');
}

function hdlFindArchives_(opts) {
  const pat = hdlPat_();
  const deadline = Date.now() + HDL_BUDGET_MS;
  const props = PropertiesService.getScriptProperties();

  // A dry run always starts from the top and never moves the cursor, so it
  // can be run at any point without costing the real sweep its place.
  const after = opts.write ? (props.getProperty(HDL_PROP_ARCH_AFTER) || '') : '';

  const rows = hdlReadRows_(pat);
  if (!rows.length) {
    Logger.log('No rows read. Check AIRTABLE_PAT and that it can see ' + HDL_BASE_ID + '.');
    return { done: true };
  }

  // THE CURSOR IS A RECORD ID, not a position. Airtable returns rows in a
  // stable order, but "row number 140" would silently mean a different row
  // if any were added or deleted between slices -- the same failure
  // XS_PROP_AFTER was introduced to fix in CrossSeed.gs.
  let start = 0;
  if (after) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].id === after) { start = i + 1; break; }
    }
  }

  let examined = 0, asked = 0, found = 0, none = 0, written = 0, already = 0;
  const preview = [];
  let i = start;

  for (; i < rows.length; i++) {
    if (Date.now() > deadline) break;
    if (opts.limit && asked >= opts.limit) break;

    const row = rows[i];
    const urls = hdlSplitUrls_(row.url);

    // No URL is not work. Move the cursor past it so the row stops being
    // reconsidered on every slice.
    if (!urls.length) {
      if (opts.write) props.setProperty(HDL_PROP_ARCH_AFTER, row.id);
      continue;
    }

    examined++;
    const adds = [];

    for (let u = 0; u < urls.length; u++) {
      // Already recorded? The stored line contains the address it archived,
      // so this costs no fetch.
      if (hdlKnownSnapshot_(row.archive, urls[u])) { already++; continue; }
      if (opts.limit && asked >= opts.limit) break;

      asked++;
      const snap = hdlWayback_(urls[u]);
      if (snap) {
        found++;
        adds.push(snap);
        if (!opts.write) {
          preview.push('  ' + String(row.name).slice(0, 38) + '\n      ' +
            urls[u].slice(0, 96) + '\n      -> ' + snap.slice(0, 110));
        }
      } else {
        none++;
        if (!opts.write) {
          preview.push('  ' + String(row.name).slice(0, 38) + '\n      ' +
            urls[u].slice(0, 96) + '\n      -> no snapshot');
        }
      }
      Utilities.sleep(HDL_PAUSE_MS);
    }

    if (opts.write) {
      // WRITTEN PER ROW, for the reason the link sweep now writes per row:
      // a batch held in memory when the six-minute cap fires is work thrown
      // away, and the cap kills the execution outright with no final flush.
      if (adds.length) {
        const f = {};
        f[HDL_F_ARCHIVE] = hdlMergeArchive_(row.archive, adds);
        hdlFlush_(pat, [{ id: row.id, fields: f }]);
        written++;
      }
      props.setProperty(HDL_PROP_ARCH_AFTER, row.id);
    }
  }

  const done = i >= rows.length;
  if (opts.write && done) props.deleteProperty(HDL_PROP_ARCH_AFTER);

  if (!opts.write) {
    Logger.log('\n======== ARCHIVE LOOKUP -- DRY RUN ========\n' +
      'Nothing was written and the cursor did not move.\n' +
      examined + ' row(s) examined, ' + asked + ' lookup(s): ' +
      found + ' with a snapshot, ' + none + ' without.\n' +
      already + ' URL(s) skipped -- already recorded.\n' +
      (preview.length ? '\n' + preview.join('\n') + '\n' : '') +
      '\nhdlFindArchives() to record them.\n');
    return { dryRun: true, examined: examined, asked: asked, found: found, none: none };
  }

  Logger.log('\n======== ARCHIVE LOOKUP ========\n' +
    (done ? 'FINISHED the sweep. ' : 'Stopped, more to do. ') +
    'Reached row ' + i + ' of ' + rows.length + '.\n' +
    'This slice: ' + examined + ' row(s) examined, ' + asked + ' lookup(s).\n' +
    '  snapshots found and recorded: ' + found + ' across ' + written + ' row(s)\n' +
    '  no snapshot exists yet:       ' + none + '\n' +
    '  skipped, already recorded:    ' + already + '\n' +
    (done
      ? '\nNothing left. hdlArchiveMissing(10) submits the ones with no\n' +
        'snapshot to the Archive; come back and run this again afterwards.\n'
      : '\nRun hdlFindArchives() again to continue from where it stopped.\n'));

  return { done: done, examined: examined, asked: asked,
           found: found, none: none, written: written };
}

/**
 * Existing archive_url lines plus the new ones, in order, without repeats.
 *
 * ADDITIVE ON PURPOSE. The stored lines are kept whatever happens, because
 * each one is a durable copy of a source that may already be gone from the
 * live web -- there is no way to get it back if this overwrites it.
 */
function hdlMergeArchive_(stored, adds) {
  const out = [];
  const seen = {};
  String(stored || '').split('\n').forEach(function (line) {
    const t = line.trim();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  (adds || []).forEach(function (line) {
    const t = String(line).trim();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  return out.join('\n');
}

// =========================================================================
// ATTEMPT COUNTING -- the guarantee that the queue always moves
// =========================================================================
/**
 * These exist because the six-minute cap is not catchable. A row that never
 * finishes is never stamped, so nothing else about the design stops it
 * being retried forever. The count is the only record that an attempt
 * happened at all.
 *
 * Written BEFORE the work, never after. A property write commits
 * immediately and survives the kill; anything written afterwards would
 * never run on precisely the executions this is meant to catch.
 */
function hdlAttempts_() {
  const raw = PropertiesService.getScriptProperties().getProperty(HDL_PROP_ATTEMPTS);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

function hdlSaveAttempts_(map) {
  PropertiesService.getScriptProperties()
    .setProperty(HDL_PROP_ATTEMPTS, JSON.stringify(map));
}

/** Clear every stored attempt count. Run after fixing a poison host. */
function hdlClearAttempts() {
  PropertiesService.getScriptProperties().deleteProperty(HDL_PROP_ATTEMPTS);
  Logger.log('Attempt counts cleared. Rows previously set aside as ' +
    'unverifiable keep that status until they are re-checked -- clear ' +
    'link_last_checked on those rows to put them back in the queue.');
}

// =========================================================================
// DATES
// =========================================================================

function hdlToday_() {
  return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
}

/** The date before which a stored check counts as stale. */
function hdlCutoff_() {
  const d = new Date();
  d.setDate(d.getDate() - HDL_RECHECK_DAYS);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// String comparison is safe here and cheaper than parsing: both values are
// ISO yyyy-MM-dd, where lexical order IS chronological order.
function hdlIsDue_(checked, cutoff) {
  if (!checked) return true;
  return String(checked) < cutoff;
}

// =========================================================================
// AIRTABLE
// =========================================================================

function hdlPat_() {
  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) throw new Error('Set AIRTABLE_PAT in Script Properties first.');
  return pat;
}

/**
 * Every row, with the six fields this needs.
 *
 * NOT FILTERED SERVER-SIDE, for the reason xsTargets_ gives about synced
 * tables and for one of its own: filterByFormula addresses fields by NAME,
 * and these field names were created today and may still be renamed. One
 * full read of a 342-row table costs about a second and cannot fail
 * silently with a smaller result.
 */
function hdlReadRows_(pat) {
  const fields = [HDL_F_URL, HDL_F_NAME, HDL_F_IGNORE, HDL_F_ARCHIVE,
                  HDL_F_STATUS, HDL_F_BROKEN, HDL_F_CHECKED, HDL_F_REVIEW];
  const out = [];
  let offset = null, guard = 0;

  do {
    let url = 'https://api.airtable.com/v0/' + HDL_BASE_ID + '/' + HDL_TABLE_ID +
      '?pageSize=' + HDL_PAGE_SIZE + '&returnFieldsByFieldId=true';
    for (let i = 0; i < fields.length; i++) url += '&fields[]=' + fields[i];
    if (offset) url += '&offset=' + offset;

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable read failed (' + resp.getResponseCode() + '): ' +
        resp.getContentText().slice(0, 300));
    }
    const j = JSON.parse(resp.getContentText());
    (j.records || []).forEach(function (r) {
      const f = r.fields || {};
      out.push({
        id: r.id,
        url:     f[HDL_F_URL]     || '',
        name:    f[HDL_F_NAME]    || '',
        ignore:  f[HDL_F_IGNORE]  || '',
        archive: f[HDL_F_ARCHIVE] || '',
        status:  f[HDL_F_STATUS]  || '',
        broken:  f[HDL_F_BROKEN]  || '',
        checked: f[HDL_F_CHECKED] || '',
        review:  f[HDL_F_REVIEW]  || ''
      });
    });
    offset = j.offset || null;
    Utilities.sleep(HDL_SLEEP_MS);
  } while (offset && ++guard < 100);

  return out;
}

/**
 * One PATCH of up to ten rows.
 *
 * NO typecast. Every link_status value written here is one of the four
 * constants at the top of this file, all of which exist in Airtable, so
 * there is nothing to coerce -- and typecast is how a nameless select
 * choice gets minted elsewhere in this project. Without it a mismatch
 * fails loudly, which is what you want when the alternative is a silently
 * invented option.
 */
function hdlFlush_(pat, rows) {
  if (!rows || !rows.length) return;
  for (let i = 0; i < rows.length; i += HDL_WRITE_BATCH) {
    const batch = rows.slice(i, i + HDL_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + HDL_BASE_ID + '/' + HDL_TABLE_ID,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      // Loud, and it stops the run. Airtable's PATCH is all-or-nothing per
      // batch, so a silent failure here means ten rows were checked and
      // none recorded -- and the run would still report success.
      const body = resp.getContentText();
      throw new Error('Write failed (' + resp.getResponseCode() + '): ' +
        body.slice(0, 400) +
        (body.indexOf('INVALID_MULTIPLE_CHOICE_OPTIONS') !== -1
          ? '\n\nThis almost certainly means the link_status option "' +
            HDL_ST_UNVERIF + '" has not been added yet. Airtable\'s API cannot ' +
            'create a select choice, so add it by hand in the field editor and ' +
            'run again. Nothing was lost -- the rows in this batch are simply ' +
            'still due.'
          : ''));
    }
    Utilities.sleep(HDL_SLEEP_MS);
  }
}

// =========================================================================
// EMAIL
// =========================================================================

/**
 * One digest per run, listing only rows that CHANGED into a broken state.
 *
 * Never a full inventory of everything broken: that list barely moves
 * between runs, and a mail that says the same thing every month is a mail
 * nobody opens. The table itself is the inventory.
 */
function hdlEmail_(rows) {
  const shown = rows.slice(0, HDL_EMAIL_MAX_ROWS);
  const firstEver = rows.filter(function (r) { return r.first; }).length;

  let body = '<p>' + rows.length + ' row(s) in <b>U.S. Hazing Deaths</b> have ' +
    'links that stopped resolving.</p>';

  if (firstEver) {
    body += '<p style="background:#fef3c7;border:1px solid #fcd34d;padding:10px;' +
      'border-radius:6px">' + firstEver + ' of these were being checked for the ' +
      '<b>first time</b>, so this is an initial finding rather than a change. ' +
      'Later runs only report links that were working and have since stopped.</p>';
  }

  body += '<p>Open the <b>broken_links</b> field on each row for the exact ' +
    'address and what happened. A <i>Blocked</i> result usually means the site ' +
    'refuses automated requests and the page opens fine in a browser &mdash; ' +
    'check by hand before hunting for a replacement, and put genuinely flaky ' +
    'addresses in <b>links_to_ignore</b>, one per line.</p><hr>';

  shown.forEach(function (r) {
    body += '<p><b>' + hdlEsc_(r.name) + '</b> &mdash; ' + hdlEsc_(r.status) +
      (r.first ? ' <i>(first check)</i>' : '') +
      (r.review ? ' &mdash; already marked <i>' + hdlEsc_(r.review) + '</i>' : '') +
      '</p><pre style="font-size:12px;white-space:pre-wrap">' +
      hdlEsc_(r.report) + '</pre>';
  });

  if (rows.length > shown.length) {
    body += '<p><i>and ' + (rows.length - shown.length) + ' more. Filter ' +
      'U.S. Hazing Deaths on link_status to see them all.</i></p>';
  }

  hdlNotify_('Hazing death sources: ' + rows.length + ' row(s) with newly broken links', body);
}

function hdlNotify_(subject, htmlBody) {
  const to = PropertiesService.getScriptProperties().getProperty(HDL_NOTIFY_PROP) ||
             Session.getEffectiveUser().getEmail();
  try {
    MailApp.sendEmail({
      to: to,
      subject: '[HazingInfo] ' + subject,
      htmlBody: htmlBody +
        '<hr><p style="color:#666;font-size:12px">Sent by HazingDeathLinks.gs. ' +
        'Change the recipient with the NOTIFY_EMAIL script property.</p>'
    });
  } catch (e) {
    // A mail failure must never take down a run that has already written
    // its findings to Airtable. The table is the record; the email is a
    // convenience.
    Logger.log('Could not send notification email: ' + e);
  }
}

function hdlEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
