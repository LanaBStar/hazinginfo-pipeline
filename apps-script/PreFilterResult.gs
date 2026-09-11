/**
 * HazingInfo Candidate URL Pipeline -- SitemapFinder.gs
 * PRODUCTION. Reads 50 States Database - Jan 2026, writes PAGES.
 * -----------------------------------------------------------------------
 * SELF-CONTAINED BY DESIGN. Everything this file needs is declared here,
 * with an SM_ prefix where LinkChecker.gs declares something similar. That
 * is deliberate: two versions of LinkChecker.gs exist in the wild and the
 * older one declares neither BROWSER_HEADERS nor an institution-URL field,
 * so depending on it makes this file's behaviour depend on which copy is
 * installed. Duplicating three constants under distinct names costs
 * nothing and removes the question.
 *
 * Apps Script treats every .gs file in a project as ONE shared global
 * scope. Redeclaring an existing name fails the whole project with
 * "already declared"; redefining an existing FUNCTION name does not error
 * at all -- the later one silently wins. Hence the prefixes throughout.
 *
 * FOUR SUBSYSTEMS, in the order a candidate URL moves through them:
 *
 *   1. SITEMAP FINDER -- for a category (Report Form / Hazing Policy /
 *      CHTR), pulls every 50 States record whose final URL field is blank,
 *      fetches the school's sitemap.xml, keyword-matches URL slugs, and
 *      CREATES CANDIDATE URL ROWS IN PAGES.
 *
 *   2. CANDIDATE PAGE CAPTURE -- fetches each candidate page and stores its
 *      text, content hash, contacts and structural signals.
 *
 *   3. REPORT FORM LINK PASS -- extracts outbound links, because 93% of
 *      these pages have no form of their own and link to a hosted one.
 *
 *   4. RE-PICK -- re-chooses the best linked form from links already
 *      stored, with no page fetches. Owns the link-ranking rules; the link
 *      pass calls into it rather than keeping a second copy.
 *
 * NO AI CREDITS USED ANYWHERE IN THIS FILE.
 *
 * -----------------------------------------------------------------------
 * CHANGED 2026-08-23: DISCOVERY WRITES CANDIDATE ROWS DIRECTLY.
 *
 * Discovery used to write its picks onto the 50 States record -- a top
 * candidate field, an alternates field, and a checked date, times three
 * categories -- and a separate "intake" stage read them back and created
 * the Candidate URLs rows. That stage is gone and so are those nine fields.
 *
 * The round-trip was pure cost. Alternates were serialised as
 * "[High] https://..." text lines and regex-parsed back out one stage
 * later, between two functions in this same file. Rank 1 had nowhere to
 * store its confidence, so it was RECOMPUTED from the URL afterwards --
 * which is why 370 rows carried a blank Keyword confidence until a
 * backfill ran. (Keyword confidence was deleted on 2026-09-01; see the
 * SM_CF_CONFIDENCE tombstone. Rank is now the only stored half.)
 * Now the rank and confidence settled during ranking are the
 * ones stored, and there is nothing to reconstruct.
 *
 * Deleted with the stage: pipelineStageIntake_, pipelineIntakeCategory_,
 * pipelineCandidateList_, pipelineNewRow_, pipelineConfidence_,
 * backfillRank1Confidence, testIntakeOnly, testCountCandidateRows_,
 * writeSitemapResultsBack_, PROP_PIPELINE_INTAKE_INDEX.
 *
 * KEPT ON PURPOSE, because CrossSeed.gs calls them: pipelineUrlKey_,
 * pipelineIntakeFlush_, pipelineExistingKeys_, INTAKE_CREATE_BATCH,
 * PIPELINE_CATEGORY_LABEL.
 * -----------------------------------------------------------------------
 */

// =========================================================================
// SHARED CONFIG
// =========================================================================

// ---- Institutions: read from PAGES, not from 50 States -----------------
// CHANGED 2026-08-23. Discovery used to read the 50 States base directly
// (appJbAvuFOxhWOID2 / tblI3LZvxRu4bgK3r). It now reads the Institutions
// table in PAGES, which is SYNCED from 50 States and therefore carries the
// same 1,483 schools and the same three confirmed-URL fields.
//
// WHY. Institutions and Candidate URLs now live in ONE base, so the skip
// gate in fetchBlankRecordsPage_ can be a server-side formula over a Count
// field. Across two bases it would have needed a second full read plus a
// code-side filter -- a second definition of "has candidates pending",
// free to drift from the first.
//
// This is a READ RELOCATION, NOT A CHANGE OF OWNERSHIP. Discovery has
// never written to 50 States: its only two touches were fetchBlankRecordsPage_
// and fetchRecordsByIds_, both reads, and since the intake stage was deleted
// it writes exclusively to Candidate URLs. 50 States remains the source of
// truth; Institutions is its mirror.
//
// ACCEPTED COST: sync lag. A URL confirmed in 50 States is not visible here
// until the next sync, so at worst discovery crawls a school answered
// minutes ago. That wastes one crawl and stores nothing, because dedup
// discards what it re-proposes.
//
// CONSEQUENCE FOR runSitemapForSpecificRecords(): the record IDs it takes
// are now PAGES Institutions record IDs, NOT 50 States record IDs. The two
// bases assign different IDs to the same school. UNITID is shared and is
// the safe way to identify a school across them.
const SM_INST_TABLE    = 'tblpgBmu7r8kQA6b5';   // Institutions (synced from 50 States)
const SM_F_INSTITUTION = 'fldHvefXrrPxibBsZ';
const SM_F_INST_URL    = 'fld5s03AW9U65Z34W';   // Institution URL
const SM_F_UNITID      = 'fldGREvzCIme6HXfl';   // UNITID

// ---- PAGES (production) ----
const PAGES_BASE_ID = 'appEvOdPi94MzZ6Db';      // PAGES
const CAND_TABLE_ID = 'tblIL5opnHj0lhvvg';      // Candidate URLs

// Candidate URLs fields the capture pass reads and writes.
const CF = {
  candidateUrl : 'fldzInwsPk3pI4PoT',
  category     : 'fld5QoBkGbSZNla35',
  fetchStatus  : 'fldhrl2Cfiiw8pAng',
  textFormat   : 'fldLy6R8b2TzUasSP',
  pageText     : 'fldUkA4YqkAQdDjbb',
  charCount    : 'fld3FjSXtg83PtdxR',
  truncated    : 'fld6oHEaNkjn4IQwX',
  contentHash  : 'fldiaSq4L7qr18Jku',
  capturedDate : 'fld2WAhvqnASCHM6X',
  signals      : 'fldX6P6WYvlbYyXmE'
};

// Candidate URLs fields written when a row is CREATED. Not in CF, which
// holds capture fields only.
const SM_CF_UNITID     = 'fldRicdqQxfBxUGBH';   // primary field
const SM_CF_INST_LINK  = 'fldhbnSdGI8PFQQc7';   // Institution, matched by value
const SM_CF_RANK       = 'fldwSwjflkrt86FKX';
// SM_CF_CONFIDENCE (Keyword confidence, fldkaqRQhLJrksecE) WAS HERE.
// REMOVED 2026-09-01, along with the field itself.
//
// It was never a second signal. Rank and confidence came from the SAME
// number: rankCandidates_ scores a URL slug (+3 per primary keyword, +1 per
// secondary), sorts by that score, and Rank is the position in that sort
// while scoreToConfidence_ is the same score put in three buckets. Rank 1
// always held the top score, so the field restated the ordering it sat next
// to. Nothing read it -- not the AI field, not the pre-filter, not any
// script -- and it was not comparable across sources either: cross-seed
// scored anchor text through a different function and wrote no Rank at all,
// while manual rows had neither.
//
// The bucket survives as a RUN-REPORT LABEL only. scoreToConfidence_ still
// feeds result.outcome and the High/Medium/Low counts in the discovery
// dashboard, which are about one run rather than about a row. That is a
// summary a person reads once, not a value stored on 787 records.
//
// DO NOT RE-ADD A FIELD WRITE HERE without deciding what would read it.
const SM_CF_SOURCE     = 'fldDgMOzWYGMEL4Xd';

// ---- Outbound report link fields (section 3) ----
const RFL = {
  linkedUrl  : 'fldzqbb7N1ZLKbW9P',
  linkedHost : 'fldZRQpGFzhIgK3Qm',
  outbound   : 'fldKvwMwS5ZG9XCfu',
  tier       : 'fld6eFtzYWu0AQ2br'   // Form link tier -- added 2026-08-27
};

// Maps repickPick_'s internal tier keys onto the numbered Form link tier
// vocabulary (Data Dictionary, added 2026-08-27). The internal keys stay
// exactly as repickPick_ has always used them -- only the field-write site
// translates -- so none of repickPick_'s own tier-ordering logic or its
// years of comments referencing these exact strings need to change.
const RP_TIER_LABELS = {
  'vendor form, hazing':     '1 - Vendor form, hazing named',
  'vendor form, incident':   '2 - Vendor form, general incident',
  'vendor form, unlabelled': '3 - Vendor form, unlabelled',
  'own site, hazing form':   '4 - School site, hazing form',
  'outside page, hazing':    '5 - Outside site, hazing form'
};
// RETURNS null, NOT '', WHEN THERE IS NO TIER. Every write site below uses
// typecast:true, and an empty STRING sent to a singleSelect does not clear
// the cell -- Airtable mints a choice whose name is the empty string and
// selects it. That is what put a nameless sixth option on Form link tier and
// set it on 32 Report Form rows, every one of them a row with no linked form
// at all (found 2026-09-01, from a row whose revision history showed the
// value written by the link pass alongside '(no report-like outbound links)').
// The damage is not cosmetic: isEmpty/isNotEmpty treat those cells as
// FILLED, so a view or script looking for rows that still need a tier skips
// them. null is what actually clears a singleSelect. This is the same hazard
// the PIPELINE_CATEGORY_LABEL comment describes for Category.
function repickTierLabel_(tier) {
  return RP_TIER_LABELS[tier] || null;
}

// ---- How we identify ourselves to the sites we read ---------------------
// UrlFetchApp's default User-Agent identifies as Google and a lot of
// university WAFs reject it outright with a 403. In the August 2026 review
// data that was 118 of 195 "Needs Review" flags, of which one was a
// genuinely dead link -- so the default UA was manufacturing false alarms
// at roughly a 99:1 rate. Browser-shaped so those WAFs answer, with a
// HazingInfo product token and contact URL appended (well-formed per RFC
// 7231) so any admin reading their logs can see who this is.
//
// This reads public pages at a few requests per second. It does not, and
// must not, be used to get past logins or paywalls.
const SM_BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 ' +
    'HazingInfoLinkChecker/1.0 (+https://hazinginfo.org)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// =========================================================================
// 1. SITEMAP FINDER
// =========================================================================

const SITEMAP_RECORDS_PER_RUN = 15;   // 50 States records pulled per call
const MAX_SITEMAP_URLS = 1500;        // cap per sitemap file
const MAX_CHILD_SITEMAPS = 5;         // cap on child sitemaps for index files
const MAX_CANDIDATES_KEPT = 5;        // ranked candidates kept per school
const CRAWL_POLITENESS_DELAY_MS = 250;
const INTAKE_CREATE_BATCH = 10;       // Airtable's cap per create call

// Resumable progress, suffixed per category so switching categories
// mid-review does not collide with an in-progress run of another.
const PROP_SITEMAP_OFFSET_PREFIX = 'sitemapOffset_';
const PROP_SITEMAP_SUMMARY_PREFIX = 'sitemapSummary_';
const PROP_SITEMAP_PROCESSED_PREFIX = 'sitemapProcessed_';
const PROP_SITEMAP_WRITE_ERRORS_PREFIX = 'sitemapWriteErrors_';

function smEmptySummary_() {
  return {
    High: 0, Medium: 0, Low: 0,
    noKeywordMatch: 0, noSitemapFound: 0, noInstitutionUrl: 0, noUnitid: 0
  };
}

// URLs containing any of these are rejected outright even if they also
// match a category keyword: donor/fundraising, HR, EHS documents unrelated
// to hazing, training material, and departments that merely contain words
// like "report" or "conduct".
const GLOBAL_EXCLUSION_KEYWORDS = [
  'annual-report', 'give/', 'giving', 'donate', 'donor', 'alumni',
  'employee', 'human-resources', '/hr/', 'athletics', 'admissions/',
  'careers', 'jobs/', 'foundation', 'parent-fund', 'financial-aid',
  'scholarship', 'commencement', 'newsroom', 'press-release',
  'bloodborne', 'pathogen', 'osha', 'workplace-injury', 'chemical-spill',
  'environmental-health', 'ehs/', 'training',
  '/news/', '/blog/', '/events/', '/calendar/',
  'login', 'signin', 'sign-in', 'logout',
  // ADDED 2026-08-27. Third-party resources that repeatedly scored as
  // false-positive CHTR/Hazing Policy candidates across unrelated schools
  // -- clerycenter.org and stophazing.org are general nonprofit awareness
  // sites, never a specific school's own document. .gov is broader on
  // purpose: no legitimate CHTR/Hazing Policy/Report Form page is ever
  // hosted on a government domain -- colleges use .edu, even public ones
  // -- so this is a correct general rule, not a narrow patch for the two
  // state-legislature statute pages that surfaced tonight.
  'clerycenter.org', 'stophazing.org', '.gov'
];

// Terms short enough to appear inside unrelated words, matched on word
// boundaries. Real examples this fixes: 'chtr' matched inside techtrek,
// peachtree, techtronic and murchtricia; 'conduct' inside conductors and
// semiconductor. Every other keyword is long enough that a bare substring
// match is safe, and boundary-matching them all would reject legitimate
// hits like hazing-policy.pdf where the term runs into punctuation.
const BOUNDARY_SENSITIVE_TERMS = ['chtr', 'conduct'];

// An image can never be a valid CHTR/Hazing Policy/Report Form candidate --
// added 2026-08-27 after a stophazing.org poster PNG got fetched as HTML
// text (no image-type check existed anywhere upstream) and passed the
// pre-filter as 95,000+ "characters" of garbage. Rejected at discovery/
// cross-seed time so the row is never created at all, not just handled
// gracefully once it reaches capture -- same principle as the login/
// clerycenter.org/stophazing.org/.gov exclusions above. Anchored to the
// end of the URL (like the .pdf check elsewhere), not a GLOBAL_EXCLUSION_
// KEYWORDS-style bare substring, since a file extension should only match
// as an actual extension.
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?)(\?|$)/i;

function matchesKeyword_(slug, term) {
  if (BOUNDARY_SENSITIVE_TERMS.indexOf(term) === -1) {
    return slug.indexOf(term) !== -1;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '($|[^a-z0-9])').test(slug);
}

// Category definitions: the 50 States field that says "this school still
// needs one", plus the keyword scoring rules.
//
// THE REPORT FORM LIST IS DELIBERATELY BROAD, and that was tested rather
// than assumed (2026-08-22). The standing suspicion was that bare 'hazing'
// and the Greek-life terms were admitting policy pages and should be cut.
// Measured: 48 of 231 successful linked-form finds have a candidate URL
// containing 'hazing' and no report/incident/complaint/form word at all,
// and 13 more come from Greek-life pages -- 27% of everything found. The
// reason is structural: 93% of Report Form candidates have no form of
// their own, so this category finds PAGES THAT POINT AT a form, and those
// are topic pages by nature. A URL keyword cannot tell a topic page that
// links to a form from one that doesn't. Only the outbound-link evidence
// can, and that is what the link pass collects. The list stays broad and
// the filtering happens after capture.
// THE GATE READS THE COMPLIANCE FIELD. Changed 2026-09-09. The history
// matters, because this is the third setting and each one was correct when
// it was made -- this is not a flip-flop.
//
// 2026-08-26, first: a two-field OR (compliance blank AND located blank).
// located_* then held only the 10/20 below-standard rows, so gating on it
// alone would have re-discovered every already-compliant school.
//
// 2026-08-26, same day: simplified to located_* alone, once Lana
// backfilled located_hazing_policy_url / located_report_form_url from the
// compliance fields on 50 States. That made located_* a true superset of
// compliance -- verified live in both bases, zero exceptions either
// direction -- so one field was enough. The note written here at the time
// named its own expiry condition out loud: it stays true ONLY IF the
// promote step writes both fields together for every 'Confirmed -
// promote'.
//
// 2026-09-09, now: that condition has arrived. The promote step's spec
// deliberately does NOT write both together. A candidate carrying
// below-standard terms writes the RECORD field only (located_* /
// chtr_index_url) and leaves compliance blank; only a clean candidate
// writes both. So located_* stops being a superset the first time promote
// runs, and a gate on located_* would retire a school the instant any URL
// landed there -- including a URL we ourselves judged below standard.
//
// That is backwards. A below-standard page is a school that still has no
// compliant one, and it is exactly the school discovery should keep
// searching. Gating on compliance restores the plain reading: BLANK
// COMPLIANCE MEANS THIS SCHOOL STILL NEEDS A PAGE THAT MEETS THE
// STANDARD, whatever else we have on file for it.
//
// Measured before the change (2026-09-09, live): schools with a record URL
// and blank compliance -- Hazing Policy 19, Report Form 23, CHTR 47. Those
// are the schools this re-opens. It is a small, one-off widening, not a
// full re-sweep.
//
// WHAT STOPS THIS RE-PROPOSING THE SAME REJECTED URLS FOREVER: nothing in
// this block, and nothing needs to. writeSitemapCandidates_ dedupes every
// proposal against the existing Candidate URLs rows for that school and
// category, REJECTED ROWS INCLUDED, so a URL a reviewer threw out is never
// recreated while its un-rejected alternates still come through. Read that
// function's header before changing anything here -- including its
// corollary, that DELETING a rejected row un-blocks the URL. Reject,
// don't delete.
//
// Each blankFields line below also names its paired record field, because
// the promote step writes both and a reader here will want to know which
// is which.
const CATEGORIES = {
  reportForm: {
    key: 'reportForm',
    label: 'Report Form',
    blankFields: ['fldIrTzWzi87nD7EU'],   // Report Form (COMPLIANCE). Record field: located_report_form_url fldeBRiCU8dnIKsYk
    pendingCountField: 'flduSxLVwgo24QZAc',
    primaryKeywords: ['hazing-report', 'report-hazing', 'hazing', 'incident-report', 'reportanincident', 'title-ix-report', 'title-ix-reporting'],
    secondaryKeywords: ['report', 'conduct', 'title-ix', 'titleix', 'incident', 'complaint', 'greek-life', 'fraternity', 'sorority', 'student-conduct']
  },
  hazingPolicy: {
    key: 'hazingPolicy',
    label: 'Hazing Policy',
    blankFields: ['fldD9gEpDcw2l35II'],   // Hazing Policy (COMPLIANCE). Record field: located_hazing_policy_url fldKyIAd65Yfn5g0V
    pendingCountField: 'fldJQyUvlr97N5asf',
    primaryKeywords: ['hazing-policy', 'anti-hazing', 'hazing-prevention', 'hazing'],
    secondaryKeywords: ['policy', 'student-handbook', 'code-of-conduct', 'conduct-code', 'handbook', 'greek-life'],
    // A URL containing "report" almost always belongs to Report Form
    // instead -- "hazing-report.pdf" is an incident report, not a policy.
    // Without this, the bare "hazing" primary keyword pulls Report Form's
    // own documents in here too.
    excludeKeywords: ['report']
  },
  chtr: {
    key: 'chtr',
    label: 'CHTR Index URL',
    blankFields: ['fldGJPC0iyuPcWtlK'],   // Transparency Report (COMPLIANCE). Record field: chtr_index_url fldqQrSD83OVoteFx
    pendingCountField: 'fldvBRkcCPToNh26v',
    // "hazing" was previously secondary-only here, which meant real
    // on-domain matches like /policies/hazing.php never accumulated
    // enough points to qualify. Matching Hazing Policy's treatment: bare
    // "hazing" is primary. The spelled-out phrase variants are there
    // because schools name these pages inconsistently.
    primaryKeywords: ['campus-hazing-transparency', 'hazing-transparency', 'chtr', 'hazing-transparency-report', 'stop-campus-hazing', 'publication-of-hazing', 'hazing-incidents', 'hazing-statistics', 'hazing'],
    secondaryKeywords: ['transparency', 'transparency-report', 'disclosure', 'compliance'],
    // ADDED 2026-08-24, for rankCandidatesByBlob_ only (cross-seed) -- see
    // that function's header. rankCandidates_ (sitemap discovery) ignores
    // this field entirely and is unaffected.
    //
    // These six are specific enough that a match means "this page IS the
    // CHTR index," not merely "this page is about hazing." The other three
    // primaryKeywords -- 'hazing-incidents', 'hazing-statistics', bare
    // 'hazing' -- describe CONTENT a transparency report has, which a
    // dated one-off PDF snapshot or an off-site advocacy page has too.
    // Confirmed against real cross-seed output 2026-08-24: Whittier's #1
    // pick was a dated "June 2026" PDF report (bare 'hazing' only) tying a
    // real index page on the same seed, and Old Westbury's seed proposed
    // hazingpreventionnetwork.org/state-hazing-laws/ -- an external
    // advocacy site, not the school's own page, qualifying purely because
    // 'hazing' sits in the PATH (the existing host-vs-path fix only
    // catches a hostname coincidence like stophazing.org; it does not
    // catch 'hazing' appearing topically in an off-site PATH).
    strongKeywords: ['campus-hazing-transparency', 'hazing-transparency', 'chtr', 'hazing-transparency-report', 'stop-campus-hazing', 'publication-of-hazing']
  }
};

// The Category option names differ between the two bases: this file calls
// CHTR "CHTR Index URL", the Candidate URLs table calls it "CHTR". Mapped
// explicitly rather than reusing CATEGORIES[key].label, because creates
// use typecast:true -- an unmatched string would silently CREATE a fourth
// option called "CHTR Index URL" and split the category in two.
const PIPELINE_CATEGORY_LABEL = {
  chtr:         'CHTR',
  reportForm:   'Report Form',
  hazingPolicy: 'Hazing Policy'
};

// -------------------------------------------------------------------------
// ENTRY POINTS (called from the web page)
// -------------------------------------------------------------------------
function runOrResumeSitemapBatch(categoryKey) {
  const category = CATEGORIES[categoryKey];
  if (!category) throw new Error('Unknown category: ' + categoryKey);

  const props = PropertiesService.getScriptProperties();
  const offsetKey = PROP_SITEMAP_OFFSET_PREFIX + categoryKey;
  const offset = props.getProperty(offsetKey);

  if (!offset) {
    props.setProperty(PROP_SITEMAP_SUMMARY_PREFIX + categoryKey,
      JSON.stringify(smEmptySummary_()));
    props.setProperty(PROP_SITEMAP_PROCESSED_PREFIX + categoryKey, '0');
    props.deleteProperty(PROP_SITEMAP_WRITE_ERRORS_PREFIX + categoryKey);
  }

  return runNextSitemapBatch_(category, offset || null);
}

function resetSitemapProgress(categoryKey) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_SITEMAP_OFFSET_PREFIX + categoryKey);
  props.deleteProperty(PROP_SITEMAP_SUMMARY_PREFIX + categoryKey);
  props.deleteProperty(PROP_SITEMAP_PROCESSED_PREFIX + categoryKey);
  props.deleteProperty(PROP_SITEMAP_WRITE_ERRORS_PREFIX + categoryKey);
  return { reset: true };
}

// -------------------------------------------------------------------------
// MAIN BATCH LOGIC
// -------------------------------------------------------------------------
function runNextSitemapBatch_(category, startOffset) {
  const pat = capPat_();
  const props = PropertiesService.getScriptProperties();
  const categoryKey = category.key;

  const page = fetchBlankRecordsPageWithRecovery_(pat, category, startOffset, props);
  const results = [];

  for (let i = 0; i < page.records.length; i++) {
    results.push(processRecord_(page.records[i], category));
    Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
  }

  const write = writeSitemapCandidates_(pat, category, results);

  const cumulative = JSON.parse(props.getProperty(PROP_SITEMAP_SUMMARY_PREFIX + categoryKey) || '{}');
  mergeSitemapSummary_(cumulative, results);
  props.setProperty(PROP_SITEMAP_SUMMARY_PREFIX + categoryKey, JSON.stringify(cumulative));

  const cumulativeWriteErrors =
    JSON.parse(props.getProperty(PROP_SITEMAP_WRITE_ERRORS_PREFIX + categoryKey) || '[]')
      .concat(write.writeErrors);
  props.setProperty(PROP_SITEMAP_WRITE_ERRORS_PREFIX + categoryKey,
    JSON.stringify(cumulativeWriteErrors));

  const processedSoFar =
    parseInt(props.getProperty(PROP_SITEMAP_PROCESSED_PREFIX + categoryKey) || '0', 10) +
    page.records.length;
  props.setProperty(PROP_SITEMAP_PROCESSED_PREFIX + categoryKey, String(processedSoFar));

  const done = !page.nextOffset;
  if (done) props.deleteProperty(PROP_SITEMAP_OFFSET_PREFIX + categoryKey);
  else props.setProperty(PROP_SITEMAP_OFFSET_PREFIX + categoryKey, page.nextOffset);

  return {
    done: done,
    category: categoryKey,
    categoryLabel: category.label,
    recovered: page.recovered,
    recordsProcessedThisBatch: page.records.length,
    cumulativeProcessed: processedSoFar,
    rowsCreatedThisBatch: write.created,
    rowsAlreadyPresent: write.skipped,
    cumulativeSummary: cumulative,
    writeErrors: cumulativeWriteErrors,
    sampleResults: results.map(function (r) {
      return {
        institution: r.institution,
        topCandidate: r.topCandidateUrl,
        confidence: r.topCandidateConfidence
      };
    })
  };
}

