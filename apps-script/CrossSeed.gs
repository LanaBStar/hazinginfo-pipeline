// =========================================================================
// CROSS-SEED DISCOVERY  (2026-08-23)  -- FILE 4 OF THE PROJECT
//
// PASTE AS A NEW FILE (File > New > Script, name it CrossSeed).
// Do NOT paste into SitemapFinder.gs.
//
// RUN:
//   xsStatus()            how many institutions each target has to work
//                         through, and where the cursor is. No fetching.
//   xsRun('reportForm')   work for ~4.5 minutes, then stop and say what is
//                         left. Run again to continue.
//   xsRun('chtr')
//   xsRun('hazingPolicy')
//   xsReset('reportForm') start that target over from the top.
//   xsDryRun('reportForm', 10)
//                         fetch 10 seeds, log exactly what WOULD be
//                         created, write nothing.
//
// -------------------------------------------------------------------------
// WHY THIS EXISTS
//
// The sitemap finder reads a school's own sitemap.xml, so it can only ever
// propose a URL the school publishes on its own domain. Two things sit
// outside that:
//
//   1. VENDOR-HOSTED DESTINATIONS. Measured against the live 50 States data
//      on 2026-08-23: 488 of 650 confirmed Report Forms (75%) are on a
//      third-party host -- Maxient, Symplicity Advocate, EthicsPoint,
//      Qualtrics, Google Forms. None of those will ever appear in a school
//      sitemap. The same is true, less often but not rarely, for CHTR: 72
//      confirmed chtr_index_urls live on cm.maxient.com/chtr.php.
//      Hazing Policy is almost entirely on-domain (7 of 1,147), so for that
//      category this pass is about hub pages and PDFs rather than vendors.
//
//   2. THE ANSWER ONE LINK OFF A HUB. A school's compliance page is named
//      after whichever requirement came first, so an
//      annual-security-and-fire-safety-report page can hold the CHTR and
//      contain no hazing term in its URL at all. No amount of keyword
//      tuning fixes that; the fix is to follow links off a page a human has
//      already confirmed is on-topic.
//
// So: take a URL this school ALREADY has confirmed for one category, read
// that page, and look at what it links to for the category that is still
// blank. That is the same mechanism the Report Form link pass already uses,
// pointed at a confirmed page instead of a guessed one.
//
// -------------------------------------------------------------------------
// WHICH CATEGORY SEEDS WHICH
//
//   CHTR          -> Report Form,  Hazing Policy
//   Hazing Policy -> Report Form,  CHTR
//   Report Form   -> nothing
//
// REPORT FORM IS NEVER A SEED, and that is a structural claim rather than a
// preference. Its confirmed URL is overwhelmingly a vendor form -- a
// Maxient or Symplicity page that exists to collect a submission. It links
// back to nothing about the school, and a majority of Maxient URLs are
// robots.txt-disallowed anyway, so there would frequently be nothing to
// read even if there were something to find. It is a leaf node.
//
// The numbers agree: only 105 schools have a Report Form and no CHTR, and
// 36 have a Report Form and no Hazing Policy, so even a perfect Report
// Form-seeded pass has a small ceiling and a bad starting point.
//
// -------------------------------------------------------------------------
// A SEED CAN BE ITS OWN ANSWER
//
// Georgian Court University's confirmed Report Form and confirmed Hazing
// Policy are THE SAME URL, because the form is embedded in the policy page.
// So this pass must not exclude the seed page from its own results. That is
// the opposite of the rule in repickParse_, which drops self-links because
// a candidate page linking to itself was winning tier 5. Different
// question, different answer: there, the page was a guess; here, a human
// already confirmed it.
//
// -------------------------------------------------------------------------
// WHAT IT COSTS, AND WHY IT IS BATCHED THE WAY IT IS
//
// One fetch per distinct seed page. Seeds are de-duplicated within a run,
// so a school whose CHTR and Hazing Policy are the same URL is read once.
//
// PDF SEEDS ARE STILL SKIPPED WITHOUT A FETCH -- but they are now COUNTED
// SEPARATELY from unreadable ones, which is the part that was missing.
//
// This was briefly changed (2026-08-29) to OCR them through
// capFetchAndExtract_, on the reasoning that a PDF buys no LINKS but does buy
// the seed's own text for Gate 0 in rankCandidatesByBlob_, and that 37% of
// Hazing Policy seeds are PDFs -- 127 institutions whose only CHTR seed could
// not be looked at. REVERTED THE SAME DAY, and the reason is worth keeping:
// the dry run it enabled proposed 3 candidates and all 3 were the seed PDF
// proposing ITSELF as the school's CHTR, because Gate 0 was matching CHTR
// terms against prose and a hazing policy cites the Act by name. Gate 0 now
// matches HEADINGS instead (see rankCandidatesByBlob_ point 4), and OCR text
// has no headings -- so a PDF seed could not qualify even if it were read.
//
// Which leaves OCR costing a Drive conversion, a large share of the
// 4.5-minute slice, and a share of the ~2,000/day quota shared with capture
// and pdfBackfill(), in exchange for nothing. Skipping is right; what was
// wrong was only that a skip and a failure were being reported as one number.
//
// If a future change gives Gate 0 something a PDF can honestly answer --
// extracted headings, or a first-page title -- this is the decision to
// revisit, and pdfSkipped is the number that says how much it would be worth.
//
// The binding limit on a personal Google account is not the fetch count
// (20,000/day) but runtime: 6 minutes per execution, ~90 minutes of trigger
// runtime per day. Hence the 4.5-minute budget and the resumable cursor.
//
// NOTHING HERE INSTALLS A TRIGGER. This is a hand-run pass, like
// runCapturePass(). If it earns a place in the scheduled pipeline it can be
// added as a stage later; until then it cannot consume runtime unattended.
//
// -------------------------------------------------------------------------
// DECLARED ELSEWHERE, NOT HERE. Apps Script treats every .gs file in a
// project as one shared global scope, so redeclaring any of these fails the
// whole project with "already declared":
//
//   from SitemapFinder.gs SM_BROWSER_HEADERS
//   from SitemapFinder.gs PAGES_BASE_ID, CF, RFL, CATEGORIES,
//                         INTAKE_CREATE_BATCH, capPat_,
//                         capRobotsDisallows_, capFetchAndExtract_,
//                         rankCandidatesByBlob_,
//                         scoreToConfidence_, pipelineUrlKey_,
//                         pipelineExistingKeys_, pipelineIntakeFlush_,
//                         repickDecode_, repickTrim_, repickUnwrap_,
//                         repickIsJunkHost_, repickIsSaneUrl_,
//                         repickIsCssJunk_, repickIsReadNotFile_,
//                         repickVendor_, repickPick_, repickSite_
//
// Verified 2026-08-23 against the pasted copies of all three files: every
// name above is declared exactly once, elsewhere, and nothing this file
// declares collides with them.
//
// Everything this file defines is prefixed xs / XS, per the naming
// discipline in SitemapFinder.gs's header. Apps Script does NOT error on a
// duplicate function name -- the later definition silently wins and the
// caller that wanted the other one breaks with no message.
// =========================================================================

