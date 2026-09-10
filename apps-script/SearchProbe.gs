// =========================================================================
// SEARCH PROBE  (2026-09-06)  -- NEW FILE. STAGE 3 OF DISCOVERY.
//
// PASTE AS A NEW FILE (File > New > Script, name it SearchProbe).
// Requires SitemapCensus.gs to be in the project -- it reads that file's
// field ids and its census results. Nothing else changes.
//
// BEFORE THE FIRST RUN: put your Apify API token in Script Properties as
// APIFY_TOKEN (Project Settings > Script Properties), the same way
// AIRTABLE_PAT is stored. spStatus() refuses to run without it and says so.
//
// RUN:
//   spStatus()        how many school+category probes are outstanding, what
//                     they would cost, and where the cursor is. No searching.
//   spDryRun(10)      build the queries for 10 institutions and log them.
//                     Sends nothing to Apify, spends nothing, writes nothing.
//   spRun()           work for ~4.5 minutes, respecting the daily query
//                     budget. Run again to continue.
//   spRunBurst(700)   ignore the daily budget and work up to 700 queries.
//                     For a one-off catch-up like 2026-09-06's.
//   spReset()         start over from the top.
//
// -------------------------------------------------------------------------
// WHY A THIRD DISCOVERY METHOD
//
// Stage 1, sitemap discovery, can only ever propose a URL a school publishes
// in its own sitemap.xml. Stage 2, cross-seeding, only reaches schools that
// already have a confirmed page in another category. The census measured
// exactly what that leaves out, on 2026-09-06:
//
//   164 institutions whose sitemap was missing, blocked or unreadable. The
//   crawler never saw their site at all, so their blank fields are not a
//   finding about the school.
//
//   Schools whose sitemap is reachable but so thin that a negative means
//   nothing -- University of Georgia publishes 19 URLs, Providence College
//   21, The Citadel 51, for entire universities.
//
//   Every Report Form negative, everywhere. About 75% of confirmed report
//   forms sit on a vendor host -- Maxient, Symplicity, EthicsPoint,
//   Qualtrics, Google Forms -- and no vendor URL will ever appear in a
//   school's own sitemap. A sitemap-based negative for that category is
//   silence, not evidence.
//
// A search engine has none of those blind spots. This runs ONLY where the
// first two methods have provably failed, which is what keeps it cheap.
//
// -------------------------------------------------------------------------
// WHAT IT COSTS, AND THE TWO GUARDS ON IT
//
// Apify's apify/google-search-scraper, billed per scraped results page.
// On the FREE tier that is $0.0045 a query plus $0.001 per run, and a free
// account carries $5 of credit a month. Measured against the census on
// 2026-09-06 the whole outstanding backlog was 666 queries -- about $3.00.
//
// GUARD ONE: A DAILY QUERY BUDGET. SP_DAILY_QUERIES caps what spRun() will
// spend in a day. The default of 35 is set so a continuously running probe
// stays inside the $5 monthly credit (35 x 30 x $0.0045 = $4.73). This is
// what makes the pass safe to leave installed once the backlog is cleared.
//
// GUARD TWO: A CAP ON THE WHOLE RUN. spRunBurst(n) is the deliberate
// override for a catch-up, and it still refuses to exceed n queries. There
// is no mode that spends without a ceiling.
//
// THE COUNTER IS ADVANCED BEFORE THE SEARCH, NOT AFTER. A run that starts
// and then fails still cost money, and a budget that only counts successes
// would let a failing pass spend all day. See spSpendQuota_.
//
// -------------------------------------------------------------------------
// THE QUERIES, AND WHY REPORT FORM'S IS SHAPED DIFFERENTLY
//
//   CHTR           site:<domain> hazing transparency report
//   Hazing Policy  site:<domain> hazing policy
//   Report Form    <institution name> hazing report form
//
// THE FIRST TWO ARE SITE-RESTRICTED AND THE THIRD IS NOT, and that is the
// single most important line in this file. A CHTR or a hazing policy is
// almost always on the school's own domain, so restricting the search there
// removes an enormous amount of noise -- state statutes, news coverage,
// advocacy sites. A report form usually is NOT on the school's domain, so
// site: would exclude the very answer we are looking for. Adding site: to
// the Report Form query would make this pass useless for the category that
// needs it most.
//
// THE COST OF AN UNRESTRICTED QUERY IS THAT OTHER SCHOOLS COME BACK, and
// the first live run on 2026-09-06 proved a keyword filter cannot catch it:
// 43 rows were created and almost every one was another institution's page.
// UAB got Central Alabama Community College's form, University of Mobile got
// hazing.umd.edu, Oakwood got both umn.edu and MIT. Every one of those URLs
// is a perfectly good hazing report form -- for somebody else.
//
// spBelongsTo_ is the answer, and it is not optional. A result is kept only
// if it is on the school's OWN domain, or on a recognised conduct vendor
// with something identifying the school in the URL. Those 43 rows were
// deleted rather than rejected: rejecting them would have blocklisted real
// URLs against the wrong institutions.
//
// -------------------------------------------------------------------------
// IT PROPOSES. IT DOES NOT DECIDE.
//
// Every hit becomes an ordinary Candidate URLs row with Source = 'Search
// API', Fetch status 'Not yet fetched' and Pre-filter result 'Not yet run'.
// It is then captured, pre-filtered, AI-triaged and reviewed exactly like a
// sitemap or cross-seed candidate. Nothing here writes to 50 States and
// nothing here promotes anything.
//
// DEDUPE IS THE EXISTING ONE. pipelineExistingKeys_ reads every row for the
// category INCLUDING REJECTED ONES, so a URL a reviewer has already thrown
// out cannot be resurrected by a search. When that happens the summary
// records it as already present, which is a STRONGER negative than no
// result at all: the search found what discovery had already found and a
// person had already dismissed.
//
// -------------------------------------------------------------------------
// DECLARED ELSEWHERE, NOT HERE. Apps Script treats every .gs file in a
// project as one shared global scope, so redeclaring any of these fails the
// whole project with "already declared":
//
//   from SitemapFinder.gs   PAGES_BASE_ID, CATEGORIES, CF, capPat_,
//                           rankCandidates_, scoreToConfidence_,
//                           pipelineExistingKeys_, pipelineIntakeFlush_,
//                           pipelineUrlKey_, INTAKE_CREATE_BATCH
//   from CrossSeed.gs       XS_F_UNITID, XS_F_INST_LINK, XS_F_SOURCE
//   from PreFilterResult.gs PF_F_RESULT
//   from SitemapCensus.gs   SC_INST_TABLE, SC_I_UNITID, SC_I_NAME,
//                           SC_I_URL, SC_I_CHTR, SC_I_POLICY, SC_I_FORM,
//                           SC_I_CNT_CHTR, SC_I_CNT_POLICY, SC_I_CNT_FORM,
//                           SC_W_STATUS, SC_W_URLS, SC_W_OUT_CHTR,
//                           SC_W_OUT_POLICY, SC_W_OUT_FORM,
//                           SC_ST_REACHABLE, SC_OUT_NOTHING,
//                           SC_OUT_NO_SITEMAP,
//                           scUnitidCmp_, scResumeIndex_, scFirstUrl_
//
// Everything this file declares is prefixed sp / SP_. Verified 2026-09-06
// against SitemapFinder.gs, CrossSeed.gs, ContentHash.gs, LiveUrlChecks.gs,
// PreFilterResult.gs and SitemapCensus.gs: no name beginning sp<Capital> or
// SP_ is declared in any of them.
// =========================================================================

