// =========================================================================
// ROBOTS PROBE  (2026-08-30)  -- read-only, hand-run, writes nothing
//
// PASTE AS A NEW FILE (File > New > Script, name it RobotsProbe).
//
// WHAT IT ANSWERS. Every Report Form row whose real proposal is a vendor
// form currently gets "Unable to check" from the AI standards pass, because
// the form itself was never fetched and hazing-selectable cannot be judged
// from the school page that links to it. The fix is to fetch the forms and
// run the existing hazingInOptions detection on them -- but the ceiling on
// that is robots.txt, and nobody has measured it.
//
// This measures it. No fetching of forms, no writes, no AI. It reads the
// distinct Linked form URLs out of Candidate URLs, asks capRobotsDisallows_
// about each one, and reports the answer grouped by host.
//
// WHY DISTINCT URLS RATHER THAN ROWS. 289 rows carry a Linked form URL but
// they collapse to about 220 distinct addresses on roughly 20 hosts -- the
// same vendor form serves several schools. Fetching per row would be a
// quarter more work for the same answer.
//
// WHY IT CHECKS robots.txt SEPARATELY AS WELL. capRobotsRules_ catches its
// own fetch errors and returns [] -- no rules -- which capRobotsDisallows_
// then reads as "allowed". So a host whose robots.txt 404s, times out, or
// refuses us is indistinguishable from one that genuinely permits the path.
// For a decision about whether to build a fetching pass on top of this, that
// difference matters: "the vendor allows it" and "we could not ask" are not
// the same finding. This file fetches robots.txt once per host itself and
// reports the HTTP code beside the verdict, so the two are visible.
//
// DECLARED ELSEWHERE, NOT HERE -- Apps Script shares one global scope, so
// redeclaring any of these fails the whole project:
//   from SitemapFinder.gs  PAGES_BASE_ID, CAND_TABLE_ID, CF, RFL,
//                          capPat_, capRobotsDisallows_, SM_BROWSER_HEADERS
//
// Everything this file defines is prefixed rbt / RBT.
// =========================================================================

const RBT_PAGE_SIZE = 100;
const RBT_SLEEP_MS  = 210;   // Airtable's 5 req/sec
const RBT_HOST_PAUSE_MS = 300;   // between robots.txt fetches, to be polite

/**
 * THE ENTRY POINT. Run this from the editor's Run dropdown.
 * Writes nothing. Logs a per-host table and returns the same data.
 */