// ---- Fields on the synced Institutions table in PAGES (production) -----
// PRODUCTION SINCE 2026-08-23. An earlier version of this comment said
// TESTER; that is no longer true and the ids below are production.
//
// Institutions is synced from the production 50 States base, so this pass
// reads seeds and writes candidates within ONE base. That is why there is
// no BASE_ID/TABLE_ID here.
const XS_INST_TABLE  = 'tblpgBmu7r8kQA6b5';   // Institutions (synced, READ-ONLY)
const XS_I_UNITID    = 'fldGREvzCIme6HXfl';
const XS_I_NAME      = 'fldHvefXrrPxibBsZ';
// TWO SETS OF URL FIELDS, AND THIS FILE READS BOTH, FOR DIFFERENT JOBS.
// Get this distinction wrong and the pass either skips schools it should
// search or crawls pages that do not exist. Changed 2026-09-09; the old
// arrangement read located_* for both jobs.
//
//   COMPLIANCE fields  -> THE GATE (XS_TARGETS[].fields). "Does this
//                         school still need one?" Blank means yes.
//   RECORD fields      -> THE SEEDS (XS_SEED_META[].fields). "Is there a
//                         real page here worth crawling for links?"
//
// The two answers differ for exactly the schools that matter: one with a
// page judged BELOW STANDARD has the record field filled and compliance
// blank. It still needs a compliant page (so it must stay in the gate),
// and the page it does have is still a real page full of real links (so it
// is still a good seed). Reading one set for both jobs loses one of those
// every time.
//
// HISTORY, because this is the third setting. 2026-08-26 the gate was
// briefly compliance-OR-located, then simplified the same day to located_*
// alone once Lana backfilled located_* from the compliance fields, making
// located_* a true superset. That note named its own expiry: it holds only
// while the promote step writes both fields together for every 'Confirmed
// - promote'. The promote spec deliberately does not -- a below-standard
// candidate writes the record field alone -- so located_* stops being a
// superset the first time promote runs, and a located_* gate would retire
// a school the moment we filed a page we ourselves judged inadequate.
// See the matching note above CATEGORIES in SitemapFinder.gs.
const XS_I_CHTR      = 'fldqQrSD83OVoteFx';   // chtr_index_url          RECORD  (seed)
const XS_I_LOC_POLICY = 'fldKyIAd65Yfn5g0V';  // located_hazing_policy_url RECORD (seed)
const XS_I_LOC_FORM   = 'fldeBRiCU8dnIKsYk';  // located_report_form_url   RECORD (not a seed -- leaf node)
const XS_I_TRANSPARENCY = 'fldGJPC0iyuPcWtlK'; // Transparency Report   COMPLIANCE (gate) -- paired with chtr_index_url
const XS_I_POLICY    = 'fldD9gEpDcw2l35II';   // Hazing Policy         COMPLIANCE (gate) -- paired with located_hazing_policy_url
const XS_I_FORM      = 'fldIrTzWzi87nD7EU';   // Report Form           COMPLIANCE (gate) -- paired with located_report_form_url

// ---- Provenance fields on Candidate URLs -------------------------------
//   Seed URL         url            the confirmed page this came off
//   Seed category    singleSelect   CHTR | Hazing Policy
//   Seed link text   singleLineText the anchor text on the seed page
//
// Read from the live base 2026-08-23. If Candidate URLs is ever recreated
// rather than edited, EVERY id in this file changes -- Airtable assigns new
// ones to a new table, and a stale id fails the whole write batch.
const XS_F_SEED_URL   = 'fldOV1CDQQ01PQl7R';
const XS_F_SEED_CAT   = 'fldsFdJdsgKJOzIPN';
const XS_F_SEED_TEXT  = 'fldcoWJ6RNYZ3BY0L';

// Candidate URLs fields this file writes directly, because CF has no key
// for them (CF holds capture fields only).
const XS_F_UNITID     = 'fldRicdqQxfBxUGBH';   // primary field
const XS_F_INST_LINK  = 'fldhbnSdGI8PFQQc7';   // Institution, matched by value
const XS_F_SOURCE     = 'fldDgMOzWYGMEL4Xd';
// XS_F_CONFIDENCE (Keyword confidence) WAS HERE. REMOVED 2026-09-01 with
// the field. See the SM_CF_CONFIDENCE tombstone in SitemapFinder.gs for
// why: it was the ranking score in three buckets, restating Rank, read by
// nothing. Cross-seed rows never carried a Rank either -- xsPickByKeyword_
// returns a single winner per seed, so there is no ordering to record.

const XS_SOURCE_VALUE = 'Cross-seed';   // already added to the Source field

// ---- Run shape ---------------------------------------------------------
const XS_BUDGET_MS   = 4.5 * 60 * 1000;   // stop STARTING work; see below
const XS_PAUSE_MS    = 400;               // other people's servers
const XS_MAX_LINKS   = 60;                // per seed page, before ranking
// Candidates kept per seed page. LOWERED FROM 3 TO 2 on 2026-08-23, from
// the 30-school dry run. At 3, UCSB's confirmed CHTR page produced three
// Symplicity pids, two of them labelled "Make a Report" -- redundant review
// work. Not lowered to 1 because Cal Poly's best answer was its SECOND pick:
// #1 was a CARE referral ("Refer a Student of Concern") and #2 was the
// actual public report form. A right answer that is never proposed is
// invisible, whereas a wrong one is rejected once and then permanently
// blocklisted, since pipelineExistingKeys_ reads rejected rows too.
const XS_MAX_PER_SEED = 2;

