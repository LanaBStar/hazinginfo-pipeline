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
// TWO PASSES LIVE IN THIS FILE. promoteDryRun / promoteApply* promote URLs
// and checkmarks. promoteHotlineContactDryRun / promoteHotlineContactApply*
// promote the hotline and the university contact, and are a SEPARATE pass
// because a hotline decision is not a verdict about the page -- the reasoning
// is in the SECOND PASS section header at the bottom of this file. Neither
// pass reads or writes the other's fields, and each has its own status and
// note fields on Candidate URLs.
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
// This publishes to a public record of how individual institutions handle
// hazing -- their policies, their transparency reports, their reporting
// routes, and what has been reported at them. It is read by students and
// prospective students deciding where to go, by their families, by
// journalists, and by researchers. Nobody arrives at it already knowing the
// answer; they arrive to find out, and they take what it says as fact.
//
// So a bad write here is not a failed job. It is a wrong statement about a
// named institution, published under HazingInfo's name, to someone with no
// way to tell it is wrong. It has a shape in each direction: a URL that goes
// somewhere useless or belongs to another school, a checkmark on a school
// that has not earned it, or a missing checkmark on a school that has. Every
// guard below exists for one of those three.
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
// number afterwards: this file is 1,977 lines (it was 927 before the
// hardening pass, and 1,788 before the 3pm calibration pass).
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
// UNITID and THE PASTED ADDRESS lets a refused URL through, and adding one is
// adding a row in Airtable.
//
// THE FIELD TAKES A WHOLE URL, DELIBERATELY. It held a fragment in the first
// draft, which was worse in both directions: nobody can be asked to decide
// which part of an address is "the distinctive bit" without knowing what a
// substring is, and somebody typing maxient.com into it would have let every
// school's Maxient form through for that school. Copy the address from the
// Candidate URLs row, paste it here. That is the entire instruction.
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
const PR_X_ALLOW    = 'fld1CYLnxN0JPz9QM';   // Allowed URL -- a PASTED address
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
 * USED FOR THE OWNERSHIP CHECK ONLY. Being on a vendor host is what earns an
 * off-domain URL the chance to match on a name token instead of being refused
 * outright.
 *
 * IT IS NOT EVIDENCE OF WHAT THE PAGE IS. The first draft of the category
 * check used this list for exactly that and was wrong: cm.maxient.com serves
 * transparency reports as well as forms, and 79 schools publish their CHTR
 * page there. The category check keys on the PATH instead -- see
 * PR_PATH_FORM.
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
    ['No update date stated or inferable', 'Update date outside the freshness window'],
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
      // Renamed 2026-09-10 when the dating rule stopped caring about
      // precision: a month or a year now dates a page as well as a day does.
      // "Dated to month or year only on index" was deleted the same day (it
      // was on zero rows, checked first), and the two survivors dropped "on
      // index" because a date inside the linked report now counts too.
      // RENAMED IN BOTH BASES AND HERE, IN ONE SITTING. These are written by
      // NAME, so a rename in one place alone fails every write carrying the
      // term -- loudly, because typecast is false, which is the point.
      'Incidents listed without description',
      'Hazing not broken out from general conduct data',
      'Login required',
      'Report announced but not published',
      'No update date stated or inferable',
      'Update date outside the freshness window'
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

// The hotline / contact pass has its own three entry points --
// promoteHotlineContactDryRun(), promoteHotlineContactApply() and
// promoteHotlineContactApplyForReal() -- declared at the bottom of this file,
// next to the logic they run.


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
          'the UNITID, and the refused address PASTED WHOLE into Allowed URL -- not ' +
          'by editing this file. Then re-run.');
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

      // THREE WAYS TO FAIL, AND ONLY ONE OF THEM IS A REFUSAL.
      //
      //   wrong-school    the address points somewhere that is positively not
      //                   this school. Refuse.
      //   unattributable  the address names nobody at all. Not evidence of the
      //                   wrong school; no evidence of the right one. Flag.
      //   cannot-test     nothing distinctive could be derived from THIS
      //                   school to test with. The check has no opinion, so it
      //                   must not pretend to one. Flag.
      const softFail = verdict.kind === 'unattributable'
        ? !PR_UNATTRIBUTABLE_BLOCK
        : verdict.kind === 'cannot-test';

      if (!verdict.ok && softFail) {
        flags.push('ownership NOT CONFIRMED -- ' + verdict.why + ' Promoted on the ' +
                   'reviewer\'s judgement. Worth opening SIGNED OUT to confirm the ' +
                   'public can actually reach it.');
      } else if (!verdict.ok) {
        base.reason = 'BLOCKED -- ' + verdict.why + ' URL: "' + url + '". ' +
          'The school\'s own site is ' + prDomain_(inst.url) + '. ' +
          'IF THIS ADDRESS IS ACTUALLY CORRECT, add a row to the Ownership ' +
          'exceptions table in PAGES: UNITID ' + unitid + ', and PASTE THIS ADDRESS ' +
          'into Allowed URL. No code change is needed and the exception survives ' +
          'future candidate rows for this school. Then re-run.';
        return base;
      }
      if (verdict.viaException) {
        flags.push('ownership allowed by exception -- off-domain address accepted ' +
                   'because a row in Ownership exceptions says it is this school\'s ' +
                   '("' + String(verdict.viaException).slice(0, 120) + '")');
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

  // The Dominican NY case: a Maxient REPORTING FORM promoted into CHTR, which
  // would have replaced a working transparency-report index, kept the
  // checkmark, and fired no warning at all.
  //
  // THIS KEYS ON THE PATH, NOT THE HOST, AND THE FIRST DRAFT GOT THAT WRONG.
  // It flagged any vendor host promoted into a non-form category, on the
  // reasoning that vendor URLs are reporting forms. They are not: 79 schools
  // publish their transparency report at cm.maxient.com/chtr.php, verified
  // against 50 States on 2026-09-10, and the host rule would have flagged
  // every one of them. It did flag two in the first dry run -- Endicott and
  // Texas A&M-San Antonio -- and both were correct pages.
  //
  // The path is the real signal and it is unambiguous. Maxient serves forms
  // from reportingform.php and transparency reports from chtr.php. Seventy-
  // nine false positives become zero, and Dominican NY is still caught.
  //
  // A FLAG THAT FIRES ON CORRECT ROWS IS WORSE THAN NO FLAG, because people
  // learn to dismiss it and then dismiss the true one too. Keep this narrow.
  const purpose = prUrlPurpose_(url);
  if (purpose === 'form' && categoryName !== 'Report Form') {
    flags.push('this address is a VENDOR REPORTING FORM (' + prPurposeEvidence_(url) +
               ') but is being promoted into ' + categoryName + '. That is very likely ' +
               'the wrong category -- check whether it belongs in Report Form, and ' +
               'whether this promotion is about to overwrite a working ' +
               categoryName + ' page. This is the Dominican NY shape.');
  }
  if (purpose === 'transparency' && categoryName !== 'CHTR') {
    flags.push('this address is a VENDOR TRANSPARENCY REPORT (' + prPurposeEvidence_(url) +
               ') but is being promoted into ' + categoryName + '. Check whether it ' +
               'belongs in CHTR instead.');
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
 * prIsUnattributableHost_ for how those are handled and why they are not
 * simply refused.
 */
function prBelongsTo_(url, inst, allowedUrls) {
  const host = prDomain_(url);
  if (!host) {
    return { ok: false, kind: 'wrong-school', why: 'the address has no readable host.' };
  }

  const own = prDomain_(inst.url);
  if (own && (host === own || host.slice(-(own.length + 1)) === '.' + own)) {
    return { ok: true };
  }

  const hit = prExceptionMatch_(url, allowedUrls);
  if (hit) return { ok: true, viaException: hit };

  const flat  = prFlatten_(url);
  const label = prFlatten_(String(own || '').split('.')[0]);

  if (!prIsVendorHost_(url)) {
    // The school's own domain label inside somebody else's address: rented
    // infrastructure serving the school's own document. NAME WORDS ARE NOT
    // CONSULTED HERE -- see PR_LABEL_MIN.
    if (label.length >= PR_LABEL_MIN && flat.indexOf(label) !== -1) {
      return { ok: true, viaLabel: label };
    }
    if (prIsUnattributableHost_(url)) {
      return {
        ok: false, kind: 'unattributable',
        why: 'this address is on ' + host + ', where the URL carries no institutional ' +
             'identifier of any kind, so it can be neither confirmed nor disproved as ' +
             'this school\'s.'
      };
    }
    return {
      ok: false, kind: 'wrong-school',
      why: 'this address is on neither the school\'s own domain nor a recognised ' +
           'conduct-reporting vendor, and does not contain the school\'s own domain ' +
           'name, so there is no basis for treating it as this school\'s page. This is ' +
           'the Seattle Pacific failure -- its Report Form was a umass.edu page.'
    };
  }

  const tokens = prTokens_(inst, own);
  if (!tokens.length) {
    // National University: the label "nu" is below the three-character floor
    // and "national" is a stop word, so nothing distinctive survives. There is
    // no test to run, which is not the same as failing one.
    return {
      ok: false, kind: 'cannot-test',
      why: 'nothing distinctive can be derived from this school\'s name or domain to ' +
           'match against a vendor address -- the domain label is too short and every ' +
           'word of the name is too generic -- so ownership could not be tested here.'
    };
  }
  for (let t = 0; t < tokens.length; t++) {
    if (flat.indexOf(tokens[t]) !== -1) return { ok: true };
  }

  return {
    ok: false, kind: 'wrong-school',
    why: 'this address is on a conduct-reporting vendor but carries nothing ' +
         'identifying this school, which is exactly how one school\'s reporting ' +
         'form gets filed against another.'
  };
}

/**
 * Does any Ownership exceptions row for this school match this address?
 *
 * THE FIELD HOLDS A PASTED URL. That was Lana's call on 2026-09-10 and it is
 * the right one twice over. It is the only thing a non-technical person can
 * be asked to do without explaining what a "string" is -- copy the address
 * from the Candidate URLs row, paste it here -- and it is SAFER than the
 * substring design it replaced, where somebody typing "maxient.com" into the
 * field would have let every school's Maxient form through for that school.
 *
 * Compared with scheme, www and trailing slash ignored, and matched in either
 * direction so that a stored address still covers the same page when a
 * tracking parameter is added or dropped.
 *
 * A VALUE THAT IS NOT A URL IS TREATED AS A SUBSTRING, for the rows written
 * under the older design. Both shapes keep working; new rows should be URLs.
 */
function prExceptionMatch_(url, allowedUrls) {
  const cand = prNormaliseUrl_(url);
  const flat = prFlatten_(url);
  for (let i = 0; i < allowedUrls.length; i++) {
    const raw = String(allowedUrls[i] || '').trim();
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw) || /^[^\/\s]+\.[a-z]{2,}\//i.test(raw)) {
      const stored = prNormaliseUrl_(raw);
      if (stored && (cand.indexOf(stored) === 0 || stored.indexOf(cand) === 0)) return raw;
    } else {
      const needle = prFlatten_(raw);
      if (needle && flat.indexOf(needle) !== -1) return raw;
    }
  }
  return '';
}