// ---- Fetch up to maxRecords blank-field records starting at startOffset ----
// Recovers from an expired Airtable pagination offset. If a batched run
// sits idle (closed tab, long gap between clicks), Airtable invalidates the
// resume token and the list call fails with
// LIST_RECORDS_ITERATOR_NOT_AVAILABLE. Without this, that failure repeats
// forever -- every click retries the same dead offset.
//
// Restarting from page 1 is only half the fix: the cumulative counters and
// summary must reset too, or a mid-run recovery double-counts every school
// from the partial sweep before the expiry, and "processed so far" climbs
// past the true population. Creating rows is idempotent (dedupe), so
// re-covering ground costs fetches, not duplicates.
function fetchBlankRecordsPageWithRecovery_(pat, category, startOffset, props) {
  try {
    const page = fetchBlankRecordsPage_(pat, category, startOffset, SITEMAP_RECORDS_PER_RUN);
    page.recovered = false;
    return page;
  } catch (err) {
    const expiredOffset = startOffset &&
      String(err.message).indexOf('LIST_RECORDS_ITERATOR_NOT_AVAILABLE') !== -1;
    if (!expiredOffset) throw err;

    Logger.log('Saved resume point expired -- restarting ' + category.label +
      ' from the beginning (processed count and summary reset too).');
    props.deleteProperty(PROP_SITEMAP_OFFSET_PREFIX + category.key);
    props.deleteProperty(PROP_SITEMAP_WRITE_ERRORS_PREFIX + category.key);
    props.setProperty(PROP_SITEMAP_PROCESSED_PREFIX + category.key, '0');
    props.setProperty(PROP_SITEMAP_SUMMARY_PREFIX + category.key,
      JSON.stringify(smEmptySummary_()));

    const page = fetchBlankRecordsPage_(pat, category, null, SITEMAP_RECORDS_PER_RUN);
    page.recovered = true;
    return page;
  }
}

// Joins one or more field ids into an Airtable formula clause requiring
// ALL of them blank, e.g. ['a','b'] -> '{a} = "", {b} = ""' -- meant to
// sit inside AND(...). Added 2026-08-26 for CATEGORIES.blankFields (see
// its header comment); a single-element array (CHTR) behaves exactly like
// the old finalUrlField check it replaces.
function smBlankClause_(fieldIds) {
  return fieldIds.map(function (id) { return '{' + id + '} = ""'; }).join(', ');
}

function fetchBlankRecordsPage_(pat, category, startOffset, maxRecords) {
  let records = [];
  let offset = startOffset || null;
  const fieldIds = [SM_F_INSTITUTION, SM_F_INST_URL, SM_F_UNITID];
  const fieldsParam = fieldIds.map(function (f) { return 'fields[]=' + f; }).join('&');
  // THE DISCOVERY GATE. Every one of category.blankFields is blank, AND
  // nothing is already waiting for a reviewer. The pending-review clause
  // was added 2026-08-23: re-crawling a school whose candidates are
  // unreviewed can only re-propose URLs already in the table, which dedup
  // then discards -- a whole sitemap fetch for nothing.
  //
  // blankFields checks the LOCATED field for every category (2026-08-26)
  // -- chtr_index_url, located_hazing_policy_url, located_report_form_url
  // -- never the compliance field. See CATEGORIES' header comment for why
  // this is safe: located_* is now a verified superset of compliance for
  // all three categories, so "already answered" needs only one field, the
  // same way it always has for CHTR.
  //
  // Pending-review count fields carry their conditions in the Airtable UI,
  // which the API cannot read or write. An unconditioned count silently
  // counts every candidate and would skip schools that should be crawled,
  // with no error.
  const filterFormula = encodeURIComponent(
    'AND(' + smBlankClause_(category.blankFields) + ', {' + category.pendingCountField + '} = 0)');
  const pageSize = Math.min(100, maxRecords);

  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + SM_INST_TABLE +
      '?filterByFormula=' + filterFormula +
      '&pageSize=' + pageSize +
      '&returnFieldsByFieldId=true&' + fieldsParam;
    if (offset) url += '&offset=' + offset;

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable list error: ' + resp.getContentText());
    }
    const json = JSON.parse(resp.getContentText());
    records = records.concat(json.records);
    offset = json.offset || null;
    Utilities.sleep(210);   // stay under 5 req/sec
  } while (offset && records.length < maxRecords);

  return { records: records.slice(0, maxRecords), nextOffset: offset };
}

// ---- Process a single record: discover sitemap, rank candidates ----
function processRecord_(record, category) {
  const institutionName = record.fields[SM_F_INSTITUTION] || '(unknown)';
  const unitid = String(record.fields[SM_F_UNITID] || '').trim();
  let institutionUrl = record.fields[SM_F_INST_URL] || '';

  const result = {
    id: record.id,
    unitid: unitid,
    institution: institutionName,
    candidates: [],
    topCandidateUrl: '',
    topCandidateConfidence: null,
    outcome: null
  };

  // No UNITID means the row cannot be filed against a school -- the
  // Institution link is matched by value. Counted separately from
  // noKeywordMatch on purpose: one is a problem with our data, the other
  // is a finding about the school's website.
  if (!unitid) { result.outcome = 'noUnitid'; return result; }
  if (!institutionUrl) { result.outcome = 'noInstitutionUrl'; return result; }

  institutionUrl = normalizeBaseUrl_(institutionUrl);

  let sitemapUrls = [];
  try { sitemapUrls = discoverSitemapUrls_(institutionUrl); }
  catch (err) { sitemapUrls = []; }

  if (sitemapUrls.length === 0) { result.outcome = 'noSitemapFound'; return result; }

  const ranked = rankCandidates_(sitemapUrls, category);
  if (ranked.length === 0) { result.outcome = 'noKeywordMatch'; return result; }

  // Rank and confidence are both settled HERE, at the moment of ranking,
  // and stored as-is. That is the whole point of writing rows directly:
  // nothing downstream reconstructs either from a serialised text field.
  result.candidates = ranked.slice(0, MAX_CANDIDATES_KEPT).map(function (c, i) {
    return { url: c.url, rank: i + 1, confidence: scoreToConfidence_(c.score) };
  });

  result.topCandidateUrl = result.candidates[0].url;
  result.topCandidateConfidence = result.candidates[0].confidence;
  result.outcome = result.topCandidateConfidence;
  return result;
}

// ---- Sitemap discovery ----
function normalizeBaseUrl_(rawUrl) {
  let url = String(rawUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

function discoverSitemapUrls_(baseUrl) {
  let sitemapLocations = [baseUrl + '/sitemap.xml'];
  sitemapLocations = sitemapLocations.concat(getSitemapsFromRobotsTxt_(baseUrl));

  const allUrls = [];
  const seenSitemaps = {};

  for (let i = 0; i < sitemapLocations.length; i++) {
    const loc = sitemapLocations[i];
    if (seenSitemaps[loc]) continue;
    seenSitemaps[loc] = true;

    const xml = fetchXmlSafely_(loc);
    if (!xml) continue;

    if (xml.indexOf('<sitemapindex') !== -1) {
      const childSitemaps = extractLocs_(xml).slice(0, MAX_CHILD_SITEMAPS);
      for (let j = 0; j < childSitemaps.length; j++) {
        const childXml = fetchXmlSafely_(childSitemaps[j]);
        if (!childXml) continue;
        Array.prototype.push.apply(allUrls, extractLocs_(childXml));
        if (allUrls.length >= MAX_SITEMAP_URLS) break;
      }
    } else {
      Array.prototype.push.apply(allUrls, extractLocs_(xml));
    }
    if (allUrls.length >= MAX_SITEMAP_URLS) break;
  }
  return allUrls.slice(0, MAX_SITEMAP_URLS);
}

function getSitemapsFromRobotsTxt_(baseUrl) {
  let text = '';
  try {
    const response = UrlFetchApp.fetch(baseUrl + '/robots.txt',
      { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() === 200) text = response.getContentText();
  } catch (err) { return []; }

  const matches = [];
  text.split('\n').forEach(function (line) {
    const trimmed = line.trim();
    if (/^sitemap:/i.test(trimmed)) {
      const sitemapUrl = trimmed.replace(/^sitemap:/i, '').trim();
      if (sitemapUrl) matches.push(sitemapUrl);
    }
  });
  return matches;
}

function fetchXmlSafely_(url) {
  try {
    const response = UrlFetchApp.fetch(url,
      { muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true });
    if (response.getResponseCode() !== 200) return null;
    const contentText = response.getContentText();
    if (contentText.indexOf('<') === -1) return null;
    return contentText;
  } catch (err) { return null; }
}

function extractLocs_(xml) {
  const locs = [];
  const regex = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) locs.push(match[1].trim());
  return locs;
}

// ---- Keyword matching & scoring ----
function rankCandidates_(urls, category) {
  const scored = [];
  const exclusions = GLOBAL_EXCLUSION_KEYWORDS.concat(category.excludeKeywords || []);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const slug = url.toLowerCase();

    if (IMAGE_EXTENSION_PATTERN.test(url)) continue;

    let excluded = false;
    for (let e = 0; e < exclusions.length; e++) {
      if (slug.indexOf(exclusions[e]) !== -1) { excluded = true; break; }
    }
    if (excluded) continue;

    let score = 0, primaryMatches = 0, secondaryMatches = 0;
    for (let p = 0; p < category.primaryKeywords.length; p++) {
      if (matchesKeyword_(slug, category.primaryKeywords[p])) { score += 3; primaryMatches++; }
    }
    for (let s = 0; s < category.secondaryKeywords.length; s++) {
      if (matchesKeyword_(slug, category.secondaryKeywords[s])) { score += 1; secondaryMatches++; }
    }

    if (primaryMatches >= 1 || secondaryMatches >= 2) scored.push({ url: url, score: score });
  }

  scored.sort(function (a, b) {
    return (b.score !== a.score) ? b.score - a.score : a.url.length - b.url.length;
  });

  const deduped = [];
  const seen = {};
  for (let i = 0; i < scored.length; i++) {
    const key = scored[i].url.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    deduped.push(scored[i]);
  }
  return deduped;
}

// A version of matchesKeyword_ for natural-language link text rather than
// a URL slug. See rankCandidatesByBlob_ for why this exists and where its
// boundary-matching differs from matchesKeyword_.
function matchesKeywordText_(blob, term) {
  const words = term.split('-').map(function (w) {
    return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const pattern = '(^|[^a-z0-9])' + words.join('[\\s-]+') + '($|[^a-z0-9])';
  return new RegExp(pattern).test(blob);
}

// Tally helper: how many of `keywords` match `text`, using the given
// matcher function. Used with two DIFFERENT matchers below -- see
// rankCandidatesByBlob_.
function keywordTally_(text, keywords, matcher) {
  let n = 0;
  for (let i = 0; i < keywords.length; i++) {
    if (matcher(text, keywords[i])) n++;
  }
  return n;
}

// Same idea as keywordTally_ but returns WHICH terms matched, not just the
// count -- rankCandidatesByBlob_ needs the terms themselves to weight a
// strongKeywords hit differently from an ordinary primary hit. Added
// 2026-08-24 alongside strongKeywords; keywordTally_ itself is untouched
// and still used everywhere a count is all that's needed.
function keywordHits_(text, keywords, matcher) {
  const hits = [];
  for (let i = 0; i < keywords.length; i++) {
    if (matcher(text, keywords[i])) hits.push(keywords[i]);
  }
  return hits;
}

// Scores a set of matched primary-keyword hits: 5 points for a term in
// category.strongKeywords, 3 for any other primary term -- was a flat 3
// per hit before 2026-08-24. When strongList is empty (every category
// except CHTR, today) every hit scores 3, so this is a no-op for them.
// The raw number is still never shown to a human (see scoreToConfidence_
// below) -- only the ranking ORDER and the High/Medium/Low bucket it lands
// in are meant to be stable.
function weightedScore_(hits, strongList) {
  let score = 0;
  for (let i = 0; i < hits.length; i++) {
    score += (strongList.length && strongList.indexOf(hits[i]) !== -1) ? 5 : 3;
  }
  return score;
}

// The part of a URL after the host -- path, query, fragment. Used to keep
// an off-site keyword match honest: 'hazing' inside cm.maxient.com/chtr.php
// names a specific document (the path); 'hazing' inside stophazing.org
// names an organization (the host itself). See rankCandidatesByBlob_.
function urlPathOnly_(url) {
  return String(url || '').replace(/^https?:\/\/[^\/]+/i, '').toLowerCase();
}

/**
 * Same CATEGORIES keyword lists as rankCandidates_, same primary (+3) /
 * secondary (+1) weights -- but matched against a link's URL AND its own
 * anchor text, not the URL slug alone. A SIBLING to rankCandidates_, not a
 * replacement: rankCandidates_ stays exactly as it is because its only
 * other caller is sitemap discovery, scoring bare URLs pulled from a
 * sitemap.xml, which has no anchor text to give it.
 *
 * QUALIFICATION HAS TWO GATES, and this went through two rounds of test
 * failures to get right -- both worth keeping, because both will look
 * like an unrelated bug to whoever touches this next without reading this.
 *
 *   1. THE URL. On-site, this is exactly rankCandidates_'s rule, against
 *      the full URL, using matchesKeyword_ itself (not the boundary-
 *      tolerant text matcher below -- an earlier draft used it here too,
 *      which is subtly stricter than matchesKeyword_ for every term
 *      except 'chtr' and 'conduct', and broke the "on-site behaves exactly
 *      like rankCandidates_" guarantee this comment makes).
 *
 *      OFF-SITE, the same match is required, but ONLY AGAINST THE PATH,
 *      never the bare host. Found by test, not by design: rankCandidates_
 *      has ALWAYS matched 'hazing' as a raw substring anywhere in the URL,
 *      including inside a hostname -- and that was always safe, because
 *      rankCandidates_'s only caller (sitemap discovery) only ever scores
 *      URLs off a school's OWN sitemap.xml, so every candidate was already
 *      same-site by construction and a hostname coincidence could never
 *      arise. Cross-seed is the first caller that ever hands it a URL
 *      that isn't guaranteed same-site, and the very first 30-school dry
 *      run surfaced the case: stophazing.org, the national awareness
 *      nonprofit, qualified as a CHTR candidate because 'hazing' sits
 *      inside its hostname -- not because anything on the page said it was
 *      a school's own transparency report. cm.maxient.com/chtr.php must
 *      still qualify off-site (72 known vendor CHTR URLs work exactly
 *      this way), and the difference is real: 'chtr' there names a
 *      specific document, in the PATH; 'hazing' in stophazing.org names an
 *      organization, in the HOST. Restricting off-site matching to the
 *      path keeps the first and drops the second.
 *
 *   2. THE LINK TEXT. If the URL (by the rule above) does not qualify and
 *      only the anchor text pushes it over the line, matched with
 *      matchesKeywordText_ against url + text (prose has no slug
 *      structure to lean on, hence its own boundary logic), the link must
 *      ALSO be sameSite. Verified by test: without this, a link to
 *      congress.gov whose anchor text reads "Stop Campus Hazing Act"
 *      scores as a CHTR candidate purely because that is the Act's name
 *      and 'stop-campus-hazing' is a primary keyword. A URL slug almost
 *      never contains a citation of a law by name; free-flowing anchor
 *      text routinely does. Same shape of problem tier 6 hit for Report
 *      Form (topical language off-site, nothing to say the page IS the
 *      document rather than ABOUT the topic), same shape of fix.
 *
 * Both gates fail closed rather than open: an off-site link whose only
 * signal is its hostname, or whose only signal is on-topic text, is
 * missed rather than wrongly proposed. Accepted -- a miss is invisible, a
 * false positive is a row a person has to reject by hand.
 *
 * EXCLUSIONS (GLOBAL_EXCLUSION_KEYWORDS + category.excludeKeywords) stay
 * URL-ONLY, exactly as in rankCandidates_ -- they mark what KIND of page a
 * URL is (an HR page, a giving page, a training page), which is a property
 * of the URL, not something a link's own on-topic text should override.
 * 'training' is on the global list to keep out OSHA/workplace-safety
 * pages; "Hazing Prevention Training" is a real, on-topic link whose text
 * contains that exact word, and testing exclusions against the blob would
 * silently throw it out.
 *
 * UPDATED 2026-08-24, THREE MORE CHANGES, all from reading the actual
 * 45-row CHTR cross-seed output rather than trusting the 0-for-10 dry run
 * was fully explained by the text-scoring fix above. category.strongKeywords
 * (CHTR only, today -- see CATEGORIES) marks the terms specific enough to
 * mean "this page IS the index," as opposed to a primary term like bare
 * 'hazing' that only means "this page is ABOUT hazing," which a dated
 * report snapshot or an off-site advocacy page satisfies just as easily:
 *
 *   1. SCORING. A strongKeywords hit now scores 5, an ordinary primary hit
 *      still scores 3 (was: flat 3 for either). Fixes Whittier: its #1
 *      cross-seed pick was a dated "June 2026" PDF matching only bare
 *      'hazing', which TIED a genuine same-seed index page that also only
 *      matched bare 'hazing' in its slug -- weighting breaks that tie in
 *      the index page's favor whenever a stronger term is available.
 *
 *   2. OFF-SITE QUALIFICATION now requires a strongKeywords hit
 *      specifically, when the category defines any -- not just any
 *      primary hit against the path. Fixes Old Westbury: its seed
 *      proposed hazingpreventionnetwork.org/state-hazing-laws/, an
 *      external advocacy site, because 'hazing' sits in the PATH. The
 *      existing off-site path-vs-host restriction above already stops a
 *      HOSTNAME coincidence (stophazing.org); it does nothing about
 *      'hazing' appearing topically in an off-site PATH, which is exactly
 *      this case. cm.maxient.com/chtr.php still qualifies off-site --
 *      'chtr' is a strongKeywords term.
 *
 *   3. THE SEED CAN QUALIFY AS ITS OWN ANSWER AGAIN, but ONLY on a
 *      strongKeywords hit in its own URL OR its own page body text -- see
 *      Gate 0 below. Until now xsPickByKeyword_ excluded isSeed links
 *      outright (added 2026-08-23, see that file), because bare 'hazing'
 *      is primary for BOTH CHTR and Hazing Policy, so every seed scored as
 *      a false-positive answer to the OTHER category. That reasoning still
 *      holds for a WEAK-only match. It does not justify excluding a seed
 *      whose own slug (or own body text) already says 'chtr' or
 *      'campus-hazing-transparency' -- a page can legally serve as its own
 *      answer (Georgian Court's Report Form is the same URL as its Hazing
 *      Policy, for exactly this reason -- see xsPickByKeyword_'s header).
 *
 *   4. THE SEED'S OWN HEADINGS COUNT TOO -- HEADINGS, NOT BODY TEXT.
 *      (Added 2026-08-26 as body text; CORRECTED to headings 2026-08-29,
 *      see below.) Some seeds carry their CHTR content on the very same
 *      page under a URL slug that says nothing about it -- Neumann's own
 *      seed URL is .../hazing-report (and 'hazing-report' is deliberately
 *      a Report Form keyword elsewhere, not a CHTR one, so the slug alone
 *      is genuinely ambiguous), but if that page opens with a "Campus
 *      Hazing Transparency Report" HEADING, gate 0 catches it. Same
 *      strongKeywords-only gate as the URL check. A category with no
 *      strongKeywords (Hazing Policy, today) still can never let its seed
 *      through on EITHER signal.
 *
 *      WHY IT IS HEADINGS AND NOT BODY TEXT -- the most expensive mistake
 *      in this function so far, and the one worth reading before touching
 *      any of it. The first version matched strongKeywords against the
 *      seed's whole capText_'d body. Measured 2026-08-29, after the fact:
 *      the 2026-08-27 CHTR cross-seed run created 40 rows and ALL 40 WERE
 *      SEEDS PROPOSING THEMSELVES, none of them qualifying on their URL --
 *      york.edu/.../hazing-policy.php, stmarys-ca.edu/.../anti-hazing-
 *      policy, lasell.edu/.../student-handbook. Every one a hazing policy
 *      filed as a CHTR. The 2026-08-24 run, before the change, produced 42
 *      rows with 2 self-proposals, both correctly URL-qualified.
 *
 *      The vocabulary was not at fault and narrowing it would not have
 *      helped. strongKeywords was chosen to be matched against a URL SLUG,
 *      where a term is a label the page's author picked for the page. It
 *      was then pointed at PROSE without being re-decided term by term --
 *      and in prose 'stop-campus-hazing' is the name of a STATUTE and
 *      'campus-hazing-transparency' is the name of an OBLIGATION, so every
 *      compliant hazing policy contains both, because citing the law it
 *      complies with is what a compliant policy does. The corpus inverted
 *      the terms' meaning; the terms themselves never changed. This is the
 *      rule the candidate-URL design doc states in section 3 about moving
 *      a keyword list between contexts -- "any list moved between contexts
 *      needs its sign re-decided term by term, never copied" -- and it was
 *      broken here two days after being written down.
 *
 *      A heading is authored the way a slug is: it names what the page IS.
 *      That is why the Neumann example in the original justification said
 *      "heading" while the code read the body -- the right corpus was named
 *      in the reasoning and not used in the implementation.
 *
 *      NOT A COMPLETE FIX, and should not be described as one. A policy
 *      page carrying a heading like "Campus Hazing Transparency Report"
 *      above a link to the actual report will still self-propose. That is
 *      a far smaller population than "cites the Act", but it is not zero --
 *      dry-run before trusting a run.
 *
 * items: [{url, text, sameSite, isSeed, headingText}]. text and url are
 * combined into a blob internally; callers do not need to pre-build one.
 * isSeed is optional and only meaningful on the CHTR/Hazing Policy keyword
 * path. headingText is optional, read ONLY when isSeed is true, and should
 * be the seed page's own capHeadings_ joined into one string -- never the
 * body text, and never the raw HTML. It was bodyText until 2026-08-29; the
 * rename is deliberate, because a field named bodyText holding headings is
 * exactly the kind of quiet lie that produced the 40 rows described in
 * point 4.
 */
function rankCandidatesByBlob_(items, category) {
  const scored = [];
  const exclusions = GLOBAL_EXCLUSION_KEYWORDS.concat(category.excludeKeywords || []);
  const strongList = category.strongKeywords || [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const slug = item.url.toLowerCase();

    if (IMAGE_EXTENSION_PATTERN.test(item.url)) continue;

    let excluded = false;
    for (let e = 0; e < exclusions.length; e++) {
      if (slug.indexOf(exclusions[e]) !== -1) { excluded = true; break; }
    }
    if (excluded) continue;

    // GATE 0: THE SEED ITSELF. See points 3 and 4 above. A weak-only
    // match (bare 'hazing', or any secondary term) never qualifies a
    // seed on either signal -- only strongKeywords does, and a category
    // with none defined (Hazing Policy, today) can never let its seed
    // through, unchanged from the blanket exclusion this replaces. A
    // term hit in both the URL and the headings counts once, not twice.
    //
    // HEADINGS, NOT BODY TEXT -- read point 4 before changing this line.
    // Matching these terms against prose files every compliant hazing
    // policy as a CHTR, because a policy cites the Act by name. 40 rows,
    // 40 wrong, measured. A slug and a heading both NAME the page; prose
    // discusses things other than the page.
    if (item.isSeed) {
      const seedUrlHits = strongList.length ? keywordHits_(slug, strongList, matchesKeyword_) : [];
      const seedHeadingText = String(item.headingText || '').toLowerCase();
      const seedHeadingHits = (strongList.length && seedHeadingText)
        ? keywordHits_(seedHeadingText, strongList, matchesKeywordText_).filter(function (k) {
            return seedUrlHits.indexOf(k) === -1;
          })
        : [];
      const seedHits = seedUrlHits.concat(seedHeadingHits);
      if (!seedHits.length) continue;
      scored.push({ url: item.url, score: weightedScore_(seedHits, strongList) });
      continue;
    }

    const text = String(item.text || '').toLowerCase();
    const blob = slug + ' ' + text;

    // GATE 1: the URL. Full URL when same-site (rankCandidates_'s exact
    // corpus); path-only when off-site (see header comment).
    const urlCorpus = item.sameSite ? slug : urlPathOnly_(item.url);
    const urlHits = keywordHits_(urlCorpus, category.primaryKeywords, matchesKeyword_);
    const urlSecondary = keywordTally_(urlCorpus, category.secondaryKeywords, matchesKeyword_);
    const urlStrongHits = strongList.length
      ? urlHits.filter(function (k) { return strongList.indexOf(k) !== -1; })
      : [];

    // Off-site, when the category defines strongKeywords, qualification
    // requires one of THOSE specifically -- see point 2 above. On-site,
    // and for any category with no strongKeywords, this is exactly the
    // old rule (any primary hit, or 2+ secondary).
    const urlQualifies = item.sameSite
      ? (urlHits.length >= 1 || urlSecondary >= 2)
      : (strongList.length
          ? urlStrongHits.length >= 1
          : (urlHits.length >= 1 || urlSecondary >= 2));

    // GATE 2: URL + text, boundary-matched, only reached if gate 1 failed,
    // and only trusted same-site.
    const blobHits = keywordHits_(blob, category.primaryKeywords, matchesKeywordText_);
    const blobSecondary = keywordTally_(blob, category.secondaryKeywords, matchesKeywordText_);
    const blobQualifies = blobHits.length >= 1 || blobSecondary >= 2;

    const qualifies = urlQualifies || (item.sameSite && blobQualifies);
    if (!qualifies) continue;

    // See point 1 above: each hit is now weighted individually rather
    // than a flat 3, so an index-labeled page outranks one that only
    // ever matches the weaker, content-describing terms.
    const score = urlQualifies
      ? weightedScore_(urlHits, strongList) + urlSecondary
      : weightedScore_(blobHits, strongList) + blobSecondary;
    scored.push({ url: item.url, score: score });
  }

  scored.sort(function (a, b) {
    return (b.score !== a.score) ? b.score - a.score : a.url.length - b.url.length;
  });

  const deduped = [];
  const seen = {};
  for (let i = 0; i < scored.length; i++) {
    const key = scored[i].url.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    deduped.push(scored[i]);
  }
  return deduped;
}

// Translates the raw point total into a label. The raw score is never
// shown to a human -- it is not calibrated or stable, and shifts whenever
// the keyword lists are tuned.
function scoreToConfidence_(score) {
  if (score >= 6) return 'High';
  if (score >= 3) return 'Medium';
  return 'Low';
}

// =========================================================================
// ONE-TIME BACKFILL: Form link tier for EXISTING rows
//
// WAS "Keyword confidence / Form link tier" until 2026-09-01. The Keyword
// confidence half went with the field; the two CHTR/Hazing Policy cases
// described below no longer run and are kept only so the history reads.
// (2026-08-27, alongside the xsNewRow_/rflWrite_ fix that stopped the gap
// going forward -- see PreFilterResult.gs's pfBackfill_ for the pattern
// this follows: dry-run first, only ever touches a BLANK field, safe to
// leave in the project and re-run any time since nothing this backfills
// will still be blank afterward.)
//
// Recomputes from what is ALREADY STORED -- no page re-fetch, for any of
// the four cases:
//   - Sitemap-discovered CHTR/Hazing Policy: rankCandidates_ on the URL
//     alone, exactly as sitemap discovery itself scores a slug.
//   - Cross-seeded CHTR/Hazing Policy: rankCandidatesByBlob_ on the URL +
//     the stored Seed link text, exactly as xsPickByKeyword_ scored it at
//     creation time. sameSite/isSeed reconstructed from Seed URL.
//   - Sitemap-discovered Report Form: repickPick_ on the stored outbound
//     link list (Outbound page links), exactly as repickRun_ does.
//   - Cross-seeded Report Form: repickPick_ on a single reconstructed
//     link (Candidate URL + Seed link text), since cross-seed never
//     stored an outbound list for these rows -- there is nothing to
//     re-parse, so this is the one case built from a single link instead
//     of a list. Same tier logic, smaller input.
//
// CAT_LABEL_TO_KEY exists because the Category field's actual values
// ("CHTR", "Hazing Policy", "Report Form") do NOT match CATEGORIES[key].label
// ("CHTR Index URL" for chtr) -- checked against the live schema before
// writing this, not assumed.
// =========================================================================

const CAT_LABEL_TO_KEY = { 'CHTR': 'chtr', 'Hazing Policy': 'hazingPolicy', 'Report Form': 'reportForm' };
const CONF_TIER_WRITE_BATCH = 10;

function confTierBackfillDryRun() { return confTierBackfill_(true); }
function confTierBackfill()       { return confTierBackfill_(false); }

function confTierBackfill_(dryRun) {
  const pat = capPat_();
  const fields = [
    CF.candidateUrl, CF.category, SM_CF_SOURCE,
    RFL.linkedUrl, RFL.tier, RFL.outbound,
    XS_F_SEED_URL, XS_F_SEED_TEXT
  ];

  const rows = [];
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?pageSize=100&returnFieldsByFieldId=true&' +
      fields.map(function (f) { return 'fields[]=' + f; }).join('&');
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) { rows.push(r); });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  const updates = [];
  let tierFilled = 0, tierSkipped = 0;

  rows.forEach(function (r) {
    const f = r.fields;
    const categoryLabel = f[CF.category] || '';
    const categoryKey = CAT_LABEL_TO_KEY[categoryLabel];
    const url = f[CF.candidateUrl] || '';
    const source = f[SM_CF_SOURCE] || '';

    // THE CHTR / HAZING POLICY BRANCH WAS HERE. It recomputed Keyword
    // confidence from the stored URL (or URL + Seed link text for
    // cross-seeded rows). Removed 2026-09-01 with the field. Nothing else
    // in this function touched those two categories, so this backfill is
    // now Report Form only -- the name is kept because the entry points
    // confTierBackfill()/confTierBackfillDryRun() may sit in someone's
    // notes, and a renamed function that quietly does not exist is worse
    // than a slightly wide name.

    if (categoryKey === 'reportForm') {
      // Report Form -- Form link tier. Only for rows that already have a
      // winning pick; a row with nothing picked has nothing to tier.
      if (f[RFL.tier] || !f[RFL.linkedUrl]) return;

      let best = null;
      if (source === 'Cross-seed') {
        const seedUrl = f[XS_F_SEED_URL] || '';
        const linkUrl = f[RFL.linkedUrl];
        const text = f[XS_F_SEED_TEXT] || '';
        const blob = (linkUrl + ' ' + text).toLowerCase();
        const shaped = {
          url: linkUrl, text: text,
          host: repickVendor_(linkUrl, blob, seedUrl),
          blob: blob, hazing: /hazing/.test(blob),
          sameSite: !!seedUrl && repickSite_(linkUrl) === repickSite_(seedUrl)
        };
        best = repickPick_([shaped]);
      } else if (f[RFL.outbound]) {
        best = repickPick_(repickParse_(f[RFL.outbound], url));
      }

      if (best) {
        tierFilled++;
        const upd = {}; upd[RFL.tier] = repickTierLabel_(best.tier);
        updates.push({ id: r.id, fields: upd });
      } else {
        tierSkipped++;   // no stored outbound to re-parse and not cross-seed -- needs a person
      }
    }
  });

  Logger.log(
    '\n======== FORM LINK TIER BACKFILL' + (dryRun ? ' DRY RUN' : '') + ' ========\n' +
    rows.length + ' Candidate URL row(s) examined.\n' +
    'Report Form rows only -- the Keyword confidence half was removed with\n' +
    'that field on 2026-09-01.\n' +
    tierFilled + ' Form link tier value(s) would be filled, ' +
      tierSkipped + ' left blank (no stored outbound to work from).\n' +
    (dryRun ? 'Nothing written.\n' : '')
  );

  if (dryRun) return { tierFilled: tierFilled, tierSkipped: tierSkipped };

  let written = 0;
  for (let i = 0; i < updates.length; i += CONF_TIER_WRITE_BATCH) {
    const batch = updates.slice(i, i + CONF_TIER_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch, typecast: true }), muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) written += batch.length;
    else Logger.log('Write failed for ' + batch.length + ' row(s): ' + resp.getContentText().slice(0, 300));
    Utilities.sleep(210);
  }
  Logger.log('Written: ' + written + ' of ' + updates.length + ' update(s).');
  return { written: written, total: updates.length };
}