// Cursor keys, one per target. Suffixed so working on Report Form does not
// destroy a half-finished CHTR run.
//
// XS_PROP_AFTER SUPERSEDES XS_PROP_INDEX (2026-08-29). The cursor used to be
// a POSITION into the target list, and xsTargets_'s header defended that by
// pointing out the list is sorted, so it cannot reorder between runs. Sorting
// was necessary and not sufficient: the list also SHRINKS while the run
// works. xsTargets_ drops any institution whose pending-candidate count is
// above zero (decision #171) -- and creating a candidate row is precisely
// what makes that count non-zero. So a slice that examines schools 0..N and
// creates rows for k of them leaves the cursor at N; on the next slice those
// k schools are gone from the list, everything after them has shifted down by
// k, and positions N-k..N-1 now sit BEHIND the cursor. Those schools are
// never examined.
//
// Nothing reported it. `created` and `skipped` both look entirely normal, and
// the run log's "Cursor at N of TOTAL" is true about the list as it stands
// rather than about the ground actually covered. That is what let it run
// across three targets unnoticed.
//
// The fix is to remember WHICH SCHOOL was last finished rather than how many
// there were. A UNITID watermark survives the list changing underneath it,
// because it names a place in the sort order instead of a slot in an array,
// and xsTargets_ sorts by UNITID -- so "resume after this UNITID" stays
// well-defined however many rows came or went in between.
//
// XS_PROP_INDEX is kept ONLY so a leftover value can be recognised and
// cleared (see xsMigrateCursor_). Nothing writes it again.
const XS_PROP_INDEX   = 'xs_index_';   // legacy, read once then deleted
const XS_PROP_AFTER   = 'xs_after_';   // last UNITID fully processed
const XS_PROP_STATS   = 'xs_stats_';

// WHICH CATEGORY SEEDS WHICH -- the table above, in code. Report Form's
// absence from every seeds[] list is the leaf-node rule.
//
// `fields` IS THE GATE and holds COMPLIANCE field ids as of 2026-09-09 --
// see the two-sets note above the field constants for why the gate and the
// seeds read different fields. A school is "already answered" for a target
// when its compliance field is filled; a below-standard page in the record
// field does not answer it.
//
// `fields` (plural) exists so xsTargets_ can share code with a category
// that ever needs more than one field again -- today every category is
// single-field. It was genuinely two per category for a few hours on
// 2026-08-26 (compliance OR located), before the located_* backfill made
// one enough; the plural survives that.
const XS_TARGETS = {
  reportForm:   { label: 'Report Form',   fields: [XS_I_FORM],         seeds: ['chtr', 'policy'] },
  chtr:         { label: 'CHTR',          fields: [XS_I_TRANSPARENCY], seeds: ['policy'] },
  hazingPolicy: { label: 'Hazing Policy', fields: [XS_I_POLICY],       seeds: ['chtr'] }
};

// SEEDS READ THE RECORD FIELDS, AND DELIBERATELY STAY THAT WAY -- they
// were NOT switched to compliance alongside XS_TARGETS on 2026-09-09.
// A seed answers a different question from the gate: not "does this school
// still need one?" but "is there a real page here to crawl for links?" A
// Hazing Policy page rated below standard is still a real page, still full
// of real links, and is often the only page a school has that points at
// its report form. Before the 2026-08-26 backfill those pages were
// invisible as seeds, because only the blank compliance field was read --
// switching these to compliance would reintroduce exactly that blind spot.
//
// `fields` (plural) here too. The policy entry was briefly
// [located, compliance] with located tried first and compliance as a
// fallback; once located_* was backfilled the fallback was dead weight and
// was removed.
const XS_SEED_META = {
  chtr:   { fields: [XS_I_CHTR],                  label: 'CHTR' },
  policy: { fields: [XS_I_LOC_POLICY], label: 'Hazing Policy' }
};

// -------------------------------------------------------------------------
// ENTRY POINTS
// -------------------------------------------------------------------------

function xsStatus() {
  const pat = capPat_();
  const props = PropertiesService.getScriptProperties();
  let out = '\n============ CROSS-SEED STATUS ============\n';
  Object.keys(XS_TARGETS).forEach(function (key) {
    const targets = xsTargets_(pat, key);
    const after  = props.getProperty(XS_PROP_AFTER + key) || '';
    const legacy = props.getProperty(XS_PROP_INDEX + key);
    const idx = xsResumeIndex_(targets, after);
    const stats = xsReadStats_(key);
    out += '\n' + XS_TARGETS[key].label + '\n' +
      '  institutions with a seed and no ' + XS_TARGETS[key].label + ': ' + targets.length + '\n' +
      '  resume after UNITID: ' + (after || '(not started)') + '\n' +
      '  position in that list: ' + idx + ' of ' + targets.length +
      (idx >= targets.length && targets.length ? '   (finished)' : '') + '\n' +
      '  created so far: ' + (stats.created || 0) +
      ', already present: ' + (stats.skipped || 0) +
      ', seeds read: ' + (stats.seedsRead || 0) +
      ', PDF seeds skipped: ' + (stats.pdfSkipped || 0) +
      ', seeds unreadable: ' + (stats.unreadable || 0) + '\n' +
      '  NOTE: these counters are reset by xsReset and count work since the\n' +
      '        last reset, NOT rows in the table. Airtable is the count.\n' +
      (legacy !== null
        ? '  NOTE: a positional cursor from before the 2026-08-29 fix is still\n' +
          '        stored for this target. The next xsRun discards it and starts\n' +
          '        from the top -- see xsMigrateCursor_ for why that is the only\n' +
          '        honest conversion.\n'
        : '');
  });
  out += '\nxsRun(<key>) to work. Keys: ' + Object.keys(XS_TARGETS).join(', ') + '\n';
  Logger.log(out);
}

function xsReset(targetKey) {
  xsRequireTarget_(targetKey);
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(XS_PROP_AFTER + targetKey);
  props.deleteProperty(XS_PROP_INDEX + targetKey);   // legacy, if still there
  props.deleteProperty(XS_PROP_STATS + targetKey);
  Logger.log('Cross-seed ' + targetKey + ' reset. Next xsRun starts from the top.\n' +
    'Cumulative stats for this target were cleared too -- they count work, not\n' +
    'rows, and the rows themselves are in Candidate URLs either way.');
}

/**
 * Fetch seeds and CREATE candidate rows. Resumable: stops on the time
 * budget and remembers where it got to.
 */
function xsRun(targetKey) {
  return xsWork_(targetKey, { write: true, limit: 0 });
}

/**
 * Fetch a few seeds and log what WOULD be created. Writes nothing, and does
 * not move the cursor -- so a dry run never costs you ground on a real one.
 *
 * Use this first on a target. The classification rules per category are
 * different and the only honest way to know whether they are right is to
 * look at what they propose on real pages.
 */
function xsDryRun(targetKey, howMany) {
  return xsWork_(targetKey, { write: false, limit: Math.max(1, howMany || 10) });
}

