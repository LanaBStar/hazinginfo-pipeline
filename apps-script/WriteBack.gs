// =========================================================================
// WriteBack.gs -- promote reviewed URLs from Live URL Checks into 50 States
// =========================================================================
//
// WHAT THIS IS FOR. Live URL Checks (PAGES) is where a human decides what a
// URL should be. 50 States is where the public site reads it from. Until
// this file existed there was nothing connecting the two, so every review
// sat in PAGES while hazinginfo.org went on serving the old link. This
// closes that gap, and nothing else: it does not judge pages, it does not
// decide standards, it moves settled decisions to where they are read.
//
// WHY IT TARGETS 50 STATES DIRECTLY. PAGES has an Institutions table
// (tblpgBmu7r8kQA6b5), and it is the obvious-looking target because it is
// the table Live URL Checks links to. It is a SYNCED COPY of 50 States and
// is therefore read-only -- a write there fails, and if it did not, it would
// be overwritten by the next sync. The real record lives in
// appJbAvuFOxhWOID2 / tblI3LZvxRu4bgK3r and that is what this writes.
//
// -------------------------------------------------------------------------
// THE TWO FIELDS PER CATEGORY, AND WHY THEY NO LONGER MOVE AS ONE
// -------------------------------------------------------------------------
// Each category has a `located_*` field and a compliance sibling. They are
// not duplicates and they do not mean the same thing:
//
//   located_*    the best URL anyone has found for this category. A record
//                of research. Drives nothing downstream, and since
//                2026-08-28 nothing checks it either.
//   sibling      HazingInfo's published position. Every presence flag is
//                literally IF({sibling} = "", 0, 1), so this field, and only
//                this field, is what puts a checkmark on the public page.
//                It is also what Live URL Checks now tracks, which is the
//                change this file was rewritten for.
//
// Federal compliance (fldcpnvdViGCupWIB) reads the policy flag AND the
// reporting-method count, so clearing the hazing policy sibling can flip a
// school's federal compliance state. That is the most consequential thing
// this script can do and the reason for the dry run, the caps and the
// per-row logging.
//
// BOTH FIELDS MOVE TOGETHER ON EVERY OPERATION (2026-08-29).
//
//   Fixed - new URL   -> BOTH. The reviewer found a working address; it is
//                        both the published position and the best URL known.
//   Confirmed broken  -> BOTH. The link is dead and no replacement was
//                        found, so there is no best URL left to remember.
//
// This reverses the 2026-08-28 rule, which cleared the sibling only. That
// rule was written to avoid "forgetting" a URL, and the argument had force
// while a clear could also mean "below HazingInfo's standard" -- a real page,
// worth keeping a record of. It cannot mean that any more: the below-standard
// branch was removed when Standards left Live URL Checks, so the only thing
// that triggers a clear now is CONFIRMED DEAD. Remembering a dead address
// buys nothing -- the standards pass cannot fetch it -- and it costs
// something real, because a non-blank located_* tells discovery this category
// is already handled and stops it hunting for the replacement we just said we
// could not find. Blank is both the honest value and the one that puts the
// school back in front of discovery.
//
// Quinnipiac (130226) lost its located_report_form_url on 2026-08-28 under
// the first version of this file. Under this rule that outcome is correct
// rather than accidental.