// ---- The gate fields, declared HERE and not reused from SitemapCensus ----
//
// THE GATE IS THE COMPLIANCE FIELD, changed 2026-09-09. It used to be
// SC_I_CHTR / SC_I_POLICY / SC_I_FORM, borrowed from SitemapCensus.gs --
// and those three constants are named for compliance fields but HOLD THE
// RECORD FIELD IDS (chtr_index_url, located_hazing_policy_url,
// located_report_form_url). That misnaming is the whole reason nobody
// noticed this pass was gating on the record fields; three separate
// readings of the code got it wrong. They are left alone in SitemapCensus
// and NOT repointed, because that file's own logic reads them too and this
// change is not about that file.
//
// WHY COMPLIANCE. A school whose page was judged BELOW STANDARD has the
// record field filled and compliance blank. It still has no page meeting
// the standard, so it is exactly the school a paid search should look at;
// gating on the record field retired it the moment we filed the inadequate
// page. Full reasoning is in the note above CATEGORIES in SitemapFinder.gs
// -- read that one, not this summary, before changing any of the three.
//
// Prefixed SP_ per this file's naming rule; no collision with the SC_I_*
// names they replace at the point of use.
const SP_I_C_TRANSPARENCY = 'fldGJPC0iyuPcWtlK'; // Transparency Report -- pairs with chtr_index_url
const SP_I_C_POLICY       = 'fldD9gEpDcw2l35II'; // Hazing Policy       -- pairs with located_hazing_policy_url
const SP_I_C_FORM         = 'fldIrTzWzi87nD7EU'; // Report Form         -- pairs with located_report_form_url

// ---- Apify ---------------------------------------------------------------
const SP_ACTOR = 'apify~google-search-scraper';
const SP_TOKEN_PROP = 'APIFY_TOKEN';

// ONE APIFY RUN PER INSTITUTION, holding that school's one to three
// queries. Not batched across schools, on purpose.
//
// Batching more queries per run would save the $0.001 start fee -- about
// $0.30 across the whole 2026-09-06 backlog, against $3.00 of queries. Not
// worth what it costs in correctness: a run spanning several schools that
// fails halfway leaves some of them probed and some not, with no record of
// which, and the results would have to be sorted back to the right school
// from a single flat dataset. One school per run means a failure is
// attributable to exactly one row and retrying it is free of side effects.
//
// This file uses Apify's run-and-wait endpoint, which returns the dataset in
// the same call and gives up after about 300 seconds. Three queries finish
// far inside that and inside Apps Script's 6-minute limit, so there is no
// run id to remember and no polling state to get wrong.

// ---- Budget --------------------------------------------------------------
// 35 queries a day is $0.1575, or $4.73 over 30 days -- just inside the free
// tier's $5 monthly credit. That is the number this default exists to
// protect. Change it and you are choosing to spend real money.
const SP_DAILY_QUERIES = 35;
const SP_COST_PER_QUERY = 0.0045;   // FREE tier, for the cost estimates only

// ---- Fields this file WRITES on Institutions -----------------------------
const SP_W_STATUS  = 'fldYEKjZzkZNV1ban';   // Search probe status
const SP_W_DATE    = 'fldd8ZUMQapUEvbJu';   // Search probe date
const SP_W_SUMMARY = 'fldP99pOgavqYBelk';   // Search probe summary

const SP_ST_PROPOSED = 'Searched - candidates proposed';
const SP_ST_NOTHING  = 'Searched - nothing usable';
const SP_ST_NONE     = 'Not eligible';
const SP_ST_ERROR    = 'Error';

// Minted by Airtable on first write, because the API cannot add a choice to
// an existing singleSelect. A real name, never an empty string -- see
// repickTierLabel_'s comment in SitemapFinder.gs for what an empty one did.
const SP_SOURCE_VALUE = 'Search API';

// ---- Run shape -----------------------------------------------------------
const SP_BUDGET_MS = 4.5 * 60 * 1000;
const SP_MAX_PER_CATEGORY = 2;      // candidates kept per school+category
const SP_MAX_RESULTS_READ = 10;     // organic results considered per query

const SP_PROP_AFTER = 'sp_after';
const SP_PROP_STATS = 'sp_stats';
const SP_PROP_QUOTA = 'sp_quota';   // {day:'YYYY-MM-DD', used:n}

