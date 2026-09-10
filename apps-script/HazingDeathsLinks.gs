// =========================================================================
// HAZING DEATH LINKS  (rewritten 2026-09-10)
//
// PASTE OVER THE EXISTING FILE. Open HazingDeathsLinks.gs in the editor,
// press Cmd+A, and paste this on top of it. DO NOT create a new file: Apps
// Script shares ONE global scope across every .gs file in the project, so a
// second copy of any HDL_ constant fails the ENTIRE project -- and the error
// names whichever file it noticed second, which is usually not the one you
// touched. Check the final line number after pasting.
//
// -------------------------------------------------------------------------
// WHAT CHANGED, AND WHY THE FILE GOT SHORTER
// -------------------------------------------------------------------------
// It now reads and writes 50 States > HAZING DEATH SOURCES, one row per
// source, instead of the six link_* fields on U.S. Hazing Deaths.
//
// Three whole machines came out with that change, and none of them was
// complexity anyone wanted -- all three existed only because the old URL
// field held several addresses in one cell:
//
//   * SPLITTING AND SUMMARISING. hdlSplitUrls_ and hdlSummarise_ turned N
//     results into one row-level verdict (All working / Some broken / All
//     broken) and then broken_links had to name the individual failures,
//     because "Some broken" does not tell you which source to replace. A row
//     is now one URL, so the status IS the answer.
//   * THE IGNORE LIST. links_to_ignore held addresses as text, parsed on
//     every run, because a row could not mute one source without silencing
//     the others. Muted is now a checkbox on the source itself.
//   * ARCHIVE LINE-PAIRING. archive_url held one snapshot per line and they
//     were matched back to their sources by looking for the original address
//     inside the Wayback URL. One row, one snapshot, one field.
//
// AND TWO THINGS WERE ADDED:
//
//   * TITLES. Every successful fetch now reads og:title (falling back to
//     <title>) and fills Title if it is empty. That is the field Softr
//     shows, so it is the difference between a profile page listing a raw
//     address and listing the name of the article.
//   * MUTED IS UN-TICKED ON A HARD DEAD LINK. Muting says "this host
//     refuses robots, stop telling me". It does not say "stop telling me if
//     the page actually disappears". A muted source that starts answering
//     404 or 410 has its mute cleared so it reappears in the review view.
//     This is what the Needs attention formula used to do; it lives here now
//     so the status field alone carries the whole story.
//
// RUN, IN THIS ORDER:
//   hdlStatus()        what is recorded and what is outstanding. Reads
//                      Airtable, fetches nothing, writes nothing.
//   hdlDryRun(10)      check 10 sources for real and log what WOULD be
//                      written. Writes nothing, stamps nothing.
//   hdlRun()           check and write for ~4.5 minutes, then stop and say
//                      what is left. Run again to continue.
//   hdlFillTitles()    fetch ONLY sources that are Live with no Title and
//                      fill it in. Needed once, now: every row was checked
//                      on 2026-09-10 and so is not due again until October.
//
// AND, SEPARATELY, THE ARCHIVE PASSES:
//   hdlFindArchivesDryRun25()    ask the Archive what snapshots exist.
//   hdlFindArchives()            record them. Resumable.
//   hdlArchiveMissingDryRun25()  list live sources with no snapshot.
//   hdlArchiveMissing10()        ask the Archive to make ten of them.
//
// -------------------------------------------------------------------------
// BEFORE THE FIRST RUN -- TWO HAND EDITS IN AIRTABLE
// -------------------------------------------------------------------------
// 1. RENAME the Link status choice "Working" to "Live". This file writes
//    "Live" and writes WITHOUT typecast, so if the choice is still called
//    Working every write fails loudly on the first live source. That is the
//    safe failure: typecast:true would silently mint a second choice called
//    Live and split the data across two options. Choice IDs survive a
//    rename, so the 159 rows already marked keep their value.
// 2. DELETE the "Needs attention" formula field if it is still there. This
//    file does not read it and the mute rule above replaces it.
//
// The six old fields on U.S. Hazing Deaths -- link_status, broken_links,
// link_last_checked, links_to_ignore, link_review, archive_url -- are no
// longer read or written by anything once this file is in place. Delete them
// AFTER one clean run of this file, not before: if you need to fall back to
// the old version for any reason, they are what it works from.
//
// -------------------------------------------------------------------------
// WHY THIS EXISTS
// -------------------------------------------------------------------------
// Sierra asked for it in the 2026-09-02 team meeting: preparing the
// "In Memory Of" material, she kept opening media links from the U.S.
// Hazing Deaths database and finding them gone. Many of these sources are a
// decade or more old and the outlets have reorganised or disappeared.
//
// It answers ONE question -- does this address still resolve -- and records
// what happened. It makes no editorial judgment about whether the page still
// says what we cited it for; that is human work.
//
// -------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT DO
// -------------------------------------------------------------------------
// IT DOES NOT JUDGE PAGE CONTENT. It follows redirects by hand and judges
// the address it lands on, which catches the common "soft 404" -- an article
// quietly redirected to the site's front page while answering 200. What it
// cannot catch is a site serving a "story not found" PAGE at the original
// address. There is a live example in the table: a Yahoo address that IS
// Yahoo's 404 page, with the real article URL buried in its err_url
// parameter. It reads Live, because Yahoo's error page resolves.
//
// IT DOES NOT SWAP IN THE ARCHIVE COPY BY ITSELF, unless you turn that on --
// see HDL_AUTO_ARCHIVE_SWAP. Off by default because promoting a snapshot
// over the original is a decision about what the public site shows.
//
// IT INSTALLS NO TRIGGER. hdlRunScheduled_ exists so one CAN be pointed at
// it later. Adding a trigger is a decision about the project's trigger
// runtime, not a side effect of pasting a file.
//
// -------------------------------------------------------------------------
// PROGRESS LIVES IN THE DATA, NOT IN A CURSOR
// -------------------------------------------------------------------------
// A source needs work when Last checked is blank or older than
// HDL_RECHECK_DAYS. Checking it writes today's date, so a row leaves the
// queue by being done. An Airtable offset token expires and a saved position
// goes wrong when the list moves; there is nothing here to reset.
//
// -------------------------------------------------------------------------
// DEPENDENCIES: NONE, ON PURPOSE
// -------------------------------------------------------------------------
// Everything is prefixed hdl / HDL_. It does not call capPat_,
// LUC_BROWSER_HEADERS or anything else in the project. The browser headers
// and login-URL patterns are a deliberate second copy, for the reason
// WriteBack.gs gives for its own copy: the two do different jobs, and this
// file must keep working if the pass it borrowed from is retired.
//
// Apps Script does NOT error on a duplicate FUNCTION name -- the later
// definition silently wins and the caller that wanted the other one breaks
// with no message. It DOES error on a duplicate const, and it fails the
// whole project. Both are reasons the prefix matters.
// =========================================================================

// ---- Where everything lives ---------------------------------------------
const HDL_BASE_ID  = 'appJbAvuFOxhWOID2';   // 50 States
const HDL_TABLE_ID = 'tblKNek3GVwR7kMnN';   // Hazing Death Sources

// Read
const HDL_F_URL      = 'fldh4cPl26UAitDQu';   // URL -- exactly one address
const HDL_F_DEATH    = 'fld3H49pInnewYt8K';   // Death record (link)
const HDL_F_MUTED    = 'fldJCX0COluCh8YnI';   // Muted (checkbox)
const HDL_F_REVIEW   = 'fldrr0Y0EIPQghdQJ';   // Review -- read for the email only
const HDL_F_ORIGINAL = 'fldfeh83BDch22yCx';   // Original URL