// -------------------------------------------------------------------------
// WRITE-BACK CAN NO LONGER CREATE A CHECKMARK
// -------------------------------------------------------------------------
// Worth stating plainly, because it changes the risk profile of running this.
//
// lucReconcile_ creates a Live URL Checks row only where the tracked field
// holds a URL, and the tracked field IS the compliance sibling. So every row
// this script can act on already has a non-blank sibling, and a swap replaces
// one non-blank value with another. The checkmark does not move.
//
// The only checkmark change available is a REMOVAL, via Confirmed broken.
// Under the previous design a swap could mint a checkmark -- American
// International gained one on 2026-08-28 that way -- and that path is now
// closed by construction rather than by care.
//
// It is not quite impossible: a row created while the sibling held a URL
// survives the sibling going blank (it becomes "No URL" rather than being
// deleted). A determination on such a row could write into a blank sibling.
// The NEW CHECKMARK line is kept in the report for exactly that case, and it
// should be rare enough to be worth reading every time it appears.
//
// -------------------------------------------------------------------------
// WHAT IT ACTS ON (rewritten 2026-10-04 for the below-standard ticks)
// -------------------------------------------------------------------------
// Each Live URL Checks row has three below-standard fields, one per
// category (CHTR / Hazing policy / Report form below standard). Only the
// one matching the row's category may be ticked. THE TICKS DECIDE WHETHER
// THE PAGE IS PUBLISHED, exactly as Hold vs Accept does in Promote:
//
//   Fixed - new URL, nothing ticked   -> record + published = proposed URL,
//                                        below-standard reasons cleared
//   Fixed - new URL, reasons ticked   -> record = proposed URL, published
//                                        emptied, reasons written
//   Working as-is, reasons ticked     -> record kept, published emptied,
//                                        reasons written (the page works
//                                        but falls short of the standard)
//   Working as-is, nothing ticked     -> ignored, nothing changes
//   Confirmed broken - no replacement -> record, published AND reasons all
//                                        cleared, whatever is ticked
//   Needs second opinion              -> ignored, not settled
//   (blank)                           -> ignored, not reviewed
//
// WHY ALL THREE FIELDS MOVE TOGETHER. Until 2026-10-04 this file wrote only
// the two URL fields, so a cleared link left its below-standard reasons
// behind, and a replacement went onto the site with no standard check at
// all. Now every applied review sets all three, the way Promote does, so a
// reason can never outlive the page it describes.
//
// THE REASONS FOLLOW THE RECORD FIELD. Reasons are written or cleared only
// when the record field ends up holding the page they describe. If the
// record field holds a different page (a hand edit, see the field-level
// guard), the reasons are left alone; and a review that would take a page
// off the site with reasons that cannot be recorded is skipped whole.
//
// IT READS THE DETERMINATION, NOT A VIEW. Pointing at "Awaiting write-back"
// would work, but a view's filter is edited in the UI, is not readable
// through the API, and changing it would silently change what this script
// publishes. The two determinations above are named here in code where a
// diff shows them.
//
// WORKING AS-IS IS A WRITE ONLY WHEN REASONS ARE TICKED. With nothing
// ticked the published page stays as it is. With reasons ticked, the reviewer
// is saying the page works but is below standard -- often a page that was
// published without the standard being applied properly -- so it comes off
// the site and the reasons are recorded.
//
// -------------------------------------------------------------------------
// ONE INSTITUTION CAN HAVE THREE ROWS, WHICH IS WHY WRITES ARE MERGED
// -------------------------------------------------------------------------
// Live URL Checks is one row per (institution, category), so a school with a
// fixed CHTR link and a fixed policy link has two rows pointing at one 50
// States record -- three if all three categories were fixed at once.
//
// Airtable rejects an entire PATCH payload that names the same record id
// twice ("Cannot have multiple records with the same ID"), so the naive
// one-request-per-row shape would fail the whole batch containing any such
// school, taking nine unrelated good writes down with it. Operations are
// therefore grouped by 50 States record id and merged into a single fields
// object per institution. On 2026-08-28 that was six schools out of 27.
//
// -------------------------------------------------------------------------
// WHAT IT REFUSES TO DO
// -------------------------------------------------------------------------
// This publishes to a site that tells parents where to report hazing. Every
// guard below exists because the cost of a bad write is a wrong link on a
// real school's page, not a failed job.
//
//   * A proposed URL that is not well-formed is never written.
//   * A proposed URL that points at a login wall is never written. On
//     2026-08-28 this script published
//     cm.maxient.com/reportingform.php?CSUEastBay&layout_id=2 as a hazing
//     reporting form; it 303s to Shibboleth, and the address guard did not
//     catch it because the wall is one hop further on. The guard stops the
//     addresses it can see. The liveness checker's login detection is what
//     catches the rest, and it found that one four hours later.
//   * A UNITID that matches no 50 States row, or more than one, is skipped
//     and named. Guessing which record was meant is not this script's job.
//   * A row whose PUBLISHED value has changed since the review is skipped.
//     Compared against the sibling, because the sibling is what the Live URL
//     Checks URL formula reads and therefore what the reviewer actually
//     opened. This comparison was against located_* until 2026-08-28 and was
//     silently wrong the moment tracking moved.
//   * A write that would not change anything is skipped rather than sent, so
//     a second run costs nothing and the log stays honest about what moved.
//   * WB_MAX_WRITES caps how many institutions one run may touch.
//
// -------------------------------------------------------------------------
// IT DOES NOT TOUCH LIVE URL CHECKS. THIS IS DELIBERATE.
// -------------------------------------------------------------------------
// The obvious follow-up -- clear the determination once its proposal has been
// applied -- is wrong here, and LiveUrlChecks.gs explains why in its
// PENDING_VERIFICATION section. Applying a proposal changes the compliance
// sibling, which changes the Live URL Checks URL formula, which makes the
// next sweep see a URL mismatch. lucClearIfStale_ then clears the
// determination, the notes, the review date and the proposed URL itself --
// at the right moment, measured against the page actually at the new address.
//
// Clearing here would do the same thing earlier, against a page nobody has
// fetched, and would need this script to duplicate the staleness rules. The
// no-op detector is what makes that safe: between write-back and the next
// sweep the row still reads "Fixed - new URL", and a re-run sees the target
// already holds the proposed URL and does nothing.
//
// RUN THIS BEFORE A SWEEP, NOT AFTER. A Reviewer-proposed URL that has not
// been applied yet exists nowhere else, and a sweep that clears its row
// destroys it. Applied first, the finding is safe in 50 States and the clear
// costs only the determination. See LUC_CLEAR_STALE_REVIEWS.
// =========================================================================


// ---- Where everything lives ---------------------------------------------
const WB_PAGES_BASE   = 'appEvOdPi94MzZ6Db';   // PAGES
const WB_CHECKS_TABLE = 'tblgX19rRaysxSlNu';   // Live URL Checks

const WB_STATES_BASE  = 'appJbAvuFOxhWOID2';   // 50 States Database
const WB_INST_TABLE   = 'tblI3LZvxRu4bgK3r';   // Institutions -- THE WRITE TARGET