/** Lowercased, scheme-less, www-less, no trailing slash. For comparing URLs. */
function prNormaliseUrl_(url) {
  return String(url || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\d*\./, '')
    .replace(/\/+$/, '');
}

/**
 * Hosts where an address CANNOT carry an institutional identifier at all.
 *
 * docs.google.com/forms/d/e/1FAIpQLSd.../viewform names nobody. Neither does
 * a Microsoft Forms id, an emailmeform builder id, a casetracker number, a
 * syntrio code, or a numbered pcdn.co CDN bucket. There is no way to
 * attribute any of them from the URL, and there never will be.
 *
 * THESE ARE FLAGGED, NOT REFUSED, AND THAT IS A DELIBERATE DEPARTURE FROM
 * SearchProbe.gs, WHICH REFUSES THEM. The reason is the inverted cost stated
 * at the top: SearchProbe is filtering machine output, where dropping an
 * unattributable candidate costs nothing. Here a human has already opened the
 * school's page and confirmed this is what it links to. Refusing would throw
 * that away and demand an exception row for every school using Google Forms,
 * which is a lot of them.
 *
 * AND NOTE WHAT THE RISK ACTUALLY IS. An unattributable address names nobody,
 * so it is not evidence of the WRONG school; it is merely no evidence of the
 * right one. That is a different and smaller danger than umass.edu on a
 * Seattle Pacific row, which names a different institution outright.
 *
 * THE ENTRIES AFTER THE FORM HOSTS CAME FROM THE 2026-09-10 DRY RUN, where
 * they were refused as wrong-school and every one turned out to be the
 * school's own document on somebody else's infrastructure -- Millikin on
 * syntrio, St. Francis on casetracker, Shaw on emailmeform, Missouri Baptist
 * on a pcdn.co WordPress CDN. Add to this list when the same shape recurs;
 * do not add a host that normally DOES name its tenant (see below).
 *
 * DO NOT ADD MAXIENT, SYMPLICITY OR ETHICSPOINT HERE. Those name their tenant
 * as a matter of course -- BYU's EthicsPoint URL carries
 * companyname=Brigham%20Young%20University -- so an address on one of them
 * with no identifier is genuinely suspicious rather than merely unreadable.
 * That is the Alcorn State case, and it should stay a refusal.
 *
 * TO MAKE THESE REFUSALS INSTEAD, set PR_UNATTRIBUTABLE_BLOCK to true. Expect
 * to add a lot of exception rows if you do.
 */
const PR_UNATTRIBUTABLE_HOSTS = [
  'docs.google.com', 'forms.gle', 'forms.office.com', 'forms.microsoft.com',
  'syntrio.com', 'casetracker.app', 'emailmeform.com', 'pcdn.co'
];
const PR_UNATTRIBUTABLE_BLOCK = false;

function prIsUnattributableHost_(url) {
  const host = prDomain_(url);
  if (!host) return false;
  for (let i = 0; i < PR_UNATTRIBUTABLE_HOSTS.length; i++) {
    const v = PR_UNATTRIBUTABLE_HOSTS[i];
    if (host === v || host.slice(-(v.length + 1)) === '.' + v) return true;
  }
  return false;
}

/**
 * Shortest domain label accepted as proof of ownership off a vendor host.
 *
 * FIVE, AND THE FLOOR IS THE WHOLE POINT. Lane College's handbook lives at
 * s3.../lanecollegeedu/, Life Pacific's at lifepacific-web.s3..., Cumberland's
 * catalogue at cumberland.smartcatalogiq.com. All three are plainly the
 * school's own document on rented infrastructure, and all three were refused
 * on 2026-09-10 because the check never looked past the host.
 *
 * ONLY THE DOMAIN LABEL COUNTS HERE, NEVER A WORD FROM THE NAME, and that
 * restriction is load-bearing. Lana's objection, and she is right: the
 * realistic error is a reviewer confusing two similarly-named schools, and a
 * name-word match passes exactly those -- St. Francis College and Saint
 * Francis University both contain "francis". A domain label is specific to
 * one institution in a way a name word is not. The five-character floor then
 * keeps short labels like sfc and spu out, since those are the ones most
 * likely to appear inside an unrelated string by accident.
 */
