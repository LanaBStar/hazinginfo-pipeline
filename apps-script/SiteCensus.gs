// =========================================================================
// SITEMAP CENSUS  (2026-09-06)  -- NEW FILE
//
// PASTE AS A NEW FILE (File > New > Script, name it SitemapCensus).
// Nothing else in the project changes. No existing .gs file is edited.
//
// RUN:
//   scStatus()        how many institutions still need a census, and where
//                     the cursor is. No fetching.
//   scDryRun(10)      census 10 institutions, log what WOULD be written,
//                     write nothing, do not move the cursor.
//   scRun()           work for ~4.5 minutes, write, then stop and say what
//                     is left. Run again to continue.
//   scReset()         start over from the top.
//
// -------------------------------------------------------------------------
// WHY THIS EXISTS
//
// On 2026-09-06, after accounting for every candidate row that will promote,
// 711 institutions still had at least one category with NO candidate URL
// ever proposed -- 520 CHTR, 507 Report Form, 260 Hazing Policy, 1,287
// school+category pairs in all. The question that could not be answered from
// the data was whether that means "we looked and there is nothing there" or
// "we never managed to look".
//
// Those are completely different facts. Only the first can honestly be
// called checked, and only the second is unfinished work. Collapsed
// together they become 711 site visits nobody can justify or dismiss.
//
// A hand sample of 18 never-proposed CHTR schools that day found BOTH
// populations present:
//
//   4 of 18 had no reachable sitemap at all -- Florida College and Southern
//   Oregon 404, BYU-Hawaii 403, CSU Maritime timed out on robots.txt. The
//   crawler read nothing about those schools.
//
//   Several of the rest publish 600-1,800 URLs with no hazing page anywhere
//   in them -- CSU Channel Islands 823, University of Jamestown 625, York
//   (NE) ~1,400, UA Monticello ~1,800. That is a real negative.
//
//   And two publish sitemaps so small they are marketing subsets rather
//   than indexes of a site -- Providence College 21 URLs, The Citadel 51,
//   for entire universities. Those look like a search but are not one.
//
// This pass records which of those three a school is, so the distinction
// survives in the data instead of in somebody's memory.
//
// -------------------------------------------------------------------------
// IT IS NOT A DISCOVERY PASS AND MUST NOT BECOME ONE
//
// It creates no candidate rows and touches no field on Candidate URLs. It
// writes seven diagnostic fields on Institutions and nothing else.
//
// That separation is deliberate. A negative result HAS NOWHERE TO LIVE on
// Candidate URLs -- that table only has a row when something was found, so
// for exactly the population this exists to describe there is no row to
// write to. Institutions has one row per school whether or not discovery
// ever produced anything, which is why the fields are there.
//
// -------------------------------------------------------------------------
// WRITING TO A SYNCED TABLE
//
// Institutions is synced from the 50 States base. Its INHERITED columns are
// read-only and this file never writes one. The seven fields below were
// added locally in PAGES, which makes them writable here -- and means they
// do NOT propagate back to 50 States. If any of this is ever needed in
// production it has to be pulled across by a script.
//
// If a write fails with INVALID_REQUEST_UNKNOWN or a permission error,
// check that you are looking at the right field id and that the field was
// added in PAGES rather than in 50 States.
//
// -------------------------------------------------------------------------
// WHY IT READS MORE OF THE SITEMAP THAN DISCOVERY DOES
//
// discoverSitemapUrls_ stops at MAX_CHILD_SITEMAPS (5) children and
// MAX_SITEMAP_URLS (1500) URLs. This pass reads up to SC_MAX_CHILDREN (25)
// and SC_MAX_URLS (50000) ON PURPOSE, because the question here is what the
// school publishes, not what discovery managed to see.
//
// The gap between the two is itself a finding. Champlain College lists 16
// child sitemaps with 'office-sitemap' at position 9 -- outside discovery's
// cap, and exactly where a dean-of-students or conduct page would live. If
// Census match summary shows matches for a school with no candidate rows,
// that is a discovery defect rather than a fact about the school, and
// Sitemap child count says whether the cap is the reason.
//
// On the 2026-09-06 sample the cap bit on roughly 2 of 14 readable sites,
// so it is real but minor. This pass is how that gets measured properly
// instead of argued about.
//
// -------------------------------------------------------------------------
// WHAT IT COSTS
//
// One robots.txt fetch and one sitemap fetch per school, plus up to 25
// child sitemap fetches where there is an index. No page fetches, no PDF
// conversion, no AI. Against the 20,000/day UrlFetchApp quota that is not
// the constraint; the 6-minute execution limit is, hence the 4.5-minute
// budget and the resumable cursor.
//
// IT ONLY CENSUSES SCHOOLS THAT NEED IT. A school with candidate rows in
// all three categories is resolved from Airtable alone and never fetched --
// see scNeedsFetch_. That is what turns 1,479 institutions into roughly the
// 711 that matter.
//
// -------------------------------------------------------------------------
// THE CURSOR IS A UNITID WATERMARK, NOT A POSITION
//
// Same choice CrossSeed.gs made on 2026-08-29, for a weaker version of the
// same reason. Its target list shrank underneath a positional cursor and
// silently skipped schools. This list does not shrink -- it is every
// institution, and censusing one does not remove it -- but a watermark
// costs nothing, survives rows being added, and means the two files behave
// the same way. A reader who understands one understands the other.
//
// -------------------------------------------------------------------------
// DECLARED ELSEWHERE, NOT HERE. Apps Script treats every .gs file in a
// project as one shared global scope, so redeclaring any of these fails the
// whole project with "already declared":
//
//   from SitemapFinder.gs  PAGES_BASE_ID, CATEGORIES, SM_BROWSER_HEADERS,
//                          capPat_, rankCandidates_, normalizeBaseUrl_,
//                          scoreToConfidence_
//
// Verified 2026-09-06 against the pasted copies of SitemapFinder.gs,
// CrossSeed.gs, ContentHash.gs, LiveUrlChecks.gs and PreFilterResult.gs:
// no name beginning sc<Capital> or SC_ is declared in any of them, and
// nothing this file declares collides.
//
// Everything here is prefixed sc / SC_, per the naming discipline in
// SitemapFinder.gs's header. Apps Script does NOT error on a duplicate
// function name -- the later definition silently wins and the caller that
// wanted the other one breaks with no message.
// =========================================================================