// Write
const HDL_F_TITLE    = 'fldNIkCcQgQaDVTNu';   // Title (primary)
const HDL_F_STATUS   = 'fldUDk93uptRMQxvO';   // Link status
const HDL_F_DETAIL   = 'fldfpgoE1POCSIAjl';   // Status detail
const HDL_F_ARCHIVE  = 'fldgO0orX97YlolDW';   // Archive URL
const HDL_F_CHECKED  = 'fldaMztTzBm2NKwm1';   // Last checked

// The deaths table, read ONCE per run for victim names so the log and the
// email can say who a source belongs to. Nothing is ever written to it.
const HDL_DEATHS_TABLE = 'tblfKVIPvlHREQGTk';
const HDL_DEATHS_NAME  = 'fldcLeYzKRWMQmwlp';   // Victim's Name

// The four Link status choices, spelled exactly as they exist in Airtable.
// WRITTEN WITHOUT typecast, deliberately: typecast:true on a value that does
// not match mints a NEW choice, and an empty string mints a nameless one --
// which is how Form link tier ended up with a blank option on 32 rows.
// Without typecast a mismatch fails loudly instead. See the header: "Working"
// must be renamed to "Live" by hand before the first run.
const HDL_ST_LIVE    = 'Live';
const HDL_ST_BROKEN  = 'Broken';
const HDL_ST_UNVERIF = 'Unverifiable';
const HDL_ST_NONE    = 'Not checked';

// ---- Run shape -----------------------------------------------------------
// STOP STARTING SOURCES AFTER THIS. Four and a half minutes of a six-minute
// cap.
//
// UrlFetchApp HAS NO TIMEOUT PARAMETER. There is no way to cap how long one
// request may take, so a single hanging host can run for minutes. The budget
// is not "how long the run takes", it is "how late the last source may
// START" -- and the gap to the six-minute cap is the only protection against
// being killed mid-source.
//
// Being killed now costs at most ONE source, because every result is written
// the moment it is known. Ninety seconds of headroom is ample insurance
// against a loss that small. It was 2 minutes on 2026-09-10 for no reason
// other than a stale setting, and that turned 37 minutes of work into 18
// separate clicks.
const HDL_BUDGET_MS    = 4.5 * 60 * 1000;
const HDL_PAUSE_MS     = 250;              // other people's servers
const HDL_WRITE_BATCH  = 10;               // Airtable's hard cap per PATCH
const HDL_PAGE_SIZE    = 100;
const HDL_SLEEP_MS     = 210;              // Airtable's 5 req/sec
const HDL_MAX_URL_LEN  = 2000;

// Redirect hops followed by hand before giving up.
//
// FOLLOWED MANUALLY RATHER THAN BY UrlFetchApp, because of the homepage
// check below: with followRedirects:true the response says 200 and gives no
// reliable way to learn WHERE it landed, so an article quietly redirected to
// the site's front page is indistinguishable from the article still being
// there. Following by hand costs the same fetches and keeps the final
// address.
const HDL_MAX_REDIRECTS = 5;

// How stale a check has to be before a source is looked at again. Sources
// that have survived a decade do not usually die this month, and the whole
// table is ~280 rows, so a monthly sweep costs one or two runs.
const HDL_RECHECK_DAYS = 30;

// ---- Titles --------------------------------------------------------------
// The page's own title, read from the response body that UrlFetchApp has
// already downloaded. No extra request, no extra second.
//
// NEVER OVERWRITTEN. Title is only written when it is EMPTY. A person who
// fixes a mangled title, or types one in for a dead source, must not have it
// silently replaced on the next sweep -- and four rows deliberately hold
// descriptive text rather than an article title, because the original URL
// field held a headline or a paragraph of notes rather than an address.
//
// og:title FIRST, <title> SECOND. A <title> often carries the outlet name
// and section furniture ("Article headline | The Advocate | Baton Rouge");
// og:title is what the publisher means the headline to be when the page is
// shared. Where neither exists the field stays empty rather than being
// filled with a guess.
const HDL_TITLE_MAX_LEN   = 250;

// HOW MUCH OF THE DOCUMENT IS SEARCHED. A title lives in the <head>, so there
// is no reason to run a regex over a whole page -- but there is also no
// reason to give up on a page for being big, which is what the first version
// of this did.
//
// IT WAS A 400KB CAP ON THE WHOLE BODY, AND IT COST ABOUT 30 TITLES on the
// first real run: cbsnews, nypost, cnn, sfgate, ajc, dallasnews and the
// Inquirer all came back "Working" with no title, because a modern news page
// routinely ships more than 400KB of HTML. The guard measured the wrong
// thing -- how big a document is says nothing about how far into it the title
// sits.
//
// So: no cap on the body, and the search runs over the first slice of it. The
// remaining limit is a sanity valve against a pathological response, not a
// judgment about which pages are worth reading.
const HDL_TITLE_SCAN_CHARS = 400000;
const HDL_TITLE_SANITY_MAX = 8000000;

// ---- Promoting the archived copy -----------------------------------------
/**
 * OFF BY DEFAULT, and this switch is a decision about the public site, not
 * a technical setting.
 *
 * WITH IT ON: when a source returns a hard dead link (404 or 410) and an
 * Archive URL is recorded, the script moves the archived address into URL,
 * writes the dead address into Original URL, and re-checks the archived copy
 * on the next sweep like anything else.
 *
 * WHY THAT IS THE SHAPE. Softr links whatever is in one field; it does not do
 * "use this field unless it has that". So the field the site reads has to
 * already hold the address the reader should get. The same move is what puts
 * the snapshot INTO the checked field -- today an archived copy is never
 * checked at all, and Wayback snapshots do occasionally fail.
 *
 * WHY IT IS OFF. It changes what the public page links to, without anyone
 * looking. Turn it on deliberately, after watching a sweep or two, and
 * re-read the counts in hdlStatus() afterwards.
 *
 * IT NEVER TOUCHES A SOURCE THAT IS MERELY BLOCKED. A 403 from a site that
 * refuses robots is a page that opens perfectly well for a human -- sending
 * a reader to an archived copy of a live article is a downgrade. Only 404
 * and 410 qualify.
 */
const HDL_AUTO_ARCHIVE_SWAP = false;

// ---- Notification --------------------------------------------------------
// Set NOTIFY_EMAIL in Script Properties to send elsewhere; otherwise the
// script owner. A mail failure never takes down a run -- see hdlNotify_.
const HDL_NOTIFY_PROP  = 'NOTIFY_EMAIL';
// Sources named in one email before it switches to a count. A first sweep can
// legitimately find dozens; a mail with 160 rows in it does not get read.
const HDL_EMAIL_MAX_ROWS = 40;

// ---- The Wayback Machine -------------------------------------------------
// Two endpoints doing two different jobs, and the difference decides where
// each is allowed to run.
//
// AVAILABILITY is a read: does a snapshot already exist. This used to run
// inline with the link check on the belief that it "answers in well under a
// second". IT DOES NOT -- archive.org routinely takes tens of seconds and
// sometimes never answers, and UrlFetchApp cannot be given a timeout. After
// several full-length runs on 2026-09-10 only 14 of 276 URLs had a snapshot,
// because the lookups were not returning and the link sweep never finished.
//
// SAVE PAGE NOW is a write to somebody else's service: it asks the Archive to
// go and crawl a page, which takes ten to thirty seconds and is rate limited.
//
// Both live in their own hand-run passes. A slow third party must never share
// an execution with the job someone is waiting for.
const HDL_WAYBACK_AVAILABLE = 'https://archive.org/wayback/available?url=';
const HDL_WAYBACK_SAVE      = 'https://web.archive.org/save/';
const HDL_SAVE_PAUSE_MS     = 2000;