// Which census outcomes make a category worth searching, and why. Anything
// not listed here is deliberately NOT probed:
//
//   'Candidates proposed'      discovery already produced something.
//   'Skipped - already answered'  the school has a URL of record.
//   'Skipped - candidates pending' a reviewer is mid-queue on it.
//   'Searched, matches found but none proposed'  the census found matches
//        discovery missed. That is a COVERAGE defect -- the fix is raising
//        MAX_SITEMAP_URLS and re-crawling, not paying for a search that
//        would rediscover a URL already sitting in the sitemap.
//
// A FUNCTION, NOT A CONSTANT, AND THE SAME GOES FOR spCats_ BELOW. Apps
// Script evaluates every .gs file's top level in the editor's file order,
// and this file sorts before SitemapCensus. A top-level constant here that
// read SC_OUT_NO_SITEMAP would hit the temporal dead zone and throw
// "Cannot access 'SC_OUT_NO_SITEMAP' before initialization" -- at LOAD
// time, which breaks every function in the whole project, not just this
// file. Reading those constants inside a function defers it to call time,
// by which point every file has loaded.
function spEligibleOutcomes_() {
  const m = {};
  m[SC_OUT_NO_SITEMAP] = 'never searched';
  m[SC_OUT_NOTHING]    = 'sitemap negative';
  return m;
}

// A sitemap negative is only worth paying to re-check when the sitemap was
// too thin to mean anything. Below this many URLs, "nothing matched" is a
// statement about our coverage rather than about the school -- University
// of Georgia publishes 19, Providence College 21, The Citadel 51.
//
// Above it, a sitemap negative is left alone for CHTR and Hazing Policy,
// because those pages are almost always on-domain and a complete sitemap
// genuinely not listing one is real evidence. Report Form is the exception
// and is probed at ANY sitemap size -- see spEligible_.
const SP_THIN_SITEMAP = 300;

// A FUNCTION for the same load-order reason as spEligibleOutcomes_ above:
// these entries read SC_I_* and SC_W_OUT_* constants declared in
// SitemapCensus.gs, which loads after this file.
//
// `gate` WAS CALLED `located` UNTIL 2026-09-09 and held the record field
// id. Renamed along with the switch to the compliance fields, because the
// old name was the misdirection: a key called `located` holding a field
// that decides compliance eligibility is how this stayed wrong for two
// weeks. If it ever needs to read a record field again, give that its own
// key rather than overloading this one.
function spCats_() { return [
  { catKey: 'chtr',         label: 'CHTR',
    gate: SP_I_C_TRANSPARENCY, count: SC_I_CNT_CHTR,   out: SC_W_OUT_CHTR,
    query: function (d, n) { return 'site:' + d + ' hazing transparency report'; } },
  { catKey: 'hazingPolicy', label: 'Hazing Policy',
    gate: SP_I_C_POLICY,       count: SC_I_CNT_POLICY, out: SC_W_OUT_POLICY,
    query: function (d, n) { return 'site:' + d + ' hazing policy'; } },
  // NO site: RESTRICTION. See the header. A report form is usually on a
  // vendor host, so restricting to the school's domain would exclude the
  // answer. The institution name carries the targeting instead.
  { catKey: 'reportForm',   label: 'Report Form',
    gate: SP_I_C_FORM,         count: SC_I_CNT_FORM,   out: SC_W_OUT_FORM,
    query: function (d, n) { return n + ' hazing report form'; } }
]; }

// =========================================================================
// ENTRY POINTS
// =========================================================================

function spStatus() {
  const pat = capPat_();
  const token = spToken_(true);
  const all = spInstitutions_(pat);
  const probes = spBuildProbes_(all);
  const after = PropertiesService.getScriptProperties().getProperty(SP_PROP_AFTER) || '';
  const idx = scResumeIndex_(all, after);
  const stats = spReadStats_();
  const quota = spQuota_();

  const byCat = {};
  const byReason = {};
  probes.forEach(function (p) {
    byCat[p.cat.label] = (byCat[p.cat.label] || 0) + 1;
    // Group on the reason WITHOUT its parenthetical detail. The thin-sitemap
    // reason carries the school's URL count so it lands on the row where a
    // reader needs it, but grouping on the full string turns one line into
    // fifty -- one per distinct count -- and buries the three numbers that
    // actually matter.
    const key = p.reason.replace(/\s*\(.*\)\s*$/, '');
    byReason[key] = (byReason[key] || 0) + 1;
  });

  let out = '\n============ SEARCH PROBE STATUS ============\n' +
    (token ? '' : '  NO APIFY TOKEN. Put it in Script Properties as ' + SP_TOKEN_PROP + '.\n' +
                  '  spStatus and spDryRun work without it; spRun will not.\n\n') +
    '  institutions: ' + all.length + '\n' +
    '  outstanding probes (school+category): ' + probes.length + '\n' +
    '  estimated cost if all run: $' + (probes.length * SP_COST_PER_QUERY).toFixed(2) + '\n';
  Object.keys(byCat).forEach(function (k) { out += '     ' + k + ': ' + byCat[k] + '\n'; });
  out += '  why they are eligible:\n';
  Object.keys(byReason).forEach(function (k) { out += '     ' + k + ': ' + byReason[k] + '\n'; });
  out +=
    '  resume after UNITID: ' + (after || '(not started)') + '\n' +
    '  position: ' + idx + ' of ' + all.length + (idx >= all.length ? '   (finished)' : '') + '\n' +
    '  today: ' + quota.used + ' of ' + SP_DAILY_QUERIES + ' queries used\n' +
    '  cumulative -- queries: ' + (stats.queries || 0) +
    ', candidates created: ' + (stats.created || 0) +
    ', already present: ' + (stats.dupes || 0) +
    ', schools with nothing usable: ' + (stats.nothing || 0) +
    ', errors: ' + (stats.errors || 0) + '\n' +
    '  spent so far (est): $' + ((stats.queries || 0) * SP_COST_PER_QUERY).toFixed(2) + '\n' +
    '\n  spDryRun(10) to see the queries. spRun() to work within today\'s budget.\n' +
    '  spRunBurst(700) to clear a backlog in one go, ignoring the daily cap.\n';
  Logger.log(out);
}