// ---- Institutions in PAGES (synced from 50 States) ----------------------
const SC_INST_TABLE = 'tblpgBmu7r8kQA6b5';

// Inherited (read-only) fields this file READS.
const SC_I_UNITID   = 'fldGREvzCIme6HXfl';
const SC_I_NAME     = 'fldHvefXrrPxibBsZ';
const SC_I_URL      = 'fld5s03AW9U65Z34W';   // Institution URL
const SC_I_CHTR     = 'fldqQrSD83OVoteFx';   // chtr_index_url
const SC_I_POLICY   = 'fldKyIAd65Yfn5g0V';   // located_hazing_policy_url
const SC_I_FORM     = 'fldeBRiCU8dnIKsYk';   // located_report_form_url

// Locally-added count fields, all statuses, no determination condition.
// THESE REQUIRE A CATEGORY CONDITION SET BY HAND IN THE AIRTABLE UI --
// Airtable's API cannot write count conditions. If they were left
// unconditioned they count every linked candidate in every category, every
// school reads non-zero, and this pass concludes that nothing needs a
// census. scStatus() prints a warning when that pattern appears.
const SC_I_CNT_CHTR   = 'fldcoif6S0rIZiMq9';
const SC_I_CNT_POLICY = 'fldoO5Zgqfj9L434H';
const SC_I_CNT_FORM   = 'fldDznPxkiUwGjbUQ';

// ---- Locally-added fields this file WRITES ------------------------------
const SC_W_STATUS     = 'fldScBd3Uxsle4wWZ';   // Sitemap status
const SC_W_CHILDREN   = 'fldgUgdBInARK8AYZ';   // Sitemap child count
const SC_W_URLS       = 'fldUNCXMweHU5V7Wd';   // Sitemap URLs seen
const SC_W_CHECKED    = 'fldL6KuyK16M9AFDt';   // Sitemap last checked
const SC_W_OUT_CHTR   = 'fld3rCEo6bUNlKFyS';   // CHTR discovery outcome
const SC_W_OUT_POLICY = 'fldaXEvpvDu2Tyuz3';   // Hazing Policy discovery outcome
const SC_W_OUT_FORM   = 'fldmiSNRwue9uv8d1';   // Report Form discovery outcome
const SC_W_SUMMARY    = 'fldyDPxEty7PGIcjj';   // Census match summary

// One row per category, tying together everything that differs between
// them. `catKey` indexes CATEGORIES in SitemapFinder.gs, so the keyword
// lists and the pendingCountField come from there and cannot drift.
const SC_CATS = [
  { catKey: 'chtr',         label: 'CHTR',          located: SC_I_CHTR,   count: SC_I_CNT_CHTR,   out: SC_W_OUT_CHTR },
  { catKey: 'hazingPolicy', label: 'Hazing Policy', located: SC_I_POLICY, count: SC_I_CNT_POLICY, out: SC_W_OUT_POLICY },
  { catKey: 'reportForm',   label: 'Report Form',   located: SC_I_FORM,   count: SC_I_CNT_FORM,   out: SC_W_OUT_FORM }
];

// ---- Outcome vocabulary -------------------------------------------------
// The first six exist as choices on all three outcome fields. The seventh
// is minted by Airtable on first write, because update_field cannot add a
// choice through the API and this value only appears once the census has
// actually found a discovery gap.
//
// A MINTED CHOICE IS SAFE HERE ONLY BECAUSE THE NAME IS NON-EMPTY. Writing
// an empty string to a singleSelect with typecast:true is what put a
// nameless option on Form link tier and set it on 32 rows -- see
// repickTierLabel_'s comment in SitemapFinder.gs. Every value below is a
// real name, and scWriteOne_ never writes '' to a select.
const SC_OUT_PROPOSED   = 'Candidates proposed';
const SC_OUT_NOTHING    = 'Searched, nothing matched';
const SC_OUT_NO_SITEMAP = 'Not searched - no sitemap';
const SC_OUT_ANSWERED   = 'Skipped - already answered';
const SC_OUT_PENDING    = 'Skipped - candidates pending';
const SC_OUT_GAP        = 'Searched, matches found but none proposed';

const SC_ST_REACHABLE = 'Reachable';
const SC_ST_NONE      = 'No sitemap';
const SC_ST_BLOCKED   = 'Blocked';
const SC_ST_ERROR     = 'Fetch error';