// -------------------------------------------------------------------------
// THE PASS
// -------------------------------------------------------------------------

function xsWork_(targetKey, opts, deadlineAt) {
  const target = xsRequireTarget_(targetKey);
  if (opts.write) xsRequireFields_();

  const pat = capPat_();
  const started = Date.now();
  const deadline = deadlineAt || (started + XS_BUDGET_MS);
  const props = PropertiesService.getScriptProperties();

  const targets = xsTargets_(pat, targetKey);
  if (!targets.length) {
    Logger.log('Nothing to do: no institution has a seed and a blank ' + target.label + '.');
    return { done: true, processed: 0 };
  }

  // Every (UNITID, url) already in Candidate URLs for this category,
  // REJECTED ROWS INCLUDED. A rejected row is the blocklist -- recreating a
  // URL a reviewer already threw out is the single most annoying thing this
  // could do. Read once per run, then kept up to date in memory.
  const seen = opts.write ? pipelineExistingKeys_(pat, target.label) : {};

  // Resume after the last UNITID this target FINISHED, not at a saved
  // position -- see XS_PROP_AFTER for what the position cursor got wrong. A
  // dry run always starts from the top and never reads or moves the mark.
  const after = opts.write ? xsMigrateCursor_(props, targetKey) : '';
  let index = xsResumeIndex_(targets, after);
  let lastDone = after;
  const stats = opts.write ? xsReadStats_(targetKey)
                           : { created: 0, skipped: 0, unreadable: 0, seedsRead: 0, pdfSkipped: 0 };

  const pending = [];
  const preview = [];
  let processedThisRun = 0;

  // Seed pages already read in THIS execution. A school whose CHTR and
  // Hazing Policy are the same page is one fetch, not two.
  const fetched = {};

  while (index < targets.length) {
    if (Date.now() > deadline) break;
    if (opts.limit && processedThisRun >= opts.limit) break;

    const inst = targets[index];
    index++;
    processedThisRun++;

    for (let s = 0; s < target.seeds.length; s++) {
      const seedKey = target.seeds[s];
      const seedUrl = (inst.seeds[seedKey] || '').trim();
      if (!seedUrl) continue;

      const cacheKey = xsNorm_(seedUrl);
      let links = fetched[cacheKey];
      if (links === undefined) {
        links = xsReadSeed_(seedUrl);

        // THREE OUTCOMES, NOT TWO. A PDF seed is skipped by choice; an
        // unreadable one was attempted and failed. Reporting both as
        // "unreadable" hid the fact that 37% of CHTR seeds are structurally
        // unreachable rather than merely broken -- a fact about what schools
        // publish, not about the checker.
        //
        // THE SLEEP IS INSIDE THE FETCHED BRANCHES ON PURPOSE. XS_PAUSE_MS
        // exists to be polite to other people's servers; a PDF skip never
        // contacts one, so pausing for it is 400ms of a 4.5-minute slice
        // spent apologising to nobody. On the CHTR target that is ~127 skips,
        // near a minute of every run.
        if (links && links.pdfSkipped) {
          stats.pdfSkipped = (stats.pdfSkipped || 0) + 1;
          links = null;                       // no entries; nothing to classify
        } else {
          Utilities.sleep(XS_PAUSE_MS);
          if (links === null) stats.unreadable = (stats.unreadable || 0) + 1;
          else stats.seedsRead = (stats.seedsRead || 0) + 1;
        }
        fetched[cacheKey] = links;            // null for both skip and failure
      }
      if (links === null) continue;

      const picks = xsClassify_(targetKey, links, seedUrl);

      for (let p = 0; p < picks.length; p++) {
        const pick = picks[p];
        const key = inst.unitid + '|' + pipelineUrlKey_(pick.url);
        if (seen[key]) { stats.skipped = (stats.skipped || 0) + 1; continue; }
        seen[key] = true;

        if (opts.write) {
          pending.push(xsNewRow_(inst, target.label, pick, seedUrl, XS_SEED_META[seedKey].label));
        } else {
          preview.push({
            unitid: inst.unitid, name: inst.name,
            seedCat: XS_SEED_META[seedKey].label, seed: seedUrl,
            url: pick.url, why: pick.why, text: pick.text
          });
        }
        stats.created = (stats.created || 0) + 1;
      }
    }

    // Flush as we go, and move the watermark with it. A create that lands
    // but whose watermark never saves means the next run proposes the same
    // rows -- dedupe would catch them, but the run would look like it found
    // nothing. Saving together keeps the two honest.
    //
    // The mark is inst.unitid -- the school just finished -- and NOT
    // targets[index].unitid, which is the next one and has not been looked at
    // yet. Writing the next school's id would skip it on resume: the same
    // class of off-by-one the position cursor died of, one school at a time
    // instead of k.
    if (opts.write) {
      while (pending.length >= INTAKE_CREATE_BATCH) {
        pipelineIntakeFlush_(pat, pending.splice(0, INTAKE_CREATE_BATCH));
      }
      lastDone = inst.unitid;
      props.setProperty(XS_PROP_AFTER + targetKey, lastDone);
      xsWriteStats_(targetKey, stats);
    }
  }

  if (opts.write) {
    pipelineIntakeFlush_(pat, pending);
    if (lastDone) props.setProperty(XS_PROP_AFTER + targetKey, lastDone);
    xsWriteStats_(targetKey, stats);
  }

  const done = index >= targets.length;

  if (!opts.write) {
    let s = '\n======== CROSS-SEED DRY RUN: ' + target.label + ' ========\n' +
      'Nothing was written and the cursor did not move.\n' +
      processedThisRun + ' institution(s) examined, ' +
      stats.seedsRead + ' seed page(s) read, ' +
      stats.unreadable + ' unreadable.\n' +
      preview.length + ' candidate(s) would be created.\n';
    preview.forEach(function (p, i) {
      s += '\n' + (i + 1) + '. ' + p.unitid + '  ' + String(p.name).slice(0, 34) + '\n' +
           '   seed (' + p.seedCat + '): ' + p.seed.slice(0, 92) + '\n' +
           '   would create:            ' + p.url.slice(0, 92) + '\n' +
           '   because: ' + p.why + (p.text ? '   link text: "' + p.text.slice(0, 50) + '"' : '') + '\n';
    });
    s += '\nRead the "would create" lines before running xsRun. A wrong rule\n' +
         'here creates rows a person then has to reject one at a time.\n';
    Logger.log(s);
    return { done: false, dryRun: true, proposed: preview.length };
  }

  Logger.log(
    '\n======== CROSS-SEED: ' + target.label + ' ========\n' +
    (done ? 'FINISHED. ' : 'Time budget reached. ') +
    'Reached ' + index + ' of ' + targets.length + ' in the list AS IT STANDS' +
    (lastDone ? ', resume after UNITID ' + lastDone : '') + '.\n' +
    'That list is recomputed every run and shrinks as rows are created, so\n' +
    'the two numbers are a progress reading, not a count of ground covered.\n' +
    'This run: ' + processedThisRun + ' institution(s).\n' +
    'Cumulative -- created: ' + stats.created +
    ', already present or rejected: ' + stats.skipped +
    ', seed pages read: ' + stats.seedsRead +
    ', PDF seeds skipped: ' + (stats.pdfSkipped || 0) +
    ', seeds unreadable: ' + stats.unreadable + '\n' +
    (done ? 'Nothing left. xsReset(\'' + targetKey + '\') to run it again from the top.\n'
          : 'Run xsRun(\'' + targetKey + '\') again to continue.\n')
  );
  return { done: done, processed: index, total: targets.length, stats: stats };
}