function spReset() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(SP_PROP_AFTER);
  props.deleteProperty(SP_PROP_STATS);
  Logger.log('Search probe reset. Next spRun() starts from the top.\n' +
    'The DAILY QUOTA IS NOT CLEARED -- that tracks money already spent today\n' +
    'and resetting a cursor does not un-spend it. Nothing on Institutions is\n' +
    'cleared either; Search probe date says which values are from this pass.');
}

/** Work within today's remaining daily budget. */
function spRun() { return spWork_({ write: true, maxQueries: 0, useDaily: true }); }

/**
 * Ignore the daily budget and run up to `maxQueries` queries.
 *
 * For a deliberate catch-up, not for routine use. The cap is required, not
 * optional: a burst with no ceiling is how a $3 job becomes a $30 one after
 * a query-building bug. spStatus() prints the estimated cost first -- read
 * it before choosing a number.
 */
function spRunBurst(maxQueries) {
  const n = Math.max(1, Number(maxQueries) || 0);
  if (!n) { Logger.log('Pass a query ceiling, e.g. spRunBurst(700).'); return; }
  return spWork_({ write: true, maxQueries: n, useDaily: false });
}

function spRunBurst700() { return spRunBurst(700); }

/**
 * Build and log the queries for the next few institutions. Sends nothing to
 * Apify, spends nothing, writes nothing, does not move the cursor.
 *
 * ALWAYS DO THIS FIRST ON A NEW BACKLOG. A malformed domain produces a
 * query that searches the wrong site and returns a confident zero, and the
 * only place that is visible is in the query text.
 */
function spDryRun(howMany) {
  return spWork_({ write: false, limit: Math.max(1, howMany || 10) });
}
// Zero-argument wrappers, for the editor's Run dropdown -- it calls the
// selected function with no arguments and offers nowhere to type a number.
// A dry run always starts from the top of the list, so re-running the same
// wrapper shows the same institutions; reach further down by picking a
// bigger one. The first ten schools are all Report Form probes, so 30 or 60
// is what you need to see a site:-restricted CHTR or Hazing Policy query.
function spDryRun10()  { return spDryRun(10); }
function spDryRun30()  { return spDryRun(30); }
function spDryRun60()  { return spDryRun(60); }
function spDryRun150() { return spDryRun(150); }

// =========================================================================
// THE PASS
// =========================================================================

function spWork_(opts) {
  let lock = null;
  if (opts.write) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) {
      Logger.log('Another search probe slice is already running -- this one did nothing.');
      return { done: false, skipped: true };
    }
  }
  try { return spWorkLocked_(opts); }
  finally { if (lock) lock.releaseLock(); }
}