// ---- Run shape ----------------------------------------------------------
const SC_BUDGET_MS   = 4.5 * 60 * 1000;
const SC_PAUSE_MS    = 250;      // matches CRAWL_POLITENESS_DELAY_MS
const SC_MAX_CHILDREN = 25;      // vs MAX_CHILD_SITEMAPS (5) -- see header
// LOWERED FROM 50000 TO 15000 on 2026-09-06. At 50,000 a single university
// consumed an entire 4.5-minute slice on its own -- the run log read "This
// run: 1 institution(s)" -- and a handful of those would have added hours to
// a pass that is already ~26 slices.
//
// Ten times discovery's own MAX_SITEMAP_URLS (1500) is still enough to
// answer the question this pass exists for: whether the school publishes a
// hazing page discovery could not reach. A page that appears only past the
// 15,000th URL of a sitemap is not a school's main hazing page. What is
// lost is completeness of the URL count on the very largest sites, where
// Sitemap URLs seen will now read 15000 rather than the true total -- read
// that value as "at least this many", not as a census of the site.
const SC_MAX_URLS     = 15000;
const SC_WRITE_BATCH  = 10;      // Airtable's cap per PATCH call

const SC_PROP_AFTER = 'sc_after';
const SC_PROP_STATS = 'sc_stats';

// =========================================================================
// ENTRY POINTS
// =========================================================================

function scStatus() {
  const pat = capPat_();
  const all = scInstitutions_(pat);
  const after = PropertiesService.getScriptProperties().getProperty(SC_PROP_AFTER) || '';
  const idx = scResumeIndex_(all, after);
  const stats = scReadStats_();

  let needFetch = 0, resolved = 0, noUrl = 0, allCountsNonZero = 0;
  for (let i = 0; i < all.length; i++) {
    if (!all[i].url) noUrl++;
    if (scNeedsFetch_(all[i])) needFetch++; else resolved++;
    if (all[i].counts.chtr > 0 && all[i].counts.hazingPolicy > 0 && all[i].counts.reportForm > 0) allCountsNonZero++;
  }

  let out = '\n============ SITEMAP CENSUS STATUS ============\n' +
    '  institutions: ' + all.length + '\n' +
    '  need a sitemap fetch (a category with no candidates): ' + needFetch + '\n' +
    '  resolvable from Airtable alone (no fetch): ' + resolved + '\n' +
    '  no Institution URL, cannot be censused: ' + noUrl + '\n' +
    '  resume after UNITID: ' + (after || '(not started)') + '\n' +
    '  position: ' + idx + ' of ' + all.length + (idx >= all.length ? '   (finished)' : '') + '\n' +
    '  written so far: ' + (stats.written || 0) +
    ', sitemaps read: ' + (stats.reachable || 0) +
    ', no sitemap: ' + (stats.noSitemap || 0) +
    ', blocked: ' + (stats.blocked || 0) +
    ', fetch errors: ' + (stats.errors || 0) +
    ', discovery gaps found: ' + (stats.gaps || 0) + '\n';

  // The count fields are only correct once a category condition has been
  // added by hand. Unconditioned, every school shows candidates in every
  // category and this pass would decide there is nothing to do -- which
  // looks exactly like a clean, finished run.
  if (allCountsNonZero > all.length * 0.9) {
    out += '\n  WARNING: ' + allCountsNonZero + ' of ' + all.length + ' institutions show a\n' +
           '  non-zero count in ALL THREE categories. That is the signature of the\n' +
           '  three "candidates (all statuses)" count fields still being\n' +
           '  UNCONDITIONED. Add the Category condition to each in the Airtable UI\n' +
           '  before running -- the API cannot set count conditions, and an\n' +
           '  unconditioned field fails silently and looks like a clean run.\n';
  }

  out += '\n  scDryRun(10) to see what would be written. scRun() to work.\n';
  Logger.log(out);
}

function scReset() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(SC_PROP_AFTER);
  props.deleteProperty(SC_PROP_STATS);
  Logger.log('Sitemap census reset. Next scRun() starts from the top.\n' +
    'Nothing stored on Institutions is cleared -- a re-run overwrites each\n' +
    'school as it reaches it, and Sitemap last checked says which values are\n' +
    'from this pass and which are left over from the previous one.');
}

/** Census institutions and WRITE. Resumable: stops on the time budget. */
function scRun() { return scWork_({ write: true, limit: 0 }); }

/**
 * Census a few institutions and log what WOULD be written. Writes nothing
 * and does not move the cursor, so a dry run never costs ground on a real
 * one. Always starts from the top.
 */
function scDryRun(howMany) { return scWork_({ write: false, limit: Math.max(1, howMany || 10) }); }

function scDryRun10() { return scDryRun(10); }
function scDryRun30() { return scDryRun(30); }

// =========================================================================
// THE PASS
// =========================================================================

/**
 * ONE SLICE OF WORK, AND THE ONLY PLACE THAT ADVANCES THE WATERMARK.
 *
 * THE LOCK IS HERE, NOT IN scRunScheduled_, AND THAT IS A FIX RATHER THAN
 * A PREFERENCE (2026-09-06). It used to guard only the trigger's handler,
 * which stopped two TRIGGERED slices colliding but did nothing about a
 * person clicking scRun() while the trigger was firing. Both would read the
 * same cursor, both would advance it, and whichever finished second moved
 * the watermark past schools the other had not written yet.
 *
 * It showed up as `rows written: 539` against `Reached 558` -- 19 schools
 * stepped over, which afterwards look identical to schools the census has
 * simply not got to. Nothing errors, nothing logs, and the run reads as
 * clean. Same shape as the positional-cursor bug CrossSeed.gs documents
 * under XS_PROP_AFTER: a cursor that is wrong by an unknown amount while
 * every counter looks normal.
 *
 * A DRY RUN TAKES NO LOCK. It writes nothing and never touches the cursor,
 * so it cannot collide with anything, and making it wait on a running slice
 * would only stop you inspecting a pass while it works.
 *
 * A slice that cannot get the lock returns rather than waiting: the next
 * trigger fire is ten minutes away and a queued slice would just overlap
 * the one after it.
 */