/**
 * Hosts that NEITHER ANSWER NOR FAIL. Not the same as a refusal.
 *
 * A stubborn host (below) answers 403 in milliseconds and the run moves on.
 * A host on THIS list accepts the connection and then never replies.
 *
 * UrlFetchApp does eventually give up -- measured at ~6 minutes on
 * 2026-09-10, when it threw "Exception: Timeout" on washingtonpost.com. But
 * that is AT the execution cap, not before it, and no parameter shortens it.
 * The throw is worthless: the execution is killed in the same moment the
 * exception would have been caught, no catch and no finally runs, and the row
 * is never stamped -- so it is first in the queue again on the next run, and
 * the one after that. One such URL stops the entire sweep indefinitely while
 * the log shows nothing but "Exceeded maximum execution time". That is
 * exactly what happened: 146 rows sat untouched across four consecutive runs.
 *
 * A URL on one of these hosts is NOT FETCHED AT ALL and is recorded
 * unverifiable -- we cannot see the page, which is not the same as the page
 * being gone.
 */
const HDL_UNFETCHABLE_HOSTS = [
  // MEASURED, not guessed. findPoison fetched this host alone and it threw
  // "Exception: Timeout" after six minutes, killing the execution.
  'washingtonpost.com',
  // Confirmed by elimination on 2026-09-10: two sources were set aside by the
  // attempt counter and both carried a usnews.com address; findPoison cleared
  // hanknuwer.com, the only other host on one of them.
  'usnews.com'
  // Add a host here the moment it is confirmed to hang rather than answer.
  // Format: bare registrable host, no scheme, no www -- 'example.com'.
  // Do not add one on suspicion: an untested host listed here is a source
  // silently never checked again.
];

/**
 * THE BACKSTOP BEHIND THAT LIST, because a list can only name hosts somebody
 * has already diagnosed.
 *
 * A source is counted as attempted BEFORE any fetch, and the count is written
 * to Script Properties immediately -- a property write commits at once and
 * therefore survives the execution being killed, which is the whole trick. A
 * source that has burned this many executions without finishing is set aside
 * as unverifiable, with the reason recorded, so the queue behind it moves.
 *
 * TWO is deliberate. One would set aside sources lost to an ordinary blip.
 * Three costs eighteen minutes to learn what two already proved.
 */
const HDL_MAX_ATTEMPTS = 2;
const HDL_PROP_ATTEMPTS = 'hdl_attempts';   // {recordId: count}

/**
 * Hosts that refuse every automated request whatever you send them.
 *
 * A 401 or 403 FROM ONE OF THESE IS RECORDED AS UNVERIFIABLE RATHER THAN
 * BROKEN, and that distinction is why this list exists. newspapers.com
 * answers 403 for a live article and a dead one identically: there is no
 * signal to read. Calling those broken would assert something the checker
 * cannot know, and would put rows in front of a reviewer every month that
 * she can do nothing about.
 *
 * WHAT IT COSTS: a genuinely dead URL on one of these hosts stays invisible
 * until a person opens it. Unavoidable rather than chosen -- the information
 * was never available to an unauthenticated checker. Unverifiable is the
 * honest name for that.
 *
 * A 403 from a host NOT on this list is still reported as Broken, because on
 * an ordinary site a 403 is worth a look.
 */
const HDL_STUBBORN_HOSTS = [
  'newspapers.com', 'ancestry.com', 'wsj.com', 'nytimes.com',
  'washingtonpost.com', 'latimes.com', 'bostonglobe.com', 'ft.com',
  'jstor.org', 'proquest.com', 'usnews.com', 'npr.org'
];
// washingtonpost.com and usnews.com are on BOTH lists, and the unfetchable
// check runs first, so their entries here are dead code for those two hosts.
// Left in place because the two lists mean different things and this one is
// the honest record that both are paywalled archives. If either ever starts
// answering, remove it from HDL_UNFETCHABLE_HOSTS and this entry resumes.

// A browser-shaped request. The default Apps Script User-Agent identifies as
// Google and a large share of news and archive sites reject it outright,
// which manufactures "dead link" readings for pages that open perfectly well
// in a browser.
const HDL_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Addresses that ARE resolvable but are a sign-in page rather than the
// article. Reported separately from a dead link because the fix differs: a
// dead link needs a replacement source, a login wall needs a person to decide
// whether the source is reachable at all.
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

  let withUrl = 0, noUrl = 0, due = 0, archived = 0, titled = 0;
  let muted = 0, swapped = 0;
  const byStatus = {};

  rows.forEach(function (r) {
    if (r.url) { withUrl++; } else { noUrl++; }
    if (r.url && hdlIsDue_(r.checked, cutoff)) due++;
    if (r.archive) archived++;
    if (r.title) titled++;
    if (r.muted) muted++;
    if (r.original) swapped++;
    const s = r.status || '(blank)';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });

  let out = '\n============ HAZING DEATH SOURCES ============\n' +
    '  source rows: ' + rows.length + '\n' +
    '  with an address: ' + withUrl + '\n' +
    '  with no address (nothing to check): ' + noUrl + '\n' +
    '  DUE NOW (never checked, or checked before ' + cutoff + '): ' + due + '\n' +
    '  with a Wayback snapshot recorded: ' + archived + '\n' +
    '  with a Title filled in: ' + titled + ' of ' + rows.length + '\n' +
    '  muted by a person: ' + muted + '\n' +
    '  now serving an archived copy: ' + swapped + '\n' +
    '  current Link status:\n';
  Object.keys(byStatus).sort().forEach(function (k) {
    out += '     ' + k + ': ' + byStatus[k] + '\n';
  });
  out += '\n  hdlDryRun(10) to see what would be written. hdlRun() to work.\n' +
         '  hdlFillTitles() to fill Title on live sources without re-checking.\n' +
         '  hdlFindArchivesDryRun25() to see what has no snapshot yet.\n';
  Logger.log(out);
  return { rows: rows.length, withUrl: withUrl, due: due,
           archived: archived, titled: titled };
}

/**
 * Check a few sources for real and log what WOULD be written. Writes nothing,
 * emails nothing, stamps nothing -- so a dry run never costs ground on a real
 * one.
 *
 * ALWAYS DO THIS FIRST after changing anything. The failure this file is most
 * likely to have is calling a live page dead because a site refused the
 * request, and the only place that is visible is the per-source log lines.
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
 * Clears Last checked everywhere, so the next hdlRun() re-checks everything.
 *
 * TWO FUNCTIONS RATHER THAN A FLAG, following WriteBack.gs: arming a
 * destructive action should be an explicit act that leaves the file
 * unchanged, so nobody arms it by editing a constant and forgets to put it
 * back.
 *
 * It clears ONLY the date. Link status and Status detail are left alone so
 * the table still says what was last known while the new sweep runs.
 *
 * NOT THE WAY TO GET TITLES. Use hdlFillTitles(), which fetches only what it
 * needs and leaves the check dates alone.
 */
