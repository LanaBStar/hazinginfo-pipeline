// =========================================================================
// CONTENT HASH  (2026-09-01)  -- NEW FILE
//
// PASTE AS A NEW FILE (File > New > Script, name it ContentHash).
// Then replace SitemapFinder.gs and LiveUrlChecks.gs with the copies
// delivered alongside this file. Nothing else in the project changes.
//
// -------------------------------------------------------------------------
// WHY THIS EXISTS
//
// Candidate URLs and Live URL Checks each stored a "content hash" of the
// same web page, and the two numbers could never agree, because each file
// grew its own hashing independently:
//
//   SitemapFinder.gs   capSha256_(bodyText)   SHA-256, over capText_'s
//                      stripped body (nav/header/footer/aside removed),
//                      no length cap, 64 hex characters.
//
//   LiveUrlChecks.gs   lucContentHash_(resp)  MD5, over a milder strip
//                      (tags out, chrome KEPT), capped at 200,000
//                      characters, truncated to 16 hex characters.
//
// Different algorithm, different input, different length. A page that had
// been captured as a candidate and was then tracked live carried two
// unrelated fingerprints, so nothing could ask the one question worth
// asking: HAS THIS PAGE CHANGED SINCE A HUMAN APPROVED IT? Answering that
// is what lets a promoted URL be re-checked for standards drift instead of
// silently rotting, and what stops a reviewer being handed a page nobody
// has touched.
//
// This file is the single definition. Both callers now produce the same
// value for the same page.
//
// -------------------------------------------------------------------------
// WHY IT HASHES STRIPPED TEXT AND NOT RAW HTML
//
// Hashing the markup would be simpler and is wrong. University pages carry
// rotating banners, build hashes in asset URLs, CSRF tokens and render
// timestamps; a markup hash changes on nearly every visit and tells you
// nothing. lucContentHash_'s own comment named this -- the flag would
// "blink on and off with the weather" -- and Candidate URLs' Content hash
// field description already promises the stripped text. Both were right.
//
// -------------------------------------------------------------------------
// WHY IT STRIPS THE PAGE CHROME
//
// The two old strippers disagreed about <nav>, <header>, <footer> and
// <aside>: capText_ removed them, lucContentHash_ kept them. One had to
// win, and removing them is the better answer -- a school editing its
// site-wide menu is not a change to its hazing policy, and both fields'
// descriptions already claim the hash ignores exactly that.
//
// The consequence is that Live URL Checks hashes are now LESS twitchy than
// they were. That is the intended direction.
//
// -------------------------------------------------------------------------
// WHAT THIS DOES *NOT* PROMISE
//
// EQUAL HASHES MEAN THE PAGE IS UNCHANGED. UNEQUAL HASHES MEAN LOOK, NOT
// PROVE. The two scripts fetch with different headers, so a server that
// personalises, A/B tests or injects a session-dependent block can hand
// them genuinely different HTML for the same URL. That is why a hash
// mismatch has always raised a flag and never cleared a determination, and
// nothing here changes that rule.
//
// PDFs ARE CANDIDATE-SIDE ONLY. SitemapFinder hashes text extracted from a
// PDF; LiveUrlChecks cannot read one at all (getContentText throws on the
// binary and the hash comes back ''). So a PDF-backed URL will have a
// candidate hash and no live hash. Cross-table comparison applies to HTML
// pages. Do not read a missing live hash as "the page vanished".
//
// REPORT FORM ROWS HASH SOMETHING DIFFERENT FROM WHAT THEY STORE. Page
// text for that category is "text plus form markup", because a general
// report form only counts if hazing can be selected and stripping the page
// would destroy that evidence. The HASH is still taken over the stripped
// body text alone -- otherwise a vendor form's hidden token fields would
// change it on every capture. So on Report Form rows the hash is not a
// fingerprint of Page text, and that is deliberate. Do not "fix" it.
//
// -------------------------------------------------------------------------
// CHANGING ANYTHING IN HERE INVALIDATES EVERY STORED HASH
//
// A hash is only ever compared against another hash produced by the same
// code. Edit the strip, the cap, the algorithm or the output length and
// every stored value in both tables becomes incomparable to every new one
// -- which does not throw, does not log, and shows up as every page in the
// project appearing to have changed at once. If you need to change it,
// change it deliberately and re-run the regeneration described in
// hazHashRegenerationNotes() below.
// =========================================================================

// Cap on how much normalised text is hashed. Inherited from
// LUC_HASH_MAX_CHARS, which it replaces. Long enough that no real page is
// truncated before its content-bearing section; short enough that a
// runaway page cannot eat a slice.
const HAZ_HASH_MAX_CHARS = 200000;

/**
 * Hash a full HTML document.
 *
 * Use this when what you have is markup. Strips scripts, styles, comments
 * and page chrome, decodes entities, then hands the plain text to
 * hazHashPlain_.
 *
 * Returns '' for empty input, which callers must read as "no information"
 * rather than "the page is empty" -- see the note on lucContentHash_ about
 * leaving a stored hash alone on an unreadable fetch.
 */