const PR_LABEL_MIN = 5;

/**
 * What a vendor address is FOR, judged by its path.
 *
 * Returns 'form', 'transparency', or '' when the address says nothing either
 * way -- which is most of the time, and the right answer when it is.
 *
 * WHY PATHS AND NOT HOSTS: see the note at the call site. The one-line
 * version is that cm.maxient.com serves both kinds and 79 schools publish
 * their transparency report there, so the host is evidence of nothing.
 *
 * ONLY ADD A PATTERN YOU HAVE CHECKED AGAINST REAL ROWS. A pattern that is
 * merely plausible turns this from a signal into noise, and a flag people
 * dismiss is worse than no flag.
 */
const PR_PATH_FORM = [
  // BOTH MAXIENT FORM PATHS. reportingform.php is the common one; reporting.php
  // is an older variant still used by 12 schools, counted against 50 States on
  // 2026-09-10 after Catholic University turned up on it in a dry run and this
  // list did not recognise it. Every pattern here was checked against real rows
  // rather than guessed; check the next one the same way.
  /maxient\.com\/reporting(?:form)?\.php/i,
  /symplicity\.com\/public_report/i,
  /ethicspoint\.com\/.*\/(?:issues\.html|report_company\.asp)/i,
  /ethicspoint\.com\/custom\/.*\/report/i
];
const PR_PATH_TRANSPARENCY = [
  /maxient\.com\/chtr\.php/i
];

function prUrlPurpose_(url) {
  const s = String(url || '');
  for (let i = 0; i < PR_PATH_TRANSPARENCY.length; i++) {
    if (PR_PATH_TRANSPARENCY[i].test(s)) return 'transparency';
  }
  for (let i = 0; i < PR_PATH_FORM.length; i++) {
    if (PR_PATH_FORM[i].test(s)) return 'form';
  }
  return '';
}