function hdlRecheckAll() {
  const n = hdlReadRows_(hdlPat_()).filter(function (r) { return r.checked; }).length;
  Logger.log('hdlRecheckAll: ' + n + ' source(s) carry a Last checked date.\n' +
    'hdlRecheckAllForReal() clears them, which makes every source due again.\n' +
    'Link status and Status detail are NOT cleared -- the table keeps saying\n' +
    'what was last known until the new sweep overwrites each row.\n' +
    'If you only want Titles, run hdlFillTitles() instead.');
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
  Logger.log('Cleared Last checked on ' + updates.length + ' source(s). ' +
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
  const names = hdlVictimNames_(pat);

  const pending = [];      // Airtable updates waiting to be flushed
  const newlyBroken = [];  // sources that changed INTO a broken state
  const lines = [];        // dry-run detail
  let examined = 0, written = 0, remaining = 0;
  let setAside = 0, titlesAdded = 0, unmuted = 0, promoted = 0;
  const attempts = opts.write ? hdlAttempts_() : {};

  for (let i = 0; i < all.length; i++) {
    const row = all[i];

    // No address is not a finding and not work. Stamp it once so it stops
    // appearing in the due count, and move on without fetching. These are the
    // rows whose entry in the old URL field was a headline or a paragraph of
    // notes rather than an address -- their text is preserved in Title.
    if (!row.url) {
      if (opts.write && row.status !== HDL_ST_NONE) {
        const f = {};
        f[HDL_F_STATUS] = HDL_ST_NONE;
        pending.push({ id: row.id, fields: f });
      }
      continue;
    }

    if (!hdlIsDue_(row.checked, cutoff)) continue;

    // Stop STARTING work we may not finish.
    if (Date.now() > deadline) { remaining++; continue; }
    if (opts.limit && examined >= opts.limit) { remaining++; continue; }

    // HAS THIS SOURCE ALREADY EATEN ITS EXECUTIONS? See HDL_MAX_ATTEMPTS. On
    // a dry run nothing is counted and nothing is set aside -- a dry run must
    // never change what a later real run will do.
    if (opts.write) {
      const tried = Number(attempts[row.id] || 0);
      if (tried >= HDL_MAX_ATTEMPTS) {
        const f = {};
        f[HDL_F_STATUS]  = HDL_ST_UNVERIF;
        f[HDL_F_DETAIL]  = 'Set aside after ' + tried + ' runs were killed before this ' +
          'source could be checked. Its host accepts the connection and never replies, ' +
          'which no automated check can time out. Open it by hand; if it is the cause, ' +
          'add its host to HDL_UNFETCHABLE_HOSTS.';
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
    const res = hdlCheckOne_(row.url);
    Utilities.sleep(HDL_PAUSE_MS);

    const status = hdlStatusOf_(res);

    if (!opts.write) {
      lines.push(hdlDescribe_(row, names, res, status));
      continue;
    }

    const f = {};
    f[HDL_F_STATUS]  = status;
    // Written on EVERY check, including empty. A source that comes back to
    // life must not keep the reason it was broken last month -- the same
    // clearing rule the promote step uses for its reason fields.
    f[HDL_F_DETAIL]  = res.ok ? '' : res.label;
    f[HDL_F_CHECKED] = today;

    // TITLE, ONLY IF EMPTY. See HDL_TITLE_MAX_LEN. A hand-corrected title is
    // never overwritten, and neither is the preserved text on the four rows
    // that never had an address.
    if (res.title && !row.title) {
      f[HDL_F_TITLE] = res.title;
      titlesAdded++;
    }

    // THE MUTE IS NOT A BLINDFOLD. A muted source that starts answering 404
    // or 410 is a different finding from the refusal it was muted for, so the
    // mute is cleared and it reappears in the review view.
    if (row.muted && res.hardDead) {
      f[HDL_F_MUTED] = false;
      unmuted++;
    }

    // OPTIONAL, OFF BY DEFAULT. See HDL_AUTO_ARCHIVE_SWAP.
    if (HDL_AUTO_ARCHIVE_SWAP && res.hardDead && row.archive && !row.original) {
      f[HDL_F_ORIGINAL] = row.url;
      f[HDL_F_URL]      = row.archive;
      // The swapped-in address has not been checked yet, and saying it is
      // Broken would be a claim about the archived copy nobody has tested.
      f[HDL_F_STATUS]   = HDL_ST_NONE;
      f[HDL_F_DETAIL]   = 'Original address returned a dead link and has been moved to ' +
        'Original URL; the archived copy is now in URL and will be checked on the next ' +
        'sweep.';
      f[HDL_F_CHECKED]  = null;
      promoted++;
    }

    pending.push({ id: row.id, fields: f });
    written++;

    // NOTIFY ON A CHANGE INTO A BROKEN STATE, not on every sweep. A link dead
    // last month and dead this month is not news, and a checker that mails
    // the same list every run stops being read. A source checked for the
    // first time counts as a change, because its previous state was "nobody
    // had looked".
    if (status === HDL_ST_BROKEN && row.status !== HDL_ST_BROKEN) {
      newlyBroken.push({
        name: hdlNameFor_(row, names),
        title: row.title || res.title || '',
        url: row.url,
        first: !row.status,
        muted: !!row.muted,
        review: row.review || '',
        label: res.label
      });
    }

    // WRITE NOW. A result is only durable once it reaches Airtable, and the
    // six-minute cap kills the execution outright -- no catch block, no
    // finally, no final flush. A batch of nine held in memory when that fires
    // is nine sources of work thrown away, which is exactly what happened
    // before writes became per-row.
    while (pending.length) {
      hdlFlush_(pat, pending.splice(0, HDL_WRITE_BATCH));
    }

    // Finished. Drop the attempt count so an unrelated failure months from
    // now starts from zero rather than inheriting this one.
    if (attempts[row.id]) {
      delete attempts[row.id];
      hdlSaveAttempts_(attempts);
    }
  }

  if (opts.write) hdlFlush_(pat, pending);

  // ---- report ----------------------------------------------------------
  if (!opts.write) {
    let s = '\n======== HAZING DEATH SOURCES -- DRY RUN ========\n' +
      'Nothing was written, nothing was emailed, no date was stamped.\n' +
      examined + ' source(s) fetched.\n';
    lines.forEach(function (l, n) { s += '\n' + (n + 1) + '. ' + l; });
    s += '\nREAD THE FAILURES ABOVE before running hdlRun(). A site that ' +
         'refuses\nautomated requests looks exactly like a dead page here, ' +
         'and the difference\nmatters: one needs a new source, the other ' +
         'needs the Muted checkbox.\n';
    Logger.log(s);
    return { dryRun: true, examined: examined };
  }

  const done = remaining === 0;
  Logger.log(
    '\n======== HAZING DEATH SOURCES ========\n' +
    (done ? 'FINISHED -- nothing left due. ' : 'Time budget reached. ') +
    'This run: ' + written + ' source(s) checked.\n' +
    '  titles filled in: ' + titlesAdded + '\n' +
    (unmuted ? '  mutes cleared (source now returns a hard dead link): ' + unmuted + '\n' : '') +
    (promoted ? '  archived copies promoted into URL: ' + promoted + '\n' : '') +
    // NEVER SILENT. Setting a source aside is the script giving up on it, and
    // that has to be visible beside the ordinary counts -- an invisible
    // give-up is how a bad row becomes a quietly wrong number.
    (setAside
      ? '  SET ASIDE: ' + setAside + ' marked Unverifiable after repeated killed ' +
        'runs. Filter Link status = Unverifiable and read Status detail.\n'
      : '') +
    (remaining ? remaining + ' source(s) still due. Run hdlRun() again to continue.\n' : '') +
    'Newly broken this run: ' + newlyBroken.length + '\n' +
    'Sources are re-checked when Last checked is more than ' +
    HDL_RECHECK_DAYS + ' days old.\n'
  );

  if (newlyBroken.length) hdlEmail_(newlyBroken);

  return { done: done, checked: written, titles: titlesAdded,
           newlyBroken: newlyBroken.length, remaining: remaining };
}

/** One result to one Link status value. */
function hdlStatusOf_(res) {
  if (res.unverifiable) return HDL_ST_UNVERIF;
  return res.ok ? HDL_ST_LIVE : HDL_ST_BROKEN;
}

function hdlDescribe_(row, names, res, status) {
  const mark = res.ok ? 'OK  ' : (res.unverifiable ? '????' : 'FAIL');
  let s = hdlNameFor_(row, names) + '  ->  ' + status +
          (row.muted ? '   [muted]' : '') + '\n' +
          '     ' + mark + '  ' + String(row.url).slice(0, 110) + '\n' +
          '           ' + res.label + '\n';
  if (res.title) {
    s += '           title: ' + res.title.slice(0, 110) +
         (row.title ? '   (NOT written -- Title already filled)' : '') + '\n';
  }
  if (row.muted && res.hardDead) {
    s += '           WOULD CLEAR THE MUTE -- this source now returns a hard dead link\n';
  }
  if (HDL_AUTO_ARCHIVE_SWAP && res.hardDead && row.archive && !row.original) {
    s += '           WOULD PROMOTE the archived copy into URL\n';
  }
  return s;
}

// =========================================================================
// CHECKING ONE SOURCE
// =========================================================================

/**
 * Fetches one address, following redirects by hand, and says what happened.
 *
 * A MOVED ARTICLE IS NOT A BROKEN LINK. A redirect that lands on a real page
 * is a pass, and the chain itself is not a finding anyone would act on.
 *
 * A REDIRECT TO THE SITE'S FRONT PAGE IS A DIFFERENT MATTER -- the "soft
 * 404". A large news site that has retired an article often answers with a
 * 302 to its homepage and a cheerful 200, which reads as working while the
 * source is gone. Comparing the final path against the one asked for catches
 * the common shape of that for free.
 *
 * WHAT IT STILL MISSES: a site serving a "story not found" PAGE at the
 * original address with a 200, and a redirect to a section index rather than
 * the root. Both need a judgment about page content. Only redirects to the
 * ROOT are flagged, because that is the shape recognisable without reading
 * anything.
 *
 * Returns { ok, unverifiable, hardDead, code, label, landed, title }.
 * hardDead is true ONLY for 404 and 410 -- the two codes that mean the page
 * is gone rather than withheld. Everything that acts differently on a dead
 * page than on a blocked one keys on that flag rather than re-testing codes.
 */
function hdlCheckOne_(url) {
  const out = { url: url, ok: false, code: 0, label: '', unverifiable: false,
                hardDead: false, landed: '', title: '' };

  if (!url) {
    out.label = 'No address to check';
    return out;
  }
  if (url.length > HDL_MAX_URL_LEN) {
    out.label = 'Not checked - address is longer than ' + HDL_MAX_URL_LEN + ' characters';
    return out;
  }

  // NOT FETCHED, ON PURPOSE. See HDL_UNFETCHABLE_HOSTS: this host hangs
  // rather than answering, and there is no way to time a request out.
  if (hdlIsUnfetchable_(url)) {
    out.unverifiable = true;
    out.label = 'Not checked - this host accepts the connection and never replies, ' +
                'so it cannot be checked automatically. Open it by hand.';
    return out;
  }

  // A STUBBORN HOST IS NOT FETCHED EITHER. This list exists precisely because
  // these hosts answer 403 for a live article and a dead one identically, so
  // the best outcome a fetch can produce is Unverifiable -- which is what
  // skipping produces, at no cost and with no hang risk.
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
  let last = null;

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
      // different facts, and only the second is a reason to find a new source.
      out.code = 0;
      out.landed = current;
      out.label = 'No response - the site could not be reached (DNS, TLS or timeout)';
      return out;
    }

    last = resp;
    code = resp.getResponseCode();
    if (code < 300 || code > 399) break;

    const next = hdlLocationOf_(resp, current);
    if (!next) {
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
    // path and the one we ended on does not.
    if (hops > 0 && !hdlIsRootish_(url) && hdlIsRootish_(current)) {
      out.label = 'Redirected to homepage - the article is probably gone. ' +
                  'Landed on ' + current;
      return out;
    }
    out.ok = true;
    out.label = hops > 0 ? 'Working - redirected to ' + current : 'Working';
    // The body is already downloaded; reading a title out of it costs no
    // request. Failures here are silent by design -- a missing title must
    // never turn a working link into a finding.
    out.title = hdlExtractTitle_(last);
    return out;
  }

  if (code === 404 || code === 410) {
    out.hardDead = true;
    out.label = 'Dead link - ' + code + ', the page is gone';
    return out;
  }
  if (code === 401 || code === 403) {
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
 * The page's own title, from a response already in hand.
 *
 * og:title first, <title> second, '' if neither is usable. Never throws:
 * every failure path returns '', because a title is a nicety and a link check
 * is not.
 *
 * NOT ATTEMPTED ON NON-HTML. Several sources here are PDFs, and
 * getContentText on a binary body returns mojibake that would be written into
 * the field as if it were a headline.
 */
function hdlExtractTitle_(resp) {
  if (!resp) return '';
  try {
    let type = '';
    const headers = resp.getAllHeaders() || {};
    Object.keys(headers).forEach(function (k) {
      if (String(k).toLowerCase() === 'content-type' && !type) {
        const v = headers[k];
        type = String(Array.isArray(v) ? v[0] : v).toLowerCase();
      }
    });
    if (type && type.indexOf('html') === -1 && type.indexOf('xml') === -1) return '';

    let body = resp.getContentText();
    if (!body) return '';
    if (body.length > HDL_TITLE_SANITY_MAX) return '';
    // Only the front of the document. See HDL_TITLE_SCAN_CHARS -- the <head>
    // is at the top, and this is a search window rather than a size limit on
    // the page itself.
    if (body.length > HDL_TITLE_SCAN_CHARS) body = body.slice(0, HDL_TITLE_SCAN_CHARS);

    // og:title in either attribute order. Publishers write both.
    //
    // THE QUOTE CHARACTER IS CAPTURED AND MATCHED BACK, and that is not
    // fussiness. The first version accepted either quote as the closing
    // delimiter -- ["']([^"']+)["'] -- so a content="..." value containing an
    // ordinary apostrophe ENDED THERE. "Nowadays We'd Call It Waterboarding"
    // was written to the table as "Nowadays We", and "Commentary: Penn
    // State's Tim Bream..." as "Commentary: Penn State". A truncated title
    // looks like a real one, which is what makes that failure worth spelling
    // out: nobody would have gone looking for it.
    let m = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*(["'])([\s\S]*?)\1/i.exec(body) ||
            /<meta[^>]+content\s*=\s*(["'])([\s\S]*?)\1[^>]*property\s*=\s*["']og:title["']/i.exec(body);
    let title = m ? m[2] : '';

    if (!title) {
      m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
      title = m ? m[1] : '';
    }
    if (!title) return '';

    title = hdlDecodeEntities_(title).replace(/\s+/g, ' ').trim();
    if (!title) return '';
    if (title.length > HDL_TITLE_MAX_LEN) {
      title = title.slice(0, HDL_TITLE_MAX_LEN - 1).replace(/\s+\S*$/, '') + '…';
    }
    return title;
  } catch (e) {
    return '';
  }
}

/**
 * HTML entities, decoded properly.
 *
 * THE FIRST VERSION OF THIS WAS A HAND-PICKED LIST and it was not enough. It
 * covered &rsquo; and &mdash; but not their NUMERIC spellings, which is what
 * WordPress and most CMSes actually emit -- so seven titles landed in the
 * table reading "&#8220;Ill Met by Moonlight&#8221; a brief excerpt &#8211;
 * Hank Nuwer". A named-entity list is a guess about which spellings a
 * publisher happens to use; the numeric forms are a rule.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Numeric first, then the named ones,
 * then &amp; LAST. A document that means to show the literal text "&#8211;"
 * writes it as "&amp;#8211;" -- decoding the ampersand first would turn that
 * into "&#8211;" and the next pass would silently convert it to a dash,
 * changing what the publisher wrote.
 */
function hdlDecodeEntities_(s) {
  const named = {
    quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
    lt: '<', gt: '>'
  };

  return String(s || '')
    // Numeric, hex and decimal. fromCodePoint rather than fromCharCode so
    // characters above the basic plane (an emoji in a headline, rarely) do
    // not come out as a pair of replacement glyphs. An out-of-range value is
    // left exactly as written rather than throwing.
    .replace(/&#x([0-9a-f]+);/gi, function (whole, hex) {
      const n = parseInt(hex, 16);
      try { return (n > 0 && n <= 0x10FFFF) ? String.fromCodePoint(n) : whole; }
      catch (e) { return whole; }
    })
    .replace(/&#(\d+);/g, function (whole, dec) {
      const n = parseInt(dec, 10);
      try { return (n > 0 && n <= 0x10FFFF) ? String.fromCodePoint(n) : whole; }
      catch (e) { return whole; }
    })
    .replace(/&([a-z]+);/gi, function (whole, name) {
      const v = named[String(name).toLowerCase()];
      return v === undefined ? whole : v;
    })
    // LAST, for the reason in the comment above.
    .replace(/&amp;/gi, '&');
}

// =========================================================================
// TITLES, WITHOUT RE-CHECKING
// =========================================================================
/**
 * Fetch sources that are Live and have no Title, and fill it in.
 *
 * WHY THIS EXISTS AS ITS OWN PASS. Titles are filled during a check, and
 * every source in this table was checked on 2026-09-10 -- so none is due
 * again until October and the Title column would sit empty for three weeks.
 * Clearing every date to force a sweep would work and would also re-fetch 280
 * sources to answer a question nobody asked.
 *
 * IT WRITES NOTHING BUT TITLE. No dates, no statuses, no details. A source it
 * cannot get a title from is left exactly as it was and will be tried again
 * on the next run of this pass, which is the honest behaviour: "no title
 * found" is not a fact worth recording.
 *
 * RESUMABLE WITH NO CURSOR. A filled Title is its own marker -- run it again
 * and it picks up where it stopped, skipping everything already done.
 */
function hdlFillTitles()         { return hdlFillTitles_({ write: true,  limit: 0  }); }
function hdlFillTitlesDryRun10() { return hdlFillTitles_({ write: false, limit: 10 }); }

function hdlFillTitles_(opts) {
  const pat = hdlPat_();
  const deadline = Date.now() + HDL_BUDGET_MS;
  const rows = hdlReadRows_(pat);
  const names = hdlVictimNames_(pat);

  const todo = rows.filter(function (r) {
    // Live only. A broken page's title is "Page not found", and an
    // unverifiable one cannot be fetched at all.
    return r.url && !r.title && r.status === HDL_ST_LIVE;
  });

  Logger.log('\n======== TITLES ========\n' +
    todo.length + ' live source(s) have no Title.\n' +
    (opts.write ? 'Filling as many as the budget allows.\n'
                : 'DRY RUN -- fetching and logging, writing nothing.\n'));

  let done = 0, missed = 0, remaining = 0;
  for (let i = 0; i < todo.length; i++) {
    if (Date.now() > deadline) { remaining = todo.length - i; break; }
    if (opts.limit && (done + missed) >= opts.limit) { remaining = todo.length - i; break; }

    const row = todo[i];
    const res = hdlCheckOne_(row.url);
    Utilities.sleep(HDL_PAUSE_MS);

    if (!res.title) {
      missed++;
      Logger.log('  no title: ' + hdlNameFor_(row, names) + '  ' + row.url.slice(0, 90) +
                 '\n            ' + res.label);
      continue;
    }

    done++;
    Logger.log('  ' + hdlNameFor_(row, names) + '\n      ' + res.title.slice(0, 120));
    if (opts.write) {
      const f = {};
      f[HDL_F_TITLE] = res.title;
      hdlFlush_(pat, [{ id: row.id, fields: f }]);
    }
  }

  Logger.log('\n' + (opts.write ? 'Filled ' : 'Would fill ') + done +
    ' title(s); ' + missed + ' source(s) returned none.\n' +
    (remaining ? remaining + ' still to do -- run hdlFillTitles() again.\n'
               : 'Nothing left to do.\n'));

  return { filled: done, missed: missed, remaining: remaining };
}

// =========================================================================
// URLS
// =========================================================================

/**
 * The comparison key for an address.
 *
 * Scheme, www and trailing slashes dropped, so http/https and www variants of
 * one address match. Query strings are KEPT: on archive sites they are the
 * article, not decoration.
 */
function hdlUrlKey_(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/**
 * The Location header of a 3xx, resolved against the address it came from.
 *
 * Servers are allowed to send a relative Location and plenty do, so a bare
 * "/" or "/news/" has to be joined to the current origin -- left raw it would
 * be handed to UrlFetchApp as a malformed URL and read as a dead link. Header
 * names are matched case-insensitively because Apps Script returns whatever
 * casing the server used.
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
  // directory. Rare, but a wrong join here invents a URL and then reports it
  // as broken.
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
 * filenames a server serves at the root count -- a redirect to /news/ is NOT
 * treated as a homepage, because a section index is sometimes where an
 * archived story genuinely lives and guessing wrong calls a working source
 * dead.
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

function hdlHostOf_(url) {
  const m = /^(?:https?:\/\/)?([^\/\?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase().replace(/^www\d*\./, '') : '';
}

function hdlHostInList_(url, list) {
  const host = hdlHostOf_(url);
  if (!host) return false;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) return true;
  }
  return false;
}

function hdlIsUnfetchable_(url) { return hdlHostInList_(url, HDL_UNFETCHABLE_HOSTS); }
function hdlIsStubborn_(url)    { return hdlHostInList_(url, HDL_STUBBORN_HOSTS); }

/** True for an address that is itself a Wayback snapshot. */
function hdlIsArchiveUrl_(url) {
  return /^https?:\/\/web\.archive\.org\/web\//i.test(String(url || ''));
}

// =========================================================================
// THE WAYBACK MACHINE
// =========================================================================

/**
 * The closest existing snapshot of this URL, or '' if there is none.
 *
 * A READ, NOT A REQUEST TO ARCHIVE. It asks what the Archive already has; it
 * never asks it to go and crawl anything. Making a snapshot is
 * hdlArchiveMissing's job.
 *
 * FAILS SOFT, ALWAYS. Every error path returns '' and the caller carries on.
 * The Archive being slow or down must never fail a link check that has
 * already been done, and nothing here ever writes an empty value over a
 * snapshot recorded earlier -- an empty answer leaves the field alone rather
 * than downgrading a real finding to a blank.
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
    // so the stored links do not trip modern browsers' upgrade rules.
    return String(snap.url).replace(/^http:\/\/web\.archive\.org/i,
                                    'https://web.archive.org');
  } catch (e) {
    return '';
  }
}

/**
 * Fill Archive URL with the snapshots that ALREADY EXIST.
 *
 * THE DIFFERENCE FROM hdlArchiveMissing, which is why both exist: that one
 * SUBMITS a page to Save Page Now and records nothing; this one ASKS whether
 * a snapshot exists and writes down the answer. Submitting without recording
 * leaves the field empty forever. The order is: link sweep, then this, then
 * hdlArchiveMissing for whatever came back with nothing, then this again a
 * few minutes later to pick the new snapshots up.
 *
 * IT NEVER ERASES. A source that already has a snapshot recorded is skipped
 * without a fetch, and a lookup that comes back empty writes nothing at all.
 *
 * A SOURCE WITH NO SNAPSHOT IS ASKED AGAIN ON THE NEXT SWEEP, deliberately.
 * There is no "we asked and there was none" marker, because that answer goes
 * stale the moment anyone archives the page.
 */
const HDL_PROP_ARCH_AFTER = 'hdl_arch_after';   // last record id completed

function hdlFindArchives()         { return hdlFindArchives_({ write: true,  limit: 0  }); }
function hdlFindArchivesDryRun25() { return hdlFindArchives_({ write: false, limit: 25 }); }

function hdlFindArchivesReset() {
  PropertiesService.getScriptProperties().deleteProperty(HDL_PROP_ARCH_AFTER);
  Logger.log('Archive lookup cursor cleared. The next hdlFindArchives() starts from\n' +
    'the top. Nothing recorded is touched -- sources that already have a snapshot\n' +
    'are still skipped without a fetch.');
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
  const names = hdlVictimNames_(pat);

  // THE CURSOR IS A RECORD ID, not a position. Airtable returns rows in a
  // stable order, but "row number 140" would silently mean a different row if
  // any were added or deleted between slices -- the failure XS_PROP_AFTER was
  // introduced to fix in CrossSeed.gs.
  let start = 0;
  if (after) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].id === after) { start = i + 1; break; }
    }
  }

  let asked = 0, found = 0, none = 0, already = 0, skipped = 0;
  const preview = [];
  let i = start;

  for (; i < rows.length; i++) {
    if (Date.now() > deadline) break;
    if (opts.limit && asked >= opts.limit) break;

    const row = rows[i];

    if (!row.url) { if (opts.write) props.setProperty(HDL_PROP_ARCH_AFTER, row.id); continue; }
    if (row.archive) {
      already++;
      if (opts.write) props.setProperty(HDL_PROP_ARCH_AFTER, row.id);
      continue;
    }
    // Asking the Archive for a snapshot OF a snapshot is a wasted lookup.
    if (hdlIsArchiveUrl_(row.url)) {
      skipped++;
      if (opts.write) props.setProperty(HDL_PROP_ARCH_AFTER, row.id);
      continue;
    }

    asked++;
    const snap = hdlWayback_(row.url);
    if (snap) {
      found++;
      if (opts.write) {
        const f = {};
        f[HDL_F_ARCHIVE] = snap;
        hdlFlush_(pat, [{ id: row.id, fields: f }]);
      } else {
        preview.push('  ' + hdlNameFor_(row, names) + '\n      ' +
          row.url.slice(0, 96) + '\n      -> ' + snap.slice(0, 110));
      }
    } else {
      none++;
      if (!opts.write) {
        preview.push('  ' + hdlNameFor_(row, names) + '\n      ' +
          row.url.slice(0, 96) + '\n      -> no snapshot');
      }
    }
    Utilities.sleep(HDL_PAUSE_MS);
    if (opts.write) props.setProperty(HDL_PROP_ARCH_AFTER, row.id);
  }

  const done = i >= rows.length;
  if (opts.write && done) props.deleteProperty(HDL_PROP_ARCH_AFTER);

  if (!opts.write) {
    Logger.log('\n======== ARCHIVE LOOKUP -- DRY RUN ========\n' +
      'Nothing was written and the cursor did not move.\n' +
      asked + ' lookup(s): ' + found + ' with a snapshot, ' + none + ' without.\n' +
      already + ' source(s) skipped -- already recorded.\n' +
      (preview.length ? '\n' + preview.join('\n') + '\n' : '') +
      '\nhdlFindArchives() to record them.\n');
    return { dryRun: true, asked: asked, found: found, none: none };
  }

  Logger.log('\n======== ARCHIVE LOOKUP ========\n' +
    (done ? 'FINISHED the sweep. ' : 'Stopped, more to do. ') +
    'Reached row ' + i + ' of ' + rows.length + '.\n' +
    '  snapshots found and recorded: ' + found + '\n' +
    '  no snapshot exists yet:       ' + none + '\n' +
    '  skipped, already recorded:    ' + already + '\n' +
    (skipped ? '  skipped, already an archive:  ' + skipped + '\n' : '') +
    (done
      ? '\nNothing left. hdlArchiveMissing(10) submits the ones with no snapshot;\n' +
        'come back and run this again a few minutes afterwards.\n'
      : '\nRun hdlFindArchives() again to continue from where it stopped.\n'));

  return { done: done, asked: asked, found: found, none: none };
}

/**
 * Asks the Wayback Machine to archive live sources that have no snapshot.
 *
 * CAPPED AND HAND-RUN, and the cap is required rather than polite: each
 * submission takes ten to thirty seconds, it is rate limited, and it is a
 * write to somebody else's infrastructure.
 *
 * IT ONLY WORKS ON PAGES THAT ARE STILL LIVE. Nothing archives a page
 * retroactively -- once a source is gone it is gone, which is the whole
 * argument for archiving a link at the moment it is added.
 *
 * IT SKIPS WHAT CANNOT BE ARCHIVED, which the old version did not: hosts on
 * either refusal list are never submitted, because a site that refuses our
 * fetches refuses the Archive's crawler too. Ten submissions of newspapers.com
 * every run is ten guaranteed declines.
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
  const names = hdlVictimNames_(pat);
  const deadline = Date.now() + HDL_BUDGET_MS;

  const candidates = [];
  let unarchivable = 0, dead = 0;

  rows.forEach(function (row) {
    if (!row.url || row.archive) return;
    if (hdlIsArchiveUrl_(row.url)) return;
    if (hdlIsStubborn_(row.url) || hdlIsUnfetchable_(row.url)) { unarchivable++; return; }
    // A page that is already gone cannot be snapshotted now. Submitting it
    // spends a slot to be told so.
    if (row.status === HDL_ST_BROKEN &&
        String(row.detail || '').indexOf('Dead link') !== -1) { dead++; return; }
    candidates.push({ name: hdlNameFor_(row, names), url: row.url });
  });

  Logger.log('\n======== ARCHIVE MISSING ========\n' +
    candidates.length + ' source(s) can be submitted.\n' +
    (unarchivable ? unarchivable + ' skipped - host refuses automated crawling.\n' : '') +
    (dead ? dead + ' skipped - already a dead link, nothing left to archive.\n' : '') +
    (opts.save ? 'Submitting up to ' + opts.limit + '.\n'
               : 'DRY RUN -- listing up to ' + opts.limit + ', sending nothing.\n'));

  let sent = 0, failed = 0;
  for (let i = 0; i < candidates.length && sent + failed < opts.limit; i++) {
    if (Date.now() > deadline) { Logger.log('Time budget reached. Run again to continue.'); break; }
    const c = candidates[i];

    if (!opts.save) {
      Logger.log('  would submit: ' + c.url.slice(0, 120) + '   (' + c.name + ')');
      sent++;
      continue;
    }

    try {
      const resp = UrlFetchApp.fetch(HDL_WAYBACK_SAVE + c.url,
        { muteHttpExceptions: true, followRedirects: true });
      const code = resp.getResponseCode();
      // 200 and 302 both mean accepted. Anything else is usually the Archive
      // declining -- a page it cannot reach, or one whose robots it will not
      // crawl. Not an error worth stopping for.
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
      'SUBMITTING IS NOT RECORDING. This asks the Archive to go and crawl the page;\n' +
      'it writes nothing. Run hdlFindArchives() afterwards to look the snapshots up\n' +
      'and record them -- give the Archive a few minutes first.'
    : 'Listed ' + sent + '. hdlArchiveMissing(10) to submit.'));

  return { candidates: candidates.length, sent: sent, failed: failed };
}

// =========================================================================
// ATTEMPT COUNTING -- the guarantee that the queue always moves
// =========================================================================
/**
 * These exist because the six-minute cap is not catchable. A source that
 * never finishes is never stamped, so nothing else about the design stops it
 * being retried forever. The count is the only record that an attempt
 * happened at all.
 *
 * Written BEFORE the work, never after. A property write commits immediately
 * and survives the kill; anything written afterwards would never run on
 * precisely the executions this is meant to catch.
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
  Logger.log('Attempt counts cleared. Sources previously set aside keep their\n' +
    'Unverifiable status until re-checked -- clear Last checked on those rows\n' +
    'to put them back in the queue.');
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
 * Every source row, with the fields this file needs.
 *
 * NOT FILTERED SERVER-SIDE. filterByFormula addresses fields by NAME, and
 * these names are new enough to still be renamed -- a rename would silently
 * return zero rows and the run would report a clean finish. One full read of
 * a ~280-row table costs about a second and cannot fail quietly with a
 * smaller result.
 */
function hdlReadRows_(pat) {
  const fields = [HDL_F_URL, HDL_F_TITLE, HDL_F_DEATH, HDL_F_STATUS, HDL_F_DETAIL,
                  HDL_F_ARCHIVE, HDL_F_CHECKED, HDL_F_MUTED, HDL_F_REVIEW,
                  HDL_F_ORIGINAL];
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
      const link = f[HDL_F_DEATH];
      out.push({
        id: r.id,
        url:      f[HDL_F_URL]      || '',
        title:    f[HDL_F_TITLE]    || '',
        death:    (Array.isArray(link) && link.length) ? link[0] : '',
        status:   f[HDL_F_STATUS]   || '',
        detail:   f[HDL_F_DETAIL]   || '',
        archive:  f[HDL_F_ARCHIVE]  || '',
        checked:  f[HDL_F_CHECKED]  || '',
        muted:    f[HDL_F_MUTED]    === true,
        review:   f[HDL_F_REVIEW]   || '',
        original: f[HDL_F_ORIGINAL] || ''
      });
    });
    offset = j.offset || null;
    Utilities.sleep(HDL_SLEEP_MS);
  } while (offset && ++guard < 100);

  return out;
}