function hazHashHtml_(html) {
  if (!html) return '';
  return hazHashPlain_(hazStripHtml_(html));
}

/**
 * Hash text that is ALREADY plain -- capText_ output, or text extracted
 * from a PDF. Do not hand this raw markup; use hazHashHtml_ for that.
 *
 * Normalisation happens here rather than in hazHashHtml_ so that both
 * entry points share exactly one definition of it. A page hashed through
 * either route produces the same value.
 */
function hazHashPlain_(text) {
  const plain = hazNormalize_(text);
  if (!plain) return '';
  return hazSha256Hex_(plain);
}

/**
 * The shared strip. Deliberately the same set of removals capText_ makes,
 * because capText_'s output is what SitemapFinder hands to hazHashPlain_
 * -- if these two ever diverge, a page captured by one script and checked
 * by the other stops matching itself and nothing says so.
 *
 * IF YOU EDIT capText_ IN SitemapFinder.gs, EDIT THIS TOO. They are not
 * one function because capText_'s output is stored and read by people
 * (Page text preserves line structure), while this feeds a digest and
 * flattens everything -- but the removals must stay identical.
 */
function hazStripHtml_(html) {
  return hazEntities_(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * Flatten to one comparable string: all whitespace collapsed to single
 * spaces, lowercased, trimmed, capped.
 *
 * LOWERCASING IS ON PURPOSE and is the one place this hides a real edit --
 * a school changing "hazing policy" to "Hazing Policy" will not register.
 * Accepted, because case-only churn from CMS templates is far more common
 * than a meaningful case-only edit.
 *
 * The whitespace collapse is what makes a reflowed paragraph or a
 * re-indented template not count as a change.
 */
function hazNormalize_(text) {
  if (!text) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
    .substring(0, HAZ_HASH_MAX_CHARS);
}

/**
 * Entity decoding, matching capEnt_ in SitemapFinder.gs.
 *
 * A SECOND COPY, on purpose. capEnt_ lives in SitemapFinder.gs and is used
 * for text people read; this one feeds a digest and must keep working if
 * that file is ever split or retired. The two are small, and a hash
 * silently changing because someone edited a display helper is worse than
 * a duplicated dozen lines. If you add an entity to one, add it here.
 */
function hazEntities_(s) {
  return String(s)
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&mdash;/gi, '-').replace(/&ndash;/gi, '-').replace(/&hellip;/gi, '...')
    .replace(/&#x([0-9a-f]+);/gi, function (m, x) { return String.fromCharCode(parseInt(x, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
}

/**
 * SHA-256 as lowercase hex, full 64 characters, NOT truncated.
 *
 * lucContentHash_ used to cut its MD5 to 16 characters to keep the grid
 * readable. Dropped rather than carried over: a truncation length is one
 * more thing that has to be identical in two places to keep the hashes
 * comparable, and Airtable truncates the column display anyway. One fewer
 * parameter to keep in sync is worth more than a tidier cell.
 */
function hazSha256Hex_(str) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes[i] < 0 ? bytes[i] + 256 : bytes[i]).toString(16);
    hex += (b.length === 1 ? '0' : '') + b;
  }
  return hex;
}

// =========================================================================
// REGENERATION -- read before deploying
// =========================================================================
/**
 * Not a function that does anything. Logs the procedure, so it lives with
 * the code it describes rather than in a document that drifts from it.
 *
 * Every hash stored before this file existed was produced by one of the
 * two old implementations and is incomparable to anything produced now.
 * They cannot be recomputed offline: Live URL Checks stores no page text
 * at all, and Candidate URLs stores post-strip text rather than the raw
 * HTML. Every hash has to come from a fresh fetch.
 */
function hazHashRegenerationNotes() {
  Logger.log([
    '',
    '=== CONTENT HASH REGENERATION ===',
    '',
    'Do these in order. Steps 2 and 4 are the ones that matter.',
    '',
    '1. Paste ContentHash.gs, SitemapFinder.gs and LiveUrlChecks.gs.',
    '   Run this function to confirm the project still compiles.',
    '',
    '2. Blank Content hash on BOTH tables (Candidate URLs fldiaSq4L7qr18Jku,',
    '   Live URL Checks fldixWKjidD1eEfPC). Old values are not merely stale,',
    '   they are in a different unit -- leaving them means every row reads as',
    '   changed, forever.',
    '',
    '3. Let the normal passes refill them. Both are resumable and',
    '   watermark-driven; this is a longer-than-usual sweep, not a special',
    '   job. Roughly 2,300 Live URL Checks rows and 780 Candidate URLs rows.',
    '',
    '4. THEN re-stamp the review snapshots. Copy the new Content hash into',
    '   Content hash snapshot on every Live URL Checks row whose',
    '   determination is still valid -- Checked URL snapshot and Checked',
    '   status snapshot both still matching. Skip this and the 89 rows that',
    '   have a snapshot today will all flag as "Page changed since review"',
    '   and re-queue for no reason.',
    '',
    'RUN WRITE-BACK BEFORE ANY OF THIS, not after. A Reviewer-proposed URL',
    'that has not been applied exists nowhere else. See WriteBack.gs.',
    ''
  ].join('\n'));
}