function spWorkLocked_(opts) {
  const pat = capPat_();
  const token = opts.write ? spToken_(false) : spToken_(true);
  const props = PropertiesService.getScriptProperties();
  const deadline = Date.now() + SP_BUDGET_MS;

  const all = spInstitutions_(pat);
  if (!all.length) { Logger.log('No institutions read. Check the PAT.'); return { done: true }; }

  const after = opts.write ? (props.getProperty(SP_PROP_AFTER) || '') : '';
  let index = scResumeIndex_(all, after);
  let lastDone = after;

  const stats = opts.write ? spReadStats_()
    : { queries: 0, created: 0, dupes: 0, nothing: 0, errors: 0 };

  // How many queries this slice may still spend.
  let allowance;
  if (!opts.write) allowance = Number.MAX_SAFE_INTEGER;
  else if (opts.useDaily) allowance = Math.max(0, SP_DAILY_QUERIES - spQuota_().used);
  else allowance = opts.maxQueries;

  if (opts.write && allowance <= 0) {
    Logger.log('Daily query budget of ' + SP_DAILY_QUERIES + ' is already used up.\n' +
      'Run again tomorrow, or spRunBurst(n) to override deliberately.');
    return { done: false, budget: true };
  }

  // Existing (UNITID|url) keys per category, REJECTED ROWS INCLUDED. Read
  // once per slice: a search that re-proposes a URL a reviewer already threw
  // out is the most annoying thing this pass could do.
  const seen = {};
  if (opts.write) {
    spCats_().forEach(function (c) { seen[c.catKey] = pipelineExistingKeys_(pat, c.label); });
  }

  const pending = [];
  const preview = [];
  let processed = 0, spent = 0;

  while (index < all.length) {
    if (Date.now() > deadline) break;
    if (opts.limit && processed >= opts.limit) break;

    const inst = all[index];
    const probes = spProbesFor_(inst);

    // Stopping mid-institution would leave half its categories probed and
    // the row's status claiming the whole school was searched. Stop before
    // starting one we cannot finish.
    if (opts.write && probes.length > allowance - spent) break;

    index++;
    processed++;
    if (!probes.length) { if (opts.write) { lastDone = inst.unitid; props.setProperty(SP_PROP_AFTER, lastDone); } continue; }

    if (!opts.write) {
      probes.forEach(function (p) {
        preview.push({ unitid: inst.unitid, name: inst.name, cat: p.cat.label,
                       reason: p.reason, query: p.query });
      });
      continue;
    }

    // MONEY IS COMMITTED HERE, BEFORE THE CALL. A run that starts and then
    // fails still cost the queries it sent.
    spSpendQuota_(probes.length);
    spent += probes.length;
    stats.queries = (stats.queries || 0) + probes.length;

    let items = null;
    try {
      items = spSearch_(token, probes.map(function (p) { return p.query; }));
    } catch (err) {
      stats.errors = (stats.errors || 0) + 1;
      spWriteInst_(pat, inst.id, {
        status: SP_ST_ERROR,
        summary: 'Apify run failed: ' + String(err).slice(0, 300) +
                 '\nQueries attempted:\n' + probes.map(function (p) { return p.query; }).join('\n')
      });
      lastDone = inst.unitid;
      props.setProperty(SP_PROP_AFTER, lastDone);
      spWriteStats_(stats);
      continue;
    }

    const lines = [];
    let created = 0;
    probes.forEach(function (p) {
      const urls = spResultsFor_(items, p.query);
      const kept = spScore_(urls, p.cat, inst);
      let made = 0, dupe = 0;
      for (let i = 0; i < kept.length && made < SP_MAX_PER_CATEGORY; i++) {
        const key = inst.unitid + '|' + pipelineUrlKey_(kept[i].url);
        if (seen[p.cat.catKey][key]) { dupe++; continue; }
        seen[p.cat.catKey][key] = true;
        pending.push(spNewRow_(inst, p.cat, kept[i]));
        made++;
      }
      created += made;
      stats.created = (stats.created || 0) + made;
      stats.dupes = (stats.dupes || 0) + dupe;
      lines.push(
        p.cat.label + ' [' + p.reason + ']\n' +
        '  query: ' + p.query + '\n' +
        '  ' + urls.length + ' result(s), ' + kept.length + ' scored, ' +
        made + ' proposed' + (dupe ? ', ' + dupe + ' already present' : '') +
        (kept.length ? '\n  top: ' + kept[0].url.slice(0, 160) +
                       ' (' + scoreToConfidence_(kept[0].score) + ')' : ''));
    });

    if (!created) stats.nothing = (stats.nothing || 0) + 1;
    spWriteInst_(pat, inst.id, {
      status: created ? SP_ST_PROPOSED : SP_ST_NOTHING,
      summary: lines.join('\n\n')
    });

    while (pending.length >= INTAKE_CREATE_BATCH) {
      pipelineIntakeFlush_(pat, pending.splice(0, INTAKE_CREATE_BATCH));
    }
    lastDone = inst.unitid;
    props.setProperty(SP_PROP_AFTER, lastDone);
    spWriteStats_(stats);

    if (spent >= allowance) break;
  }

  if (opts.write) {
    pipelineIntakeFlush_(pat, pending);
    if (lastDone) props.setProperty(SP_PROP_AFTER, lastDone);
    spWriteStats_(stats);
  }

  const done = index >= all.length;

  if (!opts.write) {
    let s = '\n======== SEARCH PROBE DRY RUN ========\n' +
      'Nothing was sent to Apify, nothing was spent, nothing was written.\n' +
      processed + ' institution(s) examined, ' + preview.length + ' quer(ies) built.\n' +
      'Estimated cost if run: $' + (preview.length * SP_COST_PER_QUERY).toFixed(2) + '\n';
    preview.forEach(function (p, i) {
      s += '\n' + (i + 1) + '. ' + p.unitid + '  ' + String(p.name).slice(0, 34) +
           '  [' + p.cat + ', ' + p.reason + ']\n     ' + p.query + '\n';
    });
    s += '\nREAD THE QUERIES. A wrong domain here buys a confident zero, and\n' +
         'the query text is the only place that is visible.\n';
    Logger.log(s);
    return { dryRun: true, examined: processed, queries: preview.length };
  }

  Logger.log(
    '\n======== SEARCH PROBE ========\n' +
    (done ? 'FINISHED. ' : 'Stopped. ') +
    'Reached ' + index + ' of ' + all.length +
    (lastDone ? ', resume after UNITID ' + lastDone : '') + '.\n' +
    'This run: ' + processed + ' institution(s), ' + spent + ' quer(ies), ' +
    '$' + (spent * SP_COST_PER_QUERY).toFixed(2) + '.\n' +
    'Cumulative -- queries: ' + stats.queries +
    ' ($' + (stats.queries * SP_COST_PER_QUERY).toFixed(2) + ')' +
    ', candidates created: ' + stats.created +
    ', already present: ' + stats.dupes +
    ', nothing usable: ' + stats.nothing +
    ', errors: ' + stats.errors + '\n' +
    (opts.useDaily
      ? 'Today: ' + spQuota_().used + ' of ' + SP_DAILY_QUERIES + ' queries used.\n'
      : 'Burst mode -- the daily cap was not applied.\n') +
    (done ? 'Nothing left. spReset() to run it again from the top.\n'
          : 'Run spRun() again to continue.\n')
  );
  return { done: done, processed: index, total: all.length, stats: stats };
}

// =========================================================================
// WHO GETS PROBED
// =========================================================================

/**
 * The probes outstanding for one institution.
 *
 * A category is eligible only when ALL of these hold:
 *   - its COMPLIANCE field is blank (2026-09-09; this was the record
 *     field until then, which wrongly retired every school whose only
 *     page had been judged below standard),
 *   - it has no candidate rows of any status,
 *   - the census recorded an outcome that a search can actually improve on.
 *
 * The third condition is what keeps this pass from being expensive. Without
 * it every blank field in the base would be searched, including the 442
 * schools whose complete sitemaps genuinely contain no hazing page.
 */
function spProbesFor_(inst) {
  const out = [];
  if (!inst.url) return out;                       // nothing to search against
  const domain = spDomain_(inst.url);
  if (!domain) return out;

  spCats_().forEach(function (c) {
    const reason = spEligible_(inst, c);
    if (!reason) return;
    out.push({ cat: c, reason: reason, query: c.query(domain, spCleanName_(inst.name)) });
  });
  return out;
}

/**
 * Why this category is worth a search, or '' if it is not.
 *
 * REPORT FORM IS PROBED AT ANY SITEMAP SIZE, and that exception is the
 * whole reason this function is not a one-liner. For CHTR and Hazing Policy
 * a complete sitemap with no hazing page is real evidence, so paying to
 * search it again buys nothing. For Report Form it is not evidence at all:
 * about 75% of confirmed forms are on a vendor host that no sitemap will
 * ever list, so a sitemap negative there is silence however many URLs the
 * school publishes.
 */