/**
 * Victim names, keyed by death-record id, for the log and the email.
 *
 * ONE READ, AND NEVER A WRITE. The linked-record field gives record ids, and
 * an id in an email tells nobody anything. Reading one field from ~340 rows
 * costs about a second at the start of a run.
 *
 * Fails soft: if the read fails the run carries on with blank names, because
 * a link check must not stop over a label.
 */
function hdlVictimNames_(pat) {
  const map = {};
  try {
    let offset = null, guard = 0;
    do {
      let url = 'https://api.airtable.com/v0/' + HDL_BASE_ID + '/' + HDL_DEATHS_TABLE +
        '?pageSize=' + HDL_PAGE_SIZE + '&returnFieldsByFieldId=true' +
        '&fields[]=' + HDL_DEATHS_NAME;
      if (offset) url += '&offset=' + offset;
      const resp = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) return map;
      const j = JSON.parse(resp.getContentText());
      (j.records || []).forEach(function (r) {
        map[r.id] = (r.fields || {})[HDL_DEATHS_NAME] || '';
      });
      offset = j.offset || null;
      Utilities.sleep(HDL_SLEEP_MS);
    } while (offset && ++guard < 100);
  } catch (e) {
    Logger.log('Could not read victim names (labels only, continuing): ' + e);
  }
  return map;
}

