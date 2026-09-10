/**
 * Paste the URLs from the "ONE OF THESE THREW" log line between the quotes,
 * separated however they came out. Fetches each one ALONE, so a throw is
 * attributable instead of poisoning a wave.
 */
function findPoison() {
  const blob = `
     https://www.marywood.edu/safety/reports | https://www.usu.edu/policies/2406/ 
  `;

  const urls = blob.split(/[\s|,]+/).filter(function (u) { return /^https?:\/\//i.test(u); });
  Logger.log('Testing ' + urls.length + ' URL(s) individually.');

  const bad = [];
  urls.forEach(function (url) {
    try {
      const resp = UrlFetchApp.fetch(url, lucRequest_(url));
      Logger.log('  ok    ' + resp.getResponseCode() + '  ' + url);
    } catch (e) {
      bad.push(url);
      Logger.log('  THREW       ' + url + '  --  ' + e);
    }
    Utilities.sleep(300);
  });

  Logger.log('');
  Logger.log(bad.length
    ? 'POISON (' + bad.length + '): ' + bad.join('  |  ')
    : 'None threw individually -- the wave may have died on total time rather than one bad URL.');
  return bad;
}