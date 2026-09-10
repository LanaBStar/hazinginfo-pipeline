// =========================================================================
// Promote.gs -- promote reviewed candidate URLs into 50 States
// =========================================================================
//
// WHAT THIS IS FOR. Candidate URLs (PAGES) is where a reviewer decides what
// a school's page is and whether it meets HazingInfo's standard. 50 States
// is where the public site reads from. Until this file existed there was no
// write path between them, which is why the compliance-field counts have not
// moved in three weeks: Report Form sat at 832 on 2026-08-23 and at 832 on
// 2026-09-10, identical, while review work piled up with nowhere to go.
//
// NOT THE SAME JOB AS WriteBack.gs. That file promotes from Live URL Checks
// (tblgX19rRaysxSlNu) and answers "is this link still alive". This one
// promotes from Candidate URLs (tblIL5opnHj0lhvvg) and answers "is this the
// right page, and is it good enough". They write to the same six 50 States
// fields under DIFFERENT rules, and this file additionally writes the three
// below-standard reason fields, which WriteBack.gs never touches. Keeping
// them separate is deliberate. Do not merge them.
//
// -------------------------------------------------------------------------
// TWO DETERMINATIONS PROMOTE, AND THEY DIFFER ONLY IN WHICH URL IS WRITTEN
// -------------------------------------------------------------------------
//   Confirmed - promote               -> write Candidate URL
//   Rejected - replacement proposed   -> write REVIEWER-PROPOSED URL
//
// The second one reads as a rejection and is not. The row is rejected as a
// *candidate* -- the reviewer looked at the candidate, found it wrong, and
// typed the correct address into Reviewer-proposed URL. The row still
// produces the school's answer. Promoting Candidate URL on such a row would
// publish the exact page the reviewer threw out.
//
//   Duplicate of confirmed page  -> nothing
//   Rejected - wrong page        -> nothing
//   Needs second opinion         -> nothing
//   (blank)                      -> nothing
//
// -------------------------------------------------------------------------
// THE INVARIANT
// -------------------------------------------------------------------------
// Both the record field (located_* / chtr_index_url) and the compliance
// field hold a URL, and WHERE THE COMPLIANCE FIELD IS FILLED IT HOLDS THE
// SAME URL AS THE RECORD FIELD.
//
//   clean row    -> URL into BOTH fields, reason field emptied
//   flagged row  -> URL into the RECORD field only, compliance emptied,
//                   reason field holds the terms
//
// So the record field is always filled by a promotion and the compliance
// field is a subset of it. Never one without the other; never the two
// holding different URLs.
//
// A CLEAN PROMOTION OVERWRITES whatever the record field held, including a
// below-standard URL filed earlier. It has to -- leaving the old value would
// put a different URL in the record field from the one in compliance, which
// the invariant forbids. Confirmed by Lana 2026-09-09: "those fields should
// always match." Verified holding across the whole table on 2026-09-10 after
// 11 schools were backfilled.
//
// -------------------------------------------------------------------------
// THE CLEARING RULE -- THE ONE MOST LIKELY TO BE FORGOTTEN
// -------------------------------------------------------------------------
// EVERY promotion writes ALL THREE of a category's fields, INCLUDING WRITING
// THEM EMPTY. It never merges, never appends, never skips a field because
// the new value is blank.
//
// A school that fixes its page produces a new promoting row with no
// below-standard terms. If the reason field were only written when terms are
// present, the old reasons would survive: the record would say the page is
// short in ways it no longer is, while the compliance field said it was
// fine. The two would contradict each other, and the reason field is the one
// the public-facing note is built from.
//
// The same in reverse -- a page that degrades must CLEAR the compliance
// field, not merely add reasons alongside it. That is the most consequential
// thing this script does: it can take a green check off a real school's
// public page. Every such case is called out by name in the report, and it
// is the reason the dry run exists.
//
// -------------------------------------------------------------------------
// A FLAGGED PROMOTION NO LONGER RETIRES A SCHOOL FROM DISCOVERY
// -------------------------------------------------------------------------
// SitemapFinder, CrossSeed and SearchProbe were switched to gate on the
// COMPLIANCE fields on 2026-09-10 (verified live with smGateCheck():
// 832 / 341 / 628). Before that they gated on the record fields, so filing
// any URL at all -- including one a reviewer had judged below standard --
// stopped the search for a better one.
//
// Because the gate now reads compliance, a flagged promotion leaves the
// school still needing a page, and discovery keeps looking. That is the
// intended behaviour and it removes the tension the earlier design had.
//
// -------------------------------------------------------------------------
// WHAT IT REFUSES TO DO
// -------------------------------------------------------------------------
// This publishes to a site that tells parents where to report hazing. Every
// guard exists because the cost of a bad write is a wrong link on a real
// school's page, not a failed job.
//
//   * Rejected - replacement proposed with an EMPTY Reviewer-proposed URL is
//     never written. Falling back to Candidate URL would publish the
//     rejected page; skipping quietly would lose the reviewer's answer.
//     It is reported and stamped Skipped - needs attention.
//   * A URL that is not well-formed is never written.
//   * A URL that points at a login wall is never written.
//   * TWO OR MORE promotable rows for the same school AND category are ALL
//     skipped and named. Which URL wins is a reviewer's call, not this
//     script's. Resolve it in Airtable and re-run.
//   * A UNITID matching no 50 States row, or more than one, is skipped.
//   * A below-standard term that does not exist in the DESTINATION
//     vocabulary is refused for the whole row, loudly. Airtable would reject
//     that write per-row anyway; catching it here names the drifted term
//     instead of returning an opaque 422. Parity between the two bases is a
//     build-time requirement, and this is what enforces it at run time.
//   * A write that would change nothing is not sent.
//   * PR_MAX_INSTITUTIONS caps how many schools one run may touch.
//
// ADDED IN THE HARDENING PASS, 2026-09-10 (see below):
//   * A CONFIRMED row that ALSO carries a Reviewer-proposed URL is refused.
//   * A URL that does not belong to the school is refused.
//   * A Google Forms /edit or /formResponse address is refused.
//
// -------------------------------------------------------------------------
// THE HARDENING PASS -- 2026-09-10, AND WHY EACH PART OF IT EXISTS
// -------------------------------------------------------------------------
// THE FIRST DRY RUN PRODUCED 231 ROWS AND SEVEN OF THEM WERE WRONG. THIS
// SCRIPT BLOCKED NONE OF THE SEVEN. Every one satisfied every guard above.
// They were caught by a person reading a log, which is not a control -- it is
// a person being careful once. This pass turns each of those seven into
// something the script refuses or marks, so that the same mistake cannot
// depend on someone being equally careful next time, at speed, on a Friday.
//
// Nothing here is hypothetical. Each guard names the row that motivated it:
//
//   Seattle Pacific   Report Form URL was a umass.edu page      -> ownership
//   Texas A&M-Victoria correct URL, wrong-looking slug          -> exceptions
//   Glenville State   promoting a 2021 handbook while the       -> proposed-URL
//                     reviewer's 2025-26 URL sat unused            block
//   William Peace     Google Forms /edit link                   -> /edit refusal
//   Dominican NY      Maxient FORM promoted into CHTR           -> category flag
//
// TWO KINDS OF OUTCOME, AND THE DIFFERENCE IS THE WHOLE DESIGN:
//
//   REFUSED  the row does not publish. Promote status becomes
//            "Skipped - needs attention" and Promote note says why. Used only
//            where publishing would put a wrong or unusable address on a real
//            school's page.
//
//   FLAGGED  the row PUBLISHES ANYWAY, and Promote flagged is ticked with the
//            reason in Promote note. Used where something is odd but refusing
//            would be the more damaging error -- because a refusal leaves a
//            school with no listed page at all.
//
// FLAGS ARE THE PART MOST LIKELY TO ROT. A flag nobody looks at is worse than
// no flag, because it looks like oversight while providing none. That is why
// it is a CHECKBOX and not only a note: a checkbox can be filtered into a
// view, and a view is how somebody finds these without reading an execution
// log. Build that view -- "Promoted - needs a second look", filtered on
// Promote flagged -- or this half of the pass does nothing.
//
// REFUSALS MUST BE FIXABLE WITHOUT A DEVELOPER. The ownership check will
// refuse addresses that are genuinely correct: state systems, districts,
// shared campuses, vendor tenants named after a school's former identity. The
// escape hatch is the Ownership exceptions table in PAGES, and it is a table
// rather than a constant in this file precisely so that the people running
// this after the deadline can use it. If you find yourself editing this file
// to unblock a school, something has gone wrong with that design -- add the
// row instead.
//
// -------------------------------------------------------------------------
// IT WRITES Promote status BACK TO CANDIDATE URLS. THIS IS DELIBERATE.
// -------------------------------------------------------------------------
// WriteBack.gs deliberately does NOT stamp its source rows, because the
// liveness sweep clears them at a better moment. There is no equivalent
// sweep here, and a reviewed row otherwise gives no sign of whether its
// decision ever reached production.
//
//   Promoted                   -> the 50 States write succeeded
//   Blocked - write failed     -> the write was attempted and rejected
//   Skipped - needs attention  -> promotable, but a guard above stopped it;
//                                 the run report says which
//   (blank)                    -> never in scope for promotion
//
// The status is a record of OUTCOME, not a gate. This script does not skip a
// row because it is already Promoted -- it recomputes what the row should
// produce and compares that against what 50 States holds. That is what makes
// a re-run safe, and what makes a later reviewer edit take effect.
//
// -------------------------------------------------------------------------
// BUILT TO RUN UNATTENDED, BUT NOT YET SCHEDULED
// -------------------------------------------------------------------------
// No prompts, no interactive state, idempotent, and every outcome is stamped
// on the row as it goes rather than held in memory -- because the six-minute
// execution cap DOES NOT THROW. No catch, no finally, nothing at the bottom
// of the function runs. Anything still in memory at the cap is lost.
//
// Do not install a trigger on this until you have watched promoteDryRun()
// and then promoteApplyForReal() by hand and read both reports. When you do,
// the trigger goes on promoteApplyForReal, and it should run BEFORE a
// discovery sweep, not after -- a promotion changes the compliance field,
// which is what the gate reads.
//
// -------------------------------------------------------------------------
// NAMES. Apps Script treats every .gs file in a project as ONE SHARED GLOBAL
// SCOPE, so redeclaring a const anywhere fails the WHOLE project -- and the
// error names whichever file it noticed second, which is usually not the one
// that was edited. Duplicate FUNCTION names are worse: they do not error at
// all, the later definition silently wins, and the caller that wanted the
// other one breaks with no message.
//
// Everything this file declares is prefixed pr / PR_. Verified 2026-09-10
// against all twelve .gs files in apps-script/ on main -- SitemapFinder,
// LiveUrlChecks, CrossSeed, SearchProbe, SiteCensus, HazingDeathsLinks,
// WriteBack, PreFilterResult, ContentHash, WebApp -- plus archive/ and
// diagnostics/: no name beginning PR_, pr<Capital> or promote is declared in
// any of them.
//
// This file declares its own base and table ids rather than borrowing
// SitemapFinder's PAGES_BASE_ID or CF, so it keeps working if that file is
// ever split or retired -- the same choice WriteBack.gs made.
//
// Re-verified 2026-09-10 after the hardening pass, against all fourteen files
// in apps-script/ plus archive/Scheduler.gs and both diagnostics files: no
// name beginning PR_ or pr<Capital> is declared anywhere else in the project,
// and this file declares no name twice.
//
// CMD+A BEFORE PASTING. Twice on 2026-09-10 a paste landed on top of the
// wrong file, once destroying SiteCensus.gs entirely. Check the final line
// number afterwards: this file is 1,778 lines (it was 927 before the
// hardening pass).
// =========================================================================