function rbtProbeLinkedForms() {
  const pat = capPat_();

  // ---- 1. every distinct Linked form URL ----------------------------
  const formula = encodeURIComponent('NOT({' + RFL.linkedUrl + '} = "")');
  const fields = 'fields[]=' + RFL.linkedUrl;
  let offset = null;
  const seen = {};
  let rowCount = 0;

  do {
    let url = 'https://api.airtable.com/v0/' + PAGES_BASE_ID + '/' + CAND_TABLE_ID +
      '?filterByFormula=' + formula + '&pageSize=' + RBT_PAGE_SIZE +
      '&returnFieldsByFieldId=true&' + fields;
    if (offset) url += '&offset=' + offset;

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Airtable list error: ' + resp.getContentText().slice(0, 300));
    }
    const j = JSON.parse(resp.getContentText());
    j.records.forEach(function (r) {
      const u = String((r.fields || {})[RFL.linkedUrl] || '').trim();
      if (!u) return;
      rowCount++;
      seen[u] = true;
    });
    offset = j.offset || null;
    Utilities.sleep(RBT_SLEEP_MS);
  } while (offset);

  const urls = Object.keys(seen);
  Logger.log('Rows with a Linked form URL: ' + rowCount);
  Logger.log('Distinct form URLs to probe: ' + urls.length);

  // ---- 2. group by origin -------------------------------------------
  const byOrigin = {};
  urls.forEach(function (u) {
    const m = /^(https?:\/\/[^\/]+)/i.exec(u);
    const origin = m ? m[1] : '(unparseable)';
    (byOrigin[origin] = byOrigin[origin] || []).push(u);
  });
  const origins = Object.keys(byOrigin).sort();
  Logger.log('Distinct hosts: ' + origins.length);

  // ---- 3. robots.txt status per host, then the verdict per URL ------
  // The robots.txt fetch here is our own, so its outcome is visible.
  // capRobotsDisallows_ then does the real check and caches per origin,
  // so it costs one further fetch per host at most.
  const report = [];
  let totalAllowed = 0, totalDisallowed = 0, totalNoRobots = 0;

  origins.forEach(function (origin) {
    let code = 0;
    let robotsErr = '';
    try {
      const r = UrlFetchApp.fetch(origin + '/robots.txt',
        { headers: SM_BROWSER_HEADERS, muteHttpExceptions: true, followRedirects: true });
      code = r.getResponseCode();
    } catch (e) {
      robotsErr = String(e).slice(0, 80);
    }
    Utilities.sleep(RBT_HOST_PAUSE_MS);

    let allowed = 0, disallowed = 0;
    const blockedSamples = [];
    byOrigin[origin].forEach(function (u) {
      if (capRobotsDisallows_(u)) {
        disallowed++;
        if (blockedSamples.length < 2) blockedSamples.push(u);
      } else {
        allowed++;
      }
    });

    const readable = (code === 200);
    if (!readable) totalNoRobots += byOrigin[origin].length;
    totalAllowed += allowed;
    totalDisallowed += disallowed;

    report.push({
      origin: origin,
      urls: byOrigin[origin].length,
      robotsCode: robotsErr ? 'threw' : code,
      robotsReadable: readable,
      allowed: allowed,
      disallowed: disallowed,
      blockedSamples: blockedSamples,
      robotsErr: robotsErr
    });
  });

  // ---- 4. report -----------------------------------------------------
  // TOTALS ARE LOGGED FIRST, AND IN THEIR OWN Logger.log CALL. Apps Script
  // truncates a long log entry, and the first version of this file put the
  // summary underneath a 57-row table -- so the only numbers anyone actually
  // needed were the only ones that got cut. Detail is what should be lost to
  // truncation, never the answer.
  report.sort(function (a, b) { return b.urls - a.urls; });

  // Of the "allowed", separate the ones a readable robots.txt actually
  // permitted from the ones that defaulted to allowed because the file could
  // not be read. Those are different findings and must not share a number.
  let allowedReadable = 0, allowedByDefault = 0;
  report.forEach(function (r) {
    if (r.robotsReadable) allowedReadable += r.allowed;
    else allowedByDefault += r.allowed;
  });

  Logger.log(
    '\n================ LINKED FORM ROBOTS PROBE -- TOTALS ================\n' +
    'Rows with a linked form:        ' + rowCount + '\n' +
    'Distinct form URLs:             ' + urls.length + '\n' +
    'Distinct hosts:                 ' + origins.length + '\n' +
    '\n' +
    'BLOCKED by a readable robots.txt: ' + totalDisallowed + '\n' +
    'ALLOWED by a readable robots.txt: ' + allowedReadable +
      '   <- the genuinely fetchable set\n' +
    'Allowed only because robots.txt could not be read: ' + allowedByDefault +
      '\n   (URLs on hosts whose robots.txt did not return 200: ' + totalNoRobots + ')\n' +
    '\n' +
    'A missing robots.txt is not permission. Decide those deliberately\n' +
    'rather than letting the default decide for you.\n' +
    'Nothing was fetched beyond robots.txt, and nothing was written.\n');

  // Detail, second and separately, so truncation costs only this.
  let out = '\nurls  robots  allowed  blocked  host\n';
  report.forEach(function (r) {
    out += String(r.urls).padStart(4) + '  ' +
           String(r.robotsCode).padStart(6) + '  ' +
           String(r.allowed).padStart(7) + '  ' +
           String(r.disallowed).padStart(7) + '  ' +
           r.origin + (r.robotsErr ? '   [' + r.robotsErr + ']' : '') + '\n';
    if (r.blockedSamples.length) {
      out += '                                  e.g. ' + r.blockedSamples[0].slice(0, 88) + '\n';
    }
  });
  Logger.log(out);

  return { rows: rowCount, urls: urls.length, hosts: origins.length,
           blocked: totalDisallowed, allowedReadable: allowedReadable,
           allowedByDefault: allowedByDefault, robotsUnreadable: totalNoRobots,
           report: report };
}