function scWork_(opts) {
  let lock = null;
  if (opts.write) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) {
      Logger.log('Another census slice is already running -- this one did nothing.\n' +
        'That is the guard working. Wait for it to finish, or scTriggerStatus()\n' +
        'to see whether the trigger is the one holding it.');
      return { done: false, skipped: true };
    }
  }
  try {
    return scWorkLocked_(opts);
  } finally {
    if (lock) lock.releaseLock();
  }
}

function scWorkLocked_(opts) {
  const pat = capPat_();
  const props = PropertiesService.getScriptProperties();
  const deadline = Date.now() + SC_BUDGET_MS;

  const all = scInstitutions_(pat);
  if (!all.length) { Logger.log('No institutions read. Check the PAT and SC_INST_TABLE.'); return { done: true }; }

  const after = opts.write ? (props.getProperty(SC_PROP_AFTER) || '') : '';
  let index = scResumeIndex_(all, after);
  let lastDone = after;

  const stats = opts.write ? scReadStats_()
    : { written: 0, reachable: 0, noSitemap: 0, blocked: 0, errors: 0, gaps: 0, skippedNoFetch: 0 };

  const pending = [];
  const preview = [];
  let processed = 0;

  while (index < all.length) {
    if (Date.now() > deadline) break;
    if (opts.limit && processed >= opts.limit) break;

    const inst = all[index];
    index++;
    processed++;

    const result = scCensusOne_(inst, stats);

    if (opts.write) {
      pending.push({ id: inst.id, fields: scFieldsFor_(result) });
      while (pending.length >= SC_WRITE_BATCH) {
        scFlush_(pat, pending.splice(0, SC_WRITE_BATCH), stats);
      }
      // The watermark is the school just finished, never all[index] --
      // writing the next school's id skips it on resume. Same off-by-one
      // CrossSeed.gs documents at length under XS_PROP_AFTER.
      lastDone = inst.unitid;
      props.setProperty(SC_PROP_AFTER, lastDone);
      scWriteStats_(stats);
    } else {
      preview.push(result);
    }
  }

  if (opts.write) {
    scFlush_(pat, pending, stats);
    if (lastDone) props.setProperty(SC_PROP_AFTER, lastDone);
    scWriteStats_(stats);
  }

  const done = index >= all.length;

  if (!opts.write) {
    let s = '\n======== SITEMAP CENSUS DRY RUN ========\n' +
      'Nothing was written and the cursor did not move.\n' +
      processed + ' institution(s) examined.\n';
    preview.forEach(function (r, i) {
      s += '\n' + (i + 1) + '. ' + r.unitid + '  ' + String(r.name).slice(0, 38) + '\n' +
           '   sitemap: ' + r.status +
           (r.status === SC_ST_REACHABLE
             ? '  (' + r.children + ' child sitemap(s), ' + r.urlsSeen + ' URL(s))'
             : '') + '\n';
      SC_CATS.forEach(function (c) { s += '   ' + c.label + ': ' + r.outcomes[c.catKey] + '\n'; });
      if (r.summary) s += '   ' + r.summary.replace(/\n/g, '\n   ') + '\n';
    });
    s += '\nRead these before running scRun(). A wrong outcome here is worse\n' +
         'than a blank one: it claims a school was checked when it was not.\n';
    Logger.log(s);
    return { dryRun: true, examined: processed };
  }

  Logger.log(
    '\n======== SITEMAP CENSUS ========\n' +
    (done ? 'FINISHED. ' : 'Time budget reached. ') +
    'Reached ' + index + ' of ' + all.length +
    (lastDone ? ', resume after UNITID ' + lastDone : '') + '.\n' +
    'This run: ' + processed + ' institution(s).\n' +
    'Cumulative -- rows written: ' + stats.written +
    ', sitemaps read: ' + stats.reachable +
    ', no sitemap: ' + stats.noSitemap +
    ', blocked: ' + stats.blocked +
    ', fetch errors: ' + stats.errors +
    ', resolved without fetching: ' + (stats.skippedNoFetch || 0) +
    ', DISCOVERY GAPS: ' + stats.gaps + '\n' +
    (stats.gaps
      ? 'A discovery gap is a school with no candidate rows where the census\n' +
        'still scored a match. Filter the outcome fields to\n' +
        '"' + SC_OUT_GAP + '" and read Census match summary.\n'
      : '') +
    (done ? 'Nothing left. scReset() to run it again from the top.\n'
          : 'Run scRun() again to continue.\n')
  );
  return { done: done, processed: index, total: all.length, stats: stats };
}

/**
 * Everything the census can say about one institution.
 *
 * RESOLVES FROM AIRTABLE FIRST AND ONLY THEN FETCHES. A school with
 * candidate rows in all three categories, or with all three located fields
 * filled, needs no sitemap read -- and skipping those is what makes this
 * pass affordable. The sitemap fields are left untouched for them rather
 * than written as blanks, because "not censused" and "censused, nothing
 * found" must not look alike.
 */