/** The part of the address that decided prUrlPurpose_, for the note. */
function prPurposeEvidence_(url) {
  const m = /\/([A-Za-z0-9_.-]+\.(?:php|html|asp|aspx))/i.exec(String(url || ''));
  if (m) return m[1];
  const p = /(public_report|report_company|issues)/i.exec(String(url || ''));
  return p ? p[1] : prDomain_(url);
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

// =========================================================================
// SECOND PASS -- HOTLINE AND CONTACT
// =========================================================================
//
// WHY THIS IS A SEPARATE PASS AND NOT PART OF prPlan_. A reviewer's hotline
// or contact decision is about a phone number and an email address that
// happen to appear on a page. It is NOT a verdict about the page. Measured
// 2026-09-12: of the twenty decided rows that produced a write, SEVEN sat on
// rows whose Reviewer determination is "Rejected - wrong page" or "Duplicate
// of confirmed page" -- the page was thrown out and the phone number was
// still correct. Every one of those rows hits an early return inside
// prPlan_, and the no-op filter in prRun_ would drop a hotline-only write
// even on the rows that survive. Folding this into the URL path would
// therefore lose a third of the work silently, which is the exact failure
// shape this file exists to prevent.
//
// So: its own entry points, its own gate, its own run, its own status fields.
// It reuses the UNITID join, prListAll_ and prPatch_ from above and touches
// nothing else.
//
// HC IS SHORT FOR HOTLINE/CONTACT. Everything this pass declares is prefixed
// PR_HC_ or prHc, which keeps it inside this file's PR_/pr namespace while
// staying obviously separable from the URL pass.
//
// -------------------------------------------------------------------------
// WHAT GATES A WRITE -- THE DECISION FIELD, NOT THE DETERMINATION
// -------------------------------------------------------------------------
//   Hotline decision = Accepted                               -> write TEST AI hotline
//   Hotline decision = Rejected - use proposed hotline instead -> write Proposed hazing hotline
//   Contact decision = Accepted                               -> write TEST AI contact
//   Contact decision = Rejected - use proposed contact instead -> write Proposed university contact
//
//   Rejected              -> NOTHING IS WRITTEN AND NOTHING IS CLEARED
//   Needs second opinion  -> nothing
//   (blank)               -> nothing
//
// REJECTED DOES NOT CLEAR. Rejected means the AI read the wrong number off
// the page. It does not mean the school has no hotline. Clearing on Rejected
// would delete hand-collected values in 50 States that nobody asked us to
// touch -- 427 rows already carry both a hotline and a contact.
//
// -------------------------------------------------------------------------
// A PROMOTED ITEM IS NEVER RECONSIDERED, AND THAT IS THE POINT
// -------------------------------------------------------------------------
// THE BUG THIS FIXES. The first version of this pass re-checked every decided
// row on every run and rewrote 50 States whenever the value differed. That
// makes an old decision permanent and retroactive: a hotline Accepted in 2026
// would overwrite a better number somebody typed into 50 States by hand in
// 2029, silently, on the next run, forever. A decision is a statement about
// what was true when it was made, not a standing instruction to keep
// asserting it.
//
// So each item carries its own status, and an item reading "Promoted" is
// SETTLED: the pass does not look at its value again and cannot overwrite
// anything. It also keeps the work bounded. Candidate URLs grows by a review
// cycle twice a year; the settled rows drop out of scope, so the run reads
// what is unresolved rather than everything ever decided.
//
//   Hotline promote status   fldxQTuaXowzfZSI9   Promoted / Refused / Write failed
//   Contact promote status   fldnGjhXBelpjQnaK   Promoted / Refused / Write failed
//   Hotline/contact promote note   fldbYVFzNy2uGoAtX   long text, shared
//
// TWO STATUS FIELDS, NOT ONE, BECAUSE THE TWO ITEMS SETTLE INDEPENDENTLY. A
// row can have a good hotline and an unusable contact. One combined status
// could only say "partly promoted", which leaves the pass unable to tell
// which half to leave alone -- so the settled half would keep being
// re-asserted, which is the bug above in miniature. Two fields also retire
// the "partly promoted" value entirely: two fields disagreeing says it
// plainly, and a schema that states the thing beats a vocabulary term that
// summarises it.
//
// TO FORCE A RE-PROMOTE, CLEAR THE STATUS FIELD. That is the documented
// escape hatch, and it is why the fields are worth a Data Dictionary entry.
// If the AI field is re-run years later and produces a different number, the
// row does NOT silently re-promote: the reviewer accepted the value they
// actually saw, and a new value deserves a new decision.
//
// SEPARATE FROM Promote status / Promote note / Promote flagged, deliberately.
// Writing "Promoted" into Promote status for a hotline write would assert
// that the page published, on rows where the page was explicitly rejected --
// and the two passes would overwrite each other's notes, leaving whichever
// ran last describing only half of what happened.
//
// THE NOTE IS SHARED, REWRITTEN IN FULL EVERY RUN, AND CARRIES SETTLED LINES
// FORWARD VERBATIM. Rewriting rather than appending keeps it from describing
// a condition that has since been fixed. Carrying the settled lines forward
// is what preserves the date an item actually reached the public site --
// without it, a run that promoted the contact would replace the hotline's
// "WROTE this on 2026-09-11" with nothing at all, and the record of when a
// value went live is the whole reason these fields exist.
//
// AND THE STAMP IS CLEARED per item when a row stops having anything to
// promote -- a reviewer changing Accepted to Rejected wipes that item's
// status rather than leaving "Promoted" under a decision that no longer says
// so.
//
// -------------------------------------------------------------------------
// THE SHAPE GUARD IS NOT OPTIONAL
// -------------------------------------------------------------------------
// The AI writes prose, and two of its habits reach these fields:
//
//   "none" / "not collected"   -- the sentinel for nothing found. Measured
//                                 2026-09-12, "none" is sitting in TEST AI
//                                 hotline or TEST AI contact on 14 rows.
//   "[email protected]"       -- a redaction artifact lifted out of page
//                                 text. It is on FOUR rows, and it passes
//                                 the existing Contact check formula, which
//                                 only asks whether an "@" is present.
//
// Neither is a value. A decision field is a human saying "yes, that one" and
// is not a guarantee the string underneath is well formed, so the guard runs
// on every write regardless of what was decided. A value that fails it is
// refused, recorded on the row, and never silently dropped.
//
// THE NATIONAL HOTLINE IS REFUSED TOO, AND THIS ONE IS A JUDGEMENT CALL.
// 888-668-4293 is the national anti-hazing line, not any school's own. The
// Hotline check formula already calls it "Reject - NOT-HAZE hotline". If a
// reviewer Accepts it anyway this pass refuses it and says so on the row
// rather than publishing it as a school's number. Delete PR_HC_NOT_HAZE and
// the two lines that read it if the organisation decides the reviewer's
// Accept should win.
//
// -------------------------------------------------------------------------
// WHAT MAKES IT SAFE TO RE-RUN
// -------------------------------------------------------------------------
// Settled items are not read at all. For the rest, the pass reads the current
// 50 States value and drops the write if it already matches. Phones compare
// on the ten digits that identify the line and emails case-insensitively, so
// a reformatted-but-identical value is a no-op rather than a write.
//
// TWO ROWS FOR ONE SCHOOL THAT DISAGREE ARE REFUSED, NOT RESOLVED. A school
// has up to three Candidate rows, one per category, and each can carry its
// own decision. Where two rows would write DIFFERENT values into the same 50
// States field, both are refused, both rows are stamped, and the conflict is
// named. Taking the first and moving on is how a silently chosen verdict
// happens.
//
// The benign version of that -- the same value Accepted on one row and
// Rejected on another, which is what 157863, 200059 and 451866 look like
// today -- is not a conflict. Rejected writes nothing, so there is nothing
// to disagree with.
//
// STILL READS ALL OF 50 STATES, and that read is the dominant cost of a run
// -- five to twenty seconds for about 1,477 rows. It does not grow: that is
// roughly how many institutions exist. Fetching only the rows a run needs, by
// UNITID, is the obvious next optimisation and is not worth its complexity
// until a run approaches the six-minute cap.
// =========================================================================

// ---- Candidate URLs fields this pass reads -------------------------------
const PR_HC_C_AI_HOTLINE    = 'fldFbCOyTYeU8pD7a';   // TEST AI hotline (formula)
const PR_HC_C_AI_CONTACT    = 'fldfTMSWqvRXImJT4';   // TEST AI contact (formula)
const PR_HC_C_HOTLINE_DEC   = 'fldPv0sfLDhOiSAhX';   // Hotline decision
const PR_HC_C_CONTACT_DEC   = 'fldMqpnRY8IUBVNA5';   // Contact decision
const PR_HC_C_PROP_HOTLINE  = 'fldXVrCGrD6hJtdd8';   // Proposed hazing hotline (phone)
const PR_HC_C_PROP_CONTACT  = 'fldJ4XBLbVQuIyIle';   // Proposed university contact (email)

// ---- Candidate URLs fields this pass WRITES ------------------------------
const PR_HC_C_HOT_STATUS = 'fldxQTuaXowzfZSI9';   // Hotline promote status
const PR_HC_C_CON_STATUS = 'fldnGjhXBelpjQnaK';   // Contact promote status
const PR_HC_C_NOTE       = 'fldbYVFzNy2uGoAtX';   // Hotline/contact promote note

// ---- 50 States fields this pass writes -----------------------------------
const PR_HC_S_HOTLINE = 'fldx3LwZMhNLw8GMl';   // Hazing Hotline (phoneNumber)
const PR_HC_S_CONTACT = 'fldqmnxOGSuDb86aV';   // University Contact (multilineText)

// ---- The decisions this pass acts on -------------------------------------
// Written by NAME, like everything else in this file. A renamed choice in
// Airtable keeps the rows already carrying it and breaks the next read, so
// these strings have to match the single-selects exactly.
const PR_HC_DEC_ACCEPTED    = 'Accepted';
const PR_HC_DEC_USE_HOTLINE = 'Rejected - use proposed hotline instead';
const PR_HC_DEC_USE_CONTACT = 'Rejected - use proposed contact instead';

// ---- The three status values, shared by both status fields ---------------
// Also written by name, with typecast:false, so a mismatch fails the write
// loudly instead of minting a fourth choice nobody meant to create.
const PR_HC_ST_PROMOTED = 'Promoted';
const PR_HC_ST_REFUSED  = 'Refused';
const PR_HC_ST_FAILED   = 'Write failed';

// The national anti-hazing line, the ten digits that identify it. See header.
const PR_HC_NOT_HAZE = '8886684293';

// Sentinels the AI writes when it found nothing. Compared lowercased.
const PR_HC_SENTINELS = ['none', 'not collected', 'not found', 'n/a', 'na',
                         'unknown', 'not listed', 'not stated', 'blank', '-'];

// A ceiling, not a target. A run that wants to touch more schools than this
// has almost certainly read something wrong, and stopping is cheaper than
// undoing.
const PR_HC_MAX_WRITES = 200;


// =========================================================================
// ENTRY POINTS -- HOTLINE AND CONTACT
// =========================================================================

/**
 * Reports what promoteHotlineContactApplyForReal() would do. Writes nothing,
 * to either base, and stamps nothing on the Candidate rows. Run this first,
 * every time.
 */
function promoteHotlineContactDryRun() {
  return prHcRun_(true);
}

/**
 * Honours PR_DRY_RUN_DEFAULT, so this is a dry run while that stays true.
 */
function promoteHotlineContactApply() {
  return prHcRun_(PR_DRY_RUN_DEFAULT ? true : false);
}

/**
 * Applies for real, ignoring PR_DRY_RUN_DEFAULT. Same reasoning as
 * promoteApplyForReal(): arming the script is an explicit act that leaves the
 * file unchanged.
 */
function promoteHotlineContactApplyForReal() {
  return prHcRun_(false);
}


// =========================================================================
// THE HOTLINE / CONTACT RUN
// =========================================================================
function prHcRun_(dryRun) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another script run holds the lock. Nothing done.');
    return { blocked: true };
  }
  try {
    const pat = prRequirePat_();
    const started = new Date();

    Logger.log(dryRun
      ? '=== HOTLINE / CONTACT -- DRY RUN, nothing will be written ==='
      : '=== HOTLINE / CONTACT -- APPLYING, writing to 50 States ===');
    Logger.log('Started ' + started.toISOString());
    Logger.log('');

    const rows = prListAll_(pat, PR_PAGES_BASE, PR_CAND_TABLE,
      [PR_C_UNITID, PR_C_CATEGORY,
       PR_HC_C_HOTLINE_DEC, PR_HC_C_CONTACT_DEC,
       PR_HC_C_AI_HOTLINE, PR_HC_C_AI_CONTACT,
       PR_HC_C_PROP_HOTLINE, PR_HC_C_PROP_CONTACT,
       PR_HC_C_HOT_STATUS, PR_HC_C_CON_STATUS, PR_HC_C_NOTE],
      prHcFormula_());

    Logger.log('Rows needing attention: ' + rows.length);
    Logger.log('(Rows whose hotline AND contact both read "' +
      PR_HC_ST_PROMOTED + '" are settled and are not read. Clear a status ' +
      'field to bring one back.)');
    if (!rows.length) {
      Logger.log('');
      Logger.log('Nothing to do. Every decision has been acted on. If that is ' +
        'a surprise, check that the decision and status names in PR_HC_DEC_* ' +
        'and PR_HC_ST_* still match the Airtable single-selects exactly -- a ' +
        'renamed choice breaks the read, not the rows.');
      return { rows: 0, written: 0 };
    }

    const institutions = prListAll_(pat, PR_STATES_BASE, PR_STATES_TABLE,
      [PR_S_UNITID, PR_S_INSTITUTION, PR_HC_S_HOTLINE, PR_HC_S_CONTACT], '');
    Logger.log('50 States rows read: ' + institutions.length);

    // UNITID -> record(s). An ARRAY, so a duplicate UNITID is detectable.
    const byUnitid = {};
    institutions.forEach(function (r) {
      const u = String(r.fields[PR_S_UNITID] || '').trim();
      if (!u) return;
      (byUnitid[u] = byUnitid[u] || []).push(r);
    });

    // ---- plan every row -------------------------------------------------
    const plans = [];
    const skips = [];
    let settledItems = 0;
    rows.forEach(function (row) {
      const p = prHcPlan_(row, byUnitid);
      p.skips.forEach(function (s) { skips.push(s); });
      p.outcomes.forEach(function (o) { if (o.kind === 'settled') settledItems++; });
      plans.push(p);
    });

    // ---- merge per 50 States record, refusing real conflicts ------------
    const merged    = {};
    const conflicts = [];
    plans.forEach(function (p) {
      p.writes.forEach(function (w) {
        const slot = merged[p.targetId] = merged[p.targetId] ||
          { school: p.school, unitid: p.unitid, fields: {}, sources: {},
            poisoned: {} };
        const prior = slot.fields[w.fieldId];
        if (prior !== undefined && !w.same(prior, w.value)) {
          const text = p.unitid + ' ' + p.school + ' / ' + w.label + ': "' +
            prior + '" (' + slot.sources[w.fieldId].categoryName + ') vs "' +
            w.value + '" (' + p.categoryName + ') -- BOTH REFUSED, decide ' +
            'which is right';
          conflicts.push(text);
          prHcMarkConflict_(plans, slot.sources[w.fieldId].candidateId,
                            w.fieldId, text);
          prHcMarkConflict_(plans, p.candidateId, w.fieldId, text);
          delete slot.fields[w.fieldId];
          delete slot.sources[w.fieldId];
          slot.poisoned[w.fieldId] = true;
          return;
        }
        if (slot.poisoned[w.fieldId]) {
          prHcMarkConflict_(plans, p.candidateId, w.fieldId,
            'refused because two other rows for this school disagreed on the ' +
            w.label);
          return;
        }
        slot.fields[w.fieldId]  = w.value;
        slot.sources[w.fieldId] = { categoryName: p.categoryName,
                                    candidateId: p.candidateId };
      });
    });

    // ---- drop the no-ops ------------------------------------------------
    const targets   = [];
    const willWrite = [];
    const noops     = [];
    for (const targetId in merged) {
      const slot = merged[targetId];
      const rec  = prHcFindRecord_(institutions, targetId);
      const out  = {};
      for (const fieldId in slot.fields) {
        const value   = slot.fields[fieldId];
        const current = rec ? String(rec.fields[fieldId] || '') : '';
        const label   = (fieldId === PR_HC_S_HOTLINE) ? 'hotline' : 'contact';
        const same = (fieldId === PR_HC_S_HOTLINE)
          ? prHcSameHotline_(current, value)
          : prHcSameContact_(current, value);
        if (same) {
          noops.push(slot.unitid + ' / ' + label + ': already "' + current + '"');
          prHcMarkOutcome_(plans, targetId, fieldId, 'noop', current);
          continue;
        }
        out[fieldId] = value;
        willWrite.push(slot.unitid + ' ' + slot.school + ' / ' + label + ': ' +
          (current ? '"' + current + '" -> ' : 'blank -> ') + '"' + value + '"');
        prHcMarkOutcome_(plans, targetId, fieldId, 'written', value);
      }
      if (Object.keys(out).length) {
        targets.push({ recordId: targetId, fields: out });
      }
    }

    // ---- report ---------------------------------------------------------
    Logger.log('');
    Logger.log('Schools to write:    ' + targets.length);
    Logger.log('Field writes:        ' + willWrite.length);
    Logger.log('Already correct:     ' + noops.length);
    Logger.log('Settled, not read:   ' + settledItems + ' item(s) on rows that ' +
      'still had other work');
    Logger.log('Refused:             ' + skips.length);
    Logger.log('Conflicts refused:   ' + conflicts.length);
    Logger.log('');

    if (willWrite.length) {
      Logger.log('--- WOULD WRITE ---');
      willWrite.forEach(function (s) { Logger.log('  ' + s); });
      Logger.log('');
    }
    if (skips.length) {
      Logger.log('--- REFUSED ---');
      skips.forEach(function (s) {
        Logger.log('  ' + (s.unitid || '(no UNITID)') + ' / ' +
          (s.categoryName || '(no category)') + ': ' + s.reason);
      });
      Logger.log('');
    }
    if (conflicts.length) {
      Logger.log('--- CONFLICTS, BOTH SIDES REFUSED ---');
      conflicts.forEach(function (s) { Logger.log('  ' + s); });
      Logger.log('');
    }
    if (noops.length) {
      Logger.log('--- ALREADY CORRECT, NOT WRITTEN ---');
      noops.forEach(function (s) { Logger.log('  ' + s); });
      Logger.log('');
    }

    if (targets.length > PR_HC_MAX_WRITES) {
      Logger.log('STOPPING. ' + targets.length + ' schools is more than ' +
        'PR_HC_MAX_WRITES (' + PR_HC_MAX_WRITES + '). Nothing was written. ' +
        'A jump this size means a decision field or a parser changed meaning, ' +
        'not that the review queue moved.');
      return { rows: rows.length, written: 0, halted: true };
    }

    if (dryRun) {
      Logger.log('=== DRY RUN -- nothing written. The two promote status ' +
        'fields and the note were NOT stamped either; a dry run that stamped ' +
        'the source rows would not be a dry run. Run ' +
        'promoteHotlineContactApplyForReal() to apply. ===');
      return {
        rows: rows.length, planned: targets.length, writes: willWrite.length,
        noops: noops.length, settledItems: settledItems,
        skips: skips, conflicts: conflicts, dryRun: true
      };
    }

    // ---- write to 50 States ---------------------------------------------
    let written = 0;
    let failedCount = 0;
    const failures = [];
    for (let i = 0; i < targets.length; i += PR_WRITE_BATCH) {
      const batch = targets.slice(i, i + PR_WRITE_BATCH);
      const res = prPatch_(pat, PR_STATES_BASE, PR_STATES_TABLE, batch);
      if (res.ok) {
        written += batch.length;
      } else {
        failedCount += batch.length;
        failures.push(res.error);
        Logger.log('WRITE FAILED for ' + batch.length + ' school(s): ' + res.error);
        batch.forEach(function (t) { prHcMarkFailed_(plans, t.recordId, res.error); });
      }
    }

    // ---- stamp the Candidate rows ---------------------------------------
    // AFTER the 50 States write, never before, so the stamp reports what
    // happened rather than what was intended. All three fields move together:
    // a stale note under a fresh status is the failure mode.
    const stamps = [];
    plans.forEach(function (p) {
      const s = prHcStampFor_(p);
      if (s === null) return;
      if (String(p.beforeHotStatus || '') === String(s.hotStatus || '') &&
          String(p.beforeConStatus || '') === String(s.conStatus || '') &&
          String(p.beforeNote || '')      === String(s.note || '')) return;
      const fields = {};
      fields[PR_HC_C_HOT_STATUS] = s.hotStatus;   // null clears it
      fields[PR_HC_C_CON_STATUS] = s.conStatus;
      fields[PR_HC_C_NOTE]       = s.note;
      stamps.push({ recordId: p.candidateId, fields: fields });
    });

    let stamped = 0;
    for (let i = 0; i < stamps.length; i += PR_WRITE_BATCH) {
      const batch = stamps.slice(i, i + PR_WRITE_BATCH);
      const res = prPatch_(pat, PR_PAGES_BASE, PR_CAND_TABLE, batch);
      if (res.ok) {
        stamped += batch.length;
      } else {
        Logger.log('STAMP FAILED for ' + batch.length + ' row(s). The 50 ' +
          'States write already happened and stands; only the record of it ' +
          'is missing, so those items will be re-promoted next run: ' + res.error);
      }
    }

    const elapsed = Math.round((new Date() - started) / 1000);
    Logger.log('');
    Logger.log('Schools written: ' + written + ', failed: ' + failedCount +
      ', rows stamped: ' + stamped + ', in ' + elapsed + 's.');
    Logger.log('Re-run the dry run to confirm: every item promoted just now is ' +
      'settled, so it should report far fewer rows needing attention.');

    const result = {
      rows: rows.length, written: written, writes: willWrite.length,
      failedCount: failedCount, failures: failures, noops: noops.length,
      settledItems: settledItems, skips: skips, conflicts: conflicts,
      willWrite: willWrite, stamped: stamped, started: started
    };

    if (PR_EMAIL_ON_APPLY) prHcEmail_(result);
    return result;

  } finally {
    lock.releaseLock();
  }
}