function spEligible_(inst, c) {
  if (inst.gate[c.catKey]) return '';
  if (inst.counts[c.catKey] > 0) return '';
  if (inst.pending[c.catKey] > 0) return '';

  const outcome = inst.census[c.catKey];
  const base = spEligibleOutcomes_()[outcome];
  if (!base) return '';
  if (base === 'never searched') return base;

  // base === 'sitemap negative'
  if (c.catKey === 'reportForm') return 'vendor blind spot';
  const urls = Number(inst.censusUrls || 0);
  if (inst.censusStatus === SC_ST_REACHABLE && urls > 0 && urls < SP_THIN_SITEMAP) {
    return 'thin sitemap (' + urls + ' urls)';
  }
  return '';
}

/**
 * Every institution with the fields this pass needs, sorted by UNITID.
 *
 * A SEPARATE READER FROM scInstitutions_, and deliberately so. That one
 * returns what the census needs; this one also needs the census's OWN
 * results -- the three discovery outcomes, the sitemap status and the URL
 * count -- because those are what decide whether a search is worth paying
 * for. Widening scInstitutions_ instead would mean editing a file that is
 * already pasted and working, for the benefit of one caller.
 *
 * Not filtered server-side, for the reason xsTargets_ gives: filterByFormula
 * addresses fields by NAME, this is a synced table whose names are inherited
 * from 50 States, and a rename there would break the formula silently and
 * return a smaller result.
 */
function spInstitutions_(pat) {
  const out = [];
  let offset = null;

  const fields = [
    SC_I_UNITID, SC_I_NAME, SC_I_URL,
    // The gate three (compliance). The SC_I_CHTR/POLICY/FORM record fields
    // they replaced are no longer fetched -- nothing in this file reads a
    // record URL. Re-add them WITH their own object key if that changes;
    // do not fold them back into `gate`.
    SP_I_C_TRANSPARENCY, SP_I_C_POLICY, SP_I_C_FORM,
    SC_I_CNT_CHTR, SC_I_CNT_POLICY, SC_I_CNT_FORM,
    CATEGORIES.chtr.pendingCountField,
    CATEGORIES.hazingPolicy.pendingCountField,
    CATEGORIES.reportForm.pendingCountField,
    SC_W_OUT_CHTR, SC_W_OUT_POLICY, SC_W_OUT_FORM,
    SC_W_STATUS, SC_W_URLS
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
      if (!unitid) continue;

      out.push({
        id: j.records[i].id,
        unitid: unitid,
        name: f[SC_I_NAME] || '',
        url: scFirstUrl_(f[SC_I_URL]),
        gate: {
          chtr:         String(f[SP_I_C_TRANSPARENCY] || '').trim(),
          hazingPolicy: String(f[SP_I_C_POLICY]       || '').trim(),
          reportForm:   String(f[SP_I_C_FORM]         || '').trim()
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
        },
        // The census's verdict per category. Blank means the census has not
        // reached this school -- which makes it INELIGIBLE, not eligible:
        // paying to search a school we have not yet crawled properly would
        // spend money to answer a question stage 1 may still answer free.
        census: {
          chtr:         String(f[SC_W_OUT_CHTR]   || ''),
          hazingPolicy: String(f[SC_W_OUT_POLICY] || ''),
          reportForm:   String(f[SC_W_OUT_FORM]   || '')
        },
        censusStatus: String(f[SC_W_STATUS] || ''),
        censusUrls:   Number(f[SC_W_URLS] || 0)
      });
    }
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  out.sort(function (a, b) { return scUnitidCmp_(a.unitid, b.unitid); });
  return out;
}

/** Every outstanding probe across every institution -- for spStatus. */
function spBuildProbes_(all) {
  const out = [];
  all.forEach(function (i) { spProbesFor_(i).forEach(function (p) { out.push(p); }); });
  return out;
}

/**
 * Bare registrable domain for a site: query.
 *
 * Strips scheme, www and any path. Keeps other subdomains, because a school
 * whose site is at catalog.example.edu genuinely lives there and widening to
 * the parent would search a different institution's pages -- the same class
 * of error that gave Barton College Appalachian State's URLs.
 */