function scCensusOne_(inst, stats) {
  const out = {
    id: inst.id, unitid: inst.unitid, name: inst.name,
    status: null, children: null, urlsSeen: null,
    outcomes: {}, summary: '', fetched: false
  };

  // Pre-resolve the categories that need no evidence from the web.
  const needsEvidence = [];
  SC_CATS.forEach(function (c) {
    if (inst.counts[c.catKey] > 0) { out.outcomes[c.catKey] = SC_OUT_PROPOSED; return; }
    if (inst.located[c.catKey])    { out.outcomes[c.catKey] = SC_OUT_ANSWERED; return; }
    if (inst.pending[c.catKey] > 0){ out.outcomes[c.catKey] = SC_OUT_PENDING; return; }
    needsEvidence.push(c);
  });

  if (!needsEvidence.length) {
    stats.skippedNoFetch = (stats.skippedNoFetch || 0) + 1;
    return out;
  }

  // A school with no Institution URL cannot be censused, and that is a
  // problem with our data rather than a finding about the school. Leave the
  // sitemap fields alone and say so in the summary.
  if (!inst.url) {
    out.summary = 'No Institution URL on this record -- cannot census.';
    needsEvidence.forEach(function (c) { out.outcomes[c.catKey] = SC_OUT_NO_SITEMAP; });
    return out;
  }

  const read = scReadSitemap_(normalizeBaseUrl_(inst.url));
  out.fetched = true;
  out.status = read.status;
  out.children = read.children;
  out.urlsSeen = read.urls.length;

  if (read.status === SC_ST_REACHABLE) stats.reachable = (stats.reachable || 0) + 1;
  else if (read.status === SC_ST_NONE) stats.noSitemap = (stats.noSitemap || 0) + 1;
  else if (read.status === SC_ST_BLOCKED) stats.blocked = (stats.blocked || 0) + 1;
  else stats.errors = (stats.errors || 0) + 1;

  if (read.status !== SC_ST_REACHABLE) {
    // The trace is the whole value of a negative row. Stored, not logged,
    // because the person deciding whether to hand-check this school is
    // reading Airtable months from now, not an execution log.
    out.summary = 'Nothing searched. What was tried:\n' + read.trace.join('\n');
    needsEvidence.forEach(function (c) { out.outcomes[c.catKey] = SC_OUT_NO_SITEMAP; });
    return out;
  }

  // REACHABLE BUT EMPTY IS NOT A SEARCH. A sitemap index whose children all
  // failed, or a urlset with no entries, leaves nothing to score -- and
  // scoring nothing would return "no match" for every category, which reads
  // as a finding about the school. Status stays Reachable because it is
  // true and Sitemap URLs seen says 0, but the outcome has to say that
  // nothing was looked at.
  if (!read.urls.length) {
    out.summary = 'Sitemap reachable but yielded 0 URLs -- nothing was searched.\n' +
      read.trace.join('\n');
    needsEvidence.forEach(function (c) { out.outcomes[c.catKey] = SC_OUT_NO_SITEMAP; });
    return out;
  }

  // Score with rankCandidates_ -- the SAME function sitemap discovery uses,
  // so a match here would have been a match there. Anything that differs
  // between the two is coverage, not judgment.
  const lines = [];
  needsEvidence.forEach(function (c) {
    const ranked = rankCandidates_(read.urls, CATEGORIES[c.catKey]);
    if (!ranked.length) {
      out.outcomes[c.catKey] = SC_OUT_NOTHING;
      lines.push(c.label + ': 0');
    } else {
      out.outcomes[c.catKey] = SC_OUT_GAP;
      stats.gaps = (stats.gaps || 0) + 1;
      lines.push(c.label + ': ' + ranked.length +
        ' (top: ' + ranked[0].url.slice(0, 160) +
        ', ' + scoreToConfidence_(ranked[0].score) + ')');
    }
  });
  // A school with more children than SC_MAX_CHILDREN was read partially by
  // the census too, so "nothing matched" is weaker there than the phrase
  // suggests. Say so on the row rather than leaving it to be inferred from
  // Sitemap child count -- Athens State lists 40 children, of which this
  // pass reads 25 and discovery read 5.
  if (read.children > SC_MAX_CHILDREN) {
    lines.push('NOTE: ' + read.children + ' child sitemaps, only the first ' +
      SC_MAX_CHILDREN + ' were read. Coverage is partial.');
  }

  out.summary = lines.join('\n');
  return out;
}

/** The Airtable payload for one censused institution. */
function scFieldsFor_(r) {
  const f = {};
  SC_CATS.forEach(function (c) {
    if (r.outcomes[c.catKey]) f[c.out] = r.outcomes[c.catKey];
  });
  // Only stamp the sitemap fields when a fetch actually happened. Writing
  // them for a school resolved from Airtable alone would claim a census
  // that never ran -- and Sitemap last checked is what every other sitemap
  // field's meaning hangs on.
  if (r.fetched) {
    f[SC_W_STATUS]  = r.status;
    f[SC_W_URLS]    = r.urlsSeen;
    f[SC_W_CHECKED] = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    // children is 0 for a plain urlset, which is meaningful, so it is
    // written whenever a fetch happened rather than only when non-zero.
    f[SC_W_CHILDREN] = r.children || 0;
  }
  if (r.summary) f[SC_W_SUMMARY] = r.summary;
  return f;
}