function hdlNameFor_(row, names) {
  const n = names && row.death ? names[row.death] : '';
  return n || row.title || '(unnamed source)';
}

/**
 * One PATCH of up to ten rows.
 *
 * NO typecast. Every Link status value written here is one of the four
 * constants at the top of this file, all of which must exist in Airtable, so
 * there is nothing to coerce -- and typecast is how a stray select choice gets
 * minted elsewhere in this project. Without it a mismatch fails loudly, which
 * is what you want when the alternative is a silently invented option.
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
      // batch, so a silent failure means ten sources were checked and none
      // recorded -- and the run would still report success.
      const body = resp.getContentText();
      throw new Error('Write failed (' + resp.getResponseCode() + '): ' +
        body.slice(0, 400) +
        (body.indexOf('INVALID_MULTIPLE_CHOICE_OPTIONS') !== -1
          ? '\n\nThis almost certainly means the Link status choice "' + HDL_ST_LIVE +
            '" does not exist yet -- it is probably still called "Working". Rename it ' +
            'by hand in the Airtable field editor (choice IDs survive a rename, so no ' +
            'row loses its value) and run again. Nothing was lost: the sources in this ' +
            'batch are simply still due.'
          : ''));
    }
    Utilities.sleep(HDL_SLEEP_MS);
  }
}

// =========================================================================
// EMAIL
// =========================================================================

/**
 * One digest per run, listing only sources that CHANGED into a broken state.
 *
 * Never a full inventory of everything broken: that list barely moves between
 * runs, and a mail that says the same thing every month is a mail nobody
 * opens. The table itself is the inventory.
 */