// -------------------------------------------------------------------------
// WHO NEEDS WORK
// -------------------------------------------------------------------------

/**
 * Institutions whose target field is blank and which have at least one seed
 * to work from. Sorted by UNITID so a resumed run covers the same ground in
 * the same order, and so the resume watermark has a well-defined meaning.
 *
 * THIS LIST SHRINKS BETWEEN RUNS, BY DESIGN. The pendingCount gate below
 * removes a school the moment it has an unreviewed candidate -- which is what
 * a successful run creates. That is correct behaviour and it is why the
 * cursor cannot be a position; see XS_PROP_AFTER. Anything else added here
 * that reads live state should assume the same: this function answers "who
 * needs work NOW", never "who needed work when the run started".
 *
 * Not filtered server-side. Airtable's filterByFormula addresses fields by
 * NAME, and this reads a SYNCED table whose field names are inherited from
 * the source base -- a rename there would break the formula here with no
 * error, only a smaller result. Filtering in code costs one full read of a
 * ~1,500-row table (ids and five short text fields) and cannot fail that way.
 */
function xsTargets_(pat, targetKey) {
  const target = XS_TARGETS[targetKey];
  const out = [];
  let offset = null;

  do {
    // BOTH SETS ARE FETCHED as of 2026-09-09, because the gate and the
    // seeds now read different fields: the compliance three answer
    // "already answered?" (target.fields), the record three supply seed
    // pages (XS_SEED_META). Dropping either set silently empties one of
    // those jobs rather than erroring -- a missing field id just comes
    // back absent, which reads as blank.
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + XS_INST_TABLE +
      '?pageSize=100&returnFieldsByFieldId=true' +
      '&fields[]=' + XS_I_UNITID + '&fields[]=' + XS_I_NAME +
      '&fields[]=' + XS_I_CHTR + '&fields[]=' + XS_I_LOC_POLICY + '&fields[]=' + XS_I_LOC_FORM +
      '&fields[]=' + XS_I_TRANSPARENCY + '&fields[]=' + XS_I_POLICY + '&fields[]=' + XS_I_FORM +
      '&fields[]=' + CATEGORIES[targetKey].pendingCountField;
    if (offset) url += '&offset=' + offset;

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable read failed: ' + resp.getContentText().slice(0, 200));
    }
    const j = JSON.parse(resp.getContentText());

    for (let i = 0; i < j.records.length; i++) {
      const f = j.records[i].fields || {};
      const unitid = String(f[XS_I_UNITID] || '').trim();
      if (!unitid) continue;                                  // cannot file it
      // "Already answered" if ANY of target.fields is filled -- see
      // XS_TARGETS' header comment for why this is not a single field.
      const alreadyAnswered = target.fields.some(function (fid) { return String(f[fid] || '').trim(); });
      if (alreadyAnswered) continue;

      // Matches discovery's own rule (decision #171): don't propose a new
      // candidate for a school that already has one sitting unreviewed.
      const pendingCount = Number(f[CATEGORIES[targetKey].pendingCountField] || 0);
      if (pendingCount > 0) continue;

      const seeds = {};
      let any = false;
      for (let s = 0; s < target.seeds.length; s++) {
        const k = target.seeds[s];
        // Walk XS_SEED_META[k].fields IN ORDER, first non-blank wins -- see
        // XS_SEED_META's header comment. Was a single field read; a below-
        // standard-but-located Hazing Policy page used to be invisible here.
        const seedFields = XS_SEED_META[k].fields;
        let v = '';
        for (let sf = 0; sf < seedFields.length && !v; sf++) {
          v = xsFirstUrl_(f[seedFields[sf]]);
        }
        if (v) { seeds[k] = v; any = true; }
      }
      if (!any) continue;

      out.push({ unitid: unitid, name: f[XS_I_NAME] || '', seeds: seeds });
    }
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  out.sort(function (a, b) { return xsUnitidCmp_(a.unitid, b.unitid); });
  return out;
}

/**
 * ONE definition of UNITID order, used by BOTH xsTargets_'s sort and the
 * resume test, so the two cannot drift apart. If they ever disagreed, a
 * watermark would land mid-list and skip or repeat an arbitrary run of
 * schools -- silently, which is the failure mode this whole change exists to
 * remove.
 */