function scFlush_(pat, rows, stats) {
  if (!rows || !rows.length) return;
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + SC_INST_TABLE,
    { method: 'patch',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ records: rows, typecast: true }),
      muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    // Loud, and it stops the run. A silent write failure here produces a
    // pass that reports success and stored nothing -- the exact failure
    // shape this project keeps paying for.
    throw new Error(
      'Write to Institutions failed (' + resp.getResponseCode() + '): ' +
      resp.getContentText().slice(0, 400) + '\n' +
      'If this says the field is computed or unknown, the field is an ' +
      'INHERITED column from the 50 States sync rather than one added ' +
      'locally in PAGES. Only locally-added fields are writable here.');
  }
  stats.written = (stats.written || 0) + rows.length;
  Utilities.sleep(210);
}

// =========================================================================
// READING INSTITUTIONS
// =========================================================================

/**
 * Every institution, with the six fields the outcome logic needs and the
 * three pending counts, sorted by UNITID.
 *
 * Not filtered server-side, for the reason xsTargets_ gives: Airtable's
 * filterByFormula addresses fields by NAME, this is a SYNCED table whose
 * names are inherited, and a rename in 50 States would break the formula
 * here with no error and a smaller result. One full read of a ~1,500-row
 * table costs a few seconds and cannot fail that way.
 */
function scInstitutions_(pat) {
  const out = [];
  let offset = null;

  const fields = [
    SC_I_UNITID, SC_I_NAME, SC_I_URL,
    SC_I_CHTR, SC_I_POLICY, SC_I_FORM,
    SC_I_CNT_CHTR, SC_I_CNT_POLICY, SC_I_CNT_FORM,
    CATEGORIES.chtr.pendingCountField,
    CATEGORIES.hazingPolicy.pendingCountField,
    CATEGORIES.reportForm.pendingCountField
  ];

  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + SC_INST_TABLE +
      '?pageSize=100&returnFieldsByFieldId=true';
    for (let i = 0; i < fields.length; i++) url += '&fields[]=' + fields[i];
    if (offset) url += '&offset=' + offset;

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable read failed: ' + resp.getContentText().slice(0, 200));
    }
    const j = JSON.parse(resp.getContentText());

    for (let i = 0; i < j.records.length; i++) {
      const f = j.records[i].fields || {};
      const unitid = String(f[SC_I_UNITID] || '').trim();
      if (!unitid) continue;   // cannot be filed against a school

      out.push({
        id: j.records[i].id,
        unitid: unitid,
        name: f[SC_I_NAME] || '',
        url: scFirstUrl_(f[SC_I_URL]),
        located: {
          chtr:         String(f[SC_I_CHTR]   || '').trim(),
          hazingPolicy: String(f[SC_I_POLICY] || '').trim(),
          reportForm:   String(f[SC_I_FORM]   || '').trim()
        },
        counts: {
          chtr:         Number(f[SC_I_CNT_CHTR]   || 0),
          hazingPolicy: Number(f[SC_I_CNT_POLICY] || 0),
          reportForm:   Number(f[SC_I_CNT_FORM]   || 0)
        },
        pending: {
          chtr:         Number(f[CATEGORIES.chtr.pendingCountField]         || 0),
          hazingPolicy: Number(f[CATEGORIES.hazingPolicy.pendingCountField] || 0),
          reportForm:   Number(f[CATEGORIES.reportForm.pendingCountField]   || 0)
        }
      });
    }
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  out.sort(function (a, b) { return scUnitidCmp_(a.unitid, b.unitid); });
  return out;
}

/** True when at least one category still needs evidence from the web. */
function scNeedsFetch_(inst) {
  for (let i = 0; i < SC_CATS.length; i++) {
    const c = SC_CATS[i];
    if (inst.counts[c.catKey] > 0) continue;
    if (inst.located[c.catKey]) continue;
    if (inst.pending[c.catKey] > 0) continue;
    return true;
  }
  return false;
}