// ---- Where everything lives ---------------------------------------------
const PR_PAGES_BASE   = 'appEvOdPi94MzZ6Db';   // PAGES
const PR_CAND_TABLE   = 'tblIL5opnHj0lhvvg';   // Candidate URLs

const PR_STATES_BASE  = 'appJbAvuFOxhWOID2';   // 50 States Database
const PR_STATES_TABLE = 'tblI3LZvxRu4bgK3r';   // 50 States -- THE WRITE TARGET

// ---- Candidate URLs fields ----------------------------------------------
const PR_C_UNITID         = 'fldRicdqQxfBxUGBH';
const PR_C_CATEGORY       = 'fld5QoBkGbSZNla35';
const PR_C_CANDIDATE_URL  = 'fldzInwsPk3pI4PoT';
const PR_C_PROPOSED_URL   = 'fldnX2cl803TQJrNY';
const PR_C_DETERMINATION  = 'flds5qRgFKkdvLjK0';
const PR_C_PROMOTE_STATUS = 'fldMKn6pqlCIBxLTp';
const PR_C_REVIEW_DATE    = 'fldQYqGfwGTbrLDbZ';

// Added 2026-09-10 with the hardening pass. Both are written by this script
// and REWRITTEN IN FULL EVERY RUN, including being written empty -- the same
// clearing rule the 50 States fields follow, and for the same reason: a note
// that is only written when there is something to say is a note that goes
// stale and then lies.
const PR_C_PROMOTE_NOTE    = 'flddwBb1T0nKBp3yz';   // Promote note (text)
const PR_C_PROMOTE_FLAGGED = 'fld8DFkIZ8jN2Oymo';   // Promote flagged (checkbox)

// DO NOT READ Review URL (fld91PUEMATcrMOWU). It is a formula built for the
// reviewing interface, not a field of record: it resolves to Linked form URL
// where one exists and Candidate URL otherwise, and it NEVER reflects
// Reviewer-proposed URL. Reading it here would publish the wrong page on
// exactly the rows this script is most careful about.

// ---- 50 States fields ----------------------------------------------------
const PR_S_UNITID      = 'fldSOdX8KWnxZ3wFv';
const PR_S_INSTITUTION = 'fldb8bn85BkJbu7YT';

// ---- The determinations this script acts on ------------------------------
// Named as constants so an Airtable rename is a one-line fix here rather
// than a silent no-op. WriteBack.gs lost 35 settled reviews that way on
// 2026-08-28 when two option names changed and a match stopped matching.
const PR_DET_CONFIRMED   = 'Confirmed - promote';
const PR_DET_REPLACEMENT = 'Rejected - replacement proposed';

// ---- Promote status values ----------------------------------------------
const PR_STATUS_PROMOTED = 'Promoted';
const PR_STATUS_FAILED   = 'Blocked - write failed';
const PR_STATUS_SKIPPED  = 'Skipped - needs attention';

// =========================================================================
// THE OWNERSHIP CHECK -- added 2026-09-10
// =========================================================================
// The 2026-09-10 dry run found Seattle Pacific's Report Form pointing at a
// umass.edu page. Nothing stopped it. A reviewer had confirmed the row, so
// every guard in this file was satisfied: the URL was well formed, it was not
// a login wall, the school resolved, the terms were in vocabulary. It would
// have published another university's page as Seattle Pacific's answer.
//
// This is the same problem SearchProbe.gs solved on 2026-09-06 with
// spBelongsTo_, and the logic here is deliberately a PORT of it rather than a
// call into it -- see the note on the vendor list below for why the two must
// be free to diverge.
//
// BUT THE COST IS INVERTED, AND THAT CHANGES THE DESIGN. SearchProbe filters
// machine-generated candidates, where a miss costs nothing: the school keeps
// a blank a person can fill later. Here every row has already been read and
// judged by a human. A wrong refusal throws away that work and leaves a
// school looking non-compliant when it is not. So this file refuses in
// exactly two shapes, and gives a way out of both:
//
//   OFF-DOMAIN AND NOT A VENDOR   -> refuse. There is no honest reading in
//                                    which umass.edu is Seattle Pacific's.
//   ON A VENDOR, NO NAME MATCH    -> refuse, because that is how one school's
//                                    Maxient form gets filed against another.
//
// THE WAY OUT IS THE Ownership exceptions TABLE, NOT A CODE CHANGE. That was
// a requirement, not a nicety: the people who will run this after the 15th
// are not the people who can edit Apps Script. A row in that table naming a
// UNITID and a string the URL is allowed to contain lets a refused address
// through, and adding one is adding a row in Airtable.
//
// Texas A&M-Victoria is the seed case, and it turned out to be a lesson in
// checking rather than reasoning. Its Maxient tenant slug still reads
// UnivofHoustonVictoria years after the school stopped being UHV, so the
// obvious conclusion -- and the one written into the handoff, this file's
// first draft, and the exception row itself -- was that the ownership check
// would refuse it on every run forever unless an exception rescued it.
//
// IT DOES NOT. Tested 2026-09-10 before this file shipped: the check passes
// that row on its own. The name tokens for "Texas A&M University-Victoria"
// are tamuv, texas and victoria, and "victoria" is sitting inside
// "UnivofHoustonVictoria". It passes for a reason nobody intended.
//
// THE EXCEPTION ROW IS KEPT ANYWAY, and deliberately: the pass depends on a
// city name that both institutions happen to share, so a future rename, or a
// vendor slug that drops "Victoria", starts refusing the row with no warning.
// A redundant exception costs nothing. A missing one costs a school.
//
// THE GENERAL POINT MATTERS MORE THAN THE ROW. A single common word --
// victoria, lincoln, columbia, aurora -- is enough to satisfy the vendor
// token test, so this check is weaker than it looks against schools whose
// names share a place name. It is inherited from SearchProbe.gs, where the
// same looseness is accepted. Do not read a pass here as proof of ownership;
// read a REFUSAL as worth investigating.
//
// EXPECT A BATCH OF LEGITIMATE REFUSALS ON THE FIRST RUN. State systems,
// districts and shared-service campuses genuinely publish on a parent
// domain. Those are exceptions to be added, not bugs. Read the dry run before
// applying and do not be surprised by them.
const PR_INST_TABLE = 'tblpgBmu7r8kQA6b5';   // Institutions (PAGES, synced)
const PR_I_UNITID   = 'fldGREvzCIme6HXfl';
const PR_I_NAME     = 'fldHvefXrrPxibBsZ';
const PR_I_URL      = 'fld5s03AW9U65Z34W';   // Institution URL, multilineText

const PR_EXC_TABLE  = 'tblP5FXdjG2zv8Nar';   // Ownership exceptions (PAGES)
const PR_X_UNITID   = 'fld2hFZp9oinC7ikk';
const PR_X_ALLOW    = 'fld1CYLnxN0JPz9QM';   // string the URL may contain
const PR_X_REASON   = 'fld8ixTRKEpLVPleN';
const PR_X_ACTIVE   = 'fld162zf3pqrjhEso';   // unticked rows are ignored

/**
 * Conduct and incident-reporting vendors.
 *
 * DELIBERATELY A SEPARATE COPY of SearchProbe.gs's SP_VENDOR_HOSTS, for the
 * reason PR_LOGIN_URL_PATTERNS is a separate copy too: the two lists answer
 * different questions. There, "may this be a candidate for review." Here,
 * "may this be published as a school's answer." A host worth searching is not
 * automatically a host worth publishing, and pointing both at one array would
 * make every future change to either a silent change to the other.
 *
 * Used for TWO different jobs below, and they pull in opposite directions:
 *   - the ownership check, where being on a vendor host is what EARNS a URL
 *     the chance to match on a name token rather than being refused outright;
 *   - the category check, where being on a vendor host is EVIDENCE that a URL
 *     is a report form and therefore does not belong in CHTR or Hazing Policy.
 */