function xsUnitidCmp_(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * First position in `targets` strictly after the watermark. Linear rather
 * than a binary search on purpose: the list is ~1,500 rows read over the
 * network, so the scan is free next to the fetch that produced it, and a
 * binary search here would be a second place for the ordering assumption to
 * live.
 */
function xsResumeIndex_(targets, after) {
  if (!after) return 0;
  let i = 0;
  while (i < targets.length && xsUnitidCmp_(targets[i].unitid, after) <= 0) i++;
  return i;
}

/**
 * The UNITID watermark for this target, converting a legacy positional cursor
 * if one is still stored.
 *
 * A legacy index CANNOT be translated into a watermark, and that is the point
 * rather than a shortcoming: the index was already wrong by an unknown
 * amount, so any UNITID derived from it would inherit that error and then
 * look authoritative -- a stale assumption presented as a fact, which is the
 * exact shape of bug this project keeps paying for. The only honest
 * conversion is to start the target over.
 *
 * Starting over costs fetches and nothing else. pipelineExistingKeys_ reads
 * REJECTED rows too, so a re-run can neither duplicate a row nor resurrect a
 * URL a reviewer threw out; and every school that did get a row is off the
 * target list already, via the pendingCount gate. So what a re-run actually
 * re-examines is close to exactly the set the old cursor may have skipped.
 */
function xsMigrateCursor_(props, targetKey) {
  const after = props.getProperty(XS_PROP_AFTER + targetKey);
  if (after) return after;

  if (props.getProperty(XS_PROP_INDEX + targetKey) !== null) {
    props.deleteProperty(XS_PROP_INDEX + targetKey);
    Logger.log(
      'Cross-seed ' + targetKey + ': a positional cursor from before the\n' +
      '2026-08-29 fix was found and discarded. This target starts from the top.\n' +
      'Nothing is duplicated -- dedupe reads rejected rows too -- and any school\n' +
      'the old cursor skipped gets examined this time.');
  }
  return '';
}

// A URL field here is multilineText and occasionally holds more than one
// value. Take the first thing that looks like a URL rather than handing a
// two-line string to UrlFetchApp.
function xsFirstUrl_(v) {
  const first = String(v || '').trim().split(/\s+/)[0];
  return /^https?:\/\//i.test(first) ? first : '';
}

// -------------------------------------------------------------------------
// READING A SEED PAGE
// -------------------------------------------------------------------------

/**
 * Returns an array of {url, text} for every resolvable outbound link, or
 * null if the page could not be read.
 *
 * Deliberately does NOT filter by topic here. rflReportLinks_ combines
 * extraction and report-form-specific keeping in one pass, which is right
 * when there is one category; here three categories want different things
 * from the same fetched page, so extraction is category-blind and every
 * judgment happens in xsClassify_.
 *
 * THE SEED PAGE IS INCLUDED IN ITS OWN RESULTS, as the first entry. See the
 * Georgian Court note in the header.
 *
 * FETCHING AND EXTRACTION IS DELEGATED TO capFetchAndExtract_ (2026-08-29).
 * This function used to carry its own fetch, its own status check and its own
 * capText_ call -- a second copy of exactly what that function does, written
 * before it existed. capFetchAndExtract_ was factored out of capOneRow_ on
 * 2026-08-27 for the stated reason that two copies of PDF-vs-HTML handling
 * could drift apart. Calling it means this path gains Content-Type detection,
 * image rejection and one shared implementation, none of which needs a second
 * copy here. That consolidation is kept; only the OCR use of it was reverted.
 *
 * A PDF SEED IS SKIPPED BEFORE THE FETCH and reported as SKIPPED, not as
 * unreadable -- see the header for why reading it buys nothing under a
 * headings-based Gate 0. The distinction matters because "we chose not to
 * look" and "we looked and failed" are different facts about a school, and
 * collapsing them is the same error #134 named about date checks.
 *
 * THE SEED CARRIES ITS OWN HEADINGS, NOT ITS BODY TEXT. Gate 0 reads
 * headingText; passing body prose is what filed 40 hazing policies as CHTRs
 * on 2026-08-27. See rankCandidatesByBlob_ point 4.
 */
function xsReadSeed_(seedUrl) {
  if (/\.pdf(\?|#|$)/i.test(seedUrl)) return { pdfSkipped: true };
  if (capRobotsDisallows_(seedUrl)) return null;

  const fetched = capFetchAndExtract_(seedUrl);
  if (!fetched.ok) return null;
  if (fetched.isImage) return null;
  if (fetched.isPdf) return { pdfSkipped: true };   // served as PDF without the extension

  const html = fetched.html || '';
  const origin = (/^(https?:\/\/[^\/]+)/i.exec(seedUrl) || [])[1] || '';
  const site = repickSite_(seedUrl);
  const seen = {};
  // headingText: the seed's own h1-h6 text, joined -- read by
  // rankCandidatesByBlob_'s Gate 0 so a readable seed can qualify as its
  // own answer on what its page CALLS ITSELF, not only on what its URL
  // slug says. Headings and slugs are both authored to name the page;
  // body prose is not, which is why this is not capText_'d body text.
  // See that function's header, point 4 (added 2026-08-26 as body text,
  // corrected to headings 2026-08-29 after it filed 40 hazing policies
  // as CHTRs).
  const out = [{ url: seedUrl, text: '(the seed page itself)', sameSite: true, isSeed: true,
                 headingText: (fetched.headings || []).join(' | ') }];
  seen[xsNorm_(seedUrl)] = true;

  const re = /<a[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = repickDecode_(m[1].trim());
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (href.indexOf('//') === 0) href = 'https:' + href;
    else if (href.charAt(0) === '/') href = origin + href;
    else if (!/^https?:/i.test(href)) continue;
    href = repickTrim_(href);

    // ORDER MATTERS: junk hosts are rejected BEFORE unwrapping. A share
    // widget carries this page's own URL in its url= parameter, so
    // unwrapping first turns it into a plausible school link and the junk
    // test then waves it through. Same reasoning as rflReportLinks_.
    if (repickIsJunkHost_(href)) continue;
    href = repickTrim_(repickUnwrap_(href));
    if (repickIsJunkHost_(href) || !repickIsSaneUrl_(href)) continue;

    const key = xsNorm_(href);
    if (seen[key]) continue;
    seen[key] = true;

    let text = repickDecode_(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (repickIsCssJunk_(text) || text === '©') text = '';

    out.push({
      url: href,
      text: text,
      sameSite: !!site && repickSite_(href) === site,
      isSeed: false
    });
    if (out.length >= XS_MAX_LINKS) break;
  }
  return out;
}

function xsNorm_(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

// -------------------------------------------------------------------------
// CLASSIFYING WHAT THE SEED PAGE LINKS TO
// -------------------------------------------------------------------------

/**
 * Returns up to XS_MAX_PER_SEED {url, text, why} picks for this target.
 *
 * TWO DIFFERENT MACHINES, on purpose.
 *
 * Report Form delegates to the existing link rules (repickVendor_ /
 * repickPick_). A vendor form URL carries no useful keywords -- nothing in
 * "cm.maxient.com/reportingform.php?SamfordUniv&layout_id=0" says hazing --
 * so URL keyword scoring is worthless for it and vendor identity plus link
 * text is everything. Those rules were rebuilt against a human review on
 * 2026-08-22 and there must not be a second copy of them.
 *
 * CHTR and Hazing Policy go through rankCandidatesByBlob_, which uses the
 * SAME CATEGORIES keyword lists as rankCandidates_ (the sitemap finder's
 * scorer) -- tuning a keyword moves both. It is a SIBLING function, not a
 * change to rankCandidates_ itself: rankCandidates_'s only other caller is
 * sitemap discovery, scoring bare URLs off a sitemap.xml, which has no
 * anchor text to give it, so its signature has to stay URL-only.
 *
 * UPDATED 2026-08-24. The first version of this comment said link text
 * was captured for the reviewer but did not affect ranking, accepted as
 * the cost of not having a second scoring path. That was reconsidered: the
 * cost was not a slightly weaker CHTR/Hazing Policy pass, it was a
 * pass that COULD NOT DO WHAT IT WAS BUILT FOR (0-for-10 on the first CHTR
 * dry run, and by design, not by bad luck -- see the note preserved
 * above this function's old header for the full history). Link text now
 * counts, gated by sameSite when the text is doing the qualifying work --
 * see rankCandidatesByBlob_'s header for why the gate exists (a page
 * merely citing "Stop Campus Hazing Act" is not a school's CHTR document).
 */
function xsClassify_(targetKey, links, seedUrl) {
  if (targetKey === 'reportForm') return xsPickReportForm_(links, seedUrl);
  return xsPickByKeyword_(targetKey, links);
}

function xsPickReportForm_(links, seedUrl) {
  // Shape the links the way repickPick_ expects. host === '' means
  // repickVendor_ did not recognise it as a form, and every tier requires
  // either a host or hazing wording, so unrecognised links fall out.
  const shaped = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const blob = (l.url + ' ' + l.text).toLowerCase();
    if (repickIsReadNotFile_(blob, l.url)) continue;   // a report you read, not one you file
    shaped.push({
      url: l.url,
      text: l.text,
      host: repickVendor_(l.url, blob, seedUrl),
      blob: blob,
      hazing: /hazing/.test(blob),
      sameSite: l.sameSite
    });
  }

  const out = [];
  const used = {};
  // repickPick_ returns one winner, so run it repeatedly against a
  // shrinking list to get a ranked few. Costs nothing (no fetches) and
  // keeps the tier order as the single definition of "best".
  for (let n = 0; n < XS_MAX_PER_SEED; n++) {
    const remaining = shaped.filter(function (l) { return !used[l.url]; });
    if (!remaining.length) break;
    const best = repickPick_(remaining);
    if (!best) break;
    used[best.url] = true;
    out.push({ url: best.url, text: xsTextFor_(links, best.url), why: best.tier });
  }
  return out;
}

function xsPickByKeyword_(targetKey, links) {
  const category = CATEGORIES[targetKey];

  // THE SEED IS NO LONGER EXCLUDED OUTRIGHT. Was, from 2026-08-23 to
  // 2026-08-24, after the first CHTR dry run proposed the seed page itself
  // for 4 of 4 schools -- bare 'hazing' is a PRIMARY keyword for CHTR and
  // for Hazing Policy alike, so a Hazing Policy seed always scored for
  // CHTR and vice versa, at Medium confidence, on every readable seed.
  // Correct diagnosis, but the fix was broader than the bug: reading the
  // actual 45-row CHTR output on 2026-08-24 turned up Neumann, whose seed
  // URL (.../hazing-report) is plausibly the school's own CHTR index, but
  // could never be proposed under a blanket exclusion -- cross-seed
  // proposed two linked PDFs instead, neither of which was the answer.
  //
  // rankCandidatesByBlob_ now gates isSeed items on its own (Gate 0, see
  // its header): a seed qualifies ONLY on a category.strongKeywords hit --
  // in its own URL, or (2026-08-26) its own page body text -- never on
  // bare 'hazing' or any secondary term alone, on either signal. That
  // preserves the original fix -- a Hazing Policy seed still cannot score
  // as CHTR on bare 'hazing' -- while letting a seed whose slug OR body
  // already says 'chtr' or 'campus-hazing-transparency' answer for itself.
  // This is the same shape as the Report Form path's existing exception
  // for Georgian Court (same URL serves both categories there); the
  // keyword path gets an equivalent, just gated on a stronger keyword
  // match instead of on vendor/form evidence, because it has no such
  // evidence to gate on.
  //
  // headingText is carried through here ONLY because xsReadSeed_ set it on
  // the seed's own entry -- every other link has none, and rankCandidatesByBlob_
  // only ever reads it when isSeed is true, so this is a no-op for them.
  // Dropping this field here would silently defeat Gate 0's heading check
  // while leaving every test that stubs `items` directly (as the
  // rankblob_v5.js harness does) passing -- this mapping is the ONLY place
  // that would break.
  //
  // WAS bodyText UNTIL 2026-08-29. If you are reconciling this against an
  // older harness, the harness is what needs updating: matching CHTR
  // strongKeywords against page prose filed 40 hazing policies as CHTRs,
  // because a compliant policy cites the Act by name. See
  // rankCandidatesByBlob_ point 4.
  //
  // xsReadSeed_ includes the seed in its results for exactly this reason.
  const items = links
    .map(function (l) { return { url: l.url, text: l.text, sameSite: l.sameSite, isSeed: l.isSeed, headingText: l.headingText }; });

  // rankCandidatesByBlob_ applies the SAME CATEGORIES keyword lists as
  // rankCandidates_ -- the sitemap scorer -- plus the same URL-only global
  // and category exclusions, but scores each link's own anchor text
  // alongside its URL, gated by sameSite when the text is doing the work,
  // and (since 2026-08-24) gates a seed's own candidacy on strongKeywords.
  // See its header comment for the full reasoning, the congress.gov case
  // that made the sameSite gate necessary, and the Whittier/Old Westbury
  // cases that added strongKeywords.
  const ranked = rankCandidatesByBlob_(items, category);

  const out = [];
  for (let i = 0; i < ranked.length && out.length < XS_MAX_PER_SEED; i++) {
    const confidence = scoreToConfidence_(ranked[i].score);
    out.push({
      url: ranked[i].url,
      text: xsTextFor_(links, ranked[i].url),
      confidence: confidence,
      why: confidence + ' keyword confidence'
    });
  }
  return out;
}

function xsTextFor_(links, url) {
  for (let i = 0; i < links.length; i++) {
    if (links[i].url === url) return links[i].text || '';
  }
  return '';
}

// -------------------------------------------------------------------------
// WRITING
// -------------------------------------------------------------------------

/**
 * A new Candidate URLs row.
 *
 * A NOTE ON WHAT "Candidate URL" MEANS FOR A CROSS-SEEDED REPORT FORM. On a
 * sitemap-discovered row, Candidate URL is the SCHOOL PAGE and Linked form
 * URL is the vendor form it points at -- because the school page is the
 * thing that was guessed and therefore the thing to review.
 *
 * Here the page is not a guess: it is a URL a human already confirmed for
 * another category. So the vendor form is what needs reviewing, and it goes
 * in Candidate URL. Linked form URL and Linked form host are ALSO set to it,
 * so anything downstream that reads those fields -- the review interface,
 * the vendor-concentration counts -- behaves the same for both kinds of row.
 *
 * Rank is left blank. Rank means "where this placed among the sitemap
 * candidates for this school", and there was no sitemap ranking here.
 * Writing 1 would claim a provenance this row does not have.
 */
function xsNewRow_(inst, categoryLabel, pick, seedUrl, seedCategoryLabel) {
  const f = {};
  f[CF.candidateUrl]        = pick.url;
  f[CF.category]            = categoryLabel;
  f[CF.fetchStatus]         = 'Not yet fetched';
  // STAMPED AT CREATION so the field is never blank (2026-09-01). A new row
  // genuinely has not been pre-filtered, and 'Not yet run' says exactly that.
  // Left unset, the row sat blank until capture reached it -- and blank meant
  // the same thing as 'Not yet run' without saying so, which is how the field
  // ended up with two values for one state. capOneRow_ overwrites this with a
  // real verdict, or with 'Unable to run - no page text' where no page could
  // be captured at all.
  f[PF_F_RESULT]            = 'Not yet run';
  f[XS_F_UNITID]            = inst.unitid;
  f[XS_F_INST_LINK]         = [inst.unitid];
  f[XS_F_SOURCE]            = XS_SOURCE_VALUE;
  f[XS_F_SEED_URL]          = seedUrl;
  f[XS_F_SEED_CAT]          = seedCategoryLabel;
  f[XS_F_SEED_TEXT]         = String(pick.text || '').slice(0, 250);

  if (categoryLabel === 'Report Form') {
    f[RFL.linkedUrl]  = pick.url;
    f[RFL.linkedHost] = repickVendor_(pick.url, (pick.url + ' ' + pick.text).toLowerCase(), seedUrl);
    f[RFL.tier]        = repickTierLabel_(pick.why);   // pick.why holds the raw tier key on this path
  }
  // pick.confidence is deliberately NOT written -- Keyword confidence was
  // deleted on 2026-09-01. It stays on the pick object because xsDryRun's
  // "because:" line quotes it, which is a thing a person reads while
  // tuning the pass, not a value stored on a row.
  return { fields: f };
}

// -------------------------------------------------------------------------
// GUARDS AND BOOKKEEPING
// -------------------------------------------------------------------------

function xsRequireTarget_(targetKey) {
  const t = XS_TARGETS[targetKey];
  if (!t) {
    throw new Error('Unknown target "' + targetKey + '". Use one of: ' +
      Object.keys(XS_TARGETS).join(', '));
  }
  return t;
}

/**
 * Refuses to write until the three provenance fields exist.
 *
 * Not a formality. Airtable's create call takes typecast:true, and an
 * unknown field id fails the whole batch -- but an EMPTY string key would
 * quietly produce rows with no seed recorded, which is the one thing this
 * pass exists to capture. Better to stop with a readable message.
 */
function xsRequireFields_() {
  const missing = [];
  if (!XS_F_SEED_URL)  missing.push('XS_F_SEED_URL (Seed URL)');
  if (!XS_F_SEED_CAT)  missing.push('XS_F_SEED_CAT (Seed category)');
  if (!XS_F_SEED_TEXT) missing.push('XS_F_SEED_TEXT (Seed link text)');
  if (missing.length) {
    throw new Error(
      'Create these fields on Candidate URLs and paste their ids into ' +
      'CrossSeed.gs first: ' + missing.join(', ') + '. ' +
      'xsDryRun() works without them.');
  }
}

function xsReadStats_(targetKey) {
  const raw = PropertiesService.getScriptProperties().getProperty(XS_PROP_STATS + targetKey);
  if (!raw) return { created: 0, skipped: 0, unreadable: 0, seedsRead: 0, pdfSkipped: 0 };
  try { return JSON.parse(raw); }
  catch (e) { return { created: 0, skipped: 0, unreadable: 0, seedsRead: 0, pdfSkipped: 0 }; }
}

function xsWriteStats_(targetKey, stats) {
  PropertiesService.getScriptProperties()
    .setProperty(XS_PROP_STATS + targetKey, JSON.stringify(stats));
}

// -------------------------------------------------------------------------
// ZERO-ARGUMENT ENTRY POINTS, for the editor's Run dropdown
// -------------------------------------------------------------------------
// The Apps Script Run button calls the selected function with NO arguments
// and offers nowhere to type values, so xsRun('chtr') and
// xsDryRun('chtr', 10) cannot be started from it -- picking xsDryRun runs
// xsDryRun(undefined, undefined) and xsRequireTarget_ throws
// 'Unknown target "undefined"'. That is the guard working, not a bug.
//
// These live INSIDE this file on purpose. They were previously pasted on
// after the fact, and replacing the file wholesale silently removed them.

function xsDryRunReportForm10() { return xsDryRun('reportForm', 10); }
function xsDryRunReportForm30() { return xsDryRun('reportForm', 30); }
function xsDryRunChtr10()       { return xsDryRun('chtr', 10); }
function xsDryRunChtr30()       { return xsDryRun('chtr', 30); }
// hazingPolicy had reset and status wrappers but no run or dry-run ones, so
// it was the one target that could not be worked from the Run dropdown at
// all. Added 2026-08-29 for parity -- an entry point that exists for two of
// three targets is a trap, not a convenience.
function xsDryRunHazingPolicy10() { return xsDryRun('hazingPolicy', 10); }
function xsDryRunHazingPolicy30() { return xsDryRun('hazingPolicy', 30); }

function xsRunReportForm()      { return xsRun('reportForm'); }
function xsRunChtr()            { return xsRun('chtr'); }
function xsRunHazingPolicy()    { return xsRun('hazingPolicy'); }

// xsReset() has the same Run-dropdown problem as xsRun/xsDryRun did --
// no way to pass 'chtr' from the dropdown, so xsReset('chtr') is
// unrunnable from it. Unlike xsRun's wrappers, a reset wrapper carries no
// "one click creates hundreds of rows" risk -- it only rewinds a cursor --
// so all three are added, not just the one needed today.
function xsResetChtr()          { return xsReset('chtr'); }
function xsResetHazingPolicy()  { return xsReset('hazingPolicy'); }
function xsResetReportForm()    { return xsReset('reportForm'); }