// ONE definition of UNITID order, shared by the sort and the resume test,
// so the two cannot drift apart and land the watermark mid-list.
function scUnitidCmp_(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function scResumeIndex_(list, after) {
  if (!after) return 0;
  let i = 0;
  while (i < list.length && scUnitidCmp_(list[i].unitid, after) <= 0) i++;
  return i;
}

// Institution URL is multilineText and occasionally holds more than one
// value, and often has no scheme. Take the first token that looks like a
// host or a URL; normalizeBaseUrl_ adds the scheme.
function scFirstUrl_(v) {
  const first = String(v || '').trim().split(/\s+/)[0];
  if (!first) return '';
  if (/^https?:\/\//i.test(first)) return first;
  return /^[a-z0-9.-]+\.[a-z]{2,}/i.test(first) ? first : '';
}

// =========================================================================
// READING A SITEMAP
// =========================================================================

/**
 * Reads the school's sitemap as completely as the caps here allow and
 * reports HOW it went, not just what it found.
 *
 * A SEPARATE IMPLEMENTATION FROM discoverSitemapUrls_, ON PURPOSE. That
 * function answers "what URLs can discovery work with" and is bounded by
 * MAX_CHILD_SITEMAPS / MAX_SITEMAP_URLS accordingly. This one answers "what
 * does the school publish, and could we see it at all", which needs the
 * wider caps and needs the failure mode preserved rather than collapsed to
 * an empty array. Keeping them separate is what makes the difference
 * between the two measurable.
 *
 * The four statuses are the point. discoverSitemapUrls_ returns [] for a
 * 404, a 403, a timeout and a genuinely empty sitemap alike -- four
 * different facts about a school, and the reason 520 blank CHTR fields
 * could not be interpreted.
 */
function scReadSitemap_(baseUrl) {
  // `trace` is the whole reason a negative from this pass can be trusted.
  // Without it, "No sitemap" is indistinguishable from "the WAF answered a
  // 404 to a datacenter IP" and from "the Institution URL points at the
  // wrong host" -- three different facts, one label. Found on 2026-09-06:
  // The University of Alabama censused as No sitemap, while its robots.txt
  // plainly names Sitemap: https://www.ua.edu/wp-sitemap.xml. Which of the
  // three that was could not be told from the stored result.
  const result = { status: SC_ST_ERROR, children: 0, urls: [], trace: [] };

  const locs = [baseUrl + '/sitemap.xml'];
  const robots = scFetch_(baseUrl + '/robots.txt');
  result.trace.push('robots.txt -> ' + scCode_(robots));
  if (robots.ok && robots.text) {
    robots.text.split('\n').forEach(function (line) {
      const t = line.trim();
      if (/^sitemap:/i.test(t)) {
        const u = t.replace(/^sitemap:/i, '').trim();
        if (u) locs.push(u);
      }
    });
  }

  const seen = {};
  let sawBlocked = false, sawAny = false, sawMissing = false, sawError = false;

  for (let i = 0; i < locs.length; i++) {
    if (result.urls.length >= SC_MAX_URLS) break;
    const loc = locs[i];
    if (seen[loc]) continue;
    seen[loc] = true;

    const r = scFetch_(loc);
    Utilities.sleep(SC_PAUSE_MS);
    result.trace.push(scShortUrl_(loc) + ' -> ' + scCode_(r));
    if (!r.ok) {
      if (r.code === 403 || r.code === 401) sawBlocked = true;
      else if (r.code === 404) sawMissing = true;
      else sawError = true;
      continue;
    }
    const xml = r.text || '';
    // MUST LOOK LIKE A SITEMAP, not merely like markup. A soft 404 -- an
    // HTML "page not found" served with a 200, which is common on
    // university CMSs -- contains '<' in abundance and would otherwise be
    // counted as a reachable sitemap with zero URLs. That produced
    // "Reachable (0 URLs)" and then "Searched, nothing matched" on UAB in
    // the first dry run: a claim that a school had been checked when
    // nothing had been read at all, which is the single failure this pass
    // exists to prevent.
    if (!/<(urlset|sitemapindex)\b/i.test(xml)) {
      sawMissing = true;
      result.trace.push('   (200 but not a sitemap -- soft 404 or HTML page)');
      continue;
    }
    sawAny = true;

    if (xml.indexOf('<sitemapindex') !== -1) {
      const kids = scLocs_(xml);
      result.children += kids.length;
      const take = kids.slice(0, SC_MAX_CHILDREN);
      for (let k = 0; k < take.length; k++) {
        if (result.urls.length >= SC_MAX_URLS) break;
        if (seen[take[k]]) continue;
        seen[take[k]] = true;
        const kr = scFetch_(take[k]);
        Utilities.sleep(SC_PAUSE_MS);
        if (!kr.ok || !kr.text) continue;
        const kl = scLocs_(kr.text);
        for (let m = 0; m < kl.length && result.urls.length < SC_MAX_URLS; m++) {
          result.urls.push(kl[m]);
        }
      }
    } else {
      const ul = scLocs_(xml);
      for (let m = 0; m < ul.length && result.urls.length < SC_MAX_URLS; m++) {
        result.urls.push(ul[m]);
      }
    }
  }

  // ORDER MATTERS. A school whose sitemap index was read but whose children
  // all failed still counts as Reachable with 0 URLs -- that is a true and
  // useful statement, and calling it "No sitemap" would be a lie about a
  // site we demonstrably reached.
  //
  // A CONNECTION FAILURE OUTRANKS A 404. If any attempt died before the
  // server answered -- DNS, TLS, timeout, code 0 -- the site did not tell
  // us there is no sitemap; we failed to ask. Reporting that as No sitemap
  // is the same class of error as the soft-404 bug above, and it matters
  // because No sitemap gets read as a finding while Fetch error gets read
  // as a retry.
  if (sawAny) result.status = SC_ST_REACHABLE;
  else if (sawBlocked) result.status = SC_ST_BLOCKED;
  else if (sawError) result.status = SC_ST_ERROR;
  else if (sawMissing) result.status = SC_ST_NONE;
  else result.status = SC_ST_ERROR;

  return result;
}

/** '200', '404', or 'no response' for a connection that never answered. */
function scCode_(r) {
  if (r.ok) return '200';
  return r.code ? String(r.code) : 'no response';
}

/** Just enough of a URL to recognise it in a trace line. */
function scShortUrl_(u) {
  return String(u).replace(/^https?:\/\//i, '').slice(0, 90);
}

/**
 * One fetch, reporting the code rather than swallowing it.
 *
 * Uses SM_BROWSER_HEADERS for the reason its own comment gives: the default
 * Apps Script User-Agent identifies as Google and university WAFs reject it
 * outright, which in August 2026 manufactured false "blocked" readings at
 * roughly a 99:1 rate. A census that mistook a WAF for a missing sitemap
 * would be worse than no census.
 */
function scFetch_(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      headers: SM_BROWSER_HEADERS,
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    });
    const code = resp.getResponseCode();
    if (code !== 200) return { ok: false, code: code, text: '' };
    return { ok: true, code: code, text: resp.getContentText() };
  } catch (err) {
    // DNS failure, TLS failure, timeout. Deliberately NOT reported as 404:
    // "the site would not answer" and "the site answered, there is no
    // sitemap" are different facts about a school.
    return { ok: false, code: 0, text: '' };
  }
}