const PR_VENDOR_HOSTS = [
  'maxient.com', 'symplicity.com', 'ethicspoint.com', 'navexglobal.com',
  'navex.com', 'qualtrics.com', 'formstack.com', 'wufoo.com',
  'jotform.com', 'guardianconduct.com', 'lighthouse-services.com',
  'reportlineweb.com', 'convercent.com', 'i-sight.com', 'caseiq.com',
  'get-rave.com', 'titleixinvestigators.com', 'publicsafetyreporting.com'
];

/**
 * Google Forms addresses that must never be published.
 *
 * William Peace's Report Form was a Google Forms /edit URL, and it would have
 * minted a checkmark on a page only WPU staff can open. What makes /edit
 * disqualifying is that whether it opens depends on which Google account the
 * VIEWER is signed into -- so a reviewer signed into the right account sees a
 * working form and the public sees a sign-in wall. That is the same
 * over-crediting bias as checking vendor forms while signed in, in a form
 * this script can actually detect.
 *
 * /formResponse is the submission endpoint, not a page anyone should land on.
 * /viewform IS THE CORRECT PUBLIC ADDRESS and is deliberately allowed.
 *
 * Note WPU publishes the broken link itself, so refusing here does not fix
 * the school's page -- it stops HazingInfo repeating the error.
 */