// ---- Live URL Checks fields (read only) ---------------------------------
const WB_C_UNITID        = 'fldGOVUMJzFHLoeel';
const WB_C_TRACKED       = 'fldyJWzzbTwWPI141';
const WB_C_URL           = 'fldJQVVn8G9xw004a';  // formula: the reviewed address
const WB_C_DETERMINATION = 'fld2QJ1NPuP2hvHzx';
const WB_C_PROPOSED_URL  = 'fld4T5J23Tqm2rj9m';
const WB_C_NOTES         = 'fldUWo0jlZFkRw2Yl';
// The URL AS THE REVIEWER SAW IT, frozen by the Live URL Checks snapshot
// automation when the determination was set. WB_C_URL above is a formula
// over the CURRENT 50 States value, so it can never show that the page
// changed after the review; this field can. Added 2026-09-26 -- see the
// staleness guard in wbPlan_.
const WB_C_SNAP_URL      = 'fldVmX5yeRqTZuqDX';
// The reviewer's below-standard ticks, one field per category (added
// 2026-10-04). Choice names match the 50 States below-standard fields exactly;
// they are written by name with typecast off.
const WB_C_BELOW_CHTR    = 'fldgfMu6RujSpxcSn';  // CHTR below standard
const WB_C_BELOW_POLICY  = 'fldjIEUMM0ers0Z4Q';  // Hazing policy below standard
const WB_C_BELOW_FORM    = 'fldjEkPZeBaqGDyac';  // Report form below standard

// ---- 50 States fields ----------------------------------------------------
const WB_S_UNITID      = 'fldSOdX8KWnxZ3wFv';
const WB_S_INSTITUTION = 'fldb8bn85BkJbu7YT';

// The determinations this script acts on. Named as constants so a rename in
// Airtable is a one-line fix here rather than a silent no-op -- which is
// exactly how Review resolved broke on 2026-08-28 when two of these four
// options were renamed and a substring match stopped matching.
const WB_DET_FIXED  = 'Fixed - new URL';
const WB_DET_BROKEN = 'Confirmed broken - no replacement found';
const WB_DET_WORKING = 'Working as-is';

/**
 * THE CATEGORY MAP. Tracked field option -> the 50 States fields it writes
 * (record, published, below-standard) and the Live URL Checks field holding
 * the reviewer's ticks for that category. All six targets verified as multilineText (writable, not formulas)
 * against the live schema on 2026-08-28.
 *
 * THE KEYS CHANGED ON 2026-08-28 when Live URL Checks switched from tracking
 * the located_* fields to tracking the compliance fields. They were
 * 'chtr_index_url', 'located_hazing_policy_url' and
 * 'located_report_form_url'. Nothing warned about this: every row would have
 * fallen through to "unrecognised Tracked field", the script would have
 * skipped all 35 settled reviews, reported zero writes, and looked like it
 * had simply found nothing to do.
 *
 * `key` must match the Live URL Checks single-select option EXACTLY. An
 * unrecognised value is skipped and logged rather than guessed at -- and if
 * EVERY row skips for that reason, the report says so in as many words
 * rather than leaving a silent zero.
 */
const WB_CATEGORIES = {
  'Transparency Report': {
    label:   'CHTR',
    located: 'fldF1eBetEtn3P9ai',
    sibling: 'flde8Mfh5vVz1iD0a',
    below:   'fld1OvoiS3flecsZ7',   // chtr_below_standard
    ticks:   WB_C_BELOW_CHTR
  },
  'Hazing Policy': {
    label:   'Hazing Policy',
    located: 'fldeV6a02lVAwHYOd',
    sibling: 'fldhLNehpqJqXgWPT',
    below:   'fld1elkZEyrtENFMU',   // hazing_policy_below_standard
    ticks:   WB_C_BELOW_POLICY
  },
  'Report Form': {
    label:   'Report Form',
    located: 'fldYG8a7J9o5hfoN2',
    sibling: 'fldhHGkKvHK8BtC1e',
    below:   'fldSepO8coDh0MSWq',   // report_form_below_standard
    ticks:   WB_C_BELOW_FORM
  }
};

// ---- Safety --------------------------------------------------------------

/**
 * DRY RUN IS THE DEFAULT AND SHOULD STAY THAT WAY between runs.
 *
 * wbDryRun() reports exactly what wbApply() would write -- every field, both
 * old and new values, every skip and why -- and writes nothing. Read that
 * output before setting this false, particularly the NEW CHECKMARK count:
 * those are schools whose public page gains a green check, and they are the
 * rows worth a second look.
 */
const WB_DRY_RUN_DEFAULT = true;

// Blast radius. 35 settled rows stand as of 2026-08-28, most of them already
// applied and therefore no-ops. This leaves headroom without allowing a
// runaway run to rewrite the table.
const WB_MAX_WRITES = 60;

const WB_WRITE_BATCH = 10;   // Airtable's hard cap per PATCH
const WB_PAGE_SIZE   = 100;
const WB_SLEEP_MS    = 210;  // Airtable's 5 req/sec

/**
 * Login-wall shapes, refused as write targets.
 *
 * DELIBERATELY A SEPARATE COPY of LiveUrlChecks.gs's LUC_LOGIN_URL_PATTERNS
 * rather than a reference to it. The two do different jobs: that list decides
 * how to LABEL a page that was fetched, and being wrong there costs a review
 * queue entry. This one decides whether to PUBLISH an address, and being
 * wrong here puts a sign-in page on a school's public record as the place to
 * report hazing. A change to one should be a considered decision about the
 * other, not an automatic inheritance -- and this file must keep working if
 * the checker is ever retired.
 */