// =========================================================================
// PRE-FIX CROSS-SEED REPORT FORM BACKFILL (added 2026-08-27). Narrower
// than confTierBackfill_ above, and for a different reason: these rows
// predate the day's xsNewRow_ fix that made cross-seed Report Form rows
// also write Linked form URL/Linked form host alongside Candidate URL
// (which, for this path, already IS the vendor form -- see xsNewRow_'s
// own header comment, not a landing-page guess). Before that fix, only
// Candidate URL got written, so confTierBackfill_'s own rule --
// "only tier a row that already has a Linked form URL" -- correctly, but
// unhelpfully, skips them: there was never anything in Linked form URL to
// re-tier.
//
// Scoped tightly on purpose: Cross-seed source, Report Form category,
// Linked form URL blank. Re-derives host/tier from Candidate URL + the
// row's own stored Seed link text -- no re-fetch, same inputs
// confTierBackfill_ already uses for this source/category combination.
// =========================================================================

function xsReportFormBackfillDryRun() { return xsReportFormBackfill_(true); }
function xsReportFormBackfill()       { return xsReportFormBackfill_(false); }

function xsReportFormBackfill_(dryRun) {
  const pat = capPat_();
  const formula = encodeURIComponent(
    'AND({' + CF.category + '}="Report Form", {' + SM_CF_SOURCE + '}="Cross-seed", {' + RFL.linkedUrl + '}="")'
  );
  const fields = [CF.candidateUrl, XS_F_SEED_URL, XS_F_SEED_TEXT, SM_CF_UNITID]
    .map(function (f) { return 'fields[]=' + f; }).join('&');

  const rows = [];
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + formula + '&pageSize=100&returnFieldsByFieldId=true&' + fields;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) { rows.push(r); });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  const updates = [];
  let filled = 0, skipped = 0;

  rows.forEach(function (r) {
    const f = r.fields;
    const linkUrl = f[CF.candidateUrl] || '';
    if (!linkUrl) { skipped++; return; }

    const seedUrl = f[XS_F_SEED_URL] || '';
    const text = f[XS_F_SEED_TEXT] || '';
    const blob = (linkUrl + ' ' + text).toLowerCase();
    const shaped = {
      url: linkUrl, text: text,
      host: repickVendor_(linkUrl, blob, seedUrl),
      blob: blob, hazing: /hazing/.test(blob),
      sameSite: !!seedUrl && repickSite_(linkUrl) === repickSite_(seedUrl)
    };
    const best = repickPick_([shaped]);

    if (best) {
      filled++;
      const upd = {};
      upd[RFL.linkedUrl] = linkUrl;
      upd[RFL.linkedHost] = best.host;
      upd[RFL.tier] = repickTierLabel_(best.tier);
      updates.push({ id: r.id, fields: upd });
    } else {
      skipped++;   // stored evidence isn't enough to classify -- left blank, needs a person
    }
  });

  Logger.log(
    '\n======== PRE-FIX CROSS-SEED REPORT FORM BACKFILL' + (dryRun ? ' DRY RUN' : '') + ' ========\n' +
    rows.length + ' old cross-seed Report Form row(s) with blank Linked form URL found.\n' +
    filled + ' would be filled (Linked form URL + host + tier, from the existing Candidate URL/seed text).\n' +
    skipped + ' left blank (not enough stored evidence to classify).\n' +
    (dryRun ? 'Nothing written.\n' : '')
  );

  if (dryRun) return { examined: rows.length, filled: filled, skipped: skipped, dryRun: true };

  let written = 0;
  for (let i = 0; i < updates.length; i += CONF_TIER_WRITE_BATCH) {
    const batch = updates.slice(i, i + CONF_TIER_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch, typecast: true }), muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) written += batch.length;
    else Logger.log('Write failed for ' + batch.length + ' row(s): ' + resp.getContentText().slice(0, 300));
    Utilities.sleep(210);
  }
  Logger.log('Written: ' + written + ' of ' + updates.length + ' update(s).');
  return { written: written, total: updates.length };
}

// =========================================================================
// ONE-TIME SWEEP: junk URLs (login/account pages) created before the
// GLOBAL_EXCLUSION_KEYWORDS fix (2026-08-27) that stops new ones. Found via
// the Bemidji State / sulross.edu wp-login.php row surfaced while checking
// the confidence backfill -- a real content-based quality signal, unlike
// blank Keyword confidence, which the same check proved is NOT one, and
// which was deleted outright on 2026-09-01 (a
// Confirmed - promote row and several Rejected rows were blank too).
//
// NEVER touches a row with any Reviewer determination already set --
// blank/missing or the explicit "Not reviewed" choice are the only two
// states this will delete. A human's verdict, whatever it was, is never
// second-guessed by a URL pattern. Deleting an UNREVIEWED junk row (unlike
// deleting a REJECTED one) does not violate "reject, don't delete" -- there
// is no verdict being destroyed, and the exclusion keyword now stops it
// from being recreated on the next discovery or cross-seed pass anyway.
// =========================================================================

const JUNK_URL_PATTERN = /\blogin\b|signin|sign-in|logout/i;
const CAND_F_DETERMINATION = 'flds5qRgFKkdvLjK0';

function junkUrlSweepDryRun() { return junkUrlSweep_(true); }
function junkUrlSweep()       { return junkUrlSweep_(false); }

function junkUrlSweep_(dryRun) {
  const pat = capPat_();
  const fields = [CF.candidateUrl, CF.category, SM_CF_SOURCE, CAND_F_DETERMINATION];

  const rows = [];
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?pageSize=100&returnFieldsByFieldId=true&' +
      fields.map(function (f) { return 'fields[]=' + f; }).join('&');
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) { rows.push(r); });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  const toDelete = [], keep = [];
  rows.forEach(function (r) {
    const url = r.fields[CF.candidateUrl] || '';
    if (!JUNK_URL_PATTERN.test(url)) return;

    const det = r.fields[CAND_F_DETERMINATION] || '';
    const unreviewed = !det || det === 'Not reviewed';
    if (unreviewed) {
      toDelete.push({ id: r.id, unitid: r.fields[SM_CF_UNITID], url: url });
    } else {
      keep.push({ unitid: r.fields[SM_CF_UNITID], url: url, determination: det });
    }
  });

  Logger.log(
    '\n======== JUNK URL SWEEP' + (dryRun ? ' DRY RUN' : '') + ' ========\n' +
    rows.length + ' Candidate URL row(s) examined.\n' +
    toDelete.length + ' junk, unreviewed row(s) -- ' + (dryRun ? 'would delete' : 'deleting') + ':\n' +
    toDelete.map(function (d) { return '  ' + d.unitid + '  ' + d.url.slice(0, 100); }).join('\n') + '\n' +
    keep.length + ' junk-LOOKING row(s) KEPT -- already reviewed, left untouched: ' +
    keep.map(function (k) { return k.unitid + '(' + k.determination + ')'; }).join(', ') + '\n' +
    (dryRun ? 'Nothing deleted.\n' : '')
  );

  if (dryRun) return { wouldDelete: toDelete.length, kept: keep.length };

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 10) {
    const batch = toDelete.slice(i, i + 10);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
        '?' + batch.map(function (d) { return 'records[]=' + d.id; }).join('&'),
      { method: 'delete', headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) deleted += batch.length;
    else Logger.log('Delete failed for ' + batch.length + ' row(s): ' + resp.getContentText().slice(0, 300));
    Utilities.sleep(210);
  }
  Logger.log('Deleted ' + deleted + ' of ' + toDelete.length + ' row(s).');
  return { deleted: deleted, kept: keep.length };
}

// =========================================================================
// PDF BACKFILL: re-runs capOneRow_ on existing rows stuck at
// "PDF - not extracted" (added 2026-08-27, alongside the OCR extraction
// itself landing in capOneRow_). Not a resumable pipeline stage -- a
// direct, bounded batch, since the volume of stuck PDF rows is small
// enough to not need one.
//
// "Dry run" here means Airtable is never written to -- it does NOT mean
// zero real Google API calls. Extraction genuinely happens (a temp Google
// Doc really gets created and deleted) because verifying the mechanism
// works IS the point of a dry run here, not something to skip.
//
// pdfBackfillTestDryRun() / pdfBackfillTest() cap at 5 rows -- enough to
// include the already-known stuck PDFs (MSMC x2, Francis Marion, etc.)
// without committing to the full table. Once that looks right,
// pdfBackfillDryRun() / pdfBackfill() default to 200 -- comfortably above
// the current count, but re-runnable if more accumulate later.
// =========================================================================

function pdfBackfillFetchRows_(pat, howMany) {
  const fields = [CF.candidateUrl, CF.category].map(function (f) { return 'fields[]=' + f; }).join('&');
  const formula = encodeURIComponent('{' + CF.fetchStatus + '} = "PDF - not extracted"');
  const url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
    '?filterByFormula=' + formula +
    '&pageSize=' + Math.min(100, howMany) + '&returnFieldsByFieldId=true&' + fields;
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
  Utilities.sleep(210);
  return JSON.parse(resp.getContentText()).records;
}

function pdfBackfillTestDryRun() { return pdfBackfill_(true, 5); }
function pdfBackfillTest()       { return pdfBackfill_(false, 5); }
function pdfBackfillDryRun()     { return pdfBackfill_(true, 200); }
function pdfBackfill()           { return pdfBackfill_(false, 200); }

function pdfBackfill_(dryRun, limit) {
  const pat = capPat_();
  const rows = pdfBackfillFetchRows_(pat, limit);

  const results = [];
  let extracted = 0, stillFailed = 0;
  let s = '\n======== PDF BACKFILL' + (dryRun ? ' DRY RUN' : '') + ' ========\n';

  rows.forEach(function (r) {
    // capOneRow_ is the SAME function every candidate row already goes
    // through -- this just re-runs it now that it knows how to extract a
    // PDF, instead of duplicating that logic here.
    const res = capOneRow_(r);
    results.push(res);
    if (res.fetchStatus === 'Fetched') extracted++; else stillFailed++;
    s += '\n' + (r.fields[CF.candidateUrl] || '').slice(0, 90) + '\n' +
         '  status: ' + res.fetchStatus + '  chars: ' + res.charCount +
         '  pre-filter: ' + res.prefilterResult + '\n';
    Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
  });

  s += '\n' + rows.length + ' PDF row(s) examined -- ' + extracted + ' extracted, ' +
    stillFailed + ' still failed (unreadable/scanned PDF, quota, or Advanced Drive Service not enabled).\n';

  if (dryRun) {
    s += 'Nothing written to Airtable.\n';
    Logger.log(s);
    return { examined: rows.length, extracted: extracted, stillFailed: stillFailed, dryRun: true };
  }

  capWriteBack_(pat, results);
  s += 'Written.\n';
  Logger.log(s);
  return { examined: rows.length, extracted: extracted, stillFailed: stillFailed };
}

// -------------------------------------------------------------------------
// CREATING THE CANDIDATE ROWS  (replaces the old intake stage)
// -------------------------------------------------------------------------
/**
 * Creates a Candidate URLs row for every candidate found, skipping any
 * (UNITID, url) pair that already has one.
 *
 * THE REJECTED ROW IS THE BLOCKLIST. Dedupe runs against every existing row
 * for this category, REJECTED ONES INCLUDED, so a URL a reviewer threw out
 * is never recreated, while the alternates that were not rejected still
 * come through. One consequence worth knowing: DELETING a rejected row
 * un-blocks that URL and it reappears on the next sweep. Reject, don't
 * delete.
 *
 * DEDUPE IS SCOPED TO THIS BATCH'S SCHOOLS, not the whole table. The old
 * intake stage read every row in the category once, which was fine because
 * it ran once. Discovery runs ~100 times per sweep, and re-reading ~750
 * rows per batch of 15 schools would be about 800 wasted API calls.
 * Asking only about the UNITIDs in hand is one call, and it is exact
 * rather than approximate.
 */
function writeSitemapCandidates_(pat, category, results) {
  const label = PIPELINE_CATEGORY_LABEL[category.key];
  const unitids = results
    .map(function (r) { return r.unitid; })
    .filter(function (u) { return !!u; });

  const seen = sitemapExistingKeys_(pat, label, unitids);

  const pending = [];
  let created = 0, skipped = 0;
  const writeErrors = [];

  results.forEach(function (r) {
    if (!r.unitid) return;
    r.candidates.forEach(function (c) {
      const key = r.unitid + '|' + pipelineUrlKey_(c.url);
      if (seen[key]) { skipped++; return; }
      seen[key] = true;                      // guard within this batch too
      pending.push(sitemapNewRow_(r.unitid, label, c));
      created++;
    });
  });

  while (pending.length) {
    const batch = pending.splice(0, INTAKE_CREATE_BATCH);
    try {
      pipelineIntakeFlush_(pat, batch);
    } catch (err) {
      // Creates are all-or-nothing per call, so nothing is half-made.
      // The next sweep re-proposes these and dedupe lets through only the
      // ones that did not land.
      created -= batch.length;
      writeErrors.push({
        batchStartIndex: created,
        institutions: category.label + ' (' + batch.length + ' row(s))',
        airtableError: String(err.message).slice(0, 400)
      });
      Logger.log('Create failed: ' + err.message);
    }
  }

  return { created: created, skipped: skipped, writeErrors: writeErrors };
}

function sitemapNewRow_(unitid, categoryLabel, c) {
  const f = {};
  f[SM_CF_UNITID]     = unitid;
  f[SM_CF_INST_LINK]  = [unitid];              // matched by value
  f[CF.category]      = categoryLabel;
  f[CF.candidateUrl]  = c.url;
  f[SM_CF_RANK]       = c.rank;
  f[CF.fetchStatus]   = 'Not yet fetched';
  // See xsNewRow_ (CrossSeed.gs) for why this is stamped at creation rather
  // than left blank: blank and 'Not yet run' meant the same thing, and the
  // field should carry one value per state.
  f[PF_F_RESULT]      = 'Not yet run';
  f[SM_CF_SOURCE]     = 'Sitemap discovery';
  // Keyword confidence is NOT written -- see the SM_CF_CONFIDENCE tombstone
  // near the top of this file. c.confidence still exists on the in-memory
  // candidate because the run report groups by it; it is deliberately not
  // stored, because Rank already carries the same ordering.
  return { fields: f };
}

/**
 * Existing keys for this category, limited to these schools.
 *
 * Each row contributes its candidate URL and, when it has one, its linked
 * form URL -- see pipelineRegisterKeys_ for why.
 */
function sitemapExistingKeys_(pat, categoryLabel, unitids) {
  const seen = {};
  if (!unitids.length) return seen;
 
  const uniq = [];
  unitids.forEach(function (u) { if (uniq.indexOf(u) === -1) uniq.push(u); });
 
  const idClause = 'OR(' + uniq.map(function (u) {
    return '{' + SM_CF_UNITID + '}="' + u + '"';
  }).join(',') + ')';
 
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + encodeURIComponent(
        'AND({' + CF.category + '}="' + categoryLabel + '",' + idClause + ')') +
      '&pageSize=100&returnFieldsByFieldId=true' +
      '&fields[]=' + SM_CF_UNITID + '&fields[]=' + CF.candidateUrl +
      '&fields[]=' + RFL.linkedUrl;
    if (offset) url += '&offset=' + offset;
 
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable list error: ' + resp.getContentText());
    }
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) {
      pipelineRegisterKeys_(seen, r.fields);
    });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);
 
  return seen;
}

/**
 * Register every key one existing candidate row should block, into seen.
 *
 * TWO KEYS PER ROW, NOT ONE. The candidate URL is the obvious one. The second
 * is the row's Linked form URL, and it is here because of a duplication
 * measured on 2026-08-30: 16 Report Form rows had been queued for review
 * twice, and every single pair was a sitemap row sitting beside a cross-seed
 * row. The mechanism is that xsNewRow_ writes the vendor form into BOTH
 * Candidate URL and Linked form URL, whereas a sitemap row that found the same
 * form carries it only in Linked form URL. A seen-set built on Candidate URL
 * alone therefore cannot see the sitemap row's form, and cross-seed proposes a
 * form the reviewer already has further down the queue.
 *
 * NATURALLY SCOPED TO Report Form. Linked form URL is blank for CHTR and
 * Hazing Policy, so this adds no keys at all in those categories and cannot
 * change their behaviour.
 *
 * Rejected rows are included here as everywhere else -- they ARE the
 * blocklist. A form a reviewer already rejected on one row should not come
 * back as a fresh proposal on another.
 */
function pipelineRegisterKeys_(seen, fields) {
  const f = fields || {};
  const u = String(f[SM_CF_UNITID] || '').trim();
  if (!u) return;
 
  const c = String(f[CF.candidateUrl] || '').trim();
  if (c) seen[u + '|' + pipelineUrlKey_(c)] = true;
 
  const lf = String(f[RFL.linkedUrl] || '').trim();
  if (lf) seen[u + '|' + pipelineUrlKey_(lf)] = true;
}

// Same normalisation the ranker uses to dedupe, so the two agree on what
// counts as the same URL: scheme and trailing slashes are noise.
function pipelineUrlKey_(url) {
  return String(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

function pipelineIntakeFlush_(pat, rows) {
  if (!rows || !rows.length) return;
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID,
    { method: 'post',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ records: rows, typecast: true }),
      muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Could not create candidate rows: ' + resp.getContentText().slice(0, 400));
  }
  Utilities.sleep(210);
}

/**
 * Every key already spoken for in Candidate URLs for this category, whatever
 * the reviewer determination. Rejected rows are deliberately included -- they
 * ARE the blocklist.
 *
 * Each row contributes its candidate URL and, when it has one, its linked
 * form URL -- see pipelineRegisterKeys_ for why.
 *
 * KEPT FOR CrossSeed.gs, which needs the whole-category set rather than a
 * per-batch slice: its batches are institutions, not candidate rows, and it
 * reads this once per run.
 */
function pipelineExistingKeys_(pat, categoryLabel) {
  const seen = {};
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + encodeURIComponent('{' + CF.category + '} = "' + categoryLabel + '"') +
      '&pageSize=100&returnFieldsByFieldId=true' +
      '&fields[]=' + SM_CF_UNITID + '&fields[]=' + CF.candidateUrl +
      '&fields[]=' + RFL.linkedUrl;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable list error: ' + resp.getContentText());
    }
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) {
      pipelineRegisterKeys_(seen, r.fields);
    });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);
  return seen;
}
function mergeSitemapSummary_(cumulative, results) {
  results.forEach(function (r) {
    cumulative[r.outcome] = (cumulative[r.outcome] || 0) + 1;
  });
}