const PR_GOOGLE_FORM_BAD = [
  /docs\.google\.com\/forms\/.*\/edit(?:[\/?#]|$)/i,
  /docs\.google\.com\/forms\/.*\/formResponse(?:[\/?#]|$)/i
];

/**
 * Below-standard terms that contradict each other.
 *
 * FLAGGED, NEVER BLOCKED, and the reason is worth stating because the
 * opposite looks safer and is not. Any term at all means the page is below
 * standard, so the compliance field is cleared and the checkmark withheld
 * IDENTICALLY whether the terms agree or not. The write does not change. What
 * changes is only the public note built from the reason field, which would
 * read as nonsense -- "Undated" beside "Dated before 2024".
 *
 * Blocking would therefore leave a school with NO listed page over a wording
 * problem, which is a worse public record than a listed page with a muddled
 * note. Flag it, publish it, let a person fix the terms.
 *
 * Each entry is a pair that cannot both be true of one page. Extend it as
 * more are found; nothing here is exhaustive.
 */
const PR_CONTRADICTIONS = {
  'Hazing Policy': [
    ['Undated', 'Dated before 2024'],
    ['No investigation process stated', 'Investigation process asserted but not described']
  ],
  'CHTR': [
    ['No update date stated or inferable on index', 'Dated to month or year only on index'],
    ['No update date stated or inferable on index', 'Index update date outside the freshness window'],
    ['Report announced but not published', 'Incidents listed without description']
  ],
  'Report Form': []
};

/**
 * Who gets the run summary, and when.
 *
 * THIS EXISTS BECAUSE Logger.log IS INVISIBLE ON A TRIGGERED RUN. Every
 * refusal reason in this file is useless to a scheduled execution unless it
 * leaves the execution -- once onto the row, in Promote note, and once into
 * an inbox. Both, not either: the row is where you look when you are already
 * in Airtable, the email is what tells you to go and look.
 *
 * Empty string means "the account the script runs as", which is right for a
 * trigger. Set an address to send somewhere else.
 *
 * DRY RUNS DO NOT EMAIL. A dry run is something a person is watching.
 */
const PR_EMAIL_TO       = '';
const PR_EMAIL_ON_APPLY = true;

/**
 * THE CATEGORY MAP.
 *
 * `key` must match the Candidate URLs Category single-select EXACTLY. An
 * unrecognised value is skipped and named rather than guessed at -- and if
 * EVERY row skips for that reason, the report says so in as many words
 * rather than reporting a silent zero that reads like "nothing to do".
 *
 *   source      the below-standard field ON CANDIDATE URLS for this category
 *   record      50 States located_* / chtr_index_url -- always written
 *   compliance  50 States published position -- the field the checkmark and
 *               every stat, map count and dashboard reads. Written with the
 *               URL on a clean row, EMPTIED on a flagged one.
 *   reason      50 States below-standard terms. Purely additive: nothing
 *               existing reads it. It is NOT a compliance signal.
 *   vocabulary  the terms the DESTINATION field will accept. Verified live
 *               against both bases on 2026-09-10, after the two prevention
 *               terms were deleted on Jolayne's decision. Names are
 *               identical across the bases; CHOICE IDS ARE NOT, which is why
 *               every write here is by name.
 */
const PR_CATEGORIES = {
  'CHTR': {
    label:      'CHTR',
    source:     'fldLN63fAxfGJr2LU',
    record:     'fldF1eBetEtn3P9ai',
    compliance: 'flde8Mfh5vVz1iD0a',
    reason:     'fld1OvoiS3flecsZ7',
    vocabulary: [
      'Incidents listed without description',
      'Hazing not broken out from general conduct data',
      'Login required',
      'Dated to month or year only on index',
      'Report announced but not published',
      'No update date stated or inferable on index',
      'Index update date outside the freshness window'
    ]
  },
  'Hazing Policy': {
    label:      'Hazing Policy',
    source:     'fldC2kSa495LaO0Bv',
    record:     'fldeV6a02lVAwHYOd',
    compliance: 'fldhLNehpqJqXgWPT',
    reason:     'fld1elkZEyrtENFMU',
    vocabulary: [
      'No policy against hazing stated',
      'No investigation process stated',
      'Investigation process asserted but not described',
      'Undated',
      'Dated before 2024',
      'Applies only to fraternity and sorority life',
      'Login required'
    ]
  },
  'Report Form': {
    label:      'Report Form',
    source:     'fldKffUFxHE9IxRcU',
    record:     'fldYG8a7J9o5hfoN2',
    compliance: 'fldhHGkKvHK8BtC1e',
    reason:     'fldSepO8coDh0MSWq',
    vocabulary: [
      'Hazing not selectable',
      'Login required',
      'Current students only'
    ]
  }
};


// ---- Safety --------------------------------------------------------------

/**
 * DRY RUN IS THE DEFAULT AND SHOULD STAY THAT WAY between runs.
 *
 * promoteDryRun() reports exactly what promoteApplyForReal() would write --
 * every field, old and new, every skip and why -- and writes nothing. Read
 * that output before arming anything, particularly the CHECKMARK CLEARED
 * lines: those are schools whose public page LOSES a green check.
 */
const PR_DRY_RUN_DEFAULT = true;

// Blast radius. 235 promotable rows stood on 2026-09-10 across roughly 200
// schools. This leaves headroom for the review still to come without
// allowing a runaway run to rewrite the table.
const PR_MAX_INSTITUTIONS = 400;

const PR_WRITE_BATCH = 10;    // Airtable's hard cap per PATCH
const PR_PAGE_SIZE   = 100;
const PR_SLEEP_MS    = 210;   // Airtable's 5 req/sec

/**
 * Login-wall shapes, refused as write targets.
 *
 * DELIBERATELY A SEPARATE COPY of WriteBack.gs's WB_LOGIN_URL_PATTERNS and
 * LiveUrlChecks.gs's LUC_LOGIN_URL_PATTERNS. All three decide different
 * things and being wrong costs different amounts. This one decides whether
 * to PUBLISH an address; being wrong here puts a sign-in page on a school's
 * public record as the place to report hazing. A change to one of the three
 * should be a considered decision about the others, not an inheritance.
 *
 * NOTE the same limit WriteBack.gs learned on 2026-08-28: this stops the
 * addresses it can SEE. A vendor URL that 303s to Shibboleth one hop later
 * passes this guard. Login required is a reviewer judgement and a
 * below-standard term for exactly that reason.
 */
const PR_LOGIN_URL_PATTERNS = [
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
  /\/(?:login|signin|sign-in|sign_in)(?:[\/?#]|$)/i
];


// =========================================================================
// ENTRY POINTS
// =========================================================================

/**
 * Reports what promoteApplyForReal() would do. Writes nothing, to either
 * base. Run this first, every time -- including on a re-run, where it should
 * report zero changes.
 */
function promoteDryRun() {
  return prRun_(true);
}

/**
 * Honours PR_DRY_RUN_DEFAULT, so this is a dry run while that stays true.
 * Kept so a trigger or a habit pointed at "the normal one" cannot write by
 * accident.
 */
function promoteApply() {
  return prRun_(PR_DRY_RUN_DEFAULT ? true : false);
}

/**
 * Applies for real, ignoring PR_DRY_RUN_DEFAULT. A separate function rather
 * than a flag to edit, so arming the script is an explicit act that leaves
 * the file unchanged -- and so nobody arms it by editing a constant and then
 * forgets to put it back.
 *
 * This is the function a scheduled trigger should eventually point at.
 */
function promoteApplyForReal() {
  return prRun_(false);
}


// =========================================================================
// THE RUN
// =========================================================================
function prRun_(dryRun) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another script run holds the lock. Nothing done.');
    return { blocked: true };
  }
  try {
    const pat = prRequirePat_();
    const started = new Date();

    Logger.log(dryRun
      ? '=== PROMOTE -- DRY RUN, nothing will be written ==='
      : '=== PROMOTE -- APPLYING, writing to 50 States ===');
    Logger.log('Started ' + started.toISOString());
    Logger.log('');

    // ---- 1. the promotable rows ---------------------------------------
    const formula = 'OR({' + PR_C_DETERMINATION + '} = "' + PR_DET_CONFIRMED + '", ' +
                    '{' + PR_C_DETERMINATION + '} = "' + PR_DET_REPLACEMENT + '")';

    const rows = prListAll_(pat, PR_PAGES_BASE, PR_CAND_TABLE,
      [PR_C_UNITID, PR_C_CATEGORY, PR_C_CANDIDATE_URL, PR_C_PROPOSED_URL,
       PR_C_DETERMINATION, PR_C_PROMOTE_STATUS, PR_C_REVIEW_DATE,
       PR_C_PROMOTE_NOTE, PR_C_PROMOTE_FLAGGED,
       PR_CATEGORIES['CHTR'].source,
       PR_CATEGORIES['Hazing Policy'].source,
       PR_CATEGORIES['Report Form'].source],
      formula);

    Logger.log('Promotable rows found: ' + rows.length);
    if (!rows.length) {
      Logger.log('Nothing to do. If this is a surprise, check that the two ' +
        'determination names in PR_DET_CONFIRMED / PR_DET_REPLACEMENT still ' +
        'match the Airtable single-select exactly.');
      return { rows: 0, written: 0 };
    }

    // ---- 2. the target table ------------------------------------------
    const targetFields = [PR_S_UNITID, PR_S_INSTITUTION];
    for (const k in PR_CATEGORIES) {
      targetFields.push(PR_CATEGORIES[k].record,
                        PR_CATEGORIES[k].compliance,
                        PR_CATEGORIES[k].reason);
    }

    const institutions = prListAll_(pat, PR_STATES_BASE, PR_STATES_TABLE, targetFields, '');
    Logger.log('50 States rows read: ' + institutions.length);

    // UNITID -> record(s). An ARRAY, so a duplicate UNITID is detectable
    // rather than silently resolving to whichever row was read last.
    const byUnitid = {};
    institutions.forEach(function (r) {
      const u = String(r.fields[PR_S_UNITID] || '').trim();
      if (!u) return;
      (byUnitid[u] = byUnitid[u] || []).push(r);
    });

    // ---- 2b. what the ownership check needs ----------------------------
    // Two more reads, both from PAGES, both once per run. Institutions is the
    // synced IPEDS mirror and supplies each school's own web address; there is
    // no such field on 50 States, which is why this read exists at all.
    //
    // NEITHER READ IS ALLOWED TO STOP THE RUN, and that is a deliberate
    // asymmetry. If Institutions cannot be read the ownership check has
    // nothing to check against, so it stands down and says so loudly rather
    // than refusing all 231 rows for want of a lookup table. A guard that
    // fails closed on its own infrastructure failure is a guard that turns a
    // bad afternoon into a blocked release.
    const instByUnitid = prInstitutions_(pat);
    const exceptions   = prExceptions_(pat);

    const ownershipLive = Object.keys(instByUnitid).length > 0;
    if (!ownershipLive) {
      Logger.log('');
      Logger.log('*** OWNERSHIP CHECK IS NOT RUNNING. The Institutions table returned ' +
        'no rows, so there is nothing to compare addresses against. Every other ' +
        'guard still applies, but a URL belonging to a different school will NOT ' +
        'be caught this run. Fix the read before trusting this output.');
    } else {
      Logger.log('Institution addresses read: ' + Object.keys(instByUnitid).length +
        ' | ownership exceptions active: ' + prExceptionCount_(exceptions));
    }

    // ---- 3. one school + category may have only ONE promotable row -----
    // Two reviewers, or one reviewer twice, can leave two rows both saying
    // promote for the same school and category. Which URL wins is a
    // reviewer's judgement. Guessing -- by rank, by date, by row order --
    // would publish a page nobody chose, silently. All such rows are skipped
    // together and named.
    const byKey = {};
    rows.forEach(function (row) {
      const u = String(row.fields[PR_C_UNITID] || '').trim();
      const c = row.fields[PR_C_CATEGORY] || '';
      (byKey[u + '|' + c] = byKey[u + '|' + c] || []).push(row);
    });

    // ---- 4. turn rows into operations ---------------------------------
    const ops = [];
    const skips = [];

    rows.forEach(function (row) {
      const u = String(row.fields[PR_C_UNITID] || '').trim();
      const c = row.fields[PR_C_CATEGORY] || '';
      const siblings = byKey[u + '|' + c] || [];

      if (siblings.length > 1) {
        skips.push({
          recordId: row.id,
          unitid: u,
          categoryName: c,
          reason: 'AMBIGUOUS -- ' + siblings.length + ' promotable rows for this school ' +
                  'and category. Resolve in Airtable (leave one promoting) and re-run.'
        });
        return;
      }

      const op = prPlan_(row, byUnitid, instByUnitid, exceptions, ownershipLive);
      if (op.skip) skips.push(op); else ops.push(op);
    });

    // ---- 5. merge per institution -------------------------------------
    // A school with a promotable CHTR row and a promotable policy row has
    // two rows pointing at one 50 States record. Airtable rejects an entire
    // PATCH payload naming the same record id twice ("Cannot have multiple
    // records with the same ID"), so the naive one-request-per-row shape
    // would fail the whole batch containing any such school and take its
    // nine unrelated good writes with it.
    const merged = {};
    ops.forEach(function (op) {
      const m = merged[op.stateRecordId] || (merged[op.stateRecordId] = {
        recordId: op.stateRecordId,
        unitid: op.unitid,
        institution: op.institution,
        fields: {},
        parts: []
      });
      for (const f in op.fields) m.fields[f] = op.fields[f];
      m.parts.push(op);
    });

    const targets = Object.keys(merged)
      .map(function (k) { return merged[k]; })
      .filter(function (t) { return t.parts.some(function (p) { return !p.noop; }); });

    const noopOnly = Object.keys(merged).length - targets.length;

    // ---- 6. report -----------------------------------------------------
    let gained = 0;
    let cleared = 0;
    const clearedList = [];

    Logger.log('');
    Logger.log('--- planned changes, by school ---');
    if (!targets.length) Logger.log('(none)');

    targets.forEach(function (t) {
      Logger.log(t.institution + ' (' + t.unitid + ')');
      t.parts.forEach(function (p) {
        if (p.noop) {
          Logger.log('    ' + p.category.label + ': already applied, no change');
          return;
        }
        Logger.log('    ' + p.category.label + ': ' + p.action);
        Logger.log('        record     "' + p.beforeRecord     + '"  ->  "' + p.url + '"');
        Logger.log('        compliance "' + p.beforeCompliance + '"  ->  "' + (p.clean ? p.url : '') + '"');
        Logger.log('        reasons    [' + p.beforeReason.join(', ') + ']  ->  [' + p.terms.join(', ') + ']');

        if (!p.beforeCompliance && p.clean) {
          gained++;
          Logger.log('        *** NEW CHECKMARK -- this school GAINS a ' +
            p.category.label + ' check on the public page');
        }
        if (p.beforeCompliance && !p.clean) {
          cleared++;
          clearedList.push(t.institution + ' (' + t.unitid + ') -- ' + p.category.label);
          Logger.log('        *** CHECKMARK CLEARED -- this school LOSES its ' +
            p.category.label + ' check on the public page');
        }
        (p.flags || []).forEach(function (f) {
          Logger.log('        FLAG: ' + f);
        });
      });
    });

    // Flagged rows PUBLISHED. They are not in the skip list, they do not stop
    // anything, and that is exactly why they need collecting somewhere a
    // person will see -- built from ops rather than targets, because a row can
    // carry a flag while its 50 States write is a no-op, and those would
    // otherwise never appear anywhere.
    const flaggedList = [];
    ops.forEach(function (op) {
      if (!op.flags || !op.flags.length) return;
      flaggedList.push(op.institution + ' (' + op.unitid + ') -- ' +
        op.category.label + ': ' + op.flags.join(' | '));
    });

    if (flaggedList.length) {
      Logger.log('');
      Logger.log('--- PROMOTED, BUT FLAGGED FOR A SECOND LOOK (' + flaggedList.length + ') ---');
      Logger.log('These rows DID publish. Nothing was stopped. Each one is ticked');
      Logger.log('"Promote flagged" on Candidate URLs with the reason in "Promote note",');
      Logger.log('so they can be filtered rather than hunted for in this log.');
      flaggedList.forEach(function (s) { Logger.log('  ' + s); });
    }

    // Checkmark removals are the most consequential thing this script does
    // and the easiest to miss inside a long per-school log. Repeat them
    // together, at the end, where they cannot be scrolled past.
    if (clearedList.length) {
      Logger.log('');
      Logger.log('--- CHECKMARKS THIS RUN WOULD REMOVE (' + clearedList.length + ') ---');
      Logger.log('Each of these schools currently shows a check on the public page and ');
      Logger.log('would stop showing it, because a reviewer marked the page below standard.');
      clearedList.forEach(function (s) { Logger.log('  ' + s); });
    }

    if (skips.length) {
      Logger.log('');
      Logger.log('--- skipped (' + skips.length + ') ---');
      skips.forEach(function (s) {
        Logger.log('  ' + (s.unitid || '(no UNITID)') + ' / ' +
          (s.categoryName || '(no category)') + ': ' + s.reason);
      });

      // The failure mode this script is most likely to have and least likely
      // to show: everything skips for one structural reason and the run
      // reports a zero that reads like "nothing needed doing".
      const unrecognised = skips.filter(function (s) {
        return s.reason && s.reason.indexOf('unrecognised Category') === 0;
      }).length;
      if (unrecognised === skips.length && !ops.length) {
        Logger.log('');
        Logger.log('*** EVERY row was skipped as an unrecognised Category. This is NOT ' +
          '"nothing to do" -- the PR_CATEGORIES keys no longer match the Candidate ' +
          'URLs single-select. Compare them before doing anything else.');
      }

      const vocab = skips.filter(function (s) {
        return s.reason && s.reason.indexOf('TERM NOT IN DESTINATION') === 0;
      }).length;
      if (vocab) {
        Logger.log('');
        Logger.log('*** ' + vocab + ' row(s) name a below-standard term that 50 States ' +
          'does not have. The two bases have drifted out of parity. Add the term to ' +
          'the destination field IN THE AIRTABLE UI (the API cannot add a select ' +
          'choice), then re-run. Do not delete it from PAGES to make this go away -- ' +
          'deleting a select option strips it from every row that held it, silently.');
      }
    }

    Logger.log('');
    Logger.log('Schools to update: ' + targets.length + ' (from ' + ops.length + ' row(s))');
    Logger.log('Already applied, nothing to do: ' + noopOnly + ' school(s)');
    Logger.log('Checkmarks gained: ' + gained + ' | Checkmarks removed: ' + cleared);
    Logger.log('Skipped: ' + skips.length + ' | Promoted but flagged: ' + flaggedList.length);

    if (targets.length > PR_MAX_INSTITUTIONS) {
      throw new Error('Refusing to run: ' + targets.length + ' schools exceeds ' +
        'PR_MAX_INSTITUTIONS (' + PR_MAX_INSTITUTIONS + '). Raise it deliberately ' +
        'if this is right.');
    }

    if (dryRun) {
      Logger.log('');
      Logger.log('DRY RUN -- nothing written, to either base.');
      Logger.log('Promote note and Promote flagged were NOT written either. A dry run ' +
        'that stamped the source rows would not be a dry run.');
      Logger.log('Read the CHECKMARKS REMOVED and FLAGGED sections above, then run ' +
        'promoteApplyForReal() to apply.');
      if (skips.length) {
        Logger.log('');
        Logger.log('On the skips: an ownership refusal on a school you know is correct ' +
          'is fixed by adding a row to the Ownership exceptions table in PAGES -- ' +
          'UNITID plus the string the address is allowed to contain -- not by ' +
          'editing this file. Then re-run.');
      }
      return {
        dryRun: true, rows: rows.length, schools: targets.length,
        skipped: skips.length, flagged: flaggedList.length,
        checkmarksGained: gained, checkmarksRemoved: cleared
      };
    }

    // ---- 7. write 50 States --------------------------------------------
    let written = 0;
    const failedRecordIds = {};

    for (let i = 0; i < targets.length; i += PR_WRITE_BATCH) {
      const batch = targets.slice(i, i + PR_WRITE_BATCH);
      const res = prPatch_(pat, PR_STATES_BASE, PR_STATES_TABLE, batch);
      if (res.ok) { written += batch.length; continue; }

      // Airtable's PATCH is all-or-nothing per batch, so one bad record
      // takes its nine batch-mates with it. Retry individually to isolate.
      Logger.log('Batch at ' + i + ' failed, retrying individually: ' + res.error);
      batch.forEach(function (t) {
        const one = prPatch_(pat, PR_STATES_BASE, PR_STATES_TABLE, [t]);
        if (one.ok) { written++; return; }
        failedRecordIds[t.recordId] = one.error;
        Logger.log('  ' + t.institution + ' (' + t.unitid + ') would not save: ' + one.error);
      });
    }

    // ---- 8. stamp Promote status back onto Candidate URLs --------------
    // Done AFTER the 50 States write and derived from its outcome, so the
    // stamp can never claim a promotion that did not land.
    // THREE FIELDS NOW, AND THE CHURN TEST COVERS ALL THREE. Before the
    // hardening pass this returned early when the status already said what it
    // was about to say. With a note and a flag alongside it that shortcut is
    // wrong: a row whose status is still Promoted but whose contradiction has
    // since been fixed would keep a flag and a note describing a problem that
    // no longer exists. Compare the whole triple, write nothing only when the
    // whole triple already matches.
    //
    // AND THE NOTE IS CLEARED, NOT SKIPPED, WHEN THERE IS NOTHING TO SAY.
    // Same rule as the 50 States reason fields, same reason: a note only ever
    // written when non-empty is a note that survives the condition that caused
    // it and then misinforms whoever reads the row next.
    const stamps = [];

    ops.forEach(function (op) {
      const failure = failedRecordIds[op.stateRecordId];
      const value = failure ? PR_STATUS_FAILED : PR_STATUS_PROMOTED;
      const note = failure
        ? ('The 50 States write was attempted and rejected: ' + String(failure).slice(0, 400))
        : (op.flags && op.flags.length ? prNoteFromFlags_(op) : '');
      const flagged = !failure && !!(op.flags && op.flags.length);
      prPushStamp_(stamps, op.candRecordId, op.beforeStatus, op.beforeNote,
                   op.beforeFlagged, value, note, flagged);
    });

    skips.forEach(function (s) {
      if (!s.recordId) return;
      prPushStamp_(stamps, s.recordId, s.beforeStatus, s.beforeNote, s.beforeFlagged,
                   PR_STATUS_SKIPPED, prNoteFromSkip_(s), false);
    });

    let stamped = 0;
    for (let i = 0; i < stamps.length; i += PR_WRITE_BATCH) {
      const batch = stamps.slice(i, i + PR_WRITE_BATCH);
      const res = prPatch_(pat, PR_PAGES_BASE, PR_CAND_TABLE, batch);
      if (res.ok) { stamped += batch.length; continue; }
      Logger.log('Promote status batch at ' + i + ' failed: ' + res.error);
      batch.forEach(function (t) {
        const one = prPatch_(pat, PR_PAGES_BASE, PR_CAND_TABLE, [t]);
        if (one.ok) stamped++;
        else Logger.log('  status stamp failed on ' + t.recordId + ': ' + one.error);
      });
    }

    const failedCount = Object.keys(failedRecordIds).length;

    Logger.log('');
    Logger.log('WROTE ' + written + ' school(s) to 50 States.' +
      (failedCount ? ' ' + failedCount + ' failed.' : ''));
    Logger.log('Stamped Promote status on ' + stamped + ' candidate row(s).');
    Logger.log('Checkmarks gained: ' + gained + ' | Checkmarks removed: ' + cleared);
    Logger.log('Finished ' + new Date().toISOString() +
      ' (' + Math.round((new Date() - started) / 1000) + 's)');
    Logger.log('');
    Logger.log('Discovery gates on the COMPLIANCE fields, so every school promoted ' +
      'with below-standard terms stays in the discovery queue. That is intended.');

    // ---- 9. the email --------------------------------------------------
    // LAST, AND AFTER EVERY WRITE. The six-minute cap does not throw, so
    // anything placed after the writes is the first thing lost -- which is
    // precisely why it goes here and not earlier. Losing the summary of a run
    // that completed costs a notification. Losing a write costs the site.
    //
    // Wrapped, because a mail quota or a bad address must not turn a
    // successful promotion into a run that looks like it failed.
    if (PR_EMAIL_ON_APPLY) {
      try {
        prEmail_({
          started: started, written: written, failedCount: failedCount,
          stamped: stamped, gained: gained, cleared: cleared,
          clearedList: clearedList, flaggedList: flaggedList, skips: skips,
          rows: rows.length, schools: targets.length,
          ownershipLive: ownershipLive
        });
      } catch (e) {
        Logger.log('Run summary email could not be sent (the run itself was fine): ' + e);
      }
    }

    return {
      dryRun: false, rows: rows.length, schools: targets.length,
      written: written, failed: failedCount, stamped: stamped,
      skipped: skips.length, flagged: flaggedList.length,
      checkmarksGained: gained, checkmarksRemoved: cleared
    };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Turns one promotable row into an operation, or into a named skip.
 *
 * Every refusal returns a reason that identifies the row and says what is
 * wrong with it, because a silent skip in a script that publishes to the
 * live site is indistinguishable from a script that did not run.
 */
function prPlan_(row, byUnitid, instByUnitid, exceptions, ownershipLive) {
  const unitid       = String(row.fields[PR_C_UNITID] || '').trim();
  const categoryName = row.fields[PR_C_CATEGORY] || '';
  const determination = row.fields[PR_C_DETERMINATION] || '';
  const candidateUrl = String(row.fields[PR_C_CANDIDATE_URL] || '').trim();
  const proposedUrl  = String(row.fields[PR_C_PROPOSED_URL] || '').trim();

  const base = {
    skip: true,
    recordId: row.id,
    unitid: unitid,
    categoryName: categoryName,
    beforeStatus: row.fields[PR_C_PROMOTE_STATUS] || '',
    beforeNote: String(row.fields[PR_C_PROMOTE_NOTE] || ''),
    beforeFlagged: row.fields[PR_C_PROMOTE_FLAGGED] === true
  };

  const category = PR_CATEGORIES[categoryName];
  if (!category) {
    base.reason = 'unrecognised Category "' + categoryName + '"';
    return base;
  }
  if (!unitid) {
    base.reason = 'no UNITID on the candidate row';
    return base;
  }

  // ---- which URL, and is there one -------------------------------------
  const flags = [];
  let url, action;

  if (determination === PR_DET_CONFIRMED) {
    if (!candidateUrl) {
      base.reason = '"' + PR_DET_CONFIRMED + '" with an empty Candidate URL';
      return base;
    }

    // WAS A NOTE UNTIL 2026-09-10. NOW A BLOCK, AND THE EVIDENCE IS THE
    // REASON. Four of the seven bad rows the first dry run produced were this
    // exact shape, and because it was only a note ALL FOUR WOULD HAVE
    // PUBLISHED. Glenville State is the one to remember: it would have
    // promoted a 2021 handbook, already flagged "Dated before 2024", while
    // the reviewer's proposed URL pointed at the 2025-26 handbook sitting
    // right there in the next field.
    //
    // A confirmed row carrying a proposal is self-contradictory. "This
    // candidate is right" and "here is the right one instead" cannot both be
    // the reviewer's answer, and this script has no standing to guess which
    // they meant -- guessing wrong publishes a page a reviewer rejected. It
    // costs one person one minute to resolve in Airtable, and it is the
    // cheapest guard in this file.
    if (proposedUrl) {
      base.reason = 'BLOCKED -- "' + PR_DET_CONFIRMED + '" but the row ALSO carries a ' +
                    'Reviewer-proposed URL ("' + proposedUrl + '"). The two say ' +
                    'opposite things and this script will not choose between them. ' +
                    'Either clear the proposed URL, or change the determination to ' +
                    '"' + PR_DET_REPLACEMENT + '" so the proposal is what publishes. ' +
                    'Then re-run.';
      return base;
    }

    url = candidateUrl;
    action = 'promote Candidate URL';

  } else if (determination === PR_DET_REPLACEMENT) {
    // THE GUARD. Falling back to Candidate URL here would publish the page
    // the reviewer explicitly rejected; skipping quietly would lose their
    // answer. Neither happens without being named.
    if (!proposedUrl) {
      base.reason = '"' + PR_DET_REPLACEMENT + '" with an EMPTY Reviewer-proposed URL. ' +
                    'The candidate was rejected and no replacement was recorded, so ' +
                    'there is nothing to promote. Not falling back to Candidate URL.';
      return base;
    }
    url = proposedUrl;
    action = 'promote Reviewer-proposed URL (candidate was rejected)';

  } else {
    base.reason = 'determination "' + determination + '" is not acted on';
    return base;
  }

  if (!prIsWellFormedUrl_(url)) {
    base.reason = 'URL is not well-formed: "' + url + '"';
    return base;
  }
  if (prIsLoginUrl_(url)) {
    base.reason = 'REFUSED -- URL is a login wall, will not publish: "' + url + '"';
    return base;
  }
  if (prIsBadGoogleFormUrl_(url)) {
    base.reason = 'REFUSED -- Google Forms editing or submission address, not a public ' +
                  'form: "' + url + '". Whether an /edit link opens depends on which ' +
                  'Google account the VIEWER is signed into, so a reviewer can see a ' +
                  'working form the public cannot reach. Find the /viewform address ' +
                  'and put that in Reviewer-proposed URL. If the school itself ' +
                  'publishes the /edit link -- William Peace does -- that is a finding ' +
                  'about the school, not a URL to copy.';
    return base;
  }

  // ---- the school -------------------------------------------------------
  const matches = byUnitid[unitid] || [];
  if (matches.length === 0) {
    base.reason = 'UNITID not found in 50 States';
    return base;
  }
  if (matches.length > 1) {
    base.reason = 'UNITID matches ' + matches.length + ' rows in 50 States -- ' +
                  'ambiguous, not guessing';
    return base;
  }
  const target = matches[0];

  // ---- does this address belong to this school -------------------------
  // Runs only when the Institutions read succeeded. See the header note: a
  // failed lookup table stands the check down rather than refusing everything.
  if (ownershipLive) {
    const inst = instByUnitid[unitid];
    if (!inst || !prDomain_(inst.url)) {
      // NOT A REFUSAL. The school has no usable address on file, so there is
      // nothing to compare against and no honest basis to refuse. Flagged so
      // the gap is visible, because a school missing its own URL is worth
      // fixing in Institutions regardless of what happens to this row.
      flags.push('ownership NOT CHECKED -- no usable Institution URL on file for this ' +
                 'school, so the address could not be compared against anything');
    } else {
      const verdict = prBelongsTo_(url, inst, exceptions[unitid] || []);

      // An address that names NOBODY is a different problem from one that
      // names somebody else. See prIsOpaqueFormHost_ for why this one is
      // flagged rather than refused, and how to change that.
      if (!verdict.ok && prIsOpaqueFormHost_(url) && !PR_OPAQUE_FORM_BLOCK) {
        flags.push('ownership UNVERIFIABLE -- this form is on ' + prDomain_(url) +
                   ', where the address carries no institutional identifier of any ' +
                   'kind, so it can be neither confirmed nor disproved as this ' +
                   'school\'s. Promoted on the reviewer\'s judgement. Worth opening ' +
                   'SIGNED OUT to confirm the public can actually reach it.');
      } else if (!verdict.ok) {
        base.reason = 'BLOCKED -- ' + verdict.why + ' URL: "' + url + '". ' +
          'The school\'s own site is ' + prDomain_(inst.url) + '. ' +
          'IF THIS ADDRESS IS ACTUALLY CORRECT, add a row to the Ownership ' +
          'exceptions table in PAGES: UNITID ' + unitid + ', and the distinctive ' +
          'string the address is allowed to contain (a vendor tenant slug, not a ' +
          'bare hostname). No code change is needed and the exception survives ' +
          'future candidate rows for this school. Then re-run.';
        return base;
      }
      if (verdict.viaException) {
        flags.push('ownership allowed by exception ("' + verdict.viaException + '") -- ' +
                   'off-domain address accepted because a row in Ownership exceptions ' +
                   'says it is this school\'s');
      }
    }
  }

  // ---- the below-standard terms ----------------------------------------
  // Read from THIS category's source field only. A Report Form row carrying
  // a stray CHTR term is a data problem, not a reason to write CHTR fields.
  const raw = row.fields[category.source] || [];
  const terms = (Array.isArray(raw) ? raw : [raw])
    .map(function (t) { return String(t || '').trim(); })
    .filter(function (t) { return t; });

  // Parity is a build-time requirement between the two bases. Airtable would
  // reject an unknown choice per-row with an opaque 422; catching it here
  // names the drifted term and refuses the whole row rather than writing a
  // partial set of reasons.
  const unknown = terms.filter(function (t) {
    return category.vocabulary.indexOf(t) === -1;
  });
  if (unknown.length) {
    base.reason = 'TERM NOT IN DESTINATION vocabulary for ' + category.label +
                  ': "' + unknown.join('", "') + '". The two bases have drifted.';
    return base;
  }

  const clean = terms.length === 0;

  // ---- flags: publish anyway, but say something -------------------------
  // Neither of these stops a promotion. Both are ticked onto the row as
  // Promote flagged with the reason in Promote note, which is what makes them
  // findable in a filtered view rather than only in a log nobody opens.
  prContradictionsIn_(categoryName, terms).forEach(function (pair) {
    flags.push('contradictory below-standard terms: "' + pair[0] + '" and "' + pair[1] +
               '" cannot both describe one page. The checkmark outcome is the same ' +
               'either way -- any term at all withholds it -- but the public note ' +
               'built from these will read as nonsense. Fix the terms on this row.');
  });

  // The Dominican NY case. Its CHTR promotion would have replaced a working
  // transparency-report index with a Maxient REPORTING FORM url, kept the
  // checkmark, and fired no warning at all. A vendor host is strong evidence
  // of a report form and weak-to-no evidence of anything else, which is why
  // this fires in one direction only: policy and CHTR pages live on the
  // school's own domain and their slugs overlap far too much -- "hazing
  // report" appears in both -- for a keyword rule to be anything but noise.
  if (categoryName !== 'Report Form' && prIsVendorHost_(url)) {
    flags.push('a conduct-reporting VENDOR address is being promoted into ' +
               categoryName + '. Vendor URLs are reporting forms almost without ' +
               'exception, so this is very likely the wrong category -- check ' +
               'whether it belongs in Report Form instead, and whether this ' +
               'promotion is about to overwrite a working ' + categoryName + ' page.');
  }

  // ---- what 50 States holds now ----------------------------------------
  const beforeRecord     = String(target.fields[category.record] || '').trim();
  const beforeCompliance = String(target.fields[category.compliance] || '').trim();
  const beforeReasonRaw  = target.fields[category.reason] || [];
  const beforeReason     = (Array.isArray(beforeReasonRaw) ? beforeReasonRaw : [beforeReasonRaw])
    .map(function (t) { return String(t || '').trim(); })
    .filter(function (t) { return t; });

  // ---- THE CLEARING RULE ------------------------------------------------
  // All three fields, every time, including empty. Never merge, never
  // append, never skip a field because the new value is blank.
  const fields = {};
  fields[category.record]     = url;
  fields[category.compliance] = clean ? url : '';
  fields[category.reason]     = terms;          // [] clears it

  // ---- is this a no-op --------------------------------------------------
  const sameReasons = beforeReason.length === terms.length &&
    beforeReason.slice().sort().join('') === terms.slice().sort().join('');
  const noop = beforeRecord === url &&
               beforeCompliance === (clean ? url : '') &&
               sameReasons;

  return {
    skip: false,
    noop: noop,
    candRecordId: row.id,
    stateRecordId: target.id,
    beforeStatus: row.fields[PR_C_PROMOTE_STATUS] || '',
    beforeNote: String(row.fields[PR_C_PROMOTE_NOTE] || ''),
    beforeFlagged: row.fields[PR_C_PROMOTE_FLAGGED] === true,
    unitid: unitid,
    institution: String(target.fields[PR_S_INSTITUTION] || '(unnamed)'),
    categoryName: categoryName,
    category: category,
    determination: determination,
    url: url,
    clean: clean,
    terms: terms,
    fields: fields,
    beforeRecord: beforeRecord,
    beforeCompliance: beforeCompliance,
    beforeReason: beforeReason,
    action: action,
    flags: flags
  };
}


// =========================================================================
// URL GUARDS
// =========================================================================

/**
 * Well-formed enough to publish. Not a test of whether it resolves -- the
 * liveness checker answers that -- only that it is a real absolute http(s)
 * URL with a dotted host and no whitespace or control characters.
 */
function prIsWellFormedUrl_(url) {
  if (!url) return false;
  if (url.length > 2000) return false;
  if (/[\s​-‍﻿]/.test(url)) return false;
  if (/[\x00-\x1f\x7f]/.test(url)) return false;
  return /^https?:\/\/[^\/\s:]+\.[^\/\s:]+(?::\d+)?(?:[\/?#]|$)/i.test(url);
}

/** Does this address point at a sign-in page? See PR_LOGIN_URL_PATTERNS. */
function prIsLoginUrl_(url) {
  if (!url) return false;
  const s = String(url);
  for (let i = 0; i < PR_LOGIN_URL_PATTERNS.length; i++) {
    if (PR_LOGIN_URL_PATTERNS[i].test(s)) return true;
  }
  return false;
}

/** A Google Forms editing or submission address. See PR_GOOGLE_FORM_BAD. */
function prIsBadGoogleFormUrl_(url) {
  if (!url) return false;
  const s = String(url);
  for (let i = 0; i < PR_GOOGLE_FORM_BAD.length; i++) {
    if (PR_GOOGLE_FORM_BAD[i].test(s)) return true;
  }
  return false;
}


// =========================================================================
// OWNERSHIP
// =========================================================================

/**
 * Bare host for a URL: no scheme, no path, no www prefix.
 *
 * KEEPS EVERY OTHER SUBDOMAIN. A school genuinely at catalog.example.edu
 * belongs there, and widening to the parent would treat a different
 * institution's pages as its own -- the Barton College / Appalachian State
 * failure SearchProbe.gs names twice. Strips the whole www-prefix family,
 * because Oakwood's address is www2.oakwood.edu and leaving that in place
 * would compare against one numbered mirror rather than the school's site.
 */
function prDomain_(url) {
  const m = /^(?:https?:\/\/)?([^\/\?#]+)/i.exec(String(url || '').trim());
  if (!m) return '';
  return m[1].toLowerCase().replace(/^www\d*\./, '').replace(/:\d+$/, '');
}

/** Lowercase, punctuation removed -- for substring matching inside a URL. */
function prFlatten_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Is this address on a recognised conduct-reporting vendor? */
function prIsVendorHost_(url) {
  const host = prDomain_(url);
  if (!host) return false;
  for (let i = 0; i < PR_VENDOR_HOSTS.length; i++) {
    const v = PR_VENDOR_HOSTS[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) return true;
  }
  return false;
}

/**
 * Strings that identify this institution inside a vendor URL.
 *
 * The domain label first -- 'samford' from samford.edu -- because vendors
 * overwhelmingly build tenant slugs from it. Then the distinctive words of
 * the name, which catches spelled-out variants.
 *
 * GENERIC WORDS ARE DROPPED, and that is what stops the test quietly becoming
 * useless: 'university', 'college' and 'state' are in hundreds of names and
 * most vendor URLs, so keeping them would match everything and re-admit the
 * errors this exists to prevent.
 */
function prTokens_(inst, ownDomain) {
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

/**
 * Does this address belong to THIS school?
 *
 * Returns { ok, why, viaException }. `why` is written to be pasted in front of
 * a reviewer, not parsed.
 *
 * THREE WAYS TO PASS, and the order matters:
 *
 *   1. It is on the school's own domain or a subdomain of it.
 *   2. An Ownership exceptions row for this UNITID names a string the address
 *      contains. CHECKED BEFORE EITHER REFUSAL, deliberately: an exception has
 *      to be able to rescue both refusal shapes, or the table only solves half
 *      the problem and the other half still needs a developer.
 *   3. It is on a recognised vendor AND carries a recognisable form of the
 *      school's name -- cm.maxient.com/reportingform.php?SamfordUniv.
 *
 * WHAT IT CANNOT DO is attribute an address that names nobody at all. See
 * prIsOpaqueFormHost_ for how those are handled and why they are not simply
 * refused.
 */
function prBelongsTo_(url, inst, allowedStrings) {
  const host = prDomain_(url);
  if (!host) return { ok: false, why: 'the address has no readable host.' };

  const own = prDomain_(inst.url);
  if (own && (host === own || host.slice(-(own.length + 1)) === '.' + own)) {
    return { ok: true };
  }

  const flat = prFlatten_(url);

  for (let i = 0; i < allowedStrings.length; i++) {
    const needle = prFlatten_(allowedStrings[i]);
    if (needle && flat.indexOf(needle) !== -1) {
      return { ok: true, viaException: allowedStrings[i] };
    }
  }

  if (!prIsVendorHost_(url)) {
    return {
      ok: false,
      why: 'this address is on neither the school\'s own domain nor a recognised ' +
           'conduct-reporting vendor, so there is no basis for treating it as this ' +
           'school\'s page. This is the Seattle Pacific failure -- its Report Form ' +
           'was a umass.edu page.'
    };
  }

  const tokens = prTokens_(inst, own);
  for (let t = 0; t < tokens.length; t++) {
    if (flat.indexOf(tokens[t]) !== -1) return { ok: true };
  }

  return {
    ok: false,
    why: 'this address is on a conduct-reporting vendor but carries nothing ' +
         'identifying this school, which is exactly how one school\'s reporting ' +
         'form gets filed against another.'
  };
}

/**
 * Hosts where a form CANNOT carry an institutional identifier at all.
 *
 * docs.google.com/forms/d/e/1FAIpQLSd.../viewform names nobody. Neither does
 * a bare Qualtrics or Microsoft Forms id. There is no way to attribute one
 * from the URL, and there never will be.
 *
 * THESE ARE FLAGGED, NOT REFUSED, AND THAT IS A DELIBERATE DEPARTURE FROM
 * SearchProbe.gs, WHICH REFUSES THEM. The reason is the inverted cost stated
 * at the top: SearchProbe is filtering machine output, where dropping an
 * unattributable candidate costs nothing. Here a human has already opened the
 * school's page and confirmed this is the form it links to. Refusing would
 * throw that away, leave the school looking non-compliant, and demand an
 * exception row for every school that uses Google Forms -- which is a lot of
 * them.
 *
 * AND NOTE WHAT THE RISK ACTUALLY IS. An opaque form names nobody, so it is
 * not evidence of the WRONG school; it is merely no evidence of the right
 * one. That is a different and smaller danger than umass.edu appearing on a
 * Seattle Pacific row, which names a different institution outright.
 *
 * TO MAKE THESE REFUSALS INSTEAD, set PR_OPAQUE_FORM_BLOCK to true. Expect to
 * add a lot of exception rows if you do.
 */
const PR_OPAQUE_FORM_HOSTS = [
  'docs.google.com', 'forms.gle', 'forms.office.com', 'forms.microsoft.com'
];
const PR_OPAQUE_FORM_BLOCK = false;

function prIsOpaqueFormHost_(url) {
  const host = prDomain_(url);
  if (!host) return false;
  for (let i = 0; i < PR_OPAQUE_FORM_HOSTS.length; i++) {
    const v = PR_OPAQUE_FORM_HOSTS[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) return true;
  }
  return false;
}

/** Which contradictory pairs are both present on this row? */
function prContradictionsIn_(categoryName, terms) {
  const pairs = PR_CONTRADICTIONS[categoryName] || [];
  const out = [];
  pairs.forEach(function (pair) {
    if (terms.indexOf(pair[0]) !== -1 && terms.indexOf(pair[1]) !== -1) out.push(pair);
  });
  return out;
}


// =========================================================================
// WHAT GETS WRITTEN BACK ONTO THE CANDIDATE ROW
// =========================================================================

/** The note for a row that promoted but carries flags. */
function prNoteFromFlags_(op) {
  const lines = ['PROMOTED, but flagged ' + prStamp_() + ':'];
  op.flags.forEach(function (f, i) { lines.push('  ' + (i + 1) + '. ' + f); });
  lines.push('');
  lines.push('This row DID publish to the live site. Nothing was blocked. Untick ' +
             'Promote flagged only by fixing what it names -- the next run re-ticks it ' +
             'otherwise, and clears it by itself once the cause is gone.');
  return lines.join('\n');
}

/** The note for a row that was refused. */
function prNoteFromSkip_(s) {
  return 'NOT PROMOTED ' + prStamp_() + '.\n\n' + (s.reason || 'no reason recorded') +
         '\n\nNothing was written to 50 States for this row. It will be reconsidered ' +
         'on every run, so fixing the cause is all that is needed -- there is no queue ' +
         'to re-add it to.';
}

function prStamp_() {
  return 'on ' + Utilities.formatDate(new Date(),
    Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm z');
}

/**
 * Queue a Promote status / note / flag write, unless all three already match.
 *
 * THE WHOLE TRIPLE OR NOTHING. Writing a subset would let a stale note outlive
 * the condition it describes, which is the failure this file has hit twice in
 * other forms -- a correct value with a comment underneath saying the
 * opposite. Airtable charges the same for one field or three.
 */
function prPushStamp_(stamps, recordId, beforeStatus, beforeNote, beforeFlagged,
                      status, note, flagged) {
  if (!recordId) return;
  if (beforeStatus === status &&
      String(beforeNote || '') === String(note || '') &&
      (beforeFlagged === true) === (flagged === true)) return;
  const f = {};
  f[PR_C_PROMOTE_STATUS]  = status;
  f[PR_C_PROMOTE_NOTE]    = note || '';
  f[PR_C_PROMOTE_FLAGGED] = !!flagged;
  stamps.push({ recordId: recordId, fields: f });
}


// =========================================================================
// THE RUN SUMMARY EMAIL
// =========================================================================

/**
 * One email per applying run.
 *
 * IT EXISTS FOR TRIGGERED RUNS AND NOTHING ELSE. A person running this by
 * hand has the log open. A trigger has no log anyone will read -- the
 * Executions panel exists but nobody visits it unprompted -- so without this
 * a scheduled promotion could refuse forty rows in silence for a month.
 *
 * BLOCKED FIRST, THEN CHECKMARK REMOVALS, THEN FLAGS. Ordered by what needs a
 * person soonest, not by what the run did most of. The counts are last, since
 * they are the part that is also in the log.
 */
function prEmail_(r) {
  const to = PR_EMAIL_TO || Session.getEffectiveUser().getEmail();
  if (!to) { Logger.log('No address to send the run summary to; skipped.'); return; }

  const needsAttention = r.skips.length + r.clearedList.length + r.flaggedList.length;
  const subject = 'HazingInfo promote: ' + r.written + ' school(s) written, ' +
    r.skips.length + ' refused, ' + r.flaggedList.length + ' flagged' +
    (r.failedCount ? ', ' + r.failedCount + ' WRITE FAILURES' : '');

  const b = [];
  b.push('Promote ran at ' + r.started.toISOString() + ' and wrote to the live site.');
  b.push('');

  if (!r.ownershipLive) {
    b.push('*** THE OWNERSHIP CHECK DID NOT RUN. The Institutions table returned no');
    b.push('rows, so no address was compared against the school it claims to belong');
    b.push('to. A URL belonging to a different school would NOT have been caught.');
    b.push('');
  }

  if (r.failedCount) {
    b.push('*** ' + r.failedCount + ' school(s) FAILED TO SAVE to 50 States. Those rows are');
    b.push('stamped "' + PR_STATUS_FAILED + '" with the error in Promote note.');
    b.push('');
  }

  if (r.skips.length) {
    b.push('REFUSED -- ' + r.skips.length + ' row(s) did not publish');
    b.push('Each is stamped "' + PR_STATUS_SKIPPED + '" with the reason in Promote note.');
    b.push('An ownership refusal on a school you know is correct is fixed by adding a');
    b.push('row to the Ownership exceptions table in PAGES, not by changing code.');
    b.push('');
    r.skips.forEach(function (s) {
      b.push('  ' + (s.unitid || '(no UNITID)') + ' / ' +
        (s.categoryName || '(no category)') + ': ' + s.reason);
    });
    b.push('');
  }

  if (r.clearedList.length) {
    b.push('CHECKMARKS REMOVED -- ' + r.clearedList.length + ' school(s) lost a check');
    b.push('These pages now show no checkmark where they previously did, because a');
    b.push('reviewer marked the page below standard. This is the most consequential');
    b.push('thing this script does. If any of these look wrong, they are worth');
    b.push('checking today rather than at the next review.');
    b.push('');
    r.clearedList.forEach(function (s) { b.push('  ' + s); });
    b.push('');
  }

  if (r.flaggedList.length) {
    b.push('PUBLISHED BUT FLAGGED -- ' + r.flaggedList.length + ' row(s)');
    b.push('These DID go live. Nothing was stopped. Each is ticked "Promote flagged"');
    b.push('on Candidate URLs, so filter a view on that field rather than working');
    b.push('from this list.');
    b.push('');
    r.flaggedList.forEach(function (s) { b.push('  ' + s); });
    b.push('');
  }

  if (!needsAttention) {
    b.push('Nothing needs attention: no refusals, no checkmarks removed, no flags.');
    b.push('');
  }

  b.push('---');
  b.push('Promotable rows read: ' + r.rows);
  b.push('Schools written:      ' + r.written);
  b.push('Rows stamped:         ' + r.stamped);
  b.push('Checkmarks gained:    ' + r.gained);
  b.push('Checkmarks removed:   ' + r.cleared);
  b.push('Refused:              ' + r.skips.length);
  b.push('Published but flagged:' + r.flaggedList.length);
  b.push('');
  b.push('Discovery gates on the compliance fields, so every school promoted with');
  b.push('below-standard terms stays in the discovery queue. That is intended.');

  MailApp.sendEmail(to, subject, b.join('\n'));
  Logger.log('Run summary emailed to ' + to + '.');
}


// =========================================================================
// AIRTABLE
// =========================================================================
function prRequirePat_() {
  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) throw new Error('Set AIRTABLE_PAT in Script Properties first.');
  return pat;
}

/**
 * POST /listRecords rather than a GET query string, for the same reason
 * LiveUrlChecks.gs and WriteBack.gs use it: Apps Script caps a fetch URL at
 * roughly 2KB and a fields[] list plus a filterByFormula goes past that.
 */
function prList_(pat, baseId, tableId, body) {
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + baseId + '/' + tableId + '/listRecords',
    {
      method: 'post',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    }
  );
  if (resp.getResponseCode() !== 200) {
    throw new Error('Airtable list error on ' + baseId + '/' + tableId +
      ' (HTTP ' + resp.getResponseCode() + '): ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

function prListAll_(pat, baseId, tableId, fields, formula) {
  const out = [];
  let offset = null;
  let guard = 0;
  do {
    const body = { pageSize: PR_PAGE_SIZE, returnFieldsByFieldId: true, fields: fields };
    if (formula) body.filterByFormula = formula;
    if (offset) body.offset = offset;
    const json = prList_(pat, baseId, tableId, body);
    (json.records || []).forEach(function (r) { out.push(r); });
    offset = json.offset || null;
    Utilities.sleep(PR_SLEEP_MS);
  } while (offset && ++guard < 400);
  return out;
}

/**
 * Takes objects carrying { recordId, fields }. Both the 50 States write and
 * the Promote status stamp go through here.
 */
function prPatch_(pat, baseId, tableId, targets) {
  const payload = {
    records: targets.map(function (t) { return { id: t.recordId, fields: t.fields }; }),
    typecast: false
  };
  const resp = UrlFetchApp.fetch(
    'https://api.airtable.com/v0/' + baseId + '/' + tableId,
    {
      method: 'patch',
      headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  Utilities.sleep(PR_SLEEP_MS);
  return { ok: resp.getResponseCode() === 200, error: resp.getContentText() };
}


/**
 * UNITID -> { name, url } for every institution, from the PAGES mirror.
 *
 * FAILS SOFT, RETURNING AN EMPTY OBJECT. The caller reads an empty result as
 * "stand the ownership check down and say so loudly" rather than "refuse
 * everything". A lookup table that cannot be read is an infrastructure
 * problem; turning it into 231 refusals would make it a publishing problem
 * too, and the second is much more expensive to undo.
 *
 * Adds roughly fifteen seconds to a run that took thirty-eight. Comfortable
 * against the six-minute cap, and it is the price of the check.
 */
function prInstitutions_(pat) {
  const out = {};
  try {
    const rows = prListAll_(pat, PR_PAGES_BASE, PR_INST_TABLE,
      [PR_I_UNITID, PR_I_NAME, PR_I_URL], '');
    rows.forEach(function (r) {
      const u = String(r.fields[PR_I_UNITID] || '').trim();
      if (!u) return;
      out[u] = {
        name: String(r.fields[PR_I_NAME] || ''),
        url:  prFirstUrl_(r.fields[PR_I_URL])
      };
    });
  } catch (e) {
    Logger.log('Could not read Institutions, so the ownership check will not run ' +
      'this time: ' + e);
    return {};
  }
  return out;
}

/**
 * Institution URL is multilineText, sometimes holds more than one value, and
 * often has no scheme. Take the first token that looks like a host.
 */
function prFirstUrl_(value) {
  const parts = String(value || '').split(/[\s,;]+/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (!p) continue;
    if (/^(?:https?:\/\/)?[^\/\s:]+\.[^\/\s:]+/i.test(p)) return p;
  }
  return '';
}

/**
 * UNITID -> [allowed strings], from the Ownership exceptions table.
 *
 * ONLY ACTIVE ROWS. Unticking Active retires an exception while keeping the
 * record of why it once existed, which is worth more than a tidy table.
 *
 * FAILS SOFT AND EMPTY, but note this failure is the opposite direction from
 * the Institutions one: with no exceptions loaded the check gets STRICTER,
 * and a school with a legitimate exception is refused rather than published.
 * That is the right way round -- an unread exceptions table costs a refusal
 * someone will see and complain about, where an unread Institutions table
 * would cost a silent gap in the check.
 */
function prExceptions_(pat) {
  const out = {};
  try {
    const rows = prListAll_(pat, PR_PAGES_BASE, PR_EXC_TABLE,
      [PR_X_UNITID, PR_X_ALLOW, PR_X_ACTIVE], '');
    rows.forEach(function (r) {
      if (r.fields[PR_X_ACTIVE] !== true) return;
      const u = String(r.fields[PR_X_UNITID] || '').trim();
      const a = String(r.fields[PR_X_ALLOW] || '').trim();
      if (!u || !a) return;
      (out[u] = out[u] || []).push(a);
    });
  } catch (e) {
    Logger.log('Could not read Ownership exceptions, so none will apply this run. ' +
      'Any school that depends on one will be refused: ' + e);
    return {};
  }
  return out;
}

function prExceptionCount_(exceptions) {
  let n = 0;
  for (const k in exceptions) n += exceptions[k].length;
  return n;
}