/**
 * The read filter, built from the same constants the code compares against so
 * a renamed choice cannot make the formula and the logic disagree.
 *
 * FOUR CLAUSES, AND EACH EARNS ITS PLACE:
 *   1-2  an actionable decision whose item is not yet Promoted -- work to do
 *   3-4  a status sitting on an item whose decision is no longer actionable --
 *        a stamp to clear
 * An item that is actionable AND Promoted is settled, matches nothing, and is
 * never read. That is the whole scaling and no-overwrite story in one filter.
 */
function prHcFormula_() {
  const hotAct = 'OR({' + PR_HC_C_HOTLINE_DEC + '} = "' + PR_HC_DEC_ACCEPTED +
                 '", {' + PR_HC_C_HOTLINE_DEC + '} = "' + PR_HC_DEC_USE_HOTLINE + '")';
  const conAct = 'OR({' + PR_HC_C_CONTACT_DEC + '} = "' + PR_HC_DEC_ACCEPTED +
                 '", {' + PR_HC_C_CONTACT_DEC + '} = "' + PR_HC_DEC_USE_CONTACT + '")';
  const hotSt  = '{' + PR_HC_C_HOT_STATUS + '} & ""';
  const conSt  = '{' + PR_HC_C_CON_STATUS + '} & ""';
  return 'OR(' +
    'AND(' + hotAct + ', ' + hotSt + ' != "' + PR_HC_ST_PROMOTED + '"), ' +
    'AND(' + conAct + ', ' + conSt + ' != "' + PR_HC_ST_PROMOTED + '"), ' +
    'AND(NOT(' + hotAct + '), ' + hotSt + ' != ""), ' +
    'AND(NOT(' + conAct + '), ' + conSt + ' != "")' +
  ')';
}