function spDomain_(url) {
  const m = /^(?:https?:\/\/)?([^\/\?#]+)/i.exec(String(url || '').trim());
  if (!m) return '';
  // STRIPS www, www2, www3 AND SO ON, not just bare 'www'. Oakwood
  // University's Institution URL is www2.oakwood.edu, and left in place that
  // restricts the search to one numbered mirror instead of the school's
  // site -- a confident zero that looks exactly like a real negative. Found
  // in the first 2026-09-06 dry run, which is what dry runs are for.
  //
  // Only the www-prefix family is removed. Any other subdomain is kept: a
  // school whose site genuinely lives at catalog.example.edu belongs there,
  // and widening to the parent domain would search a different institution's
  // pages -- the Barton College / Appalachian State failure again.
  return m[1].toLowerCase().replace(/^www\d*\./, '').replace(/:\d+$/, '');
}

/**
 * Institution name, tidied for a search query.
 *
 * The Institution field arrives from the 50 States sync with runs of
 * whitespace in it -- 'Citadel Military College of South   Carolina' is
 * real, live data. Left alone that produces a query with a gap in the
 * middle of the school's name.
 */
function spCleanName_(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

// =========================================================================
// SEARCHING
// =========================================================================

/**
 * Send a batch of queries to Apify and return the dataset items.
 *
 * USES THE RUN-AND-WAIT ENDPOINT so the results come back in the same call.
 * The alternative -- start a run, remember its id, poll on a later slice --
 * is more robust to a slow run but adds a second piece of resumable state
 * that can disagree with the cursor. One institution sends at most three
 * queries, which finishes well inside both Apify's ~300s wait and Apps
 * Script's limit, so the simpler shape is the safer one here.
 *
 * saveHtmlToKeyValueStore is turned OFF. It defaults to ON in the actor and
 * writes a full HTML snapshot of every results page to storage -- useless
 * here, and it slows the run.
 */
function spSearch_(token, queries) {
  const payload = {
    queries: queries.join('\n'),
    maxPagesPerQuery: 1,
    countryCode: 'us',
    languageCode: 'en',
    saveHtml: false,
    saveHtmlToKeyValueStore: false,
    mobileResults: false
  };
  const url = 'https://api.apify.com/v2/acts/' + SP_ACTOR +
    '/run-sync-get-dataset-items?token=' + encodeURIComponent(token) + '&clean=true';

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('Apify returned ' + code + ': ' + resp.getContentText().slice(0, 300));
  }
  const items = JSON.parse(resp.getContentText());
  if (!Array.isArray(items)) throw new Error('Apify returned an unexpected shape.');
  return items;
}

/**
 * The organic result URLs for one query, in rank order.
 *
 * MATCHED BY QUERY TEXT, not by position. A batch sends several queries in
 * one run and the dataset does not promise to come back in the order they
 * were sent -- matching by index would silently file one school's results
 * against another, which is unrecoverable once the rows exist.
 */
function spResultsFor_(items, query) {
  const want = String(query).trim().toLowerCase();
  const urls = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const term = String((it.searchQuery && it.searchQuery.term) || '').trim().toLowerCase();
    if (term !== want) continue;
    const organic = it.organicResults || [];
    for (let r = 0; r < organic.length && urls.length < SP_MAX_RESULTS_READ; r++) {
      const u = organic[r] && organic[r].url;
      if (u) urls.push(String(u));
    }
  }
  return urls;
}

/**
 * Score search results with rankCandidates_ -- the SAME scorer sitemap
 * discovery and the census use, so a URL that qualifies here would have
 * qualified there. One scoring rule for the whole pipeline.
 *
 * The host filter runs FIRST because an unrestricted query (Report Form)
 * returns directories, news and aggregators that a URL-keyword scorer has
 * no way to recognise as off-topic -- 'hazing' in the slug of a news
 * article scores exactly like 'hazing' in the slug of a school's page.
 */
function spScore_(urls, cat, inst) {
  const keep = [];
  for (let i = 0; i < urls.length; i++) {
    if (!spIsPlausibleHost_(urls[i])) continue;
    if (!spBelongsTo_(urls[i], inst)) continue;
    keep.push(urls[i]);
  }
  return rankCandidates_(keep, CATEGORIES[cat.catKey]);
}

/**
 * Does this search result actually belong to THIS school?
 *
 * ADDED 2026-09-06 AFTER THE FIRST LIVE RUN, which created 43 rows and
 * almost every one was another institution's page. UAB was given Central
 * Alabama Community College's reporting form, University of Mobile was given
 * hazing.umd.edu, Oakwood was given both communitystandards.umn.edu and
 * hazefree.mit.edu, Troy was given a WSFA news article, and eight rows
 * pointed at hazingpreventionnetwork.org.
 *
 * The cause is structural, not a bad keyword list. rankCandidates_ scores
 * the URL SLUG and nothing else, so 'hazing.umd.edu/hazing-reporting' scores
 * exactly as well for Oakwood as it does for Maryland. Sitemap discovery
 * never needed an ownership test because every URL it saw came from the
 * school's own sitemap; an unrestricted web search has no such guarantee,
 * and this is the check that replaces it.
 *
 * TWO WAYS A RESULT CAN QUALIFY:
 *
 * 1. It is on the school's own domain, or a subdomain of it. endhazing.sl.
 *    ua.edu is University of Alabama's, and correctly belongs to UNITID
 *    100751 and to nobody else.
 *
 * 2. It is on a recognised conduct-reporting vendor AND carries something
 *    identifying the school. This is the case the whole unrestricted Report
 *    Form query exists for: about 75% of confirmed forms are on Maxient,
 *    Symplicity Advocate, EthicsPoint, Qualtrics or Google Forms. Those URLs
 *    name their institution -- cm.maxient.com/reportingform.php?SamfordUniv,
 *    ucsb-advocate.symplicity.com/public_report/... -- so requiring a token
 *    match keeps the vendor route open without letting one school's vendor
 *    form be filed against every school in the country.
 *
 * A GOOGLE FORM WITH AN OPAQUE ID CANNOT PASS THIS TEST, and that is the
 * accepted cost. docs.google.com/forms/d/e/1FAIpQLSd.../viewform names
 * nobody, so there is no honest way to attribute it from the URL alone.
 * Better a missed candidate than a form filed against the wrong school:
 * a miss leaves a blank a person can still fill, while a wrong row gets
 * reviewed, rejected, and then blocklists a real URL for that school.
 */
function spBelongsTo_(url, inst) {
  const host = spDomain_(url);
  if (!host) return false;

  const own = spDomain_(inst.url);
  if (own && (host === own || host.slice(-(own.length + 1)) === '.' + own)) return true;

  let isVendor = false;
  for (let i = 0; i < SP_VENDOR_HOSTS.length; i++) {
    const v = SP_VENDOR_HOSTS[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) { isVendor = true; break; }
  }
  if (!isVendor) return false;

  const flat = String(url).toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = spTokens_(inst, own);
  for (let t = 0; t < tokens.length; t++) {
    if (flat.indexOf(tokens[t]) !== -1) return true;
  }
  return false;
}

/**
 * Strings that identify this institution inside a vendor URL.
 *
 * The domain label first -- 'samford' from samford.edu, 'ucsb' from
 * ucsb.edu -- because vendors overwhelmingly build their identifiers from
 * it. Then the distinctive words of the institution's name, which catches
 * spelled-out variants.
 *
 * SHORT AND GENERIC WORDS ARE DROPPED, and that is what stops this test
 * quietly becoming useless: 'university', 'college' and 'state' appear in
 * hundreds of institution names and in most vendor URLs, so keeping them
 * would match everything and re-admit exactly the errors this exists to
 * prevent. A four-character minimum also keeps 'of', 'the' and 'at' out.
 */
function spTokens_(inst, ownDomain) {
  const out = [];
  const label = String(ownDomain || '').split('.')[0].replace(/[^a-z0-9]/g, '');
  if (label.length >= 3) out.push(label);

  const stop = {
    university: 1, universities: 1, college: 1, colleges: 1, state: 1,
    community: 1, institute: 1, institution: 1, school: 1, campus: 1,
    academy: 1, center: 1, centre: 1, technical: 1, technology: 1,
    seminary: 1, district: 1, system: 1, main: 1, north: 1, south: 1,
    east: 1, west: 1, saint: 1, national: 1, american: 1, international: 1
  };
  String(inst.name || '').toLowerCase().split(/[^a-z0-9]+/).forEach(function (w) {
    if (w.length >= 4 && !stop[w] && out.indexOf(w) === -1) out.push(w);
  });
  return out;
}

// Conduct and incident-reporting vendors. A result on one of these can be a
// school's real reporting route; a result anywhere else off-domain cannot.
// Kept here rather than reusing repickVendor_ because that function needs a
// seed URL and a text blob this pass does not have.
const SP_VENDOR_HOSTS = [
  'maxient.com', 'symplicity.com', 'ethicspoint.com', 'navexglobal.com',
  'navex.com', 'qualtrics.com', 'formstack.com', 'wufoo.com',
  'jotform.com', 'guardianconduct.com', 'lighthouse-services.com',
  'reportlineweb.com', 'convercent.com', 'i-sight.com', 'caseiq.com',
  'get-rave.com', 'titleixinvestigators.com', 'publicsafetyreporting.com'
];

// Hosts that can never be a school's own page or its reporting vendor.
// GLOBAL_EXCLUSION_KEYWORDS already drops clerycenter.org, stophazing.org
// and .gov; this catches the rest of what an unrestricted search returns.
const SP_JUNK_HOSTS = [
  'wikipedia.org', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'linkedin.com', 'youtube.com', 'reddit.com', 'tiktok.com', 'pinterest.com',
  'niche.com', 'collegefactual.com', 'petersons.com', 'usnews.com',
  'collegeboard.org', 'chegg.com', 'coursehero.com', 'studocu.com',
  'indeed.com', 'glassdoor.com', 'yelp.com', 'apnews.com', 'nytimes.com',
  'washingtonpost.com', 'cnn.com', 'foxnews.com', 'nbcnews.com', 'usatoday.com',
  'insidehighered.com', 'chronicle.com', 'justia.com', 'findlaw.com',
  'casetext.com', 'lexisnexis.com', 'scribd.com', 'coursicle.com'
];

function spIsPlausibleHost_(url) {
  const h = spDomain_(url);
  if (!h) return false;
  for (let i = 0; i < SP_JUNK_HOSTS.length; i++) {
    if (h === SP_JUNK_HOSTS[i] || h.slice(-(SP_JUNK_HOSTS[i].length + 1)) === '.' + SP_JUNK_HOSTS[i]) {
      return false;
    }
  }
  return true;
}

// =========================================================================
// WRITING
// =========================================================================

/**
 * A new Candidate URLs row from a search hit.
 *
 * IDENTICAL IN SHAPE to a sitemap or cross-seed row apart from Source, so
 * capture, pre-filter, the AI pass and the review views all treat it the
 * same. Rank is left blank: there was no sitemap ranking, and writing 1
 * would claim a provenance this row does not have -- the same reasoning
 * xsNewRow_ gives.
 */
function spNewRow_(inst, cat, hit) {
  const f = {};
  f[CF.candidateUrl] = hit.url;
  f[CF.category]     = cat.label;
  f[CF.fetchStatus]  = 'Not yet fetched';
  f[PF_F_RESULT]     = 'Not yet run';
  f[XS_F_UNITID]     = inst.unitid;
  f[XS_F_INST_LINK]  = [inst.unitid];
  f[XS_F_SOURCE]     = SP_SOURCE_VALUE;
  return { fields: f };
}

function spWriteInst_(pat, recordId, vals) {
  const f = {};
  f[SP_W_STATUS]  = vals.status;
  f[SP_W_DATE]    = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  if (vals.summary) f[SP_W_SUMMARY] = vals.summary;

  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + SC_INST_TABLE,
    { method: 'patch',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ records: [{ id: recordId, fields: f }], typecast: true }),
      muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Write to Institutions failed (' + resp.getResponseCode() + '): ' +
      resp.getContentText().slice(0, 300));
  }
  Utilities.sleep(210);
}