function scLocs_(xml) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
  return locs;
}

// =========================================================================
// BOOKKEEPING
// =========================================================================

// =========================================================================
// TEMPORARY TRIGGER -- so the census finishes without being clicked
// =========================================================================
/**
 * scInstallTrigger()   run scRun() every 10 minutes until the census is
 *                      finished, then remove itself.
 * scDeleteTrigger()    stop it now.
 * scTriggerStatus()    is one installed?
 *
 * THIS IS THE ONE PLACE IN THE PROJECT THAT INSTALLS A TRIGGER, AND IT IS
 * MEANT TO BE TEMPORARY. CrossSeed.gs's header states the rule it is bending:
 * a hand-run pass cannot consume runtime unattended, so it does not install
 * one. The census is different in one respect only -- it is a single
 * bounded job with a known end, roughly 26 slices as measured on 2026-09-06,
 * and it deletes its own trigger the moment scWork_ reports done. It is not
 * a scheduled stage and must not become one.
 *
 * IF IT DOES NOT SELF-DELETE, DELETE IT BY HAND. scDeleteTrigger(), or the
 * clock icon in the Apps Script editor. A personal Google account has about
 * 90 minutes of trigger runtime a day shared with everything else in this
 * project, so a trigger left running after the census finishes is taking
 * budget from the capture and link passes silently.
 *
 * TEN MINUTES, NOT FIVE. Each slice budgets 4.5 minutes and can overrun
 * while finishing a school's child sitemaps. At a 5-minute interval a slow
 * slice would still be running when the next fires; LockService below makes
 * that harmless, but a skipped fire is wasted budget either way.
 */
const SC_TRIGGER_FN = 'scRunScheduled_';
const SC_TRIGGER_MINUTES = 10;

function scInstallTrigger() {
  if (scFindTriggers_().length) {
    Logger.log('A census trigger is already installed. scTriggerStatus() to check it, ' +
      'scDeleteTrigger() to remove it.');
    return;
  }
  ScriptApp.newTrigger(SC_TRIGGER_FN).timeBased().everyMinutes(SC_TRIGGER_MINUTES).create();
  Logger.log(
    'Census trigger installed: scRun() every ' + SC_TRIGGER_MINUTES + ' minutes.\n' +
    'It removes itself when the census finishes. If you want it gone sooner,\n' +
    'run scDeleteTrigger().\n\n' +
    'It shares this account\'s ~90 minutes/day of trigger runtime with the rest\n' +
    'of the project, so check scStatus() tomorrow rather than assuming it ran\n' +
    'the whole night.');
}

function scDeleteTrigger() {
  const found = scFindTriggers_();
  found.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log(found.length
    ? 'Removed ' + found.length + ' census trigger(s).'
    : 'No census trigger was installed.');
}

function scTriggerStatus() {
  const n = scFindTriggers_().length;
  const after = PropertiesService.getScriptProperties().getProperty(SC_PROP_AFTER) || '(not started)';
  Logger.log('Census trigger(s) installed: ' + n + '\n' +
    'Resume after UNITID: ' + after + '\n' +
    (n ? 'It will delete itself when the census finishes.\n'
       : 'scInstallTrigger() to have it run itself.\n'));
}

function scFindTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === SC_TRIGGER_FN;
  });
}

/**
 * The trigger's entry point. Never call this by hand -- use scRun().
 *
 * TWO GUARDS, both of which exist because a trigger runs when nobody is
 * watching:
 *
 * THE LOCK stops two slices working the same watermark. A slice that
 * overruns its 4.5-minute budget can still be running when the next fires;
 * without the lock both would read the same cursor, census the same schools
 * and write them twice. Harmless to the data, since writes are idempotent
 * PATCHes, but it burns half the day's runtime budget doing nothing. A fire
 * that cannot get the lock simply returns.
 *
 * THE SELF-DELETE is what keeps this temporary. scWork_ returns done:true
 * only when the cursor has passed the last institution.
 */
function scRunScheduled_() {
  // No lock here any more -- scWork_ takes it, so a manual scRun() and a
  // triggered slice now exclude each other rather than only trigger-vs-
  // trigger. See scWork_'s header for what that missing case cost.
  const r = scWork_({ write: true, limit: 0 });
  if (r && r.skipped) return;              // someone else is working; try again in 10
  if (r && r.done) {
    scDeleteTrigger();
    Logger.log('Census finished -- trigger removed. scStatus() for the totals.');
  }
}

function scReadStats_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SC_PROP_STATS);
  const empty = { written: 0, reachable: 0, noSitemap: 0, blocked: 0, errors: 0, gaps: 0, skippedNoFetch: 0 };
  if (!raw) return empty;
  try { return JSON.parse(raw); } catch (e) { return empty; }
}

function scWriteStats_(stats) {
  PropertiesService.getScriptProperties().setProperty(SC_PROP_STATS, JSON.stringify(stats));
}