// -------------------------------------------------------------------------
// MANUAL TARGETED RE-RUN
// Runs specific records by ID, bypassing the blank-field query and the
// resumable offset -- useful for filling a gap without disturbing an
// in-progress sweep's resume point or counters.
// -------------------------------------------------------------------------
function runSitemapForSpecificRecords(categoryKey, recordIds) {
  const category = CATEGORIES[categoryKey];
  if (!category) throw new Error('Unknown category: ' + categoryKey);
  if (!recordIds || !recordIds.length) throw new Error('Pass an array of record IDs.');

  const pat = capPat_();
  const records = fetchRecordsByIds_(pat, recordIds);

  const results = [];
  for (let i = 0; i < records.length; i++) {
    results.push(processRecord_(records[i], category));
    Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
  }

  const write = writeSitemapCandidates_(pat, category, results);

  Logger.log('Targeted re-run for ' + category.label + ': ' + results.length +
    ' record(s), ' + write.created + ' row(s) created, ' + write.skipped +
    ' already present, ' + write.writeErrors.length + ' write error(s).');

  return {
    category: categoryKey,
    categoryLabel: category.label,
    recordsProcessed: results.length,
    rowsCreated: write.created,
    rowsAlreadyPresent: write.skipped,
    writeErrors: write.writeErrors,
    results: results.map(function (r) {
      return {
        institution: r.institution,
        topCandidate: r.topCandidateUrl,
        confidence: r.topCandidateConfidence,
        outcome: r.outcome
      };
    })
  };
}

function fetchRecordsByIds_(pat, recordIds) {
  const fieldIds = [SM_F_INSTITUTION, SM_F_INST_URL, SM_F_UNITID];
  const fieldsParam = fieldIds.map(function (f) { return 'fields[]=' + f; }).join('&');
  const idFormula = 'OR(' + recordIds.map(function (id) {
    return 'RECORD_ID()="' + id + '"';
  }).join(',') + ')';

  const url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + SM_INST_TABLE +
    '?filterByFormula=' + encodeURIComponent(idFormula) +
    '&pageSize=' + recordIds.length +
    '&returnFieldsByFieldId=true&' + fieldsParam;

  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Airtable list error: ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText()).records;
}

// -------------------------------------------------------------------------
// BOUNDED SITEMAP SWEEP
// -------------------------------------------------------------------------
// The previous scheduler used .everyMinutes(15), which fires 96 times a day
// forever. A personal Google account allows only 90 MINUTES of total
// trigger runtime per day (a Workspace account gets 6 hours). At even two
// minutes per firing that design needs three-plus hours a day. Past the
// limit Google silently stops running the trigger -- a difficult failure to
// notice -- and meanwhile it consumes the daily urlfetch quota whether or
// not there is work to do.
//
// This is a BOUNDED sweep: it works through all three categories in short
// self-chaining slices, then STOPS. Nothing fires again until you start
// another. Pasting this file schedules nothing.
// -------------------------------------------------------------------------

const SITEMAP_SWEEP_ORDER = ['chtr', 'reportForm', 'hazingPolicy'];
const SITEMAP_SWEEP_HANDLER = 'continueSitemapSweep';
const SITEMAP_LEGACY_HANDLERS = ['runScheduledSitemapSweep'];
const SITEMAP_SLICE_BUDGET_MS = 4 * 60 * 1000;
const SITEMAP_SLICE_GAP_MINUTES = 1;
const SITEMAP_SWEEP_MAX_SLICES = 150;

const PROP_SWEEP_CATEGORY_INDEX = 'sitemapSweepCategoryIndex';
const PROP_SWEEP_SLICE_COUNT = 'sitemapSweepSliceCount';

function removeScheduledSitemapTrigger() {
  const names = [SITEMAP_SWEEP_HANDLER].concat(SITEMAP_LEGACY_HANDLERS);
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return names.indexOf(t.getHandlerFunction()) !== -1;
  });
  triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Removed ' + triggers.length + ' sitemap trigger(s). Nothing is scheduled now.');
  return { removed: triggers.length };
}

function scheduleNextSitemapSlice_() {
  // Always clear first. Without this, a slice that somehow runs twice would
  // leave two chains going, each consuming the same daily budget.
  removeScheduledSitemapTrigger();
  ScriptApp.newTrigger(SITEMAP_SWEEP_HANDLER)
    .timeBased().after(SITEMAP_SLICE_GAP_MINUTES * 60 * 1000).create();
}

function startSitemapSweep() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_SWEEP_CATEGORY_INDEX, '0');
  props.setProperty(PROP_SWEEP_SLICE_COUNT, '0');
  SITEMAP_SWEEP_ORDER.forEach(function (k) { resetSitemapProgress(k); });
  scheduleNextSitemapSlice_();
  Logger.log('Sweep started from the beginning. First slice in about ' +
    SITEMAP_SLICE_GAP_MINUTES + ' minute(s). It stops on its own when all ' +
    SITEMAP_SWEEP_ORDER.length + ' categories are done.');
}

function resumeSitemapSweep() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_SWEEP_CATEGORY_INDEX) === null) {
    Logger.log('No sweep in progress to resume. Use startSitemapSweep() instead.');
    return;
  }
  props.setProperty(PROP_SWEEP_SLICE_COUNT, '0');   // fresh runaway budget
  scheduleNextSitemapSlice_();
  Logger.log('Sweep resumed where it left off.');
}

function stopSitemapSweep() {
  removeScheduledSitemapTrigger();
  Logger.log('Sweep stopped. Per-category progress is kept -- resumeSitemapSweep() ' +
    'picks up from here, startSitemapSweep() starts over.');
}

function sitemapSweepStatus() {
  const props = PropertiesService.getScriptProperties();
  const names = [SITEMAP_SWEEP_HANDLER].concat(SITEMAP_LEGACY_HANDLERS);
  const scheduled = ScriptApp.getProjectTriggers().filter(function (t) {
    return names.indexOf(t.getHandlerFunction()) !== -1;
  }).length;
  const idx = parseInt(props.getProperty(PROP_SWEEP_CATEGORY_INDEX) || '0', 10);
  Logger.log(
    'Scheduled triggers: ' + scheduled + '\n' +
    'Current category: ' + (SITEMAP_SWEEP_ORDER[idx] || '(finished)') +
      ' (' + (idx + 1) + ' of ' + SITEMAP_SWEEP_ORDER.length + ')\n' +
    'Slices used this run: ' + (props.getProperty(PROP_SWEEP_SLICE_COUNT) || '0') + '\n' +
    'Processed so far -- chtr: ' + (props.getProperty(PROP_SITEMAP_PROCESSED_PREFIX + 'chtr') || '0') +
    ', reportForm: ' + (props.getProperty(PROP_SITEMAP_PROCESSED_PREFIX + 'reportForm') || '0') +
    ', hazingPolicy: ' + (props.getProperty(PROP_SITEMAP_PROCESSED_PREFIX + 'hazingPolicy') || '0')
  );
}

function continueSitemapSweep() {
  const props = PropertiesService.getScriptProperties();

  // Delete the trigger that just fired before doing any work. One-shot
  // triggers are not self-cleaning, and an accumulating pile of them is
  // exactly how a "bounded" sweep quietly becomes unbounded.
  removeScheduledSitemapTrigger();

  const sliceCount = parseInt(props.getProperty(PROP_SWEEP_SLICE_COUNT) || '0', 10) + 1;
  props.setProperty(PROP_SWEEP_SLICE_COUNT, String(sliceCount));
  if (sliceCount > SITEMAP_SWEEP_MAX_SLICES) {
    Logger.log('Stopping: hit the ' + SITEMAP_SWEEP_MAX_SLICES + '-slice guard without ' +
      'finishing. Something is looping rather than progressing -- check ' +
      'sitemapSweepStatus() before restarting.');
    return;
  }

  const startedAt = Date.now();
  let categoryIndex = parseInt(props.getProperty(PROP_SWEEP_CATEGORY_INDEX) || '0', 10);

  while (Date.now() - startedAt < SITEMAP_SLICE_BUDGET_MS) {
    if (categoryIndex >= SITEMAP_SWEEP_ORDER.length) {
      Logger.log('Sweep complete in ' + sliceCount + ' slice(s). Nothing further is scheduled.');
      props.deleteProperty(PROP_SWEEP_CATEGORY_INDEX);
      props.deleteProperty(PROP_SWEEP_SLICE_COUNT);
      return;
    }

    const categoryKey = SITEMAP_SWEEP_ORDER[categoryIndex];
    let result;
    try {
      result = runOrResumeSitemapBatch(categoryKey);
    } catch (err) {
      if (String(err.message).indexOf('Service invoked too many times for one day') !== -1) {
        // Quota is account-wide and resets on its own. Stop rather than
        // reschedule: another slice would fail identically and each attempt
        // still costs trigger runtime.
        Logger.log('Daily urlfetch quota reached while processing ' + categoryKey +
          '. Sweep stopped and NOTHING is scheduled. Run resumeSitemapSweep() ' +
          'once the quota resets.');
        return;
      }
      throw err;
    }

    Logger.log('Slice ' + sliceCount + ' -- ' + categoryKey + ': ' +
      result.recordsProcessedThisBatch + ' school(s), ' +
      result.rowsCreatedThisBatch + ' row(s) created, ' +
      result.rowsAlreadyPresent + ' already present, done=' + result.done);

    if (result.done) {
      categoryIndex++;
      props.setProperty(PROP_SWEEP_CATEGORY_INDEX, String(categoryIndex));
    }
  }

  scheduleNextSitemapSlice_();
  Logger.log('Slice ' + sliceCount + ' finished its time budget. Next slice shortly.');
}

// -------------------------------------------------------------------------
// SITEMAP FINDER UI (body only -- LinkChecker.gs's doGet wraps this)
// -------------------------------------------------------------------------
function buildSitemapHtml_() {
  return `
    <style>
      body { font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto 40px; padding: 0 20px; }
      h2 { margin-bottom: 20px; }
      p.sub { color: #666; margin-top: 0; margin-bottom: 12px; }
      label.catOption { display: block; margin: 6px 0; font-size: 15px; cursor: pointer; }
      button { background: #2563eb; color: white; border: none; padding: 12px 20px;
               border-radius: 6px; font-size: 15px; cursor: pointer; margin-top: 12px; }
      button:disabled { background: #93c5fd; cursor: default; }
      #status { margin-top: 16px; color: #444; }
      pre { background: #f5f5f5; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-size: 13px; }
      .bar-bg { background: #e5e7eb; border-radius: 6px; height: 10px; margin-top: 8px; overflow: hidden; }
      .bar-fill { background: #2563eb; height: 10px; width: 0%; transition: width 0.3s; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
      td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; }
      .conf-High { color: #15803d; font-weight: 600; }
      .conf-Medium { color: #b45309; font-weight: 600; }
      .conf-Low { color: #999; }
    </style>
    <h2>HazingInfo Sitemap Candidate Finder</h2>
    <p class="sub">Finds candidate URLs for schools with a blank Report Form, Hazing Policy, or CHTR field by scanning each school's sitemap for likely pages &mdash; no AI, no credits. Candidate rows are created in the PAGES base; nothing is written to a school's live URL field. Results are candidates only, not confirmed correct.</p>
    <p class="sub">This runs in batches automatically &mdash; if it's interrupted, picking the same category and clicking Run again resumes where it left off.</p>

    <div id="categoryPicker">
      <label class="catOption"><input type="radio" name="cat" value="reportForm" checked> Report Form</label>
      <label class="catOption"><input type="radio" name="cat" value="hazingPolicy"> Hazing Policy</label>
      <label class="catOption"><input type="radio" name="cat" value="chtr"> CHTR Index URL</label>
    </div>

    <button id="runBtn" onclick="run()">Run</button>
    <div id="status"></div>

    <script>
      function selectedCategory() {
        return document.querySelector('input[name="cat"]:checked').value;
      }
      function run() {
        document.getElementById('runBtn').disabled = true;
        document.querySelectorAll('input[name="cat"]').forEach(function (el) { el.disabled = true; });
        document.getElementById('status').innerHTML = 'Starting...';
        step();
      }
      function step() {
        google.script.run
          .withSuccessHandler(onBatchDone)
          .withFailureHandler(onError)
          .runOrResumeSitemapBatch(selectedCategory());
      }
      function onBatchDone(result) {
        var recoveredNote = result.recovered
          ? '<p style="color:#b45309;">Your saved progress for this category had expired (it sat too long since the last run), so this restarted from the beginning of the list. Nothing was lost &mdash; rows already created are skipped as duplicates.</p>'
          : '';
        document.getElementById('status').innerHTML =
          recoveredNote +
          '<p>Processed ' + result.cumulativeProcessed + ' schools so far for ' + result.categoryLabel + '.</p>' +
          '<p>This batch: ' + result.rowsCreatedThisBatch + ' candidate row(s) created, ' +
            result.rowsAlreadyPresent + ' already present or previously rejected.</p>' +
          '<div class="bar-bg"><div class="bar-fill" style="width:' +
          (result.done ? 100 : Math.min(95, (result.cumulativeProcessed / 800) * 100)) + '%"></div></div>' +
          recentBatchHtml(result) +
          (result.done ? finalSummaryHtml(result) : '<p>Still running, fetching next batch...</p>');
        if (result.done) {
          document.getElementById('runBtn').disabled = false;
          document.querySelectorAll('input[name="cat"]').forEach(function (el) { el.disabled = false; });
        } else {
          step();
        }
      }
      function recentBatchHtml(result) {
        var rows = result.sampleResults.map(function (r) {
          var confClass = r.confidence ? 'conf-' + r.confidence : '';
          return '<tr><td>' + r.institution + '</td><td class="' + confClass + '">' +
            (r.confidence || '&mdash;') + '</td><td>' + (r.topCandidate || '(none found)') + '</td></tr>';
        }).join('');
        return '<table><tr><th>Institution</th><th>Confidence</th><th>Top candidate</th></tr>' + rows + '</table>';
      }
      function finalSummaryHtml(result) {
        var s = result.cumulativeSummary;
        var parts = ['<p><strong>Done.</strong></p>',
          '<pre>High confidence: ' + (s.High || 0) + '\\n' +
          'Medium confidence: ' + (s.Medium || 0) + '\\n' +
          'Low confidence: ' + (s.Low || 0) + '\\n' +
          'Sitemap found, no keyword match: ' + (s.noKeywordMatch || 0) + '\\n' +
          'No sitemap found: ' + (s.noSitemapFound || 0) + '\\n' +
          'No Institution URL on file: ' + (s.noInstitutionUrl || 0) + '\\n' +
          'No UNITID on the record: ' + (s.noUnitid || 0) + '</pre>'];
        if (result.writeErrors && result.writeErrors.length > 0) {
          parts.push('<p style="color:red"><strong>' + result.writeErrors.length +
            ' create call(s) failed.</strong> Creates are all-or-nothing per call, so every row in an affected call failed together. They will be re-proposed on the next sweep.</p>');
          for (var i = 0; i < result.writeErrors.length; i++) {
            var we = result.writeErrors[i];
            parts.push('<div style="background:#fee;border:1px solid #f99;border-radius:6px;padding:10px;margin-top:8px;">');
            parts.push('<p><strong>' + we.institutions + '</strong></p>');
            parts.push('<p><strong>Airtable error:</strong></p><pre>' + we.airtableError + '</pre>');
            parts.push('</div>');
          }
        }
        return parts.join('');
      }
      function onError(err) {
        document.getElementById('runBtn').disabled = false;
        document.querySelectorAll('input[name="cat"]').forEach(function (el) { el.disabled = false; });
        document.getElementById('status').innerHTML =
          '<p style="color:red">Error: ' + err.message + '</p>' +
          '<p>Progress up to this point is saved. Click Run again to resume.</p>';
      }
    </script>
  `;
}

// =========================================================================
// 2. CANDIDATE PAGE CAPTURE
// =========================================================================
// Reads Candidate URLs rows where Fetch status is "Not yet fetched",
// fetches each page, and writes back the page text, its content hash, the
// extracted contacts, and the structural signals.
//
// RUN: runCapturePass()    -- works until it runs out of time, then stops
//                             and says how many are left. Run again to
//                             continue. Nothing is scheduled.
//      capturePassStatus() -- how many rows remain, no fetching.
//      captureThreeOnly()  -- smoke test: three rows, real writes.
//
// Resumable by construction: the selector is Fetch status = "Not yet
// fetched", and every processed row leaves that state. An interrupted run
// loses nothing and re-running never re-fetches a page that succeeded.
//
// TEXT STORED, by category:
//   CHTR, Hazing Policy -> boilerplate-stripped body text.
//   Report Form         -> an evidence packet: title, headings, form
//                          markup, then body text. NOT whole-page HTML:
//                          Simpson's report form is 95k+ of HTML and
//                          truncating it cuts the end of the page, which is
//                          exactly where the <option> list lives.
//
// THE HASH IS ALWAYS OVER STRIPPED TEXT, whatever gets stored. University
// pages carry rotating banners and session tokens; a hash of raw markup
// would change on nearly every fetch and the change-detection gate would
// save nothing. Measured: Simpson's handbook page is 51% site chrome,
// ACU's hazing policy 35%.
// -------------------------------------------------------------------------

const CAPTURE_MAX_CHARS   = 95000;   // margin under Airtable's 100,000/field
const CAPTURE_WRITE_BATCH = 3;       // small: rows carry full page text
const CAPTURE_TIME_BUDGET_MS = 4.5 * 60 * 1000;
const CAPTURE_PAGE_SIZE   = 30;

// 'Text plus form markup' replaced 'Raw HTML' on 2026-08-22. The old label
// was left over from a version that really did store raw HTML; Report Form
// rows have stored an evidence packet since the truncation fix, and calling
// that "raw HTML" would mislead anyone deciding whether the stored text is
// usable.
const CAPTURE_FORMAT_REPORT_FORM = 'Text plus form markup';
const CAPTURE_FORMAT_OTHER       = 'Stripped text';

function capturePassStatus() {
  const pat = capPat_();
  const n = capCountRemaining_(pat);
  Logger.log('Rows still needing capture: ' + n + '\nRun runCapturePass() to work through them.');
  return n;
}

function runCapturePass() {
  const pat = capPat_();
  const startedAt = Date.now();
  let processed = 0, failedWrites = 0;

  while (Date.now() - startedAt < CAPTURE_TIME_BUDGET_MS) {
    const rows = capFetchRows_(pat, CAPTURE_PAGE_SIZE);
    if (!rows.length) {
      Logger.log('Capture complete. Nothing left with Fetch status "Not yet fetched". ' +
                 'Processed ' + processed + ' row(s) this run.');
      return { done: true, processed: processed };
    }

    const results = [];
    for (let i = 0; i < rows.length; i++) {
      if (Date.now() - startedAt >= CAPTURE_TIME_BUDGET_MS) break;
      results.push(capOneRow_(rows[i]));
      Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
    }
    failedWrites += capWriteBack_(pat, results);
    processed += results.length;
  }

  const left = capCountRemaining_(pat);
  Logger.log('Time budget reached. Processed ' + processed + ' row(s) this run' +
    (failedWrites ? ', ' + failedWrites + ' write batch(es) failed' : '') +
    '.\n' + left + ' row(s) still to go -- run runCapturePass() again.');
  return { done: false, processed: processed, remaining: left };
}

// Deliberate, not a leftover: three real rows, real writes, so a change to
// the capture logic can be checked against live pages without spending a
// full pass. Every row it touches leaves "Not yet fetched", same as a
// normal run, so nothing has to be undone.
function captureThreeOnly() {
  const pat = capPat_();
  const rows = capFetchRows_(pat, 3);
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    results.push(capOneRow_(rows[i]));
    Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
  }
  const failed = capWriteBack_(pat, results);
  Logger.log('Wrote ' + results.length + ' row(s), ' + failed + ' failed batch(es).');
  results.forEach(function (r) {
    Logger.log(r.fetchStatus + ' | ' + r.charCount + ' chars | ' + r.contentHash.slice(0, 12) + '...');
  });
}

function capPat_() {
  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) throw new Error('Set AIRTABLE_PAT in Script Properties first.');
  return pat;
}

function capNotYetFetchedFormula_() {
  return encodeURIComponent('OR({' + CF.fetchStatus + '} = "", {' + CF.fetchStatus + '} = "Not yet fetched")');
}

function capCountRemaining_(pat) {
  // Airtable has no count endpoint, so walk pages of ids only. Cheap --
  // ids, not page text.
  let count = 0, offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + capNotYetFetchedFormula_() +
      '&pageSize=100&returnFieldsByFieldId=true&fields[]=' + CF.fetchStatus;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const json = JSON.parse(resp.getContentText());
    count += json.records.length;
    offset = json.offset || null;
    Utilities.sleep(210);
  } while (offset);
  return count;
}

function capFetchRows_(pat, howMany) {
  const fields = [CF.candidateUrl, CF.category, CAND_F_DETERMINATION].map(function (f) { return 'fields[]=' + f; }).join('&');
  const url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
    '?filterByFormula=' + capNotYetFetchedFormula_() +
    '&pageSize=' + Math.min(100, howMany) + '&returnFieldsByFieldId=true&' + fields;
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
  Utilities.sleep(210);
  return JSON.parse(resp.getContentText()).records;
}

function capWriteBack_(pat, results) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  let failures = 0;

  const payload = results.map(function (r) {
    const f = {};
    f[CF.fetchStatus]  = r.fetchStatus;
    f[CF.capturedDate] = today;
    f[CF.pageText]     = r.stored;
    f[CF.charCount]    = r.charCount;
    f[CF.truncated]    = r.truncated;
    f[CF.contentHash]  = r.contentHash;
    f[CF.signals]      = r.signals;
    f[PF_F_RESULT]     = r.prefilterResult;
    if (r.textFormat) f[CF.textFormat] = r.textFormat;
    if (r.newCandidateUrl) f[CF.candidateUrl] = r.newCandidateUrl;
    return { id: r.id, fields: f };
  });

  for (let i = 0; i < payload.length; i += CAPTURE_WRITE_BATCH) {
    const batch = payload.slice(i, i + CAPTURE_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch, typecast: true }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      failures++;
      // All-or-nothing: the whole batch stays "Not yet fetched" and gets
      // picked up again next run. Nothing is silently lost.
      Logger.log('Write failed for ' + batch.length + ' row(s): ' + resp.getContentText().slice(0, 300));
    }
    Utilities.sleep(210);
  }
  return failures;
}

/**
 * PDF text extraction via Drive API OCR conversion (added 2026-08-27).
 * Requires the Drive API enabled as an Advanced Service (Apps Script
 * editor: Services > + > Drive API) -- a one-time manual step in the
 * project, not something a script can turn on for itself.
 *
 * Converts the PDF to a TEMPORARY Google Doc with OCR, reads its text,
 * and deletes the temp doc immediately regardless of outcome -- nothing
 * is left behind in Drive, success or failure.
 *
 * Returns '' (never throws, never null) on any failure -- Advanced
 * Service not enabled, quota exceeded, a scanned/unreadable PDF -- so
 * capOneRow_ always gets a plain string back and doesn't need a separate
 * error path for this: an empty result falls through to the same
 * "PDF - not extracted" status the old code used for every PDF.
 */
function capExtractPdfText_(pdfBlob) {
  let doc;
  try {
    doc = Drive.Files.create(
      { name: 'pdf-ocr-temp-' + Utilities.getUuid(), mimeType: MimeType.GOOGLE_DOCS },
      pdfBlob,
      { ocr: true, ocrLanguage: 'en' }
    );
  } catch (err) {
    return '';
  }

  let text = '';
  try {
    text = DocumentApp.openById(doc.id).getBody().getText();
  } catch (err) {
    // leave text as ''
  } finally {
    // Cleanup via the BASIC DriveApp service, not the Advanced one --
    // sidesteps any question about the Advanced Service's delete-method
    // name across API versions, and this always works regardless.
    try { DriveApp.getFileById(doc.id).setTrashed(true); } catch (e) { /* best effort */ }
  }
  return text;
}

/**
 * Fetches a URL and extracts whatever text is available, PDF-aware.
 * Factored out (2026-08-27) so both capOneRow_'s main fetch and the
 * one-hop stub chase below use the exact same PDF-vs-HTML handling
 * instead of two copies that could drift apart.
 *
 * ok=false only on a fetch error or non-200 HTTP status. A PDF that
 * fetched fine but produced no OCR text still returns ok=true with an
 * empty bodyText -- that is a real, distinct outcome (unreadable/scanned
 * PDF) the caller needs to tell apart from "never reached the page".
 */
function capFetchAndExtract_(url) {
  const looksLikePdf = /\.pdf(\?|$)/i.test(url);
  const looksLikeImage = IMAGE_EXTENSION_PATTERN.test(url);
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      headers: SM_BROWSER_HEADERS, muteHttpExceptions: true,
      followRedirects: true, validateHttpsCertificates: true
    });
  } catch (err) {
    return { ok: false, reason: 'fetch error: ' + err.message };
  }

  const code = resp.getResponseCode();
  if (code !== 200) return { ok: false, reason: 'HTTP ' + code, code: code };

  const hdrs = resp.getHeaders();
  const ctype = (hdrs['Content-Type'] || hdrs['content-type'] || '').toLowerCase();
  const isPdf = looksLikePdf || ctype.indexOf('application/pdf') !== -1;
  const isImage = !isPdf && (looksLikeImage || ctype.indexOf('image/') === 0);

  // SAFETY NET, not the primary fix. Discovery/cross-seed now reject an
  // image URL before a candidate row is ever created (IMAGE_EXTENSION_
  // PATTERN in rankCandidates_/rankCandidatesByBlob_) -- this only catches
  // whatever gets past that some other way: a Manual entry row, or a
  // stub-chase target whose link text said "download" but pointed at an
  // image instead of a document. No text is extractable either way, so
  // this returns the same shape a failed PDF does rather than falling
  // through to capText_ on raw binary, which is what produced 95,000+
  // "characters" of garbage on the stophazing.org poster PNG that
  // surfaced this whole fix.
  if (isImage) {
    return {
      ok: true, isImage: true, bodyText: '', html: '', title: '', headings: [],
      forms: { isReportForm: false, reason: 'image -- no text to extract', markup: '', count: 0 }
    };
  }

  if (isPdf) {
    const bodyText = capExtractPdfText_(resp.getBlob().setContentType('application/pdf'));
    return {
      ok: true, isPdf: true, bodyText: bodyText, html: '', title: '', headings: [],
      forms: { isReportForm: false, reason: 'PDF -- no HTML form to check', markup: '', count: 0 }
    };
  }

  const html = resp.getContentText();
  return {
    ok: true, isPdf: false, html: html,
    bodyText: capText_(html), title: capTitle_(html),
    headings: capHeadings_(html), forms: capForms_(html)
  };
}

