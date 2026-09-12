IN github, the old copy of pre-filter has it:
// =========================================================================
// PRE-FILTER RESULT  (2026-08-24)  -- NEW FILE, paste alongside SitemapFinder.gs
//
// PASTE AS A NEW FILE (File > New > Script, name it PreFilterResult).
// SitemapFinder.gs must be the UPDATED copy delivered alongside this file
// -- it already contains the two call sites this depends on (capOneRow_
// and rflOneRow_/rflWrite_). No further edits to it are needed.
//
// WHAT THIS FIXES. Pre-filter result (fldkhZNE6jFi76kY4) was never written
// by anything. capOneRow_ computed the six Pre-filter signals (
// hasReportForm, formReason, hazingInFraming, hazingInOptions, bodyChars,
// formCount) and stored them as text, but nothing ever turned them into
// the verdict the field's own description promises: Passed / Dropped - no
// form found / Dropped - too little text / Dropped - terms only in
// navigation.
//
// -------------------------------------------------------------------------
// WHY THE THREE CHECKS SPLIT BY CATEGORY THE WAY THEY DO
//
// "No form found" applies to Report Form ONLY. hasReportForm/formReason/
// hazingInOptions all come from capForms_, which exists to implement
// decision #147's two-limb test (a dedicated hazing report form, OR a
// general form where hazing is selectable) -- CHTR and Hazing Policy pages
// were never supposed to have a form at all, so judging them on one is
// meaningless.
//
// "Too little text" applies to CHTR and Hazing Policy ONLY. Checked
// against the real Character count distribution on the 694 rows captured
// before this patch (2026-08-24): the genuine failures sit at 0-262 chars
// (three uj.edu handbook pages at exactly 0, a sulross.edu page that
// turned out to be a login redirect at 262) and real short Hazing Policy/
// CHTR content starts around 164-480 chars. But Report Form's low end is
// dominated by LEGITIMATE vendor pages -- EthicsPoint, Smartsheet,
// Qualtrics -- sitting at 60-160 chars because they are JS-rendered forms
// with no server-side text to scrape. Applying this check to Report Form
// would drop real candidates at the same rate as junk, so it never runs
// for that category.
//
// "Terms only in navigation" applies to all three. Safe everywhere because
// it only fires when the category term appears in the page's nav/header/
// footer/aside chrome and NOWHERE in the actual body -- a page with no
// hazing mention anywhere (the common Report Form case) does not trigger
// it, it just falls through to the next check.
//
// -------------------------------------------------------------------------
// WHY "NO FORM FOUND" RESOLVES INSIDE THE LINK PASS, NOT AS ITS OWN STAGE
//
// capOneRow_ only ever looks at the ONE page it just fetched. Whether that
// page LINKS to a vendor form (Maxient, Symplicity, etc.) is only known
// once the Report Form Link Pass (section 3 of SitemapFinder.gs) has read
// it -- and that pass's own header says 93% of Report Form pages have no
// form of their own, so for most rows the page capture found is a
// stepping stone, not the answer.
//
// First cut of this fix ran that as a separate hand-triggered pass
// (pfResolveReportForm_), reading the same rows a second time after the
// link pass finished. Unnecessary: runReportFormLinkPass() already visits
// every such row exactly once. rflOneRow_ now calls rflResolvePrefilter_
// (added to SitemapFinder.gs) at the end of every branch, and rflWrite_
// writes the result in the SAME PATCH call that already writes Linked
// form URL / host / Outbound report links. No second read, no second
// write, no separate trigger -- and once real scheduling gets built,
// 'linkpass' is already one of the three PIPELINE_STAGES, so this comes
// along for free rather than needing a fourth stage bolted on.
//
// pfClassify_ only defers to the link pass when it genuinely cannot
// decide yet: Report Form, no form of its own, not caught by the nav-only
// check. If the page already has its own form, it is 'Passed' at capture
// time -- no reason to wait.
// =========================================================================

// ---- The field this file exists to write --------------------------------
const PF_F_RESULT = 'fldkhZNE6jFi76kY4';   // Pre-filter result

// Below this many chars of BODY TEXT (nav/header/footer/aside already
// stripped by capText_), a CHTR or Hazing Policy page is treated as
// nothing to appraise. See the header for the data this number is based
// on. NOT applied to Report Form -- see header.
const PF_MIN_CHARS = 100;

// -------------------------------------------------------------------------
// THE CLASSIFIER -- called from capOneRow_ (SitemapFinder.gs) at capture
// time, with everything it needs already in hand.
// -------------------------------------------------------------------------
function pfClassify_(category, bodyText, navText, hasReportForm) {
  const HAZING = /hazing/i;
  const hazingInBody = HAZING.test(bodyText);
  const hazingInNavOnly = !hazingInBody && HAZING.test(navText);

  if (category === 'CHTR' || category === 'Hazing Policy') {
    if (bodyText.length < PF_MIN_CHARS) return 'Dropped - too little text';
    if (hazingInNavOnly) return 'Dropped - terms only in navigation';
    return 'Passed';
  }

  // Report Form. Resolve now if we already can; otherwise leave it for
  // rflResolvePrefilter_ once the link pass has looked for an outbound
  // vendor link.
  if (hazingInNavOnly) return 'Dropped - terms only in navigation';
  if (hasReportForm) return 'Passed';
  return 'Not yet run';
}