const WB_LOGIN_URL_PATTERNS = [
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
 * Reports what wbApply() would do. Writes nothing. Run this first, every
 * time -- including on a re-run, where it should report zero writes.
 */
function wbDryRun() {
  return wbRun_(true);
}

/**
 * Applies the pending write-back to 50 States. Read wbDryRun()'s output
 * first.
 */
function wbApply() {
  return wbRun_(WB_DRY_RUN_DEFAULT ? true : false);
}

/**
 * Applies for real, ignoring WB_DRY_RUN_DEFAULT. Separate function rather
 * than a flag to edit, so arming the script is an explicit act that leaves
 * the file unchanged -- and so nobody arms it by editing a constant and then
 * forgets to put it back.
 */
function wbApplyForReal() {
  return wbRun_(false);
}


// =========================================================================
// THE RUN
// =========================================================================
function wbRun_(dryRun) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another script run holds the lock. Nothing done.');
    return { blocked: true };
  }
  try {
    const pat = wbRequirePat_();

    Logger.log(dryRun
      ? '=== DRY RUN -- nothing will be written ==='
      : '=== APPLYING -- writing to 50 States ===');

    // ---- 1. the settled reviews --------------------------------------
    const rows = wbListAll_(pat, WB_PAGES_BASE, WB_CHECKS_TABLE,
      [WB_C_UNITID, WB_C_TRACKED, WB_C_URL, WB_C_DETERMINATION,
       WB_C_PROPOSED_URL, WB_C_NOTES, WB_C_SNAP_URL,
       WB_C_BELOW_CHTR, WB_C_BELOW_POLICY, WB_C_BELOW_FORM], wbSettledFormula_());

    Logger.log('Settled reviews found: ' + rows.length);
    if (!rows.length) {
      Logger.log('Nothing to do.');
      return { rows: 0, writes: 0 };
    }

    // ---- 2. the target table ------------------------------------------
    const targetFields = [WB_S_UNITID, WB_S_INSTITUTION];
    for (const k in WB_CATEGORIES) {
      targetFields.push(WB_CATEGORIES[k].located, WB_CATEGORIES[k].sibling,
                        WB_CATEGORIES[k].below);
    }

    const institutions = wbListAll_(pat, WB_STATES_BASE, WB_INST_TABLE, targetFields, '');
    Logger.log('50 States institutions read: ' + institutions.length);

    // UNITID -> record(s). An array, so a duplicate UNITID is detectable
    // rather than silently resolving to whichever row was read last.
    const byUnitid = {};
    institutions.forEach(function (r) {
      const u = String(r.fields[WB_S_UNITID] || '').trim();
      if (!u) return;
      (byUnitid[u] = byUnitid[u] || []).push(r);
    });

    // ---- 3. turn rows into operations ---------------------------------
    const ops = [];
    const skips = [];

    // APPLY ONCE (added 2026-09-26). A review already applied is not read
    // again, so a later correction in 50 States is never overwritten by an old
    // decision. See WB_APPLIED_PREFIX.
    const applied = wbLoadApplied_();
    let alreadyOnce = 0;
    rows.forEach(function (row) {
      if (applied[row.id] && applied[row.id] === wbFingerprint_(row)) {
        alreadyOnce++;
        return;
      }
      const op = wbPlan_(row, byUnitid);
      if (op.skip) skips.push(op); else ops.push(op);
    });
    Logger.log('Reviews already applied once, not re-read: ' + alreadyOnce);

    // ---- 4. merge per institution -------------------------------------
    // See the header: Airtable rejects a payload naming one record twice,
    // and six institutions have two rows each.
    const merged = {};
    ops.forEach(function (op) {
      const m = merged[op.recordId] || (merged[op.recordId] = {
        recordId: op.recordId,
        unitid: op.unitid,
        institution: op.institution,
        fields: {},
        parts: []
      });
      for (const f in op.fields) m.fields[f] = op.fields[f];
      m.parts.push(op);
    });

    const targets = Object.keys(merged).map(function (k) { return merged[k]; });

    // ---- 5. report -----------------------------------------------------
    let newCheckmarks = 0;
    let lostCheckmarks = 0;

    Logger.log('');
    Logger.log('--- planned changes, by institution ---');
    targets.forEach(function (t) {
      Logger.log(t.institution + ' (' + t.unitid + ')');
      t.parts.forEach(function (p) {
        Logger.log('    ' + p.category.label + ': ' + p.action);
        Logger.log('        published (sibling) was: "' + p.currentSibling + '" -> "' + p.value + '"');
        Logger.log('        located_* was:           "' + p.currentLocated + '" -> ' +
          (p.writesLocated ? '"' + p.locatedTarget + '"' : 'unchanged (kept on purpose)'));
        Logger.log('        below-standard was:      [' + p.currentBelow.join('; ') + '] -> ' +
          (p.writesBelow ? '[' + p.belowTarget.join('; ') + ']' : 'unchanged'));
        if (!p.currentSibling && p.value) {
          newCheckmarks++;
          Logger.log('        *** NEW CHECKMARK -- this school gains a ' +
            p.category.label + ' check on the public page');
        }
        if (p.currentSibling && !p.value) {
          lostCheckmarks++;
          Logger.log('        *** CHECKMARK CLEARED -- ' + p.category.label +
            ' check removed from the public page');
        }
      });
    });

    if (skips.length) {
      Logger.log('');
      Logger.log('--- skipped (' + skips.length + ') ---');
      skips.forEach(function (s) {
        Logger.log('  ' + s.unitid + ' / ' + s.trackedName + ': ' + s.reason);
      });

      // A silent zero is the failure mode this script is most likely to have
      // and least likely to show. If every row skipped for the same
      // structural reason, say so loudly rather than reporting "0 writes"
      // and letting it read as "nothing needed doing".
      const unrecognised = skips.filter(function (s) {
        return s.reason && s.reason.indexOf('unrecognised Tracked field') === 0;
      }).length;
      if (unrecognised === skips.length && !ops.length) {
        Logger.log('');
        Logger.log('*** EVERY row was skipped as an unrecognised Tracked field. This is ' +
          'not "nothing to do" -- WB_CATEGORIES keys no longer match the Live URL ' +
          'Checks single-select. Compare them before doing anything else.');
      }
    }

    Logger.log('');
    Logger.log('Institutions to update: ' + targets.length +
      ' (from ' + ops.length + ' reviewed row(s))');
    Logger.log('New checkmarks: ' + newCheckmarks + ' | Cleared checkmarks: ' + lostCheckmarks);
    Logger.log('Below-standard reasons written: ' + ops.filter(function (o) {
      return o.writesBelow && o.belowTarget.length; }).length +
      ' | cleared: ' + ops.filter(function (o) {
      return o.writesBelow && !o.belowTarget.length; }).length);

    if (targets.length > WB_MAX_WRITES) {
      throw new Error('Refusing to run: ' + targets.length + ' institutions exceeds ' +
        'WB_MAX_WRITES (' + WB_MAX_WRITES + '). Raise it deliberately if this is right.');
    }

    if (dryRun) {
      Logger.log('');
      Logger.log('DRY RUN -- nothing written, and the applied-reviews record was not ' +
        'changed. Run wbApplyForReal() to apply.');
      return { dryRun: true, rows: rows.length, institutions: targets.length,
               skipped: skips.length, newCheckmarks: newCheckmarks,
               clearedCheckmarks: lostCheckmarks };
    }

    // ---- 6. write ------------------------------------------------------
    let written = 0;
    const failed = [];

    for (let i = 0; i < targets.length; i += WB_WRITE_BATCH) {
      const batch = targets.slice(i, i + WB_WRITE_BATCH);
      const res = wbPatch_(pat, WB_STATES_BASE, WB_INST_TABLE, batch);
      if (res.ok) {
        written += batch.length;
        continue;
      }

      // Airtable's PATCH is all-or-nothing per batch, so one bad record
      // takes its nine batch-mates with it. Retry individually to isolate.
      Logger.log('Batch at ' + i + ' failed, retrying individually: ' + res.error);
      batch.forEach(function (t) {
        const one = wbPatch_(pat, WB_STATES_BASE, WB_INST_TABLE, [t]);
        if (one.ok) { written++; return; }
        failed.push({ unitid: t.unitid, institution: t.institution, error: one.error });
        Logger.log('  ' + t.institution + ' (' + t.unitid + ') would not save: ' + one.error);
      });
    }

    Logger.log('');
    Logger.log('WROTE ' + written + ' institution(s).' +
      (failed.length ? ' ' + failed.length + ' failed.' : ''));

    // ---- 7. record what is now applied ---------------------------------
    // A review counts as applied when its write landed, or when 50 States
    // already held its outcome. Skips for any other reason (changed since
    // the review, a field held a different page, a refusal) are NOT recorded:
    // they stay live until a person re-reviews or Live URL Checks clears them.
    // Entries for reviews that no longer exist are dropped, so the record
    // never holds more than today's settled reviews.
    const failedUnitids = {};
    failed.forEach(function (f) { failedUnitids[f.unitid] = true; });
    const byRowId = {};
    rows.forEach(function (r) { byRowId[r.id] = r; });
    const next = {};
    Object.keys(applied).forEach(function (id) {
      if (byRowId[id] && applied[id] === wbFingerprint_(byRowId[id])) next[id] = applied[id];
    });
    ops.forEach(function (op) {
      if (!failedUnitids[op.unitid]) next[op.rowId] = wbFingerprint_(byRowId[op.rowId]);
    });
    skips.forEach(function (sk) {
      if (sk.rowId && sk.reason === 'already applied, nothing to change') {
        next[sk.rowId] = wbFingerprint_(byRowId[sk.rowId]);
      }
    });
    wbSaveApplied_(next);
    Logger.log('Applied-reviews record: ' + Object.keys(next).length + ' review(s).');
    Logger.log('The next liveness sweep will see the changed URLs, clear these ' +
      'determinations against the new pages, and return them for re-review. ' +
      'That is intended -- see the header.');

    return { dryRun: false, rows: rows.length, institutions: targets.length,
             written: written, failed: failed, skipped: skips.length,
             newCheckmarks: newCheckmarks, clearedCheckmarks: lostCheckmarks };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Turns one reviewed row into an operation, or into a named skip.
 *
 * Every refusal returns a reason that identifies the row and says what is
 * wrong with it, because a silent skip in a script that publishes to the
 * live site is indistinguishable from a script that did not run.
 */
function wbPlan_(row, byUnitid) {
  const unitid      = String(row.fields[WB_C_UNITID] || '').trim();
  const trackedName = row.fields[WB_C_TRACKED] || '';
  const determination = row.fields[WB_C_DETERMINATION] || '';
  const proposed    = String(row.fields[WB_C_PROPOSED_URL] || '').trim();
  const reviewedUrl = String(row.fields[WB_C_URL] || '').trim();

  const base = { unitid: unitid, trackedName: trackedName, skip: true, rowId: row.id };

  const category = WB_CATEGORIES[trackedName];
  if (!category) {
    base.reason = 'unrecognised Tracked field "' + trackedName + '"';
    return base;
  }
  if (!unitid) {
    base.reason = 'no UNITID on the review row';
    return base;
  }

  const matches = byUnitid[unitid] || [];
  if (matches.length === 0) {
    base.reason = 'UNITID not found in 50 States';
    return base;
  }
  if (matches.length > 1) {
    base.reason = 'UNITID matches ' + matches.length + ' rows in 50 States -- ambiguous, not guessing';
    return base;
  }

  const target = matches[0];
  const currentLocated = String(target.fields[category.located] || '').trim();
  const currentSibling = String(target.fields[category.sibling] || '').trim();
  const currentBelow   = wbNames_(target.fields[category.below]);
  const snapUrl        = String(row.fields[WB_C_SNAP_URL] || '').trim();

  // TICKS IN ANOTHER CATEGORY'S FIELD ARE REFUSED, never moved or guessed.
  // The same rule as Promote: a reason in the wrong field is a reviewer slip,
  // and publishing on the strength of it could clear or keep the wrong page.
  const ticks = wbNames_(row.fields[category.ticks]);
  const stray = [];
  for (const k in WB_CATEGORIES) {
    const other = WB_CATEGORIES[k];
    if (other !== category && wbNames_(row.fields[other.ticks]).length) stray.push(other.label);
  }
  if (stray.length) {
    base.reason = 'REFUSED -- below-standard reasons are ticked in the ' + stray.join(' and ') +
      ' field on a ' + category.label + ' row. Move them to the ' + category.label +
      ' field, or clear them.';
    return base;
  }

  // value         -> the published (sibling) field
  // locatedValue  -> the record field, or null to leave it alone
  // belowValue    -> the below-standard field
  // marksPage     -> the page those reasons describe ('' when clearing)
  let value, locatedValue, belowValue, marksPage, action;

  if (determination === WB_DET_FIXED) {
    if (!proposed) {
      base.reason = '"' + WB_DET_FIXED + '" with no Reviewer-proposed URL';
      return base;
    }
    if (!wbIsWellFormedUrl_(proposed)) {
      base.reason = 'proposed URL is not well-formed: "' + proposed + '"';
      return base;
    }
    if (wbIsLoginUrl_(proposed)) {
      base.reason = 'REFUSED -- proposed URL is a login wall, will not publish: "' + proposed + '"';
      return base;
    }
    locatedValue = proposed;        // a verified address is the best URL known
    value        = ticks.length ? '' : proposed;
    belowValue   = ticks;
    marksPage    = proposed;
    action = ticks.length
      ? 'record the proposed URL as BELOW STANDARD (not published), with ' + ticks.length + ' reason(s)'
      : 'write proposed URL, clear any below-standard reasons';

  } else if (determination === WB_DET_BROKEN) {
    value        = '';
    locatedValue = '';               // confirmed dead -- forget it, so discovery looks again
    belowValue   = [];
    marksPage    = '';
    action = 'CLEAR the published link, the record field and the below-standard reasons ' +
             '(confirmed broken, no replacement)';

  } else if (determination === WB_DET_WORKING) {
    if (!ticks.length) {
      base.reason = '"' + WB_DET_WORKING + '" with nothing ticked -- nothing to change';
      return base;
    }
    value        = '';
    locatedValue = null;             // the record field keeps the page
    belowValue   = ticks;
    marksPage    = snapUrl;
    action = 'take the link OFF the site (works, but below standard), keep it in the record field, ' +
             'with ' + ticks.length + ' reason(s)';

  } else {
    base.reason = 'determination "' + determination + '" is not acted on';
    return base;
  }

  // THE STALENESS GUARD COMPARES AGAINST THE SIBLING, not located_*. The
  // reviewer opened whatever the Live URL Checks URL formula served them, and
  // since 2026-08-28 that formula reads the compliance field. Comparing
  // against located_* would ask whether a field nobody looked at has moved --
  // it would wave through a genuinely stale review whenever located_* happened
  // to still match, and block a good one whenever located_* had drifted.
  if (reviewedUrl && currentSibling && reviewedUrl !== currentSibling) {
    base.reason = 'the published URL has changed since the review (reviewed "' +
      reviewedUrl + '", now "' + currentSibling + '") -- needs re-review, not write-back';
    return base;
  }

  // THE REVIEW-TIME GUARD (added 2026-09-26). The guard above cannot fire in
  // practice: WB_C_URL is a formula over the CURRENT published value, so
  // "reviewed" and "current" are the same value read twice. A settled review
  // therefore kept acting on whatever address later replaced the one the
  // reviewer judged -- including a newer, working one put there by Promote
  // or by hand. Found on 2026-09-26 in a dry run: Concordia Irvine (Hazing
  // Policy) and George Fox (CHTR) were both marked "Confirmed broken" against
  // an older address, and write-back planned to clear the NEWER, different
  // page and remove both checkmarks.
  //
  // The fix compares against the snapshot of the address taken when the
  // review was made. Three cases:
  //   already applied   the field already holds what this review would
  //                     write -- fall through to the no-op test below.
  //   unchanged         the field still holds the address the reviewer saw
  //                     -- act on the review.
  //   anything else     the page changed after the review, or there is no
  //                     snapshot to tell -- skip and ask for a re-review.
  //                     The next Live URL Checks sweep clears the stale
  //                     review on its own; nothing here is lost.
  if (reviewedUrl !== value) {
    if (!snapUrl) {
      base.reason = 'no snapshot of the address the reviewer saw, so it cannot tell whether ' +
        'the published URL (now "' + reviewedUrl + '") changed after the review -- ' +
        'needs re-review, not write-back';
      return base;
    }
    if (reviewedUrl !== snapUrl) {
      base.reason = 'the published URL changed after the review (reviewed "' + snapUrl +
        '", now "' + reviewedUrl + '") -- needs re-review, not write-back';
      return base;
    }
  }

  // Build exactly what will be sent, then test THAT for a no-op.
  const fields = {};
  fields[category.sibling] = value;
  if (locatedValue !== null) fields[category.located] = locatedValue;

  // THE FIELD-LEVEL GUARD (added 2026-09-26). A review is about ONE page: the
  // address the reviewer saw (the snapshot). Each URL field is changed only if
  // it holds that exact page now, or already holds the target value. Anything
  // else is left alone. Found on 2026-09-26: Richmond's review judged
  // org-conduct.html, but the published field was already blank, so the run
  // went on to clear the record field (located_*) -- which held a DIFFERENT,
  // live page (hazing-prevention.html). The guard above only ever looked at
  // the published field.
  const heldBack = [];
  for (const f in fields) {
    const current = String(target.fields[f] || '').trim();
    if (current === fields[f]) continue;                 // already there
    if (snapUrl && current === snapUrl) continue;        // the reviewed page
    heldBack.push(f === category.sibling ? 'published' : 'located_*');
    delete fields[f];
  }
  const writesLocated = (category.located in fields);

  // THE REASONS FOLLOW THE RECORD FIELD (added 2026-10-04). They describe one
  // page, so they are written or cleared only when the record field ends up
  // holding that page. If the reviewer ticked reasons and the record field
  // cannot hold the page they describe, nothing is applied: taking a link off
  // the site without recording why would lose the finding.
  const finalLocated = writesLocated ? fields[category.located] : currentLocated;
  if (finalLocated === marksPage) {
    if (!wbSameList_(currentBelow, belowValue)) fields[category.below] = belowValue;
  } else if (belowValue.length) {
    base.reason = 'left alone: below-standard reasons are ticked, but the record field holds a ' +
      'different page ("' + finalLocated + '") from the one they describe ("' +
      (marksPage || '(none)') + '") -- fix the record field, then re-review';
    return base;
  } else if (currentBelow.length) {
    heldBack.push('below-standard (they belong to the page in the record field)');
  }
  const writesBelow = (category.below in fields);

  let changes = writesBelow;
  for (const f in fields) {
    if (f === category.below) continue;
    const current = String(target.fields[f] || '').trim();
    if (current !== fields[f]) { changes = true; break; }
  }
  if (!changes) {
    base.reason = heldBack.length
      ? 'left alone: the ' + heldBack.join(' and ') + ' field holds a different page from ' +
        'the one reviewed ("' + (snapUrl || '(no snapshot)') + '") -- needs re-review, not write-back'
      : 'already applied, nothing to change';
    return base;
  }

  return {
    skip: false,
    rowId: row.id,
    unitid: unitid,
    institution: String(target.fields[WB_S_INSTITUTION] || '(unnamed)'),
    recordId: target.id,
    trackedName: trackedName,
    category: category,
    fields: fields,
    writesLocated: writesLocated,
    locatedTarget: writesLocated ? fields[category.located] : currentLocated,
    writesBelow: writesBelow,
    belowTarget: belowValue,
    currentBelow: currentBelow,
    currentLocated: currentLocated,
    currentSibling: currentSibling,
    value: value,
    action: action
  };
}


// =========================================================================
// APPLY ONCE: THE APPLIED-REVIEWS RECORD  (added 2026-09-26)
// =========================================================================
// Write-back used to re-read every settled review each night and re-apply
// any whose page was still there. So a later correction in 50 States -- by
// hand, or by Promote -- was undone by a months-old decision (Richmond,
// 2026-09-26). Now each review is applied once and remembered here.
//
// WHAT IS REMEMBERED: row id -> a short fingerprint of the review (the
// determination, the page the reviewer saw, the proposed URL). A changed
// decision or a re-review against a different page has a different
// fingerprint and applies again. When Live URL Checks clears a stale review,
// the row drops out of the settled set and its entry is pruned on the next
// real run -- so this never outgrows today's settled reviews (15 on
// 2026-09-26). Stored in Script Properties, split across keys of under 8 KB.
//
// IF THE PROJECT IS EVER COPIED, copy the wb_applied_* properties too, or run
// wbMarkAllApplied() once in the new copy before the first real run.
const WB_APPLIED_PREFIX = 'wb_applied_';

/**
 * The reviews this script reads: Fixed, Confirmed broken, and Working as-is
 * only when a below-standard reason is ticked. Working as-is with nothing
 * ticked changes nothing, so it is not read at all.
 */
function wbSettledFormula_() {
  const ticked = 'OR({' + WB_C_BELOW_CHTR + '} != "", {' + WB_C_BELOW_POLICY + '} != "", {' +
                 WB_C_BELOW_FORM + '} != "")';
  return 'OR({' + WB_C_DETERMINATION + '} = "' + WB_DET_FIXED + '", ' +
         '{' + WB_C_DETERMINATION + '} = "' + WB_DET_BROKEN + '", ' +
         'AND({' + WB_C_DETERMINATION + '} = "' + WB_DET_WORKING + '", ' + ticked + '))';
}

/** A multiple-select value as a sorted list of trimmed names. */
function wbNames_(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v])
    .map(function (x) { return String(x && x.name ? x.name : x).trim(); })
    .filter(function (x) { return x; })
    .sort();
}