const STUB_MAX_CHARS = 3000;
const STUB_DOC_EVIDENCE = /\.pdf(\?|$)|download|view (the )?(pdf|document)|read (the )?(policy|handbook)/i;

/**
 * General <a href> link extraction for stub-chasing (added 2026-08-27) --
 * unlike rflReportLinks_, this keeps ANY sane link, not just report-like
 * ones, since a Hazing Policy stub links to a document, not a report
 * form. Reuses the same href-normalization safety (relative->absolute,
 * junk-host rejection, redirect-unwrap) rflReportLinks_ already
 * established, so a chase target gets the same scrutiny a discovered
 * candidate link already does.
 */
function capMainContentHtml_(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function capAllLinks_(html, pageUrl) {
  const mainHtml = capMainContentHtml_(html);
  const origin = (/^(https?:\/\/[^\/]+)/i.exec(pageUrl) || [])[1] || '';
  const seen = {}, out = [];
  const re = /<a[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(mainHtml)) !== null) {
    let href = repickDecode_(m[1].trim());
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (href.indexOf('//') === 0) href = 'https:' + href;
    else if (href.charAt(0) === '/') href = origin + href;
    else if (!/^https?:/i.test(href)) continue;
    href = repickTrim_(href);

    if (repickIsJunkHost_(href)) continue;
    href = repickTrim_(repickUnwrap_(href));
    if (repickIsJunkHost_(href) || !repickIsSaneUrl_(href)) continue;

    let text = repickDecode_(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (repickIsCssJunk_(text) || text === '©') text = '';

    const key = href.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ url: href, text: text });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Whether a chase-target link actually relates to the category's topic --
 * added 2026-08-27 after confirmedStubCheck() showed the document-format
 * check alone (STUB_DOC_EVIDENCE) isn't enough on its own: a TAMU System
 * contract-management handbook and a Warner Pacific strategic plan PDF
 * both "looked like a document" without having anything to do with
 * hazing, reporting, or conduct. Reuses the exact primary/secondary
 * keyword lists (CATEGORIES) and matcher (matchesKeyword_) already
 * trusted everywhere else in this file for judging relevance, rather
 * than inventing a new rule just for this.
 */
function capLinkIsTopicallyRelevant_(link, categoryKey) {
  const cat = CATEGORIES[categoryKey];
  if (!cat) return false;
  const blob = (link.url + ' ' + link.text).toLowerCase();
  const keywords = (cat.primaryKeywords || []).concat(cat.secondaryKeywords || []);
  return keywords.some(function (k) { return matchesKeyword_(blob, k); });
}

function capOneRow_(record) {
  const url = record.fields[CF.candidateUrl] || '';
  const catObj = record.fields[CF.category];
  const category = (catObj && catObj.name) ? catObj.name : String(catObj || '');
  const isReportForm = (category === 'Report Form');
  const determination = record.fields[CAND_F_DETERMINATION] || '';
  const unreviewed = !determination || determination === 'Not reviewed';

  const base = {
    id: record.id, fetchStatus: 'Fetch failed', stored: '', charCount: 0,
    truncated: false, contentHash: '', signals: '',
    textFormat: isReportForm ? CAPTURE_FORMAT_REPORT_FORM : CAPTURE_FORMAT_OTHER,
    // NOTHING WAS CAPTURED on any early-return path below, so the free
    // pre-filter cannot run on this row -- not "has not yet run". The
    // distinction is the reviewer's, not the machine's: 'Not yet run' names
    // a step a person could go and complete, and for a robots-blocked or
    // HTTP-error row no such step exists. Changed 2026-09-01, when 136 of
    // 146 unclassified rows turned out to be permanently unclassifiable and
    // were sitting under a label that implied the opposite.
    //
    // 'Not yet run' still exists and still means genuinely pending -- it is
    // what pfClassify_ (PreFilterResult.gs) returns for a Report Form page
    // with no form of its own, deferring to the link pass. Two values, two
    // meanings; rflResolvePrefilter_ treats both as still-open.
    prefilterResult: 'Unable to run - no page text',
    newCandidateUrl: ''   // set only when the stub chase rewrites the URL
  };

  if (!url) return Object.assign(base, { fetchStatus: 'Fetch failed', signals: 'no candidate URL on this row' });
  if (capRobotsDisallows_(url)) return Object.assign(base, { fetchStatus: 'Blocked by robots.txt' });

  const fetched = capFetchAndExtract_(url);
  if (!fetched.ok) {
    if (fetched.code) return Object.assign(base, { fetchStatus: 'HTTP error', signals: 'HTTP ' + fetched.code });
    return Object.assign(base, { fetchStatus: 'Fetch failed', signals: fetched.reason });
  }
  if (fetched.isPdf && !fetched.bodyText) {
    return Object.assign(base, {
      fetchStatus: 'PDF - not extracted',
      signals: 'OCR conversion produced no text (unreadable/scanned PDF, Advanced Drive Service not enabled, or quota exceeded)'
    });
  }
  if (fetched.isImage) {
    return Object.assign(base, {
      fetchStatus: 'Image - not extracted',
      signals: 'URL/Content-Type indicates an image (' + url.slice(0, 90) + ') -- no text to extract, never a valid candidate'
    });
  }

  let isPdf = fetched.isPdf, bodyText = fetched.bodyText, html = fetched.html || '';
  let title = fetched.title, headings = fetched.headings, forms = fetched.forms;
  let effectiveUrl = url;
  let chaseNote = '';

  // ONE-HOP STUB CHASE (added 2026-08-27). A short landing page that just
  // points at the real document elsewhere -- "Download Student Handbook
  // PDF" and nothing else -- gets confirmed by reviewers based on where it
  // LEADS, but the pipeline only ever captured the thin shell, leaving
  // nothing for pre-filter/confidence/a future AI standards check to judge.
  //
  // Hazing Policy/Report Form ONLY -- CHTR must stay the index page on
  // purpose (chtr_index_url's whole design depends on staying stable while
  // individual reports come and go; see CATEGORIES.chtr). Only for
  // UNREVIEWED rows -- rewriting Candidate URL out from under an existing
  // Reviewer determination is a different, higher-stakes action a person
  // should do deliberately (see the separate confirmed-row stub check),
  // not something a capture pass does silently.
  //
  // Capped at exactly one hop: if the target ALSO looks thin, this is left
  // for a person rather than chased further -- chaseNote records why nothing
  // changed instead of failing silently.
  if (!isPdf && unreviewed && (category === 'Hazing Policy' || category === 'Report Form')
      && bodyText.length < STUB_MAX_CHARS) {
    const links = capAllLinks_(html, url);
    const categoryKey = CAT_LABEL_TO_KEY[category];
    const target = links.find(function (l) {
      return (STUB_DOC_EVIDENCE.test(l.url) || STUB_DOC_EVIDENCE.test(l.text)) &&
        capLinkIsTopicallyRelevant_(l, categoryKey);
    });
    if (target) {
      const chased = capFetchAndExtract_(target.url);
      const targetTooThin = chased.ok && !chased.isPdf && chased.bodyText.length < STUB_MAX_CHARS;
      const targetPdfEmpty = chased.ok && chased.isPdf && !chased.bodyText;
      if (chased.ok && !targetTooThin && !targetPdfEmpty) {
        effectiveUrl = target.url;
        isPdf = chased.isPdf;
        bodyText = chased.bodyText;
        html = chased.html || '';
        title = chased.title;
        headings = chased.headings;
        forms = chased.forms;
        chaseNote = 'chasedFrom: ' + url;
      } else {
        chaseNote = 'stubDetected: possible target ' + target.url + ' (' +
          (!chased.ok ? (chased.reason || 'fetch failed')
            : targetTooThin ? 'also looks thin' : 'PDF produced no text') +
          ') -- needs a person, not chased';
      }
    }
  }

  let navText = '';
  if (!isPdf) {
    navText = capNavOnlyText_(html);
  }

  // Free pre-filter classification. See PreFilterResult.gs for pfClassify_
  // and capNavOnlyText_ (declared there, visible here through Apps
  // Script's shared global scope, same as CrossSeed.gs already borrows
  // from this file). Report Form's "no form found" case cannot be decided
  // here for HTML pages -- it needs the outbound-link pass in section 3 --
  // so pfClassify_ leaves it at 'Not yet run' when the page has no form of
  // its own; rflWrite_ resolves that case as the link pass reaches each
  // row, instead of this needing a separate stage.
  //
  // A PDF is a genuine exception, not a special case of the same rule: the
  // link pass reads HTML <a> tags, which a PDF has none of, so a PDF
  // Report Form candidate deferred the normal way would sit at
  // 'Not yet run' forever -- there is no later stage that will ever reach
  // it. And a PDF is NOT automatically the wrong answer for Report Form:
  // some schools' actual reporting mechanism is a downloadable PDF a
  // person fills out and emails in. So a PDF Report Form candidate
  // resolves immediately, using the same RP_FORM_EVIDENCE signal
  // repickPick_ already trusts to judge whether an HTML link looks like a
  // real form (vs. a page that merely mentions the topic), applied here to
  // the PDF's own extracted text and URL instead of a link's blob.
  let prefilterResult;
  let pdfLooksLikeForm = null;
  if (isPdf && isReportForm) {
    pdfLooksLikeForm = RP_FORM_EVIDENCE.test(bodyText.toLowerCase()) || RP_FORM_EVIDENCE.test(effectiveUrl.toLowerCase());
    prefilterResult = pdfLooksLikeForm ? 'Passed' : 'Dropped - no form found';
  } else {
    prefilterResult = pfClassify_(category, bodyText, navText, forms.isReportForm);
  }

  // A PDF has no HTML form markup to preserve, so it always gets the plain
  // stored text -- the TITLE/HEADINGS/FORM MARKUP wrapper only makes sense
  // for an actual HTML page.
  let stored = bodyText;
  if (isReportForm && !isPdf) {
    // Form markup and page text, never one instead of the other. A page can
    // carry a search box while the real content sits in the body -- storing
    // only the form would discard the thing the AI needs to read. Order
    // matters: title and headings first, form markup next, body text last,
    // so truncation cuts context rather than evidence.
    stored = 'TITLE: ' + title + '\nHEADINGS: ' + headings.join(' | ') + '\n\n' +
      (forms.markup ? 'FORM MARKUP:\n' + forms.markup + '\n\n' : 'NO FORM FOUND ON PAGE\n\n') +
      'PAGE TEXT:\n' + bodyText;
  }

  const truncated = stored.length > CAPTURE_MAX_CHARS;
  if (truncated) stored = stored.slice(0, CAPTURE_MAX_CHARS) + '...[truncated]';

  const signals = [
    'hasReportForm: '   + forms.isReportForm,
    'formReason: '      + forms.reason,
    'hazingInFraming: ' + /hazing/i.test(title + ' ' + headings.join(' ') + ' ' + effectiveUrl),
    'hazingInOptions: ' + /hazing/i.test(forms.markup),
    'bodyChars: '       + bodyText.length,
    'formCount: '       + forms.count
  ].concat(pdfLooksLikeForm === null ? [] : ['pdfFormEvidence: ' + pdfLooksLikeForm])
   .concat(chaseNote ? [chaseNote] : [])
   .join('\n');

  return Object.assign(base, {
    fetchStatus: 'Fetched',
    stored: stored,
    charCount: stored.length,
    truncated: truncated,
    // ALWAYS THE STRIPPED BODY TEXT, never `stored`. On Report Form rows
    // `stored` is text plus form markup, whose hidden token fields change
    // on every capture -- hashing it would report a changed page each time.
    // hazHashPlain_ is the shared normaliser in ContentHash.gs; it is what
    // makes this value comparable with the Live URL Checks hash of the same
    // page. Was capSha256_(bodyText) until 2026-09-01 -- same algorithm, but
    // unnormalised, so the two tables could never agree. See ContentHash.gs.
    contentHash: hazHashPlain_(bodyText),
    signals: signals,
    prefilterResult: prefilterResult,
    textFormat: isPdf ? CAPTURE_FORMAT_OTHER : base.textFormat,
    newCandidateUrl: effectiveUrl !== url ? effectiveUrl : ''
  });
}

// ---- robots.txt (per-execution cache: 5 candidates on one domain read it once) ----
var CAP_ROBOTS_CACHE = {};

function capRobotsDisallows_(url) {
  const m = /^(https?:\/\/[^\/]+)/i.exec(url);
  if (!m) return false;
  const origin = m[1];
  if (!(origin in CAP_ROBOTS_CACHE)) CAP_ROBOTS_CACHE[origin] = capRobotsRules_(origin);
  const rules = CAP_ROBOTS_CACHE[origin];
  if (!rules.length) return false;
  const path = url.slice(origin.length) || '/';
  for (let i = 0; i < rules.length; i++) if (path.indexOf(rules[i]) === 0) return true;
  return false;
}

function capRobotsRules_(origin) {
  let text = '';
  try {
    const r = UrlFetchApp.fetch(origin + '/robots.txt',
      { headers: SM_BROWSER_HEADERS, muteHttpExceptions: true, followRedirects: true });
    if (r.getResponseCode() === 200) text = r.getContentText();
  } catch (err) { return []; }
  const rules = [];
  let applies = false;
  text.split('\n').forEach(function (line) {
    const t = line.trim();
    if (/^user-agent:/i.test(t)) applies = (t.replace(/^user-agent:/i, '').trim() === '*');
    else if (applies && /^disallow:/i.test(t)) {
      const p = t.replace(/^disallow:/i, '').trim();
      if (p) rules.push(p);
    }
  });
  return rules;
}

// ---- Page parsing ----
// WHAT THIS MAY AND MAY NOT CONCLUDE: the script gathers evidence, the AI
// judges the standard. hasReportForm, hazingInFraming and hazingInOptions
// are reported SEPARATELY and never combined into a verdict here. Decision
// #147 has two limbs -- a form specifically for hazing, OR a general form
// where hazing is selectable -- and an early version tested only the hazing
// half, passing Touro's policy page whose only "form" is a campus location
// filter. An unreadable page claims nothing at all.
const CAP_REPORT_HINTS = ['describe','description','incident','report','complaint','what happened',
                          'date of','location of','witness','anonymous','concern','allegation'];
const CAP_NON_REPORT_HINTS = ['search','subscribe','newsletter','sign in','signin','log in','login','password'];

function capForms_(html) {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const selects = html.match(/<select[\s\S]*?<\/select>/gi) || [];
  const pieces = forms.concat(selects.filter(function (s) { return forms.join(' ').indexOf(s) === -1; }));
  const markup = pieces.join('\n\n');

  if (!forms.length) return { count: 0, markup: markup, isReportForm: false, reason: 'no form on page' };

  // Judge each form separately -- a page can hold both a search box and a
  // real report form, and the search box must not disqualify the page.
  for (let i = 0; i < forms.length; i++) {
    const blob = capEnt_(forms[i]).toLowerCase();
    const hasTextarea = /<textarea/i.test(forms[i]);
    let hints = 0;
    for (let h = 0; h < CAP_REPORT_HINTS.length; h++) if (blob.indexOf(CAP_REPORT_HINTS[h]) !== -1) hints++;
    let nonReport = false;
    for (let n = 0; n < CAP_NON_REPORT_HINTS.length; n++) if (blob.indexOf(CAP_NON_REPORT_HINTS[n]) !== -1) { nonReport = true; break; }
    if (hasTextarea && hints >= 1) return { count: forms.length, markup: markup, isReportForm: true, reason: 'textarea + report wording' };
    if (!nonReport && hints >= 2)  return { count: forms.length, markup: markup, isReportForm: true, reason: hints + ' report-field hints' };
  }
  return { count: forms.length, markup: markup, isReportForm: false,
           reason: forms.length + ' form(s), none look like a report form' };
}

function capTitle_(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? capEnt_(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '(none)';
}

function capHeadings_(html) {
  const out = [];
  const re = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = capEnt_(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (t && out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

// capNavOnlyText_ is declared in PreFilterResult.gs, not here -- visible
// through Apps Script's shared global scope, same as pfClassify_/PF_F_RESULT.
function capText_(html) {
  return capEnt_(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function capEnt_(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&mdash;/gi, '-').replace(/&ndash;/gi, '-').replace(/&hellip;/gi, '...')
    .replace(/&#x([0-9a-f]+);/gi, function (m, x) { return String.fromCharCode(parseInt(x, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
}

// capSha256_ WAS HERE, REMOVED 2026-09-01. It hashed capText_'s output
// directly -- correct input, but with no shared normalisation and no length
// cap, so it could never produce the same value as LiveUrlChecks.gs's MD5
// for the same page. Both now go through ContentHash.gs, which owns the
// strip, the normalisation, the cap and the digest in one place.
//
// Nothing else in this file called it; the one call site was capOneRow_'s
// contentHash, now hazHashPlain_. If you are restoring this function from an
// older copy, you are re-introducing the divergence -- don't.

// =========================================================================
// CONFIRMED-ROW STUB CHECK (added 2026-08-27, alongside the capture-time
// chase in capOneRow_). That chase only ever runs for UNREVIEWED rows --
// rewriting a Candidate URL out from under an existing human verdict is a
// different, higher-stakes action than fixing an unreviewed candidate, so
// it was deliberately left out of the automatic path. This is the manual
// counterpart: finds ALREADY-CONFIRMED Hazing Policy/Report Form rows
// (Confirmed - promote or Right page - below standard -- both mean "this
// IS the right page", independent of standards compliance) that show the
// same short-landing-page pattern, and reports what the likely real
// document is so a person can re-review and update deliberately.
//
// READ-ONLY, ALWAYS. This never writes to Airtable and never touches a
// row's Candidate URL -- only capOneRow_'s chase does that, and only for
// unreviewed rows. No dry-run/real-run split exists here because there is
// nothing for a dry run to hold back.
//
// Live re-fetch per row (stored Page text is the stripped body, not the
// raw HTML a link needs to be found in), so this makes real HTTP calls --
// same politeness delay as every other live-fetch pass in this file.
// =========================================================================

function confirmedStubCheck() {
  const pat = capPat_();
  const formula = encodeURIComponent(
    'AND(' +
      'OR({' + CF.category + '}="Hazing Policy",{' + CF.category + '}="Report Form"), ' +
      'OR({' + CAND_F_DETERMINATION + '}="Confirmed - promote",{' + CAND_F_DETERMINATION + '}="Right page - below standard"), ' +
      '{' + CF.charCount + '} < ' + STUB_MAX_CHARS +
    ')'
  );
  const fields = [CF.candidateUrl, CF.category, CAND_F_DETERMINATION, CF.charCount, SM_CF_UNITID]
    .map(function (f) { return 'fields[]=' + f; }).join('&');

  const rows = [];
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + formula + '&pageSize=100&returnFieldsByFieldId=true&' + fields;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) { rows.push(r); });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  const stubs = [], clean = [], failed = [];

  rows.forEach(function (r) {
    const url = r.fields[CF.candidateUrl] || '';
    if (!url) return;
    const fetched = capFetchAndExtract_(url);
    if (!fetched.ok) { failed.push({ unitid: r.fields[SM_CF_UNITID], url: url, reason: fetched.reason }); return; }
    if (fetched.isPdf) return;   // already a PDF -- nothing further to chase, not this check's job

    const links = capAllLinks_(fetched.html, url);
    const catObj = r.fields[CF.category];
    const categoryName = (catObj && catObj.name) ? catObj.name : String(catObj || '');
    const categoryKey = CAT_LABEL_TO_KEY[categoryName];
    const target = links.find(function (l) {
      return (STUB_DOC_EVIDENCE.test(l.url) || STUB_DOC_EVIDENCE.test(l.text)) &&
        capLinkIsTopicallyRelevant_(l, categoryKey);
    });
    const detObj = r.fields[CAND_F_DETERMINATION];
    const detName = (detObj && detObj.name) ? detObj.name : String(detObj || '');

    if (target) {
      stubs.push({
        unitid: r.fields[SM_CF_UNITID], determination: detName,
        currentUrl: url, likelyTarget: target.url, chars: r.fields[CF.charCount]
      });
    } else {
      clean.push({ unitid: r.fields[SM_CF_UNITID], url: url });
    }
    Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
  });

  let s = '\n======== CONFIRMED-ROW STUB CHECK ========\n' +
    rows.length + ' already-reviewed, short (<' + STUB_MAX_CHARS + ' char) row(s) checked.\n\n' +
    stubs.length + ' likely stub(s) -- needs manual re-review:\n';
  stubs.forEach(function (st) {
    s += '  ' + st.unitid + '  (' + st.determination + ', ' + st.chars + ' chars)\n' +
         '    current:       ' + st.currentUrl + '\n' +
         '    likely target: ' + st.likelyTarget + '\n';
  });
  s += '\n' + clean.length + ' short-but-clean row(s) -- no document-like outbound link found, left alone.\n';
  if (failed.length) {
    s += failed.length + ' row(s) failed to re-fetch (skipped): ' +
      failed.map(function (f) { return f.unitid + ' (' + f.reason + ')'; }).join(', ') + '\n';
  }

  Logger.log(s);
  return { checked: rows.length, stubs: stubs.length, clean: clean.length, failed: failed.length };
}

// =========================================================================
// UNREVIEWED STUB BACKFILL (added 2026-08-27). capOneRow_'s chase only
// fires on ITS OWN capture pass -- a row already sitting at "Fetched"
// from before the chase existed will never be re-touched by a normal
// capture run (that only picks up "Not yet fetched" rows). This re-runs
// capOneRow_ specifically on already-captured, UNREVIEWED, short Hazing
// Policy/Report Form rows, so they get upgraded to whatever capture would
// produce today instead of sitting on a landing-page URL discovery/
// cross-seed would no longer suggest under current logic.
//
// Same shape as pdfBackfill_: capOneRow_ and capWriteBack_ do the real
// work, this just selects the right rows and reports what changed.
// =========================================================================

function stubBackfillFetchRows_(pat, howMany) {
  const formula = encodeURIComponent(
    'AND(' +
      'OR({' + CF.category + '}="Hazing Policy",{' + CF.category + '}="Report Form"), ' +
      'OR({' + CAND_F_DETERMINATION + '}="",{' + CAND_F_DETERMINATION + '}="Not reviewed"), ' +
      '{' + CF.fetchStatus + '}="Fetched", ' +
      '{' + CF.charCount + '} < ' + STUB_MAX_CHARS +
    ')'
  );
  const fields = [CF.candidateUrl, CF.category, CAND_F_DETERMINATION].map(function (f) { return 'fields[]=' + f; }).join('&');
  const url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
    '?filterByFormula=' + formula +
    '&pageSize=' + Math.min(100, howMany) + '&returnFieldsByFieldId=true&' + fields;
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
  Utilities.sleep(210);
  return JSON.parse(resp.getContentText()).records;
}

function stubBackfillTestDryRun() { return stubBackfill_(true, 5); }
function stubBackfillTest()       { return stubBackfill_(false, 5); }
function stubBackfillDryRun()     { return stubBackfill_(true, 200); }
function stubBackfill()           { return stubBackfill_(false, 200); }

function stubBackfill_(dryRun, limit) {
  const pat = capPat_();
  const rows = stubBackfillFetchRows_(pat, limit);

  const results = [];
  let chased = 0, unchanged = 0;
  let s = '\n======== UNREVIEWED STUB BACKFILL' + (dryRun ? ' DRY RUN' : '') + ' ========\n';

  rows.forEach(function (r) {
    // capOneRow_ already has the chase built in, gated on category +
    // unreviewed + short body text -- the query above just narrows down
    // to likely candidates cheaply via the stored Character count; the
    // real decision inside capOneRow_ uses a fresh live fetch either way.
    const res = capOneRow_(r);
    results.push(res);
    if (res.newCandidateUrl) chased++; else unchanged++;
    s += '\n' + (r.fields[CF.candidateUrl] || '').slice(0, 90) + '\n' +
      (res.newCandidateUrl ? '  -> chased to: ' + res.newCandidateUrl.slice(0, 90) + '\n' : '  (unchanged)\n') +
      '  status: ' + res.fetchStatus + '  chars: ' + res.charCount + '  pre-filter: ' + res.prefilterResult + '\n';
    Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
  });

  s += '\n' + rows.length + ' unreviewed short row(s) examined -- ' + chased +
    ' chased to a new URL, ' + unchanged + ' left as-is.\n';

  if (dryRun) {
    s += 'Nothing written to Airtable.\n';
    Logger.log(s);
    return { examined: rows.length, chased: chased, unchanged: unchanged, dryRun: true };
  }

  capWriteBack_(pat, results);
  s += 'Written.\n';
  Logger.log(s);
  return { examined: rows.length, chased: chased, unchanged: unchanged };
}

// =========================================================================
// 3. REPORT FORM LINK PASS
// =========================================================================
// RUN: runReportFormLinkPass()   -- works 4.5 min, stops, says what is
//                                   left. Run again to continue.
//      reportFormLinkStatus()    -- how many remain, no fetching.
//      compareReportFormPasses() -- old detector vs new, side by side.
//
// WHY THIS EXISTS. Profiling 15 human-confirmed Report Form URLs found 13
// (87%) on a third-party domain: cm.maxient.com (8), *-advocate.symplicity
// (3), Qualtrics, Google Forms. Only 2 were on the school's own site.
// Across all 491 fetched candidates, only 7% have a form on the page.
//
// The sitemap crawler reads the SCHOOL's sitemap.xml, so it can never
// surface a cm.maxient.com URL. For this category the page it finds is a
// stepping stone: the school page that LINKS to the real form. So extract
// the outbound link and propose THAT.
//
// NON-DESTRUCTIVE. Writes only the three link fields. Page text, Content
// hash, Fetch status and Pre-filter signals are left alone.
//
// THE RULES LIVE IN SECTION 4, NOT HERE. Keeping a second copy is how the
// two halves drift apart.
//
// KNOWN LIMITATION: the tag regex stops at the first ">", including one
// inside a quoted attribute, so an anchor using Tailwind arbitrary variants
// (class="[.small>&]:leading-tight") is invisible and any form link inside
// it is lost. Roanoke is the known example. A proper fix needs an attribute
// parser rather than a regex.
// -------------------------------------------------------------------------

const RFL_TIME_BUDGET_MS = 4.5 * 60 * 1000;
const RFL_WRITE_BATCH = 10;
const RFL_PAGE_SIZE = 30;

function reportFormLinkStatus() {
  const pat = capPat_();
  const n = rflCountRemaining_(pat);
  Logger.log('Report Form rows still needing the link pass: ' + n);
  return n;
}

function runReportFormLinkPass() {
  const pat = capPat_();
  const started = Date.now();
  let processed = 0, found = 0, failures = 0, dropped = 0;
 
  rflDupLoadSeen_(pat);
 
  while (Date.now() - started < RFL_TIME_BUDGET_MS) {
    const rows = rflFetchRows_(pat, RFL_PAGE_SIZE);
    if (!rows.length) {
      Logger.log('Link pass complete. Processed ' + processed + ' row(s) this run, ' +
                 found + ' with a linked form found, ' +
                 dropped + ' dropped as duplicate forms.');
      return { done: true, processed: processed, found: found, dropped: dropped };
    }
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      if (Date.now() - started >= RFL_TIME_BUDGET_MS) break;
      const r = rflOneRow_(rows[i]);
      r.existingSignals = String((rows[i].fields || {})[CF.signals] || '');
      if (r.linkedUrl) found++;
      if (r.dupOf) dropped++;
      results.push(r);
      Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
    }
    failures += rflWrite_(pat, results);
    processed += results.length;
  }
 
  const left = rflCountRemaining_(pat);
  Logger.log('Time budget reached. Processed ' + processed + ' this run, ' + found +
    ' with a linked form, ' + dropped + ' dropped as duplicate forms' +
    (failures ? ', ' + failures + ' write batch(es) failed' : '') +
    '.\n' + left + ' row(s) left -- run runReportFormLinkPass() again.');
  return { done: false, processed: processed, found: found,
           dropped: dropped, remaining: left };
}

const RFL_DUPLICATE_VALUE = 'Dropped - duplicate form';
 
// (school, linked form) pairs already spoken for. Loaded once per pass by
// rflDupLoadSeen_, then added to in memory as rows are decided, so two new
// rows in the SAME slice that resolve to one form do not both survive.
// Reassigned per pass, never read before rflDupLoadSeen_ has run.
let RFL_DUP_SEEN = {};
 
/**
 * Every (UNITID, linked form) pair currently in Candidate URLs for Report
 * Form. Rows already dropped as duplicates are included -- harmless, since
 * their form is represented by the survivor anyway -- and so are rejected
 * rows, deliberately: a form a reviewer rejected should not come back as a
 * fresh proposal on another row.
 *
 * Rows awaiting this pass cannot pollute the set: rflFormula_ selects rows
 * with Outbound page links empty, and rflWrite_ writes outbound and
 * Linked form URL in the same PATCH, so an unprocessed row has neither.
 */
function rflDupLoadSeen_(pat) {
  const seen = {};
  let offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + encodeURIComponent(
        'AND({' + CF.category + '} = "Report Form", NOT({' + RFL.linkedUrl + '} = ""))') +
      '&pageSize=100&returnFieldsByFieldId=true' +
      '&fields[]=' + SM_CF_UNITID + '&fields[]=' + RFL.linkedUrl;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable list error loading dedupe keys: ' +
        resp.getContentText().slice(0, 300));
    }
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) {
      const f = r.fields || {};
      const u = String(f[SM_CF_UNITID] || '').trim();
      const lf = String(f[RFL.linkedUrl] || '').trim();
      if (u && lf) seen[u + '|' + pipelineUrlKey_(lf)] = r.id;
    });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);
 
  RFL_DUP_SEEN = seen;
  Logger.log('Dedupe keys loaded: ' + Object.keys(seen).length + ' (school, form) pair(s).');
  return seen;
}
 