/**
 * Everything inside <nav>, <header>, <footer>, <aside> -- the exact blocks
 * capText_ strips OUT of the stored body text -- concatenated and
 * tag-stripped. This is the "site-wide navigation" half of the terms-only
 * -in-navigation check; capText_'s output is the "body" half.
 *
 * Must be called on the RAW html, before capText_ discards these blocks.
 * There is no way to recover this later -- Page text only ever stores the
 * already-stripped body (plus form markup for Report Form) -- which is why
 * pfBackfill_ below cannot apply this check to rows captured before this
 * file existed.
 */
function capNavOnlyText_(html) {
  const blocks = []
    .concat(html.match(/<nav[\s\S]*?<\/nav>/gi) || [])
    .concat(html.match(/<header[\s\S]*?<\/header>/gi) || [])
    .concat(html.match(/<footer[\s\S]*?<\/footer>/gi) || [])
    .concat(html.match(/<aside[\s\S]*?<\/aside>/gi) || []);
  return capEnt_(blocks.join(' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

// -------------------------------------------------------------------------
// BACKFILL -- one-time, for rows captured before this file existed
// -------------------------------------------------------------------------
/**
 * CHTR and Hazing Policy only, decided from the already-stored Character
 * count -- no re-fetch needed. Only ever touches rows with a BLANK
 * Pre-filter result, so it is safe to leave in the project and re-run any
 * time: nothing this patch classifies going forward will still be blank.
 *
 * INCOMPLETE ON PURPOSE: cannot apply the terms-only-in-navigation check
 * retroactively. Page text only ever stored the already-stripped body, so
 * there is nothing left to check nav text against for a row captured
 * before capNavOnlyText_ existed. Those rows can only ever land on Passed
 * or Dropped - too little text here; a row that would genuinely have
 * failed the nav-only check stays Passed until it is re-captured.
 */
function pfBackfillDryRun() { return pfBackfill_(true); }
function pfBackfill() { return pfBackfill_(false); }

function pfBackfill_(dryRun) {
  const pat = capPat_();
  const formula = encodeURIComponent(
    'AND(OR({' + CF.category + '} = "CHTR", {' + CF.category + '} = "Hazing Policy"), ' +
    '{' + CF.fetchStatus + '} = "Fetched", {' + PF_F_RESULT + '} = "")');

  const fields = 'fields[]=' + CF.charCount;
  let offset = null;
  const rows = [];

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

  let passed = 0, dropped = 0;
  const updates = rows.map(function (r) {
    const chars = Number(r.fields[CF.charCount] || 0);
    const result = chars < PF_MIN_CHARS ? 'Dropped - too little text' : 'Passed';
    if (result === 'Passed') passed++; else dropped++;
    const f = {}; f[PF_F_RESULT] = result;
    return { id: r.id, fields: f };
  });

  Logger.log('pfBackfill (CHTR + Hazing Policy): ' + rows.length + ' row(s) -- ' +
    passed + ' would pass, ' + dropped + ' would drop (too little text). ' +
    'Terms-only-in-navigation not checked -- see header, not recoverable retroactively.');

  if (dryRun) { Logger.log('DRY RUN -- nothing written.'); return { dryRun: true, total: rows.length, passed: passed, dropped: dropped }; }

  for (let i = 0; i < updates.length; i += PF_WRITE_BATCH) {
    const batch = updates.slice(i, i + PF_WRITE_BATCH);
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
  Logger.log('Written: ' + passed + ' Passed, ' + dropped + ' Dropped - too little text.');
  return { total: rows.length, passed: passed, dropped: dropped };
}

/**
 * One-time backfill for Report Form rows captured before this patch --
 * same decision rflResolvePrefilter_ makes going forward, run once here
 * because those rows will never pass through rflOneRow_ again unless
 * their Outbound report links field is cleared. Reads the STORED
 * Pre-filter signals text and whatever Linked form URL already holds;
 * does not re-fetch.
 */
function pfBackfillReportFormDryRun() { return pfBackfillReportForm_(true); }
function pfBackfillReportForm() { return pfBackfillReportForm_(false); }

function pfBackfillReportForm_(dryRun) {
  const pat = capPat_();
  const formula = encodeURIComponent(
    'AND({' + CF.category + '} = "Report Form", {' + CF.fetchStatus + '} = "Fetched", ' +
    'OR({' + PF_F_RESULT + '} = "", {' + PF_F_RESULT + '} = "Not yet run"))');

  const fields = ['fields[]=' + CF.signals, 'fields[]=' + RFL.linkedUrl].join('&');
  let offset = null;
  const rows = [];

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

  let passed = 0, dropped = 0;
  const updates = rows.map(function (r) {
    const sig = r.fields[CF.signals] || '';
    const hasForm = sig.indexOf('hasReportForm: true') !== -1;
    const linkedUrl = String(r.fields[RFL.linkedUrl] || '').trim();
    const result = (hasForm || linkedUrl) ? 'Passed' : 'Dropped - no form found';
    if (result === 'Passed') passed++; else dropped++;
    const f = {}; f[PF_F_RESULT] = result;
    return { id: r.id, fields: f };
  });

  Logger.log('pfBackfillReportForm: ' + rows.length + ' row(s) eligible -- ' +
    passed + ' would pass, ' + dropped + ' would drop (no form, no linked form URL).');

  if (dryRun) { Logger.log('DRY RUN -- nothing written.'); return { dryRun: true, total: rows.length, passed: passed, dropped: dropped }; }

  for (let i = 0; i < updates.length; i += PF_WRITE_BATCH) {
    const batch = updates.slice(i, i + PF_WRITE_BATCH);
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
  Logger.log('Written: ' + passed + ' Passed, ' + dropped + ' Dropped - no form found.');
  return { total: rows.length, passed: passed, dropped: dropped };
}

const PF_WRITE_BATCH = 10;   // Airtable's cap per PATCH call