/**
 * One Candidate row -> nothing, or one or two queued field writes.
 *
 * candidateId is the row in Candidate URLs; targetId is the row in 50 States.
 * They were one field called recordId in the first version of this pass, which
 * is exactly the kind of ambiguity that produces a write to the wrong base, so
 * they are two names now.
 */
function prHcPlan_(row, byUnitid) {
  const f = row.fields || {};
  const unitid = String(f[PR_C_UNITID] || '').trim();
  const categoryName = prHcSelectName_(f[PR_C_CATEGORY]) || '(no category)';

  const hotlineDec = prHcSelectName_(f[PR_HC_C_HOTLINE_DEC]);
  const contactDec = prHcSelectName_(f[PR_HC_C_CONTACT_DEC]);

  const out = {
    candidateId: row.id, unitid: unitid, school: '',
    categoryName: categoryName, targetId: '',
    writes: [], skips: [], outcomes: [],
    beforeHotStatus: prHcSelectName_(f[PR_HC_C_HOT_STATUS]),
    beforeConStatus: prHcSelectName_(f[PR_HC_C_CON_STATUS]),
    beforeNote: String(f[PR_HC_C_NOTE] || ''),
    hotActionable: (hotlineDec === PR_HC_DEC_ACCEPTED ||
                    hotlineDec === PR_HC_DEC_USE_HOTLINE),
    conActionable: (contactDec === PR_HC_DEC_ACCEPTED ||
                    contactDec === PR_HC_DEC_USE_CONTACT)
  };

  // SETTLED ITEMS ARE NOT EVEN READ. Their value is live, their note line is
  // carried forward verbatim, and nothing about them can be overwritten.
  const hotSettled = out.hotActionable &&
                     out.beforeHotStatus === PR_HC_ST_PROMOTED;
  const conSettled = out.conActionable &&
                     out.beforeConStatus === PR_HC_ST_PROMOTED;
  if (hotSettled) out.outcomes.push({ label: 'hotline', kind: 'settled' });
  if (conSettled) out.outcomes.push({ label: 'contact', kind: 'settled' });

  const wantsHotline = out.hotActionable && !hotSettled;
  const wantsContact = out.conActionable && !conSettled;

  // Nothing to do and nothing to clear. Not a refusal: Rejected and Needs
  // second opinion are decisions that write nothing by design, and the refusal
  // list is only useful if every line on it is something a reviewer can act on.
  if (!wantsHotline && !wantsContact) return out;

  if (!unitid) {
    out.skips.push({ unitid: '', categoryName: categoryName, label: 'row',
      reason: 'no UNITID on the Candidate row, so there is no 50 States row ' +
              'to write to' });
    return out;
  }

  const matches = byUnitid[unitid] || [];
  if (matches.length === 0) {
    out.skips.push({ unitid: unitid, categoryName: categoryName, label: 'row',
      reason: 'UNITID not found in 50 States' });
    return out;
  }
  if (matches.length > 1) {
    out.skips.push({ unitid: unitid, categoryName: categoryName, label: 'row',
      reason: 'UNITID matches ' + matches.length + ' rows in 50 States -- ' +
              'ambiguous, not guessing' });
    return out;
  }
  const target = matches[0];
  out.targetId = target.id;
  out.school   = String(target.fields[PR_S_INSTITUTION] || '').trim();

  // ---- hotline ----------------------------------------------------------
  if (wantsHotline) {
    const useProposed = (hotlineDec === PR_HC_DEC_USE_HOTLINE);
    const raw = String(f[useProposed ? PR_HC_C_PROP_HOTLINE
                                     : PR_HC_C_AI_HOTLINE] || '').trim();
    const source = useProposed ? 'Proposed hazing hotline' : 'TEST AI hotline';

    if (!raw) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'hotline',
        reason: 'hotline decision is "' + hotlineDec + '" but ' + source +
                ' is empty -- fill it or change the decision' });
    } else if (prHcIsSentinel_(raw)) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'hotline',
        reason: 'hotline decision is "' + hotlineDec + '" but ' + source +
                ' reads "' + raw + '", which is the AI saying it found ' +
                'nothing, not a phone number' });
    } else if (prHcDigits_(raw).length < 10) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'hotline',
        reason: 'hotline "' + raw + '" has only ' + prHcDigits_(raw).length +
                ' digits, so it cannot be a usable number' });
    } else if (prHcIsNotHaze_(raw)) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'hotline',
        reason: 'hotline "' + raw + '" is the national anti-hazing line, not ' +
                'this school\'s own number. Accepted on the row, refused ' +
                'here -- see the PR_HC_NOT_HAZE note in Promote.gs' });
    } else {
      out.writes.push({
        fieldId: PR_HC_S_HOTLINE, label: 'hotline', value: raw,
        source: source, same: prHcSameHotline_
      });
    }
  }

  // ---- contact ----------------------------------------------------------
  if (wantsContact) {
    const useProposed = (contactDec === PR_HC_DEC_USE_CONTACT);
    const raw = String(f[useProposed ? PR_HC_C_PROP_CONTACT
                                     : PR_HC_C_AI_CONTACT] || '').trim();
    const source = useProposed ? 'Proposed university contact' : 'TEST AI contact';

    if (!raw) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'contact',
        reason: 'contact decision is "' + contactDec + '" but ' + source +
                ' is empty -- fill it or change the decision' });
    } else if (prHcIsSentinel_(raw)) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'contact',
        reason: 'contact decision is "' + contactDec + '" but ' + source +
                ' reads "' + raw + '", which is the AI saying it found ' +
                'nothing, not an address' });
    } else if (!prHcIsUsableEmail_(raw)) {
      out.skips.push({ unitid: unitid, categoryName: categoryName,
        label: 'contact',
        reason: 'contact "' + raw + '" is not a single well-formed email ' +
                'address. A redacted page often yields "[email protected]", ' +
                'which has an "@" and is still not an address' });
    } else {
      out.writes.push({
        fieldId: PR_HC_S_CONTACT, label: 'contact', value: raw,
        source: source, same: prHcSameContact_
      });
    }
  }

  return out;
}