// =========================================================================
// BUDGET AND BOOKKEEPING
// =========================================================================

function spToken_(quiet) {
  const t = PropertiesService.getScriptProperties().getProperty(SP_TOKEN_PROP);
  if (!t && !quiet) {
    throw new Error('Set ' + SP_TOKEN_PROP + ' in Script Properties first ' +
      '(Apify Console > Settings > Integrations > API tokens).');
  }
  return t || '';
}

function spToday_() { return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd'); }

function spQuota_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SP_PROP_QUOTA);
  const today = spToday_();
  if (!raw) return { day: today, used: 0 };
  try {
    const q = JSON.parse(raw);
    return (q.day === today) ? q : { day: today, used: 0 };
  } catch (e) { return { day: today, used: 0 }; }
}

/**
 * Charge queries against today's allowance BEFORE they are sent.
 *
 * Counting after a successful call would let a run that fails repeatedly
 * spend all day: each attempt costs Apify money whether or not this script
 * ever sees the results.
 */
function spSpendQuota_(n) {
  const q = spQuota_();
  q.used += n;
  PropertiesService.getScriptProperties().setProperty(SP_PROP_QUOTA, JSON.stringify(q));
}

function spReadStats_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SP_PROP_STATS);
  const empty = { queries: 0, created: 0, dupes: 0, nothing: 0, errors: 0 };
  if (!raw) return empty;
  try { return JSON.parse(raw); } catch (e) { return empty; }
}

function spWriteStats_(stats) {
  PropertiesService.getScriptProperties().setProperty(SP_PROP_STATS, JSON.stringify(stats));
}