/** The key for one row, or '' when it cannot have one. */
function rflDupKey_(unitid, formUrl) {
  const u = String(unitid || '').trim();
  const f = String(formUrl || '').trim();
  if (!u || !f) return '';
  return u + '|' + pipelineUrlKey_(f);
}
 
/** A determination that means a person has actually decided. */
function rflIsReviewed_(v) {
  const s = String(v || '').trim();
  return !!s && s !== 'Not reviewed';
}

// Selection: Report Form, successfully fetched, not yet link-scanned.
// Requires Outbound page links to be EMPTY, so improving the extractor
// does not by itself re-process finished rows. Re-picking from stored links
// is free and covers most rule changes; only a change to what gets
// EXTRACTED needs the field cleared first, at a fetch per row.
//
// WIDENED TO CHTR. Until then the AI reviewing a transparency page saw the
// page's text with every address stripped out, so a link to the report
// arrived as the bare word "View" and the model had to guess whether a report
// existed at all. It guessed differently on two runs of the same page. Giving
// it the actual addresses removes the guess.
//
// THE TWO CATEGORIES ARE SCANNED BY THE SAME PASS BUT KEPT ON DIFFERENT
// RULES. See rflReportLinks_ for why the filter has two arms, and rflWrite_
// for the three Report Form fields a CHTR row must never be given.
function rflFormula_() {
  return encodeURIComponent(
    'AND(OR({' + CF.category + '} = "Report Form", ' +
             '{' + CF.category + '} = "CHTR"), ' +
        '{' + CF.fetchStatus + '} = "Fetched", ' +
        '{' + RFL.outbound + '} = "")'
  );
}

function rflCountRemaining_(pat) {
  let count = 0, offset = null;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + rflFormula_() + '&pageSize=100&returnFieldsByFieldId=true&fields[]=' + CF.candidateUrl;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());
    count += j.records.length;
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);
  return count;
}

function rflFetchRows_(pat, howMany) {
  // CF.signals and PF_F_RESULT are read alongside the candidate URL so
  // rflOneRow_ can resolve Pre-filter result's deferred Report Form case
  // (see capOneRow_) without a second read or a separate pass.
  // SM_CF_UNITID and CAND_F_DETERMINATION are read for the duplicate check:
  // the first forms half the key, the second is the guard that stops a
  // reviewed row ever being collapsed.
  const url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
    '?filterByFormula=' + rflFormula_() + '&pageSize=' + Math.min(100, howMany) +
    '&returnFieldsByFieldId=true&fields[]=' + CF.candidateUrl +
    '&fields[]=' + CF.signals + '&fields[]=' + PF_F_RESULT +
    '&fields[]=' + SM_CF_UNITID + '&fields[]=' + CAND_F_DETERMINATION +
    // Read since the pass covers two categories. EVERY downstream decision
    // branches on it -- which links are kept, which fields are written, and
    // whether the Report Form pre-filter runs at all -- so a row arriving
    // without it would be treated as Report Form and given form fields it
    // has no business carrying.
    '&fields[]=' + CF.category;
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
  Utilities.sleep(210);
  return JSON.parse(resp.getContentText()).records;
}

function rflOneRow_(record) {
  const pageUrl = record.fields[CF.candidateUrl] || '';
  // Category is read here and carried on `out` all the way to rflWrite_.
  // A row whose category is missing or unrecognised is treated as CHTR, the
  // narrower of the two: it gets its links stored and nothing else. Guessing
  // "Report Form" on an unknown row would hand it a form tier and a
  // pre-filter verdict, which is the failure worth avoiding.
  const category = String(record.fields[CF.category] || '');
  const isForm = category === 'Report Form';
  const out = { id: record.id, category: category, isForm: isForm,
                linkedUrl: '', linkedHost: '', tier: '', outbound: '' };
  if (!pageUrl) { out.outbound = '(no candidate URL)'; rflResolvePrefilter_(out, record); return out; }

  let resp;
  try {
    resp = UrlFetchApp.fetch(pageUrl, {
      headers: SM_BROWSER_HEADERS, muteHttpExceptions: true,
      followRedirects: true, validateHttpsCertificates: true
    });
  } catch (err) {
    out.outbound = '(fetch failed: ' + err.message + ')'; rflResolvePrefilter_(out, record); return out;
  }
  if (resp.getResponseCode() !== 200) {
    out.outbound = '(HTTP ' + resp.getResponseCode() + ')'; rflResolvePrefilter_(out, record); return out;
  }

  const html = resp.getContentText();
  const links = rflReportLinks_(html, pageUrl, isForm);
  if (!links.length) {
    out.outbound = isForm ? '(no report-like outbound links)'
                          : '(no outbound links worth keeping)';
    rflResolvePrefilter_(out, record); return out;
  }

  // STORE EVERYTHING, PICK FROM A SUBSET. The outbound list keeps links the
  // picker will not choose (annual security reports, Clery pages) because a
  // stored link costs nothing and re-picking from stored text is free,
  // while re-extracting costs a fetch per row. Rules change; fetches do not
  // come back.
  out.outbound = links.map(function (l) { return l.text + ' -> ' + l.url; }).join('\n').slice(0, 90000);

  // PICKING IS A REPORT FORM JOB AND ONLY A REPORT FORM JOB. rflPick_ chooses
  // the one form a school's row will be judged on and assigns it a Form link
  // tier. A CHTR row has no such thing to choose: its links are stored so a
  // person and the AI can read them, and nothing downstream picks a winner.
  if (isForm) {
    const best = rflPick_(links);
    if (best) { out.linkedUrl = best.url; out.linkedHost = best.host; out.tier = best.tier; }
  }
  rflResolvePrefilter_(out, record);
  return out;
}

/**
 * Finishes Pre-filter result's deferred Report Form case as a side effect
 * of the link pass every row already goes through -- no separate stage.
 * See capOneRow_ / pfClassify_ (PreFilterResult.gs) for the case this
 * resolves: a page with no form of its own, where the only remaining
 * question is whether it links out to one.
 *
 * NEVER OVERWRITES A DECIDED VALUE. A row that pfClassify_ already sent to
 * 'Passed' (had its own form) or 'Dropped - terms only in navigation' at
 * capture time keeps that verdict -- only 'Not yet run' (or blank, for
 * rows captured before Pre-filter result existed) gets set here. Sets
 * out.prefilterResult only when there is something to write; rflWrite_
 * leaves the field untouched on every other row rather than re-sending an
 * unchanged value.
 */
function rflResolvePrefilter_(out, record) {
  // NOT FOR CHTR ROWS, AND THIS GUARD IS LOAD-BEARING. Everything below is
  // Report Form machinery: Pre-filter result's vocabulary ('Passed',
  // 'Dropped - no form found') describes whether a page offers a REPORT FORM,
  // and the duplicate check keys on two rows sharing one form. Run on a CHTR
  // row it would stamp a meaningless verdict and could mark a real
  // transparency page a duplicate of an unrelated one.
  //
  // Placed inside the function rather than at the call sites because
  // rflOneRow_ calls this on all five of its exit paths, and a guard that has
  // to be remembered five times is a guard that gets missed once.
  if (!out.isForm) return;

  const fields = record.fields || {};
  const current = String(fields[PF_F_RESULT] || '');
 
  // ---- duplicate check, first ----------------------------------------
  const key = rflDupKey_(fields[SM_CF_UNITID], out.linkedUrl);
  if (key) {
    const incumbent = RFL_DUP_SEEN[key];
    if (incumbent && incumbent !== out.id) {
      // Three refusals, in order of how much damage each would do.
      if (rflIsReviewed_(fields[CAND_F_DETERMINATION])) {
        // A person decided this row. Their work outranks our tidiness.
      } else if (current.indexOf('Dropped') === 0) {
        // Already out of the queue for another reason; rewriting the
        // reason would lose why.
      } else {
        out.prefilterResult = RFL_DUPLICATE_VALUE;
        out.dupOf = incumbent;
        return;
      }
    } else if (!incumbent) {
      // First row to claim this form. Register it so a later row in this
      // same slice dedupes against it without waiting for a reload.
      RFL_DUP_SEEN[key] = out.id;
    }
  }
 
  // ---- the original deferred-case logic ------------------------------
  // Still-open states: blank (captured before the field existed), the
  // deferred Report Form case, and a row nothing could be captured for --
  // the link pass fetches the page itself, so it can still resolve one.
  if (current !== '' && current !== 'Not yet run' &&
      current !== 'Unable to run - no page text') return;
  const hadForm = String(fields[CF.signals] || '').indexOf('hasReportForm: true') !== -1;
  out.prefilterResult = (hadForm || out.linkedUrl) ? 'Passed' : 'Dropped - no form found';
}

/**
 * A link to a document. Checked before anything else on a CHTR page, because
 * the transparency report is a file far more often than it is a page.
 */
function rflIsDocLink_(href) {
  return /\.(pdf|docx?|xlsx?|pptx?|rtf|csv)(?:[?#]|$)/i.test(String(href || ''));
}

/**
 * How likely a link is to BE the transparency report. CHTR rows only.
 *
 * THIS REPLACED A BLOCKLIST, AND THE REASON IS WORTH KEEPING. The first
 * version kept every same-site link that was not obvious furniture, then
 * capped at 20. McMurry's page returned twenty header-nav links -- "Visit
 * Campus", "How to Apply", "Find Your Major" -- because nav comes first in
 * the HTML and the cap was spent before the parser reached the content. The
 * report link, the entire reason for the change, never got collected. A
 * blocklist cannot be written ahead of time against a university's menu.
 *
 * SCORE THE WHOLE BLOB, HREF INCLUDED, and that is what makes this work where
 * a text-only rule would not. McMurry's link says only "View" -- but its
 * address carries the year, the word, or the file extension. Meanwhile
 * "Visit Campus" pointing at /admissions-overview/campus-tours/ has no signal
 * anywhere in either half, and falls out without anyone naming it.
 *
 * BEING ON THE SCHOOL'S OWN SITE IS NOT, BY ITSELF, A REASON TO KEEP A LINK.
 * Every nav item is on the school's own site. It counts only once something
 * else already does.
 */
function rflChtrScore_(blob, isDoc, host, onSite) {
  let s = 0;
  if (isDoc) s += 100;                                            // a file, usually the report
  if (/hazing|transparency|chtr/.test(blob)) s += 60;
  if (/report|incident|violation|disclosure|biannual|bi-annual|annual/.test(blob)) s += 40;
  if (/(?:19|20)\d{2}/.test(blob)) s += 25;                       // "2024-2025", "Fall 2025"
  if (host) s += 15;                                              // a known vendor
  if (s > 0 && onSite) s += 10;                                   // tiebreak only
  return s;
}

/**
 * Outbound links worth storing, on TWO DIFFERENT RULES.
 *
 * REPORT FORM keeps an ALLOWLIST: a known reporting vendor, or text that
 * reads like a way to report something. That works because a reporting route
 * announces itself -- a Maxient host or the word "report" is strong evidence,
 * and everything else on the page is noise.
 *
 * CHTR KEEPS ALMOST EVERYTHING, and it has to. The link to a transparency
 * report says whatever the school felt like: "View", "2024-2025",
 * "Fall 2025 (PDF)", "Download", a bare year. McMurry's says "View" and
 * nothing else. An allowlist looking for report-ish words drops exactly the
 * links this change exists to capture, so the CHTR arm inverts it: keep the
 * link unless it is obviously site furniture, and require only that it be a
 * document, on the school's own site, or on a known vendor.
 *
 * NOISE IS THE CHEAP FAILURE HERE. A few extra links in a text field cost
 * nothing -- a reader, human or model, skips them. A missing link costs a
 * school its checkmark, silently. Keep the blocklist short.
 *
 * DOCUMENTS ARE LISTED FIRST on CHTR rows. Whatever reads this field reads
 * the top of it most carefully, and on a transparency page the report is
 * usually the PDF.
 */
function rflReportLinks_(html, pageUrl, isForm) {
  const origin = (/^(https?:\/\/[^\/]+)/i.exec(pageUrl) || [])[1] || '';
  const site = repickSite_(pageUrl);
  const seen = {}, out = [];
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
    // check then passes it.
    if (repickIsJunkHost_(href)) continue;
    href = repickTrim_(repickUnwrap_(href));
    if (repickIsJunkHost_(href) || !repickIsSaneUrl_(href)) continue;

    let text = repickDecode_(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (repickIsCssJunk_(text) || text === '©') text = '';

    const blob = (href + ' ' + text).toLowerCase();

    const host = repickVendor_(href, blob, pageUrl);
    const isDoc = rflIsDocLink_(href);
    const onSite = !!site && repickSite_(href) === site;

    let score = 0;
    if (isForm) {
      // Keep a link if it points at a known reporting vendor, or reads like a
      // way to report something. Vendor match alone is enough -- the link
      // text is sometimes just "here".
      if (!host && !/report|incident|complaint|concern|submit|file a/.test(blob)) continue;
    } else {
      // CHTR: keep only links carrying a positive signal. See rflChtrScore_.
      score = rflChtrScore_(blob, isDoc, host, onSite);
      if (score <= 0) continue;
    }

    const key = href.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push({
      url: href,
      text: text ? text.slice(0, 60) : '(no link text)',
      host: host,
      blob: blob,
      hazing: /hazing/.test(blob),
      sameSite: onSite,
      isDoc: isDoc,
      score: score,
      // A report you READ is not a report you FILE. Annual security
      // reports, Clery pages and transparency reports all match "report"
      // and none of them collect anything. Flagged rather than dropped so
      // the stored outbound list stays complete.
      readNotFile: repickIsReadNotFile_(blob, href)
    });
    // REPORT FORM CAPS DURING COLLECTION, AS IT ALWAYS HAS. CHTR DOES NOT --
    // it caps after ranking, below. Capping a page-ordered walk throws away
    // whatever sits furthest down the HTML, and on a university page that is
    // the content: the nav is at the top. This is the bug that returned
    // twenty menu items for McMurry and left out the report.
    //
    // The ceiling here is a runaway guard, not a limit anyone should hit.
    if (isForm && out.length >= 40) break;
    if (!isForm && out.length >= 300) break;
  }

  if (!isForm) {
    // Rank, THEN trim. Highest score first; appearance order breaks ties, so
    // two equally plausible links stay in the order the page put them.
    out.forEach(function (l, i) { l.pos = i; });
    out.sort(function (a, b) {
      return (b.score - a.score) || (a.pos - b.pos);
    });
    return out.slice(0, 20);
  }
  return out;
}

function rflPick_(links) {
  const best = repickPick_(links.filter(function (l) { return !l.readNotFile; }));
  return best ? { url: best.url, host: best.host, tier: best.tier } : null;
}

function rflWrite_(pat, results) {
  let failures = 0;
  const payload = results.map(function (r) {
    const f = {};
    // Outbound links are written for BOTH categories. That is the whole point
    // of the widening.
    f[RFL.outbound] = r.outbound;

    // THESE THREE ARE REPORT FORM ONLY, AND THE GUARD MATTERS MOST FOR THE
    // THIRD. Linked form URL and Linked form host describe the one form a
    // Report Form row is judged on; a CHTR row has no such form, so writing
    // them would state something false. Form link tier is worse: this PATCH
    // sends typecast: true, and a value that matches no existing choice MINTS
    // A NEW ONE. That is how the field acquired a nameless option across 32
    // rows. repickTierLabel_ returns null rather than '' for exactly this
    // reason -- and a CHTR row must not reach it at all.
    if (r.isForm) {
      f[RFL.linkedUrl] = r.linkedUrl;
      f[RFL.linkedHost] = r.linkedHost;
      f[RFL.tier] = repickTierLabel_(r.tier);
    }
    // Only set when rflResolvePrefilter_ actually decided something this
    // round -- a row already Passed or Dropped - terms only in navigation
    // from capture must not be sent back to undefined/blank.
    if (r.prefilterResult) f[PF_F_RESULT] = r.prefilterResult;
    if (r.dupOf) f[CF.signals] = (r.existingSignals ? r.existingSignals + '\n' : '') +
                                 'duplicateOf: ' + r.dupOf;
    return { id: r.id, fields: f };
  });
  for (let i = 0; i < payload.length; i += RFL_WRITE_BATCH) {
    const batch = payload.slice(i, i + RFL_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch, typecast: true }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      failures++;
      Logger.log('Write failed for ' + batch.length + ' row(s): ' + resp.getContentText().slice(0, 300));
    }
    Utilities.sleep(210);
  }
  return failures;
}

// "found by neither" lumps together two different situations -- a page with
// no report-like links at all, and a page whose links exist but none
// qualified. Measured 2026-08-22 of 491 rows: 231 linked form, 26 inline
// form only, 157 links present but none qualifying, 79 nothing at all.
function compareReportFormPasses() {
  const pat = capPat_();
  let offset = null, total = 0, oldFound = 0, newFound = 0, both = 0, neither = 0, onlyNew = 0, onlyOld = 0;
  const hosts = {};

  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + encodeURIComponent(
        'AND({' + CF.category + '} = "Report Form", {' + CF.fetchStatus + '} = "Fetched")') +
      '&pageSize=100&returnFieldsByFieldId=true' +
      '&fields[]=' + CF.signals + '&fields[]=' + RFL.linkedUrl + '&fields[]=' + RFL.linkedHost;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());

    j.records.forEach(function (r) {
      total++;
      const sig = r.fields[CF.signals] || '';
      const o = sig.indexOf('hasReportForm: true') !== -1;
      const n = !!(r.fields[RFL.linkedUrl] || '').trim();
      if (o) oldFound++;
      if (n) newFound++;
      if (o && n) both++;
      else if (n) onlyNew++;
      else if (o) onlyOld++;
      else neither++;
      const h = (r.fields[RFL.linkedHost] || '').trim();
      if (h) hosts[h] = (hosts[h] || 0) + 1;
    });
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  const keys = Object.keys(hosts).sort(function (a, b) { return hosts[b] - hosts[a]; });
  const pct = function (v) { return total ? ' (' + Math.round(v / total * 100) + '%)' : ''; };
  Logger.log(
    '\n========= REPORT FORM: old detector vs linked-form pass =========\n' +
    'Rows compared (Report Form, Fetched): ' + total + '\n\n' +
    '  OLD  form on the page itself     : ' + oldFound + pct(oldFound) + '\n' +
    '  NEW  linked hosted form found    : ' + newFound + pct(newFound) + '\n\n' +
    '  found by both                    : ' + both + '\n' +
    '  found ONLY by the new pass       : ' + onlyNew + '   <-- what the old detector missed\n' +
    '  found ONLY by the old detector   : ' + onlyOld + '\n' +
    '  found by neither                 : ' + neither + pct(neither) + '\n\n' +
    'Hosts: ' + (keys.length ? keys.map(function (k) { return k + ' x' + hosts[k]; }).join(', ') : '(none)')
  );
}

// =========================================================================
// 4. RE-PICK -- the link rules live here
// =========================================================================
// Re-chooses the best linked form from links ALREADY STORED in Outbound
// report links. NO PAGE FETCHES: Airtable calls only, so it is effectively
// free against the daily quota and can be re-run as often as the rules need
// tuning. Section 3 calls into these same functions, so a rule fixed here
// is fixed in both places.
//
// RUN: repickDryRun()  -- reports what would change, writes nothing.
//      repickApply()   -- writes the changes.
//
// TIER ORDER AND WHY, all of it learned from real pages:
//
//   Vendor beats hazing wording. An early version ranked "mentions hazing"
//   first, so Christopher Newport picked cnu.edu/public/hazing.html -- a
//   page, not a form -- while its Maxient form sat in the same list under
//   the text "Report an incident".
//
//   Vendor links are then ranked among themselves by what the link text
//   says the form COLLECTS. Montana Western links TEN Maxient forms:
//   conduct, housing, fire, academic misconduct, CARE referral, pregnancy
//   accommodation, injury. Document order is arbitrary; the link text is
//   the only thing that distinguishes them, and it was being discarded.
//
//   BLANK BEATS WRONG. A tier for "own domain + report wording" was tried
//   and produced 147 picks that were mostly junk -- Heritage picked
//   report-web-issue, William Woods picked an annual security report. The
//   cause is that "report" is a verb in "submit a report" and a noun in
//   "Annual Security Report", and link text does not distinguish them. The
//   tier was removed: a populated field gets trusted, so a wrong value is
//   worse than an empty one.
//
// ENTITY DECODING, three attempts before it was right: decode the href at
// all; decode in a LOOP (some CMSes double-escape, and one pass leaves
// &amp; behind, which looks decoded); and decode entity FORMS rather than a
// hand-written list (WordPress emits &#038;, with a leading zero, so a
// literal &#38; misses it). All three were found by querying Airtable after
// runs that reported success. A green log is not verification.
// -------------------------------------------------------------------------