// =========================================================================
// RECORDING WHAT HAPPENED TO EACH ROW
// =========================================================================

/** Record an outcome for whichever plan(s) proposed this field on this target. */
function prHcMarkOutcome_(plans, targetId, fieldId, kind, value) {
  plans.forEach(function (p) {
    if (p.targetId !== targetId) return;
    p.writes.forEach(function (w) {
      if (w.fieldId !== fieldId) return;
      p.outcomes.push({ label: w.label, kind: kind, value: value,
                        source: w.source });
    });
  });
}

/** Record a conflict refusal against one specific Candidate row. */
function prHcMarkConflict_(plans, candidateId, fieldId, text) {
  plans.forEach(function (p) {
    if (p.candidateId !== candidateId) return;
    p.writes.forEach(function (w) {
      if (w.fieldId !== fieldId) return;
      p.outcomes.push({ label: w.label, kind: 'conflict', value: w.value,
                        reason: text });
    });
  });
}

/** Turn every 'written' outcome on a failed target into 'failed'. */
function prHcMarkFailed_(plans, targetId, error) {
  plans.forEach(function (p) {
    if (p.targetId !== targetId) return;
    p.outcomes.forEach(function (o) {
      if (o.kind === 'written') { o.kind = 'failed'; o.reason = error; }
    });
  });
}

/**
 * Pull an item's existing note lines back out of the stored note, so a settled
 * item keeps the date it was actually promoted instead of being silently
 * dropped when the other item is rewritten.
 *
 * Matches on the "hotline: " / "contact: " prefix this pass writes. A note a
 * human has rewritten by hand may not match, which is why the caller has a
 * fallback line rather than assuming this returns something.
 */
function prHcCarryLines_(note, label) {
  const out = [];
  String(note || '').split('\n').forEach(function (line) {
    if (line.indexOf(label + ': ') === 0) out.push(line);
  });
  return out;
}

/**
 * The three field values for one row, or null for a row needing no stamp.
 * Returns { hotStatus, conStatus, note } -- a status is null when that item
 * has nothing to record, which clears it.
 */
function prHcStampFor_(p) {
  const rowSkips = p.skips.filter(function (s) { return s.label === 'row'; });
  const lines = [];

  rowSkips.forEach(function (s) {
    lines.push('row: REFUSED -- ' + s.reason);
  });

  const statusFor = function (label) {
    const actionable = (label === 'hotline') ? p.hotActionable : p.conActionable;
    const before     = (label === 'hotline') ? p.beforeHotStatus : p.beforeConStatus;

    // THE DECISION WAS WITHDRAWN AFTER BEING ACTED ON. Clear the status --
    // leaving "Promoted" under a decision that now reads Rejected is a claim
    // the row no longer makes -- but KEEP the history in the note. The whole
    // reason these fields exist is to answer "did this ever reach the public
    // site", and that question does not stop mattering because the decision
    // changed afterwards. The value itself stays in 50 States: this pass never
    // clears one.
    if (!actionable) {
      if (before) {
        const old = prHcCarryLines_(p.beforeNote, label);
        old.forEach(function (l) { lines.push(l); });
        lines.push(label + ': the decision above has since been changed or ' +
          'removed, so this row no longer asserts it. What was written to 50 ' +
          'States was LEFT IN PLACE -- nothing was cleared there.');
      }
      return null;
    }
    if (rowSkips.length) return PR_HC_ST_REFUSED;

    const os = p.outcomes.filter(function (o) { return o.label === label; });
    const ss = p.skips.filter(function (s) { return s.label === label; });
    if (!os.length && !ss.length) return null;

    let status = null;
    os.forEach(function (o) {
      if (o.kind === 'failed') {
        status = PR_HC_ST_FAILED;
        lines.push(label + ': WRITE FAILED -- ' + (o.reason || 'no error text') +
          '. Nothing reached 50 States, and this item is not marked promoted, ' +
          'so the next run will try again.');
      } else if (o.kind === 'written') {
        if (status !== PR_HC_ST_FAILED) status = PR_HC_ST_PROMOTED;
        lines.push(label + ': WROTE "' + o.value + '" to 50 States ' +
          prHcStamp_() + ', from ' + o.source + '.');
      } else if (o.kind === 'noop') {
        if (status !== PR_HC_ST_FAILED) status = PR_HC_ST_PROMOTED;
        // PREFER AN EXISTING "WROTE" LINE over "already correct". A no-op means
        // the value in 50 States matches; if a previous run recorded actually
        // writing it, that line carries the DATE it went live, which is worth
        // more than restating that it is there now. This is also what carries
        // the first 16 rows across from the single combined status field this
        // pass used before the two per-item fields existed.
        const prior = prHcCarryLines_(p.beforeNote, label).filter(function (l) {
          return l.indexOf(label + ': WROTE ') === 0;
        });
        if (prior.length) {
          prior.forEach(function (l) { lines.push(l); });
        } else {
          lines.push(label + ': already correct in 50 States ("' + o.value +
            '"), nothing rewritten.');
        }
      } else if (o.kind === 'settled') {
        if (status !== PR_HC_ST_FAILED) status = PR_HC_ST_PROMOTED;
        const carried = prHcCarryLines_(p.beforeNote, label);
        if (carried.length) {
          carried.forEach(function (l) { lines.push(l); });
        } else {
          lines.push(label + ': promoted in an earlier run. This run did not ' +
            're-check it, and the original note line is no longer in this ' +
            'field to quote.');
        }
      } else if (o.kind === 'conflict') {
        if (status !== PR_HC_ST_FAILED && status !== PR_HC_ST_PROMOTED) {
          status = PR_HC_ST_REFUSED;
        }
        lines.push(label + ': REFUSED -- ' + o.reason);
      }
    });
    ss.forEach(function (s) {
      if (status !== PR_HC_ST_FAILED && status !== PR_HC_ST_PROMOTED) {
        status = PR_HC_ST_REFUSED;
      }
      lines.push(label + ': REFUSED -- ' + s.reason);
    });
    return status;
  };

  const hotStatus = statusFor('hotline');
  const conStatus = statusFor('contact');

  if (hotStatus === null && conStatus === null && !lines.length) {
    // Nothing to say. Only worth a write if a stale stamp is sitting there.
    if (p.beforeHotStatus || p.beforeConStatus || p.beforeNote) {
      return { hotStatus: null, conStatus: null, note: '' };
    }
    return null;
  }

  lines.push('');
  lines.push('Written by the hotline/contact pass in Promote.gs and rewritten ' +
             'in full on every run, so nothing here describes a condition ' +
             'that has since been fixed. An item reading "Promoted" in its ' +
             'status field is settled and is not re-checked; clear that field ' +
             'to force a re-promote. Nothing here refers to the page URL -- ' +
             'that is Promote status and Promote note.');

  return { hotStatus: hotStatus, conStatus: conStatus, note: lines.join('\n') };
}