function wbSameList_(a, b) {
  return a.length === b.length && a.join('\n') === b.join('\n');
}
const WB_APPLIED_CHUNK  = 8000;   // characters per property; the limit is 9 KB

function wbFingerprint_(row) {
  const f = (row && row.fields) || {};
  const parts = [f[WB_C_DETERMINATION] || '', String(f[WB_C_SNAP_URL] || '').trim(),
                 String(f[WB_C_PROPOSED_URL] || '').trim()];
  // Ticks join the fingerprint only when there are some (2026-10-04), so a
  // changed set of reasons applies again, and every review applied before the
  // ticks existed keeps the fingerprint it was recorded with.
  const ticks = [WB_C_BELOW_CHTR, WB_C_BELOW_POLICY, WB_C_BELOW_FORM]
    .map(function (id) { return wbNames_(f[id]).join(';'); })
    .filter(function (t) { return t; });
  if (ticks.length) parts.push(ticks.join('/'));
  const raw = parts.join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw,
                                        Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 12);
}

function wbLoadApplied_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const keys = Object.keys(all).filter(function (k) { return k.indexOf(WB_APPLIED_PREFIX) === 0; })
    .sort(function (a, b) {
      return Number(a.slice(WB_APPLIED_PREFIX.length)) - Number(b.slice(WB_APPLIED_PREFIX.length));
    });
  if (!keys.length) return {};
  try {
    return JSON.parse(keys.map(function (k) { return all[k]; }).join('')) || {};
  } catch (e) {
    // A damaged record must not be read as "nothing applied" silently: that
    // would re-apply every old review. Stop and say so.
    throw new Error('The applied-reviews record (' + WB_APPLIED_PREFIX + '*) could not be read: ' +
      e + '. Run wbMarkAllApplied() to rebuild it, then re-run.');
  }
}