const REPICK_WRITE_BATCH = 10;

// TWO KINDS OF HOST, and conflating them was a real bug.
//
// A CONDUCT SYSTEM is built for student conduct reporting. Its presence on
// a hazing page is strong evidence. The host alone is enough.
const RP_CONDUCT_SYSTEMS = [
  'maxient.com', 'guardianconduct', 'campusoptics.com',
  'advocate.symplicity.com',      // Symplicity Advocate = conduct reporting
  'getrave.com', 'safecolleges', 'stopit'
];

// A HOTLINE is a corporate ethics & compliance line. Convercent's own
// landing copy is "financial and auditing concerns, harassment, theft,
// substance abuse and unsafe conditions" -- employees, not students.
//
// They are NOT vetoed. Three EthicsPoint tenants were reviewed as correct
// WITH hazing selectable (37117, 79218), so a blanket rejection would have
// destroyed right answers. They are demoted: see repickPick_, where vendor
// class breaks ties within a tier.
const RP_HOTLINES = [
  'ethicspoint.com', 'navexglobal.com', 'navex.com',
  'lighthouse-services.com', 'i-sight.com', 'reportit', 'convercent.com',
  'syntrio.com', 'alertline.com', 'speakup', 'silentwhistle',
  'integritycounts.ca'
];

const RP_REPORTING_SYSTEMS = RP_CONDUCT_SYSTEMS.concat(RP_HOTLINES);

function repickIsConduct_(url) {
  const l = String(url || '').toLowerCase();
  for (let i = 0; i < RP_CONDUCT_SYSTEMS.length; i++) {
    if (l.indexOf(RP_CONDUCT_SYSTEMS[i]) !== -1) return true;
  }
  return false;
}

// Generic form hosts. Real report forms live on these constantly -- Warner
// Pacific's is a Smartsheet, TWU's Spanish form is a Google Form -- so they
// are kept, but gated on purpose wording.
const RP_FORM_BUILDERS = [
  'formstack.com', 'wufoo.com', 'jotform.com', 'qualtrics.com',
  'docs.google.com/forms', 'forms.gle', 'forms.office.com', 'surveymonkey.com',
  'typeform.com', 'cognitoforms.com', 'tfaforms.com', 'ngwebsolutions.com',
  'smartsheet.com/b/form', 'app.smartsheet.com', 'formsite.com',
  '123formbuilder.com', 'machform', 'dynamicforms'
];

const RP_PURPOSE = /hazing|report|incident|complaint|concern|conduct|misconduct|bias|title ?ix|grievance|discriminat|harass/;

// Bare 'symplicity.com' used to be on the vendor list and caught three
// unrelated products. Only Advocate is a reporting system.
const RP_NOT_REPORTING = ['-csm.symplicity.com', 'accommodate.symplicity.com'];

// Not a form, whatever the host: the console you administer forms in, and
// the door you log in through. HSU linked the Google Forms EDITOR for its
// hazing form, Livingstone linked the Qualtrics control panel, Canton's
// best remaining link was a Rave login page, and CSUSM's SimpleSAML
// wrapper was recorded as its report form -- the real page is in ReturnTo.
const RP_NOT_A_FORM = /\/login|\/controlpanel|\/signin|\/sign-in|as_login|docs\.google\.com\/forms\/[^ ]*\/edit|\/admin(\/|$)/;

// What makes a link on the school's OWN site a form rather than a page
// about forms. Deliberately does NOT match a bare "/report-" segment:
// "report-hazing" is a page that tells you how to report, and matching it
// is the same two-meanings-of-report trap that killed the old tier 5.
const RP_FORM_EVIDENCE = /\/forms?\b|[-_]form\b|reportform|submit|file[- _]a[- _]|report[- _]a[- _](concern|incident|violation)|incident[- _]report[- _]form/;

// The LINK can veto the PAGE. Page context rescues opaque form-builder
// URLs, but it must not rescue a form that says outright it is something
// else: McMurry's page mentions misconduct, and its Wufoo link is a
// "Marketing Request Form". When the link names its own purpose and that
// purpose is not reporting, believe the link.
const RP_LINK_VETO = /marketing|recruit|rsvp|registration|register for|application|apply|scholarship|donat|newsletter|subscribe|nomination|ticket|reservation|order form|survey invitation/;

const RP_JUNK_HOSTS = [
  'omniupdate.com',            // CMS admin console; link text is often "&copy;"
  // Self-hosted OU Campus lives on the school's OWN subdomain, so the
  // omniupdate.com entry never caught it.
  'oucampus', 'skin=oucampus', 'action=de&',
  'reddit.com/submit', 'facebook.com/sharer', 'facebook.com/share',
  'twitter.com/intent', 'x.com/intent', 'linkedin.com/share',
  'linkedin.com/shareArticle', 'pinterest.com/pin', 'addthis.com',
  'sharethis.com', 'tumblr.com/share', 'wa.me/', 'api.whatsapp.com'
];

const RP_HAZING   = /hazing/;
const RP_GENERAL  = /incident|student conduct|community standard|code of conduct|concern|behavio|care (referral|report)|conduct report|report a|dean of students|refer a/;
// title[ -]?ix replaces "title ix|title-ix": neither spelling matched the
// compact form vendors actually use in a path --
// maryville-advocate.symplicity.com/titleix_report/ -- so the Title IX
// demotion did nothing on the very row it was written for.
const RP_TITLEIX  = /title[ -]?ix|sexual|harass|discriminat|bias/;
// fire[ _-] replaces the old "fire ": Daemen's pick was
// advocate.symplicity.com/fire_log/index.php and the trailing space meant
// an underscore defeated the whole test.
const RP_OFFTOPIC = /fire[ _-]|fire[ _-]?log|fire[ _-]?report|injur|froi|pregnan|parent|covid|accessib|academic (integrity|misconduct|dishonest)|grade|parking|maintenance|facilit|website|web issue|technolog|help ?desk|absence|travel|dining|food|lost|key request|id card|room change|event registration|timesheet|payroll/;

function repickDryRun()  { repickRun_(false); }
function repickApply()   { repickRun_(true);  }

function repickRun_(doWrite) {
  const pat = capPat_();
  let offset = null, seen = 0, changed = 0, gained = 0, lost = 0, withPick = 0;
  const moves = [], tierCounts = {};

  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + encodeURIComponent(
        'AND({' + CF.category + '} = "Report Form", {' + CF.fetchStatus + '} = "Fetched")') +
      '&pageSize=100&returnFieldsByFieldId=true' +
      '&fields[]=' + CF.candidateUrl + '&fields[]=' + RFL.outbound +
      '&fields[]=' + RFL.linkedUrl + '&fields[]=' + RFL.linkedHost;
    if (offset) url += '&offset=' + offset;

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
    const j = JSON.parse(resp.getContentText());

    const writes = [];
    j.records.forEach(function (r) {
      seen++;
      const pageUrl = r.fields[CF.candidateUrl] || '';
      const best = repickPick_(repickParse_(r.fields[RFL.outbound] || '', pageUrl));

      const oldUrl = (r.fields[RFL.linkedUrl] || '').trim();
      const newUrl = best ? best.url : '';
      const newHost = best ? best.host : '';
      if (best) { withPick++; tierCounts[best.tier] = (tierCounts[best.tier] || 0) + 1; }

      if (newUrl !== oldUrl) {
        changed++;
        if (!oldUrl && newUrl) gained++;
        if (oldUrl && !newUrl) lost++;
        if (moves.length < 30) {
          moves.push('  ' + pageUrl.slice(0, 62) +
            '\n     was: ' + (oldUrl || '(none)').slice(0, 82) +
            '\n     now: ' + (newUrl || '(none)').slice(0, 82) +
            (best ? '   [' + best.tier + ']' : ''));
        }
        const f = {};
        f[RFL.linkedUrl] = newUrl;
        f[RFL.linkedHost] = newHost;
        f[RFL.tier] = best ? repickTierLabel_(best.tier) : null;   // null clears; '' mints a nameless option
        writes.push({ id: r.id, fields: f });
      }
    });

    if (doWrite) repickWrite_(pat, writes);
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset);

  const tiers = Object.keys(tierCounts).sort(function (a, b) { return tierCounts[b] - tierCounts[a]; })
    .map(function (k) { return '    ' + k + ': ' + tierCounts[k]; }).join('\n');

  Logger.log(
    '\n============ RE-PICK ' + (doWrite ? '(APPLIED)' : '(DRY RUN - nothing written)') + ' ============\n' +
    'Rows examined            : ' + seen + '\n' +
    'Rows that end up w/ a URL: ' + withPick + '\n' +
    'Rows whose pick changes  : ' + changed + '\n' +
    '  had none, now has one  : ' + gained + '\n' +
    '  had one, now has none  : ' + lost + '\n' +
    '\nWhere the new picks come from:\n' + tiers +
    '\n\nFirst ' + moves.length + ' changes:\n' + moves.join('\n') +
    (doWrite ? '' : '\n\nIf this looks right, run repickApply().')
  );
}

function repickParse_(outbound, pageUrl) {
  const origin = repickSite_(pageUrl);
  const lines = outbound.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cut = line.lastIndexOf(' -> ');
    if (cut === -1) continue;               // "(no report-like outbound links)" etc.
    let text = repickDecode_(line.slice(0, cut).trim());

    const raw = repickTrim_(repickDecode_(line.slice(cut + 4).trim()));
    if (!/^https?:/i.test(raw)) continue;
    if (repickIsJunkHost_(raw)) continue;
    const url = repickTrim_(repickUnwrap_(raw));
    if (repickIsJunkHost_(url) || !repickIsSaneUrl_(url)) continue;

    if (repickIsCssJunk_(text) || text === '©' || text === '&copy;') text = '';
    const blob = (url + ' ' + text).toLowerCase();
    if (repickIsReadNotFile_(blob, url)) continue;

    // A page cannot be its own report form. Nav bars, breadcrumbs and
    // canonical links routinely point at the current page, and with the old
    // tier 5 that self-link won outright -- 6 rows, including CSU Pueblo,
    // whose confirmed chtr_index_url is that exact URL.
    if (pageUrl && repickNormUrl_(url) === repickNormUrl_(pageUrl)) continue;

    out.push({
      url: url,
      text: text,
      host: repickVendor_(url, blob, pageUrl),
      blob: blob,
      hazing: RP_HAZING.test(blob),
      sameSite: !!origin && repickSite_(url) === origin
    });
  }
  return out;
}

function repickPick_(links) {
  const tiers = [
    ['vendor form, hazing',        function (l) { return l.host && l.hazing; }],
    ['vendor form, incident',      function (l) { return l.host && RP_GENERAL.test(l.blob) && !RP_OFFTOPIC.test(l.blob); }],

    // TITLE IX DEMOTED BELOW UNLABELLED. A Title IX form is scoped to sex
    // discrimination and hazing is outside it; an unlabelled general
    // reporting form is exactly where hazing lands. Maryville's page linked
    // both titleix_report and public_report with identical "Make a Report"
    // text, and the narrower one won. "Unlabelled" has to MEAN unlabelled:
    // without the RP_TITLEIX exclusion this tier is a catch-all that
    // matches Title IX links too, so demoting tier 3 achieved nothing.
    ['vendor form, unlabelled',    function (l) { return l.host && !RP_TITLEIX.test(l.blob) && !RP_OFFTOPIC.test(l.blob); }],

    // TIER REMOVED: 'vendor form, title ix'. It kept 14 rows. Twelve of the
    // 21 rows kept by this tier and the other-purpose tier were in the
    // 2026-08-22 review and ALL TWELVE were judged wrong. Hazing is outside
    // Title IX's scope by statute, so such a form cannot accept a hazing
    // report under any configuration -- a veto, not a demotion.

    // TIER 5 NARROWED. "Same site + hazing" describes every CHTR index page
    // and hazing policy page a school hosts -- which is why all 29 rows it
    // produced were reviewed as wrong, and why CSU Pueblo's and Manor's
    // confirmed chtr_index_url were filed here as report forms. It needs
    // evidence of a FORM, not of the topic.
    ['own site, hazing form',      function (l) { return l.sameSite && l.hazing && RP_FORM_EVIDENCE.test(l.blob); }],

    // TIER REMOVED: 'vendor form, other purpose'. It kept 7 rows and every
    // one was a form for something else, saying so in its own link text:
    // "Website Feedback", "Report a Web Accessibility Concern" x2, "Fire
    // Log", "COVID19 Reporting Form", "Social Event Registration Form". The
    // vocabularies were not at fault -- they demoted these links out of
    // tiers 2-4, and this tier picked them up anyway, because being
    // off-topic was its whole definition.

    // !sameSite is what makes the tier 5 fix actually bite. This tier is
    // for a hazing link on SOMEONE ELSE'S domain -- Samford's page links a
    // law firm's help-us-stop-hazing. Without it, every same-site hazing
    // page tier 5 had just rejected fell straight through and was picked
    // here anyway: 23 rows in the first dry run.
    //
    // RP_FORM_EVIDENCE ADDED 2026-08-23 -- the same narrowing tier 5 got,
    // applied one tier down, for the same reason: topic is not evidence of
    // a form. Found by the first cross-seed dry run. Of 7 proposals, the 2
    // from vendor tiers were both correct and all 5 from THIS tier were
    // wrong: a policy PDF (ComplianceBridge), a policy repository
    // (PolicyStat), a hazing hub subdomain, and the Stop Campus Hazing Act
    // on congress.gov, twice.
    //
    // It fires hardest under cross-seeding, and that is not bad luck. The
    // link pass reads a GUESSED candidate page. Cross-seed reads a page a
    // human already CONFIRMED as CHTR or Hazing Policy -- and a confirmed
    // compliance page reliably links the statute, the policy document and
    // the policy repository. All carry "hazing", all sit off-site, none is
    // a form. Requiring form evidence is the only thing that separates
    // them, and congress.gov needs no junk-host entry once it is required.
    //
    // Safe against reviewed work: the 166 applied picks are incident 86 +
    // unlabelled 70 + hazing 8 + own-site 2 = 166, so no reviewed row sits
    // in this tier. repickDryRun() should still report 0 changes.
    ['outside page, hazing',       function (l) { return l.hazing && !l.sameSite && RP_FORM_EVIDENCE.test(l.blob); }]
  ];

  for (let t = 0; t < tiers.length; t++) {
    // VENDOR CLASS BREAKS TIES WITHIN A TIER. Document order used to
    // decide, and it was wrong twice over: Dillard's page offered a Google
    // Form and the school's own Maxient student-complaints form under
    // identical "Online Reporting Form" text, and the Google Form won on
    // position (its title turned out to be "Title IX Incident"). TAMUV's
    // hazing page listed Convercent above Maxient and Convercent won, while
    // the school's OTHER candidate page picked that same Maxient form
    // correctly.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const conduct = repickIsConduct_(l.url);
        if (pass === 0 && !conduct) continue;   // conduct systems first
        if (pass === 1 && conduct) continue;    // then everything else
        if (tiers[t][1](l)) return { url: l.url, host: l.host, tier: tiers[t][0] };
      }
    }
  }
  return null;
}

// Returns the matched host, or '' if this URL is not a report form.
function repickVendor_(url, blob, pageUrl) {
  const l = url.toLowerCase();
  const text = (blob || l);
  const page = String(pageUrl || '').toLowerCase();

  if (RP_NOT_A_FORM.test(l)) return '';
  for (let i = 0; i < RP_NOT_REPORTING.length; i++) {
    if (l.indexOf(RP_NOT_REPORTING[i]) !== -1) return '';
  }
  for (let i = 0; i < RP_REPORTING_SYSTEMS.length; i++) {
    if (l.indexOf(RP_REPORTING_SYSTEMS[i]) !== -1) return RP_REPORTING_SYSTEMS[i];
  }
  for (let i = 0; i < RP_FORM_BUILDERS.length; i++) {
    if (l.indexOf(RP_FORM_BUILDERS[i]) !== -1) {
      // A form builder counts only when something says what the form is
      // for -- otherwise any form anyone ever built scores as a hazing
      // report form (McMurry's marketing-request-form did).
      //
      // THE PAGE COUNTS AS EVIDENCE, and leaving it out was too strict.
      // forms.office.com/r/P32EssbNUt cannot say what it collects; it is
      // opaque by design. But lyon.edu/file-a-title-ix-report can, and a
      // form linked from that page is that page's form. Dropping those cost
      // 27 rows, several of them real.
      if (RP_LINK_VETO.test(text)) return '';
      return (RP_PURPOSE.test(text) || RP_PURPOSE.test(page)) ? RP_FORM_BUILDERS[i] : '';
    }
  }
  return '';
}

function repickIsJunkHost_(url) {
  const l = url.toLowerCase();
  for (let i = 0; i < RP_JUNK_HOSTS.length; i++) {
    if (l.indexOf(RP_JUNK_HOSTS[i].toLowerCase()) !== -1) return true;
  }
  return false;
}

// Outlook Safe Links and SSO redirects carry the real URL in a parameter.
// The wrapper is tenant-scoped and can expire; the target is the form.
function repickUnwrap_(url) {
  // Proofpoint URL Defense wraps differently from Safe Links -- the real
  // URL sits between __ and __; rather than in a query parameter.
  // Carthage's Google Form arrived this way.
  const pp = /urldefense\.com\/v3\/__(https?:[^ ]*?)__;/i.exec(url);
  if (pp) {
    try { return decodeURIComponent(pp[1]); } catch (e) { return pp[1]; }
  }
  const m = /[?&](?:url|target|TargetResource|RelayState|redirect(?:_uri)?)=([^&]+)/i.exec(url);
  if (!m) return url;
  let inner;
  try { inner = decodeURIComponent(m[1]); } catch (e) { return url; }
  return /^https?:\/\//i.test(inner) ? inner : url;
}

// Sentence punctuation swept up with the href. La Salle stored both
// "?LaSalleUniv" and "?LaSalleUniv." -- the same form, one of them broken.
function repickTrim_(url) {
  return url.replace(/[.,;:!)\]}'"]+$/, '');
}

// A host whose last label is not a plausible TLD is a mangled URL, not a
// site. Catches "www.walsh.eduanti-hazing-policy" -- a missing slash in a
// school's own share link, which would otherwise look like a valid pick.
function repickIsSaneUrl_(url) {
  const host = repickSite_(url);
  if (!host) return false;
  return /\.[a-z]{2,24}$/.test(host.split(':')[0]);
}

// Bare domain, www. stripped, so www.sgsc.edu and sgsc.edu are the same site.
function repickSite_(url) {
  const m = /^https?:\/\/([^\/]+)/i.exec(url || '');
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

// Decode until it stops changing, and decode entity FORMS rather than a
// hand-written list. Percent-encoding (%3a%2f) is left alone -- that is
// legitimate URL encoding inside a query parameter, and decoding it breaks
// links.
function repickDecode_(s) {
  let out = String(s).trim();
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
      .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
    if (next === out) break;
    out = next;
  }
  return out;
}

function repickIsCssJunk_(t) {
  return /\[\.|&\]|:text-|:leading-|\bmd:|\blg:/.test(t);
}

// "Annual Security Report" is a document. "Submit a report" is an action.
function repickIsReadNotFile_(blob, url) {
  // TWO BUGS FIXED HERE.
  // 1. The old test ran /\.pdf(\?|$)/ against the BLOB, which is
  //    url + ' ' + link text. The $ anchor can never match when link text
  //    follows, so the PDF check silently never fired -- which is how
  //    MVNU's Jan-26-Biannual-Anti-Hazing-Report.pdf became a report form.
  //    Test the URL alone.
  // 2. Extension alone is not enough to reject. Touro's
  //    HazingIncidentReportForm.docx is a genuine hazing report form you
  //    download, fill in and file -- reviewed as correct. A document is
  //    only disqualifying when it is a report you READ.
  const u = String(url || blob || '').toLowerCase().split(/\s/)[0];
  const isDoc = /\.(pdf|docx?|rtf|xlsx?)(\?|#|$)/.test(u);
  const saysForm = /form|complaint/.test(u);
  if (isDoc && !saysForm) return true;
  return /annual[- _]?(security|report)|clery|fire[- _]?safety|security[- _]?and[- _]?fire|transparency[- _]?report|crime[- _]?statistic|annual[- _]?disclosure/.test(blob);
}

// Normalised for the self-link test only. Scheme, www, trailing slash and a
// lone index.html all removed -- a page linking to itself does so in
// whichever of those forms its CMS emits.
function repickNormUrl_(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/\/index\.(html?|php|aspx)$/, '/')
    .replace(/[\/?#]+$/, '');
}

function repickWrite_(pat, writes) {
  for (let i = 0; i < writes.length; i += REPICK_WRITE_BATCH) {
    const batch = writes.slice(i, i + REPICK_WRITE_BATCH);
    const resp = UrlFetchApp.fetch(
      'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID,
      { method: 'patch',
        headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
        payload: JSON.stringify({ records: batch, typecast: true }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('Write failed for ' + batch.length + ' row(s): ' + resp.getContentText().slice(0, 300));
    }
    Utilities.sleep(210);
  }
}

// =========================================================================
// 5. PIPELINE SCHEDULER -- runs all three stages unattended
// =========================================================================
// WHAT YOU RUN, ONCE:
//   installPipelineSchedule()   -- turns the schedule on
//   removePipelineSchedule()    -- turns it off, and stops a run in flight
//   pipelineStatus()            -- what is scheduled, and how far along
//   startPipelineNow()          -- run it now, ignoring the calendar
//
// ONE RECURRING TRIGGER, NOT THREE. The stages share a quota, a 20-trigger
// limit and a natural order, so they run as a single chain and a stage
// finishes before the next begins.
//
// THE STAGES, since intake was removed 2026-08-23:
//   1. crossseed     reuse confirmed pages as seeds, CREATE candidate rows
//   2. discover      sweep each school's sitemap, CREATE candidate rows
//   3. capture       fetch each new candidate page, store text and signals
//   4. linkpass      for Report Form rows, extract the linked hosted form,
//                    and drop a row whose form the school already has
//
// The Linked Forms register was removed 2026-08-31. RF-2 and RF-3 are now
// recorded per candidate row, in Hazing selectable and Form access, so
// there is no second table to reconcile.
//
// WHY A DAILY TRIGGER RATHER THAN A QUARTERLY ONE
// A full discovery sweep is ~7,000 fetches and 1.5-2 hours of runtime, but
// a personal Google account allows only 90 MINUTES of trigger runtime per
// DAY. So a full run physically cannot finish in one day, and when the
// daily allowance runs out Google stops running triggers SILENTLY -- the
// chain dies with no error and no email, and a quarterly trigger would not
// come back for months. The daily tick fixes both with one trigger: it
// starts a run on the scheduled day, and on every other day it checks
// whether a run is stalled and restarts the chain if so.
//
// SHARES THE LINK CHECKER'S LOCK ON PURPOSE. Both draw on the same daily
// quota, so running at once would just have them competing.
// -------------------------------------------------------------------------

const PIPELINE_MONTHS = [0, 3, 6, 9];   // Jan, Apr, Jul, Oct (JS months 0-based)
const PIPELINE_START_DAY = 15;
const PIPELINE_TICK_HOUR = 3;           // 3am, after the link checker's 2am

const PIPELINE_SLICE_BUDGET_MS = 4 * 60 * 1000;
const PIPELINE_CHAIN_GAP_MINUTES = 1;
const PIPELINE_WATCHDOG_MINUTES = 8;    // must exceed the 6-minute cap
const PIPELINE_QUOTA_BACKOFF_MINUTES = 360;
const PIPELINE_MAX_SLICES_PER_DAY = 12; // ~54 min, inside the 90-min allowance
const PIPELINE_MAX_SLICES_PER_RUN = 400;
const PIPELINE_MAX_CONSECUTIVE_ERRORS = 3;
const PIPELINE_STALLED_AFTER_MINUTES = 30;

const PIPELINE_STAGES = ['crossseed', 'discover', 'capture', 'linkpass'];
const PIPELINE_STAGE_LABELS = {
  crossseed: 'Cross-seed discovery (reuses confirmed pages as seeds)',
  discover: 'Sitemap discovery (creates candidate rows)',
  capture:  'Candidate page capture',
  linkpass: 'Report Form link pass'
};

const HANDLER_PIPELINE_TICK  = 'pipelineDailyTick';
const HANDLER_PIPELINE_CHAIN = 'pipelineChainRun';

const PROP_PIPELINE_STATE = 'candidatePipelineState';
const PROP_PIPELINE_CATEGORY_INDEX = 'candidatePipelineCategoryIndex';
const PROP_PIPELINE_XS_CATEGORY_INDEX = 'candidatePipelineXsCategoryIndex';

const SM_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function installPipelineSchedule() {
  removePipelineSchedule();
  ScriptApp.newTrigger(HANDLER_PIPELINE_TICK)
    .timeBased().everyDays(1).atHour(PIPELINE_TICK_HOUR).create();
  Logger.log('Pipeline schedule installed. Daily check at ~' + PIPELINE_TICK_HOUR +
    ':00; starts a full run on day ' + PIPELINE_START_DAY + ' of ' +
    PIPELINE_MONTHS.map(function (m) { return SM_MONTH_NAMES[m]; }).join(', ') +
    '; resumes a stalled run on any other day.');
  return pipelineStatus();
}

function removePipelineSchedule() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === HANDLER_PIPELINE_TICK || fn === HANDLER_PIPELINE_CHAIN) {
      ScriptApp.deleteTrigger(t); n++;
    }
  });
  Logger.log('Removed ' + n + ' pipeline trigger(s). Deleting the chain trigger is what ' +
    'actually stops a run in flight, since each slice books the next one.');
  return { removed: n };
}