function hdlEmail_(rows) {
  const shown = rows.slice(0, HDL_EMAIL_MAX_ROWS);
  const firstEver = rows.filter(function (r) { return r.first; }).length;
  const wasMuted  = rows.filter(function (r) { return r.muted; }).length;

  let body = '<p>' + rows.length + ' source(s) in <b>Hazing Death Sources</b> ' +
    'stopped resolving.</p>';

  if (firstEver) {
    body += '<p style="background:#fef3c7;border:1px solid #fcd34d;padding:10px;' +
      'border-radius:6px">' + firstEver + ' of these were being checked for the ' +
      '<b>first time</b>, so this is an initial finding rather than a change.</p>';
  }
  if (wasMuted) {
    body += '<p style="background:#fee2e2;border:1px solid #fca5a5;padding:10px;' +
      'border-radius:6px">' + wasMuted + ' of these were <b>muted</b> and have had the ' +
      'mute cleared, because the page now returns a hard dead link rather than the ' +
      'refusal it was muted for.</p>';
  }

  body += '<p>Open <b>Status detail</b> on each row for what happened. A ' +
    '<i>Blocked</i> result usually means the site refuses automated requests and the ' +
    'page opens fine in a browser &mdash; check by hand, and tick <b>Muted</b> rather ' +
    'than hunting for a replacement.</p><hr>';

  shown.forEach(function (r) {
    body += '<p><b>' + hdlEsc_(r.name) + '</b>' +
      (r.title ? ' &mdash; ' + hdlEsc_(r.title) : '') +
      (r.first ? ' <i>(first check)</i>' : '') +
      (r.muted ? ' <i>(mute cleared)</i>' : '') +
      (r.review ? ' &mdash; already marked <i>' + hdlEsc_(r.review) + '</i>' : '') +
      '</p><pre style="font-size:12px;white-space:pre-wrap">' +
      hdlEsc_(r.url) + '\n' + hdlEsc_(r.label) + '</pre>';
  });

  if (rows.length > shown.length) {
    body += '<p><i>and ' + (rows.length - shown.length) + ' more. Filter Hazing Death ' +
      'Sources on Link status to see them all.</i></p>';
  }

  hdlNotify_('Hazing death sources: ' + rows.length + ' newly broken', body);
}

function hdlNotify_(subject, htmlBody) {
  const to = PropertiesService.getScriptProperties().getProperty(HDL_NOTIFY_PROP) ||
             Session.getEffectiveUser().getEmail();
  try {
    MailApp.sendEmail({
      to: to,
      subject: '[HazingInfo] ' + subject,
      htmlBody: htmlBody +
        '<hr><p style="color:#666;font-size:12px">Sent by HazingDeathsLinks.gs. ' +
        'Change the recipient with the NOTIFY_EMAIL script property.</p>'
    });
  } catch (e) {
    // A mail failure must never take down a run that has already written its
    // findings to Airtable. The table is the record; the email is a
    // convenience.
    Logger.log('Could not send notification email: ' + e);
  }
}

function hdlEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