function wbSaveApplied_(map) {
  const props = PropertiesService.getScriptProperties();
  const text = JSON.stringify(map);
  const chunks = [];
  for (let i = 0; i < text.length; i += WB_APPLIED_CHUNK) {
    chunks.push(text.slice(i, i + WB_APPLIED_CHUNK));
  }
  const values = {};
  chunks.forEach(function (c, n) { values[WB_APPLIED_PREFIX + n] = c; });
  props.setProperties(values, false);
  // Remove leftover chunks from a longer, older record.
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf(WB_APPLIED_PREFIX) === 0 &&
        Number(k.slice(WB_APPLIED_PREFIX.length)) >= chunks.length) {
      props.deleteProperty(k);
    }
  });
}

/**
 * ONE-TIME BASELINE. Marks every review that is settled today as already
 * applied, WITHOUT writing anything to 50 States. Run once in a new project,
 * or if the record is ever lost, before the first real run -- so no old
 * decision fires again. Safe to re-run.
 */
function wbMarkAllApplied() {
  const pat = wbRequirePat_();
  const rows = wbListAll_(pat, WB_PAGES_BASE, WB_CHECKS_TABLE,
    [WB_C_DETERMINATION, WB_C_PROPOSED_URL, WB_C_SNAP_URL,
     WB_C_BELOW_CHTR, WB_C_BELOW_POLICY, WB_C_BELOW_FORM], wbSettledFormula_());
  const map = {};
  rows.forEach(function (r) { map[r.id] = wbFingerprint_(r); });
  wbSaveApplied_(map);
  Logger.log('Baseline recorded: ' + rows.length + ' settled review(s) marked as already ' +
    'applied. Nothing was written to 50 States.');
  return { marked: rows.length };
}