function prHcStamp_() {
  return 'on ' + Utilities.formatDate(new Date(),
    Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm z');
}


// =========================================================================
// HOTLINE / CONTACT SHAPE TESTS
// =========================================================================

/** Airtable returns a singleSelect as an object by name, or a bare string. */
function prHcSelectName_(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v.name) return String(v.name).trim();
  return '';
}

function prHcDigits_(s) {
  return String(s || '').replace(/[^0-9]/g, '');
}

/** The AI's ways of saying "nothing here". Compared lowercased and trimmed. */
function prHcIsSentinel_(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return true;
  for (let i = 0; i < PR_HC_SENTINELS.length; i++) {
    if (t === PR_HC_SENTINELS[i]) return true;
  }
  return false;
}

/**
 * The ten digits that identify the line, ignoring a leading country code and
 * anything after -- an extension, a vanity suffix, a note in brackets.
 *
 * THIS DELIBERATELY DIFFERS FROM THE Hotline check FORMULA, which compares
 * the LAST ten digits. Last-ten is correct until a value carries an
 * extension: "1-800-779-7366 ext. 1083" ends in the extension, so last-ten
 * reads it as a different line from "800-779-7366" and the pass would
 * rewrite an already-correct field. First-ten-after-the-country-code gives
 * the same answer as last-ten on every plain number and the right answer on
 * the ones with an extension. The formula is untouched: it drives a review
 * queue, where a false "Differs - review" costs a glance, not a write.
 */
function prHcLineDigits_(s) {
  let d = prHcDigits_(s);
  if (d.length > 10 && d.charAt(0) === '1') d = d.slice(1);
  return d.slice(0, 10);
}

function prHcIsNotHaze_(s) {
  return prHcLineDigits_(s) === PR_HC_NOT_HAZE;
}

/**
 * One address, no spaces, a dot in the domain. Deliberately strict: the
 * values that reach here have already been accepted by a human, so the only
 * job left is catching strings that are not addresses at all.
 */
function prHcIsUsableEmail_(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/[\s<>,;\[\]()]/.test(t)) return false;
  return /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)*\.[A-Za-z]{2,}$/.test(t);
}

/** Phones compare on the ten digits that identify the line. */
function prHcSameHotline_(a, b) {
  const da = prHcDigits_(a);
  const db = prHcDigits_(b);
  if (da.length < 10 || db.length < 10) return da === db;
  return prHcLineDigits_(a) === prHcLineDigits_(b);
}

/** Emails compare case-insensitively and trimmed, like Contact check. */
function prHcSameContact_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function prHcFindRecord_(records, recordId) {
  for (let i = 0; i < records.length; i++) {
    if (records[i].id === recordId) return records[i];
  }
  return null;
}


// =========================================================================
// THE HOTLINE / CONTACT RUN SUMMARY EMAIL
// =========================================================================

/**
 * Same reasoning as prEmail_: this exists for a triggered run, where the log
 * is invisible. Refusals and conflicts come first, counts last.
 */
function prHcEmail_(r) {
  const to = PR_EMAIL_TO || Session.getEffectiveUser().getEmail();
  if (!to) { Logger.log('No address to send the run summary to; skipped.'); return; }

  const needsAttention = r.skips.length + r.conflicts.length;
  const subject = 'HazingInfo hotline/contact: ' + r.written +
    ' school(s) written, ' + r.skips.length + ' refused' +
    (r.conflicts.length ? ', ' + r.conflicts.length + ' conflicts' : '') +
    (r.failedCount ? ', ' + r.failedCount + ' WRITE FAILURES' : '');

  const b = [];
  b.push('The hotline / contact pass ran at ' + r.started.toISOString() +
         ' and wrote to the live site.');
  b.push('');
  b.push('This pass writes only Hazing Hotline and University Contact on 50');
  b.push('States. It never touches a URL, a compliance field or a checkmark.');
  b.push('Every item it acted on carries its outcome in "Hotline promote');
  b.push('status" or "Contact promote status", with the detail in');
  b.push('"Hotline/contact promote note" -- work from those fields, not this');
  b.push('email. An item reading "Promoted" is settled and will not be');
  b.push('re-checked or overwritten; clear its status to force a re-promote.');
  b.push('');

  if (r.failedCount) {
    b.push('*** ' + r.failedCount + ' school(s) FAILED TO SAVE to 50 States.');
    b.push('Those items are stamped "' + PR_HC_ST_FAILED + '" and are NOT');
    b.push('settled, so the next run tries again.');
    b.push('');
    r.failures.forEach(function (e) { b.push('  ' + e); });
    b.push('');
  }

  if (r.conflicts.length) {
    b.push('CONFLICTS -- ' + r.conflicts.length + ', both sides refused');
    b.push('Two Candidate rows for one school would have written different values');
    b.push('into the same field. Neither was written, and both rows are stamped.');
    b.push('Decide which is right and change the other row\'s decision.');
    b.push('');
    r.conflicts.forEach(function (s) { b.push('  ' + s); });
    b.push('');
  }

  if (r.skips.length) {
    b.push('REFUSED -- ' + r.skips.length + ' decision(s) did not publish');
    b.push('A decision was made but the value underneath could not be used. Each');
    b.push('is fixed on the Candidate row, by correcting the value or changing the');
    b.push('decision. There is no queue to re-add anything to.');
    b.push('');
    r.skips.forEach(function (s) {
      b.push('  ' + (s.unitid || '(no UNITID)') + ' / ' +
        (s.categoryName || '(no category)') + ': ' + s.reason);
    });
    b.push('');
  }

  if (r.willWrite && r.willWrite.length) {
    b.push('WRITTEN -- ' + r.willWrite.length + ' field(s)');
    b.push('');
    r.willWrite.forEach(function (s) { b.push('  ' + s); });
    b.push('');
  }

  if (!needsAttention) {
    b.push('Nothing needs attention: no refusals and no conflicts.');
    b.push('');
  }

  b.push('---');
  b.push('Rows needing attention:    ' + r.rows);
  b.push('Schools written:           ' + r.written);
  b.push('Field writes:              ' + r.writes);
  b.push('Already correct, skipped:  ' + r.noops);
  b.push('Settled, not re-checked:   ' + r.settledItems);
  b.push('Refused:                   ' + r.skips.length);
  b.push('Conflicts refused:         ' + r.conflicts.length);
  b.push('Candidate rows stamped:    ' + r.stamped);

  MailApp.sendEmail(to, subject, b.join('\n'));
  Logger.log('Run summary emailed to ' + to + '.');
}