function pipelineStatus() {
  let tick = false, chain = false;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER_PIPELINE_TICK) tick = true;
    if (t.getHandlerFunction() === HANDLER_PIPELINE_CHAIN) chain = true;
  });
  const s = pipelineRead_();
  Logger.log(
    'Daily tick installed : ' + tick + '\n' +
    'Next slice queued    : ' + chain + '\n' +
    'Runs on              : day ' + PIPELINE_START_DAY + ' of ' +
      PIPELINE_MONTHS.map(function (m) { return SM_MONTH_NAMES[m]; }).join(', ') +
      ' (' + Session.getScriptTimeZone() + ')\n' +
    (s ? ('Current run          : ' + s.status + ', stage ' +
      (s.stageIndex >= PIPELINE_STAGES.length
        ? 'finished'
        : PIPELINE_STAGE_LABELS[PIPELINE_STAGES[s.stageIndex]] +
          ' (' + (s.stageIndex + 1) + ' of ' + PIPELINE_STAGES.length + ')') + '\n' +
          'Started              : ' + s.startedAt + ' by ' + s.startedBy + '\n' +
          'Slices               : ' + s.slices + ' total, ' + s.slicesToday + ' today (cap ' +
            PIPELINE_MAX_SLICES_PER_DAY + ')\n' +
          'Last slice           : ' + (s.lastSliceAt || 'never') + '\n' +
          'Rows                 : ' + (s.stats.created || 0) + ' created, ' +
            (s.stats.alreadyThere || 0) + ' already present, ' +
            (s.stats.captured || 0) + ' captured, ' + (s.stats.linked || 0) + ' link-passed\n' +
          (s.lastError ? 'Last error           : ' + s.lastError + '\n' : '') +
          (s.endNote ? 'Note                 : ' + s.endNote + '\n' : ''))
        : 'Current run          : none yet\n')
  );
  return { tickInstalled: tick, chainPending: chain, run: s };
}

/** Run now, ignoring the calendar. Safe for a first live test. */
function startPipelineNow() {
  const existing = pipelineRead_();
  if (existing && existing.status === 'running' && !pipelineStalled_(existing)) {
    throw new Error('A run is already going (stage ' +
      PIPELINE_STAGES[existing.stageIndex] + ', ' + existing.slices +
      ' slices). Use removePipelineSchedule() to stop it first.');
  }
  pipelineStart_('manual');
  return pipelineStatus();
}

/**
 * Fires once a day. Two jobs, and the second matters most:
 *   - on the scheduled day, start a run
 *   - on ANY day, resume a run whose chain died
 *
 * A chain dies silently when the account's daily trigger runtime is spent,
 * which on a personal account is guaranteed partway through a full sweep.
 * Without this, a run would stop one day and never come back.
 */
function pipelineDailyTick() {
  const now = new Date();
  const state = pipelineRead_();

  if (state && state.status === 'running') {
    if (pipelineStalled_(state)) {
      Logger.log('Run has not advanced in ' + PIPELINE_STALLED_AFTER_MINUTES +
        '+ minutes -- restarting the chain. (Most likely yesterday\'s trigger runtime ran out.)');
      state.slicesToday = 0;
      state.dayStamp = pipelineToday_();
      pipelineWrite_(state);
      pipelineSchedule_(PIPELINE_CHAIN_GAP_MINUTES);
    } else {
      Logger.log('Run is already moving; nothing for the daily tick to do.');
    }
    return;
  }

  const isStartDay = now.getDate() === PIPELINE_START_DAY &&
                     PIPELINE_MONTHS.indexOf(now.getMonth()) !== -1;
  if (!isStartDay) {
    Logger.log('Not a start day and no run in progress -- nothing to do.');
    return;
  }
  pipelineStart_('schedule');
}

/** The self-chaining continuation. Deletes itself on the way in. */
function pipelineChainRun() {
  pipelineDeleteChain_();
  pipelineSlice_();
}

function pipelineStart_(startedBy) {
  // Discovery starts from the top of each category. NOTE: this clears any
  // manual sitemap sweep's saved progress, so do not start a run while one
  // is half-finished.
  SITEMAP_SWEEP_ORDER.forEach(function (k) { resetSitemapProgress(k); });
  PropertiesService.getScriptProperties().setProperty(PROP_PIPELINE_CATEGORY_INDEX, '0');
  SITEMAP_SWEEP_ORDER.forEach(function (k) { xsReset(k); });
  PropertiesService.getScriptProperties().setProperty(PROP_PIPELINE_XS_CATEGORY_INDEX, '0');

  const state = {
    runId: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    startedAt: new Date().toISOString(),
    startedBy: startedBy,
    stageIndex: 0,
    slices: 0,
    slicesToday: 0,
    dayStamp: pipelineToday_(),
    sliceCompleted: true,
    timeouts: 0,
    consecutiveErrors: 0,
    lastError: '',
    lastSliceAt: '',
    stats: { created: 0, alreadyThere: 0, captured: 0, linked: 0, linkedFormsFound: 0 },
    status: 'running',
    finishedAt: '',
    endNote: ''
  };
  pipelineWrite_(state);
  Logger.log('Pipeline run started by ' + startedBy + '. First slice in about ' +
    PIPELINE_CHAIN_GAP_MINUTES + ' minute(s).');
  pipelineSchedule_(PIPELINE_CHAIN_GAP_MINUTES);
  return state;
}

function pipelineSlice_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another run holds the script lock. Trying again shortly.');
    pipelineSchedule_(PIPELINE_CHAIN_GAP_MINUTES);
    return;
  }

  try {
    const state = pipelineRead_();
    if (!state || state.status !== 'running') {
      Logger.log('No run in progress -- chain stopping.');
      return;
    }

    const today = pipelineToday_();
    if (state.dayStamp !== today) { state.dayStamp = today; state.slicesToday = 0; }

    if (state.slicesToday >= PIPELINE_MAX_SLICES_PER_DAY) {
      Logger.log('Daily slice cap reached (' + PIPELINE_MAX_SLICES_PER_DAY +
        '). Stopping for today; the daily tick resumes tomorrow. Nothing is ' +
        'scheduled, so no trigger runtime is spent overnight.');
      state.sliceCompleted = true;
      pipelineWrite_(state);
      return;   // deliberately schedules nothing
    }

    if (state.slices >= PIPELINE_MAX_SLICES_PER_RUN) {
      pipelineFinish_(state, 'aborted', 'Hit the ' + PIPELINE_MAX_SLICES_PER_RUN +
        '-slice guard without finishing. Something is looping rather than progressing.');
      return;
    }

    // A slice killed by the 6-minute cap does NOT throw -- the execution
    // just ends, so nothing below this line would run. Booking the
    // successor first is the only thing that can resume the chain.
    pipelineSchedule_(PIPELINE_WATCHDOG_MINUTES);
    if (state.sliceCompleted === false) {
      state.timeouts = (state.timeouts || 0) + 1;
      Logger.log('Previous slice was killed mid-flight (most likely the 6-minute cap). ' +
        'Resumed by watchdog. Timeouts this run: ' + state.timeouts);
    }
    state.sliceCompleted = false;
    state.slices++;
    state.slicesToday++;
    state.lastSliceAt = new Date().toISOString();
    pipelineWrite_(state);

    const stage = PIPELINE_STAGES[state.stageIndex];
    const deadlineAt = Date.now() + PIPELINE_SLICE_BUDGET_MS;
    let result;

    try {
      if (stage === 'crossseed')     result = pipelineStageCrossSeed_(deadlineAt, state);
      else if (stage === 'discover') result = pipelineStageDiscover_(deadlineAt, state);
      else if (stage === 'capture')  result = pipelineStageCapture_(deadlineAt, state);
      else if (stage === 'linkpass') result = pipelineStageLinkPass_(deadlineAt, state);
      else { pipelineFinish_(state, 'complete', ''); return; }
    } catch (err) {
      state.sliceCompleted = true;
      const msg = String(err && err.message ? err.message : err);

      if (msg.indexOf('Service invoked too many times for one day') !== -1) {
        state.lastError = 'Daily urlfetch quota reached during ' + stage + '.';
        pipelineWrite_(state);
        Logger.log(state.lastError + ' Backing off ' + PIPELINE_QUOTA_BACKOFF_MINUTES +
          ' minutes; the daily tick will also pick this up.');
        pipelineSchedule_(PIPELINE_QUOTA_BACKOFF_MINUTES);
        return;
      }

      state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
      state.lastError = msg;
      pipelineWrite_(state);
      Logger.log('Slice error (' + state.consecutiveErrors + '): ' + msg);
      if (state.consecutiveErrors >= PIPELINE_MAX_CONSECUTIVE_ERRORS) {
        pipelineFinish_(state, 'aborted', 'Gave up after ' + state.consecutiveErrors +
          ' consecutive failures. Last error: ' + msg);
      } else {
        pipelineSchedule_(10);
      }
      return;
    }

    state.sliceCompleted = true;
    state.consecutiveErrors = 0;
    state.lastError = '';

    if (result && result.done) {
      Logger.log(PIPELINE_STAGE_LABELS[stage] + ' finished.');
      state.stageIndex++;
      if (state.stageIndex >= PIPELINE_STAGES.length) {
        pipelineFinish_(state, 'complete', '');
        return;
      }
    }

    pipelineWrite_(state);
    pipelineSchedule_(PIPELINE_CHAIN_GAP_MINUTES);   // replaces the watchdog
  } finally {
    lock.releaseLock();
  }
}

function pipelineFinish_(state, status, note) {
  state.status = status;
  state.finishedAt = new Date().toISOString();
  state.endNote = note || '';
  pipelineWrite_(state);
  pipelineDeleteChain_();
  pipelineEmail_(state);
  Logger.log('Pipeline run ' + status + ' after ' + state.slices + ' slice(s).');
}

function pipelineStageCrossSeed_(deadlineAt, state) {
  const props = PropertiesService.getScriptProperties();
  let idx = parseInt(props.getProperty(PROP_PIPELINE_XS_CATEGORY_INDEX) || '0', 10);

  while (Date.now() < deadlineAt) {
    if (idx >= SITEMAP_SWEEP_ORDER.length) return { done: true };
    const targetKey = SITEMAP_SWEEP_ORDER[idx];
    const res = xsWork_(targetKey, { write: true, limit: 0 }, deadlineAt);
    state.stats.created += (res.stats && res.stats.created) || 0;
    state.stats.alreadyThere += (res.stats && res.stats.skipped) || 0;
    Logger.log('  crossseed/' + targetKey + ': ' +
      ((res.stats && res.stats.created) || 0) + ' row(s) created, done=' + res.done);
    if (res.done) {
      idx++;
      props.setProperty(PROP_PIPELINE_XS_CATEGORY_INDEX, String(idx));
    }
  }
  return { done: idx >= SITEMAP_SWEEP_ORDER.length };
}

function pipelineStageDiscover_(deadlineAt, state) {
  const props = PropertiesService.getScriptProperties();
  let idx = parseInt(props.getProperty(PROP_PIPELINE_CATEGORY_INDEX) || '0', 10);

  while (Date.now() < deadlineAt) {
    if (idx >= SITEMAP_SWEEP_ORDER.length) return { done: true };
    const res = runOrResumeSitemapBatch(SITEMAP_SWEEP_ORDER[idx]);
    state.stats.created += res.rowsCreatedThisBatch || 0;
    state.stats.alreadyThere += res.rowsAlreadyPresent || 0;
    Logger.log('  discover/' + SITEMAP_SWEEP_ORDER[idx] + ': ' +
      res.recordsProcessedThisBatch + ' school(s), ' +
      res.rowsCreatedThisBatch + ' row(s) created, done=' + res.done);
    if (res.done) {
      idx++;
      props.setProperty(PROP_PIPELINE_CATEGORY_INDEX, String(idx));
    }
  }
  return { done: idx >= SITEMAP_SWEEP_ORDER.length };
}

function pipelineStageCapture_(deadlineAt, state) {
  const pat = capPat_();
  while (Date.now() < deadlineAt) {
    const rows = capFetchRows_(pat, CAPTURE_PAGE_SIZE);
    if (!rows.length) return { done: true };

    const results = [];
    for (let i = 0; i < rows.length; i++) {
      if (Date.now() >= deadlineAt) break;
      results.push(capOneRow_(rows[i]));
      Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
    }
    capWriteBack_(pat, results);
    state.stats.captured += results.length;
  }
  return { done: false };
}

function pipelineStageLinkPass_(deadlineAt, state) {
  const pat = capPat_();
  rflDupLoadSeen_(pat);
 
  while (Date.now() < deadlineAt) {
    const rows = rflFetchRows_(pat, RFL_PAGE_SIZE);
    if (!rows.length) return { done: true };
 
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      if (Date.now() >= deadlineAt) break;
      const r = rflOneRow_(rows[i]);
      r.existingSignals = String((rows[i].fields || {})[CF.signals] || '');
      if (r.linkedUrl) state.stats.linkedFormsFound++;
      if (r.dupOf) state.stats.duplicateFormsDropped =
        (state.stats.duplicateFormsDropped || 0) + 1;
      results.push(r);
      Utilities.sleep(CRAWL_POLITENESS_DELAY_MS);
    }
    rflWrite_(pat, results);
    state.stats.linked += results.length;
  }
  return { done: false };
}

function pipelineToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function pipelineStalled_(state) {
  const stamp = state.lastSliceAt || state.startedAt;
  if (!stamp) return true;
  const age = Date.now() - new Date(stamp).getTime();
  if (isNaN(age)) return true;
  // A run parked by the daily slice cap is not stalled -- it is waiting for
  // tomorrow on purpose. Only treat it as dead once a new day has begun.
  if (state.slicesToday >= PIPELINE_MAX_SLICES_PER_DAY && state.dayStamp === pipelineToday_()) {
    return false;
  }
  return age > PIPELINE_STALLED_AFTER_MINUTES * 60 * 1000;
}

function pipelineRead_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_PIPELINE_STATE);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function pipelineWrite_(state) {
  PropertiesService.getScriptProperties()
    .setProperty(PROP_PIPELINE_STATE, JSON.stringify(state));
}

function pipelineSchedule_(delayMinutes) {
  pipelineDeleteChain_();
  ScriptApp.newTrigger(HANDLER_PIPELINE_CHAIN)
    .timeBased().after(Math.max(1, delayMinutes) * 60 * 1000).create();
}

function pipelineDeleteChain_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER_PIPELINE_CHAIN) ScriptApp.deleteTrigger(t);
  });
}

function pipelineEmail_(state) {
  const ok = state.status === 'complete';
  const subject = 'Candidate pipeline ' + (ok ? 'finished' : 'ABORTED') +
    ' -- ' + state.stats.created + ' new candidates, ' + state.stats.captured + ' captured';

  const parts = [
    '<h2>Candidate URL pipeline ' + (ok ? 'finished' : 'aborted') + '</h2>',
    state.endNote ? '<p style="background:#fee;border:1px solid #f99;padding:10px;' +
      'border-radius:6px">' + state.endNote + '</p>' : '',
    '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
    '<tr><td><b>Started</b></td><td>' + state.startedAt + ' (' + state.startedBy + ')</td></tr>' +
    '<tr><td><b>Finished</b></td><td>' + state.finishedAt + '</td></tr>' +
    '<tr><td><b>Slices</b></td><td>' + state.slices +
      (state.timeouts ? ' (' + state.timeouts + ' hit the 6-minute cap and were resumed)' : '') +
      '</td></tr>' +
    '<tr><td><b>New candidate rows</b></td><td>' + state.stats.created +
      ' created, ' + state.stats.alreadyThere +
      ' skipped (already present, or previously rejected)</td></tr>' +
    '<tr><td><b>Pages captured</b></td><td>' + state.stats.captured + '</td></tr>' +
    '<tr><td><b>Link pass rows</b></td><td>' + state.stats.linked + ', of which ' +
      state.stats.linkedFormsFound + ' had a linked form' +
      (state.stats.duplicateFormsDropped
        ? ', ' + state.stats.duplicateFormsDropped + ' dropped as duplicate forms'
        : '') + '</td></tr>' +
    '</table>'
  ];

  // Zero is a legitimate result once every school has been swept, so say
  // which kind of zero it is rather than leaving it to be inferred.
  if (ok && state.stats.created === 0) {
    parts.push('<p style="background:#f3f4f6;border:1px solid #d1d5db;padding:10px;' +
      'border-radius:6px">No new candidates this run. Every URL discovery found was ' +
      'already in the Candidate URLs table, or had been rejected by a reviewer. ' +
      'That is the expected steady state between real changes to school websites.</p>');
  }

  if (typeof notify_ === 'function') {
    notify_(subject, parts.join(''));
  } else {
    Logger.log(subject + '\n' + parts.join('\n').replace(/<[^>]+>/g, ' '));
  }
}

// ---- Discovery gate check (read-only) ----------------------------------
// Counts what the discovery gate will match, using the SAME constants the
// real gate uses -- CATEGORIES, PAGES_BASE_ID, SM_INST_TABLE, SM_F_UNITID --
// so a bad paste or a wrong field ID shows up here instead of as a
// scheduled run that quietly crawls nothing. Fetches no websites and
// writes nothing.

function smGateCheck() {
  const pat = capPat_();
  let out = '\n=========== DISCOVERY GATE CHECK (read-only) ===========\n';

  Object.keys(CATEGORIES).forEach(function (key) {
    const c = CATEGORIES[key];
    const before = smGateCount_(pat, smBlankClause_(c.blankFields));
    const after  = smGateCount_(pat,
      'AND(' + smBlankClause_(c.blankFields) + ', {' + c.pendingCountField + '} = 0)');
    out += '\n' + c.label + '\n' +
      '  blank confirmed URL           : ' + before + '\n' +
      '  ...and nothing awaiting review: ' + after + '   <- discovery crawls these\n' +
      '  skipped by the new gate       : ' + (before - after) + '\n';
  });

  out += '\nTHE GATE READS THE COMPLIANCE FIELDS -- Report Form, Hazing Policy and\n' +
         'Transparency Report -- changed 2026-09-10 in CATEGORIES[].blankFields.\n' +
         'See that header comment before changing any of the three. From\n' +
         '2026-08-26 until then it read the RECORD fields (located_* /\n' +
         'chtr_index_url), and the note printed here described that older\n' +
         'behaviour for two weeks after it stopped being true. Every baseline\n' +
         'below is compliance-measured, so all three rows are comparable.\n' +
         '\nBASELINES -- "blank confirmed URL" / "nothing awaiting review":\n' +
         '  2026-08-23              Report Form 832/644 | Policy 335/289 | CHTR 599/562\n' +
         '  2026-09-10 pre-promote  Report Form 832/790 | Policy 341/332 | CHTR 628/617\n' +
         '  2026-09-10 post-promote Report Form 803/767 | Policy 333/324 | CHTR 620/609\n' +
         '\nReport Form sat at exactly 832 from 2026-08-23 to 2026-09-10 -- three\n' +
         'weeks of review moving nothing -- because reviewed URLs had no write\n' +
         'path into 50 States. Promote.gs is that path. Its first run wrote 213\n' +
         'schools and moved 45 compliance fields (49 gained, 4 cleared).\n' +
         '\nA rising number is not a regression. A flagged promotion fills the\n' +
         'record field and leaves compliance blank on purpose, so the school\n' +
         'stays in the queue; new discovery raises these counts too.\n' +
         '\nA ZERO in the second row of any category means the gate matched nothing.\n' +
         'That is the dangerous failure: discovery would report "done" having\n' +
         'crawled no schools. Check the count field conditions in the Airtable UI.\n';
  Logger.log(out);
}

function smGateCount_(pat, formula) {
  let count = 0, offset = null, guard = 0;
  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + SM_INST_TABLE +
      '?filterByFormula=' + encodeURIComponent(formula) +
      '&pageSize=100&returnFieldsByFieldId=true&fields[]=' + SM_F_UNITID;
    if (offset) url += '&offset=' + offset;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable read failed: ' + resp.getContentText().slice(0, 200));
    }
    const j = JSON.parse(resp.getContentText());
    count += (j.records || []).length;
    offset = j.offset || null;
    Utilities.sleep(210);
  } while (offset && ++guard < 200);
  return count;
}
// ---- One-off discovery test, two schools (WRITES ROWS) ------------------
// Paste at the end of SitemapFinder.gs and run smTestDiscoverTwoSchools
// from the Run dropdown.
//
// WHY A WRAPPER. The Apps Script Run dropdown calls the selected function
// with NO arguments and gives you nowhere to type values, so
// runSitemapForSpecificRecords('chtr', [...]) cannot be started from it.
// The values are baked in here instead. That is the same reason
// xsDryRunReportForm10 and repickDryRun exist.
//
// WHAT THIS EXERCISES. Everything that changed in discovery on 2026-08-23
// and has never run in production since:
//   - fetchRecordsByIds_ reading PAGES Institutions instead of 50 States
//   - the repointed SM_F_* field IDs
//   - processRecord_ crawling a sitemap and ranking candidates
//   - writeSitemapCandidates_ writing DIRECT to Candidate URLs, with the
//     intake stage deleted -- the part of the migration never yet proven
//
// It deliberately does NOT test the new gate: runSitemapForSpecificRecords
// bypasses the blank-field query by design, so it can fill a gap without
// disturbing a sweep's resume point. The gate was proved separately by
// smGateCheck().
//
// THIS WRITES ROWS. Two schools, up to 5 candidates each. Every row it
// creates carries Source = 'Sitemap discovery' and today's date, so they
// are easy to find and delete if the test goes badly.
//
// THE TWO SCHOOLS, chosen 2026-08-23 because each has a blank
// chtr_index_url, zero unreviewed CHTR candidates, an Institution URL
// carrying a proper https:// scheme, and a Hazing Policy already on file
// (so the site is known to have hazing content to find):
//
//   201195  Baldwin Wallace University  (Ohio, ~2,900 undergrad)
//   141325  Wesleyan College            (Georgia, ~500 undergrad)
//
// Two rather than one, and deliberately different sizes: a single school
// returning zero candidates is ambiguous -- it could mean the machinery is
// broken or simply that the school has no CHTR page. Two make that easier
// to read.
//
// ZERO CANDIDATES IS A LEGITIMATE RESULT. What is being tested is that the
// pass runs, writes correctly shaped rows, and reports honestly -- not that
// these particular schools have findable CHTR pages.

function smTestDiscoverTwoSchools() {
  return runSitemapForSpecificRecords('chtr', [
    'rec0As4Umpwfqy1jC',   // 201195  Baldwin Wallace University  https://www.bw.edu/
    'rec1FH1QEp8JvcqyZ'    // 141325  Wesleyan College            https://www.wesleyancollege.edu/
  ]);
}

// -------------------------------------------------------------------------
// TARGETED RECAPTURE (added 2026-08-27), for a specific list of record
// IDs -- built for confirmedStubCheck()'s output. That check finds
// already-reviewed rows sitting on a landing-page stub, but deliberately
// never rewrites Candidate URL itself (that stays a human decision). Once
// you've pasted the real document's URL over the stub by hand, Page text/
// Character count/Content hash/Pre-filter result still describe the OLD
// page -- this re-runs capOneRow_ + capWriteBack_ on just these rows so
// everything else catches up to match, in one step, without waiting for
// (or clearing Fetch status to trigger) a general capture pass that would
// also touch unrelated rows.
//
// Safe to run even on a row you HAVEN'T updated yet -- it just reconfirms
// the same content unchanged. No need to run this separately per row.
//
// THE FOUR ROWS FROM THE 2026-08-27 confirmedStubCheck() RUN:
//   154749  bethelks.edu  (Hazing Policy, Confirmed - promote)
//   217776  swu.edu       (Hazing Policy, Right page - below standard)
//   444398  bua.edu       (Hazing Policy, Right page - below standard)
//   179548  stephens.edu  (Report Form, Right page - below standard --
//                          the one judgment call, only worth including
//                          here once you've actually decided on it)
function recaptureConfirmedStubFixes() {
  return recaptureRows_([
    'rec55PCO3acCBBpUr',   // 154749  bethelks.edu
    'rec7ffsp4NttJDMho',   // 217776  swu.edu
    'recDKx1ikUG3jQLdN',   // 444398  bua.edu
    'recfgjv7f2VJx4jUe'    // 179548  stephens.edu
  ]);
}

function recaptureRows_(recordIds) {
  const pat = capPat_();
  const idFormula = 'OR(' + recordIds.map(function (id) { return 'RECORD_ID()="' + id + '"'; }).join(',') + ')';
  const fields = [CF.candidateUrl, CF.category, CAND_F_DETERMINATION]
    .map(function (f) { return 'fields[]=' + f; }).join('&');
  const url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
    '?filterByFormula=' + encodeURIComponent(idFormula) +
    '&pageSize=' + recordIds.length + '&returnFieldsByFieldId=true&' + fields;
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Airtable list error: ' + resp.getContentText());
  const rows = JSON.parse(resp.getContentText()).records;

  const results = rows.map(function (r) { return capOneRow_(r); });
  capWriteBack_(pat, results);

  let s = '\n======== TARGETED RECAPTURE ========\n' + rows.length + ' row(s) re-captured:\n';
  rows.forEach(function (r, i) {
    s += '\n' + (r.fields[CF.candidateUrl] || '').slice(0, 90) + '\n' +
      '  status: ' + results[i].fetchStatus + '  chars: ' + results[i].charCount +
      '  pre-filter: ' + results[i].prefilterResult + '\n';
  });
  Logger.log(s);
  return { recaptured: rows.length };
}