// =========================================================================
// URL GUARDS
// =========================================================================

/**
 * Well-formed enough to publish. Not a test of whether it resolves -- the
 * liveness checker answers that -- only that it is a real absolute http(s)
 * URL with a dotted host and no whitespace or control characters.
 */
function wbIsWellFormedUrl_(url) {
  if (!url) return false;
  if (url.length > 2000) return false;
  if (/[\s ​-‍﻿]/.test(url)) return false;
  if (/[\x00-\x1f\x7f]/.test(url)) return false;
  return /^https?:\/\/[^\/\s:]+\.[^\/\s:]+(?::\d+)?(?:[\/?#]|$)/i.test(url);
}

/** Does this address point at a sign-in page? See WB_LOGIN_URL_PATTERNS. */
function wbIsLoginUrl_(url) {
  if (!url) return false;
  const s = String(url);
  for (let i = 0; i < WB_LOGIN_URL_PATTERNS.length; i++) {
    if (WB_LOGIN_URL_PATTERNS[i].test(s)) return true;
  }
  return false;
}


// =========================================================================
// AIRTABLE
// =========================================================================
function wbRequirePat_() {
  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) throw new Error('Set AIRTABLE_PAT in Script Properties first.');
  return pat;
}

/**
 * POST /listRecords rather than a GET query string, for the same reason
 * LiveUrlChecks.gs uses it: Apps Script caps a fetch URL at roughly 2KB and
 * a fields[] list plus a filterByFormula goes past that.
 */
function wbList_(pat, baseId, tableId, body) {
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

function wbListAll_(pat, baseId, tableId, fields, formula) {
  const out = [];
  let offset = null;
  let guard = 0;
  do {
    const body = { pageSize: WB_PAGE_SIZE, returnFieldsByFieldId: true, fields: fields };
    if (formula) body.filterByFormula = formula;
    if (offset) body.offset = offset;
    const json = wbList_(pat, baseId, tableId, body);
    (json.records || []).forEach(function (r) { out.push(r); });
    offset = json.offset || null;
    Utilities.sleep(WB_SLEEP_MS);
  } while (offset && ++guard < 400);
  return out;
}

function wbPatch_(pat, baseId, tableId, targets) {
  const payload = {
    records: targets.map(function (t) {
      return { id: t.recordId, fields: t.fields };
    })
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
  Utilities.sleep(WB_SLEEP_MS);
  return { ok: resp.getResponseCode() === 200, error: resp.getContentText() };
}
