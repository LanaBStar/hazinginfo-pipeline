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
// CMD+A BEFORE PASTING. Twice on 2026-09-10 a paste landed on top of the
// wrong file, once destroying SiteCensus.gs entirely. Check the final line
// number afterwards: this file is 927 lines.
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

      const op = prPlan_(row, byUnitid);
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
        if (p.note) Logger.log('        note: ' + p.note);
      });
    });

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
    Logger.log('Skipped: ' + skips.length);

    if (targets.length > PR_MAX_INSTITUTIONS) {
      throw new Error('Refusing to run: ' + targets.length + ' schools exceeds ' +
        'PR_MAX_INSTITUTIONS (' + PR_MAX_INSTITUTIONS + '). Raise it deliberately ' +
        'if this is right.');
    }

    if (dryRun) {
      Logger.log('');
      Logger.log('DRY RUN -- nothing written, to either base.');
      Logger.log('Read the CHECKMARKS REMOVED section above, then run ' +
        'promoteApplyForReal() to apply.');
      return {
        dryRun: true, rows: rows.length, schools: targets.length,
        skipped: skips.length, checkmarksGained: gained, checkmarksRemoved: cleared
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
    const stamps = [];
    ops.forEach(function (op) {
      const failure = failedRecordIds[op.stateRecordId];
      const value = failure ? PR_STATUS_FAILED : PR_STATUS_PROMOTED;
      if (op.beforeStatus === value) return;   // already says this; don't churn
      const f = {};
      f[PR_C_PROMOTE_STATUS] = value;
      stamps.push({ recordId: op.candRecordId, fields: f });
    });
    skips.forEach(function (s) {
      if (!s.recordId) return;
      if (s.beforeStatus === PR_STATUS_SKIPPED) return;
      const f = {};
      f[PR_C_PROMOTE_STATUS] = PR_STATUS_SKIPPED;
      stamps.push({ recordId: s.recordId, fields: f });
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

    return {
      dryRun: false, rows: rows.length, schools: targets.length,
      written: written, failed: failedCount, stamped: stamped,
      skipped: skips.length, checkmarksGained: gained, checkmarksRemoved: cleared
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
function prPlan_(row, byUnitid) {
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
    beforeStatus: row.fields[PR_C_PROMOTE_STATUS] || ''
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
  let url, action, note = '';

  if (determination === PR_DET_CONFIRMED) {
    if (!candidateUrl) {
      base.reason = '"' + PR_DET_CONFIRMED + '" with an empty Candidate URL';
      return base;
    }
    url = candidateUrl;
    action = 'promote Candidate URL';
    // Not an error, but worth seeing: a confirmed row usually has no
    // proposal, and one that does may have been mis-determined.
    if (proposedUrl) {
      note = 'row also carries a Reviewer-proposed URL ("' + proposedUrl +
             '"), which is NOT used on a confirmed row -- worth a look';
    }

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
    note: note
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
