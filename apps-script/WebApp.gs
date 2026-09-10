// =========================================================================
// WebApp.gs -- the ONE doGet for the project, plus the Live URL Checks page
// =========================================================================
//
// ⚠ PASTE THIS AND DELETE LinkChecker.gs IN THE SAME SITTING. ⚠
//
// Apps Script shares one global scope across every .gs file, and duplicate
// FUNCTION names do not error -- the later declaration silently wins, and
// nothing tells you which file that was. `doGet` and `buildNavBar_` are
// currently declared in LinkChecker.gs. If both files are present the web
// app will serve one of the two routers unpredictably, which is a far
// nastier failure than a missing page.
//
// If you want to stage it: delete just `doGet`, `buildNavBar_` and
// `buildLivenessHtml_` from LinkChecker.gs, and the rest of that file can
// sit dormant until you remove it.
//
// -------------------------------------------------------------------------
// WHY THE ROUTER MOVED
// -------------------------------------------------------------------------
// It was inside LinkChecker.gs, which is the file being retired -- and
// SitemapFinder.gs depends on it (its own comment at the top of
// buildSitemapHtml_ reads "body only -- LinkChecker.gs's doGet wraps
// this"). So deleting the old link checker would have taken the Sitemap
// Finder page down with it, for reasons having nothing to do with link
// checking.
//
// A router belongs in its own file for the same reason a shared constant
// does: whoever deletes a feature should not have to know that the
// project's front door was living inside it.
//
// -------------------------------------------------------------------------
// WHO THIS PAGE IS FOR
// -------------------------------------------------------------------------
// Someone who needs to run or check on these jobs without opening the Apps
// Script editor. That shapes three things:
//
//   1. Every button says what it will DO, not which function it calls.
//   2. Anything expensive or destructive is two clicks, with the cost
//      stated in the confirmation. "Start a new sweep" re-checks ~3,546
//      URLs and takes hours; it must not be one careless click next to
//      "Refresh".
//   3. The page never lies about progress. A slice that stops early
//      because it ran out of time says so, rather than showing a finished
//      bar.
// =========================================================================

const WEBAPP_PAGES = {
  livechecks: { label: 'Live URL Checks', title: 'HazingInfo Live URL Checks' },
  sitemap:    { label: 'Sitemap Finder',  title: 'HazingInfo Sitemap Candidate Finder' }
};

function doGet(e) {
  const requested = (e && e.parameter && e.parameter.page) || 'livechecks';
  const page = WEBAPP_PAGES[requested] ? requested : 'livechecks';

  const body = page === 'sitemap'
    ? buildSitemapHtml_()          // lives in SitemapFinder.gs
    : buildLiveUrlChecksHtml_();

  return HtmlService.createHtmlOutput(buildNavBar_(page) + body)
    .setTitle(WEBAPP_PAGES[page].title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function buildNavBar_(activePage) {
  const base = ScriptApp.getService().getUrl();
  const tab = function (key) {
    const active = key === activePage;
    const style = 'display:inline-block;padding:8px 16px;margin-right:6px;' +
      'border-radius:6px 6px 0 0;text-decoration:none;font-size:14px;' +
      (active ? 'background:#2563eb;color:white;font-weight:600;'
              : 'background:#eee;color:#333;');
    return '<a href="' + base + '?page=' + key + '" target="_top" style="' + style + '">' +
      WEBAPP_PAGES[key].label + '</a>';
  };
  return '<div style="border-bottom:2px solid #2563eb;margin-bottom:20px;">' +
    Object.keys(WEBAPP_PAGES).map(tab).join('') + '</div>';
}


// =========================================================================
// SERVER SIDE OF THE LIVE URL CHECKS PAGE
// =========================================================================
/**
 * Everything the page needs in one call, so a refresh is one round trip.
 *
 * Reads only Script Properties and the trigger list -- no Airtable -- so it
 * is instant and safe to call as often as the page likes. The row counts
 * come from the stored sweep state, not from a live query, which is why
 * this never costs API quota.
 */
function lucUiStatus() {
  const state = lucReadState_();
  const scheduleInstalled = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'lucCheckSliceScheduled';
  });
  const reconcileInstalled = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'lucReconcile';
  });

  let daysUntilDue = null;
  if (state) {
    const age = lucDaysSinceLastSweep_(state);
    if (age !== null) daysUntilDue = Math.ceil(LUC_MIN_SWEEP_INTERVAL_DAYS - age);
  }

  return {
    hasState: !!state,
    status: state ? state.status : 'none',
    startedAt: state ? state.startedAt : '',
    finishedAt: state ? (state.finishedAt || '') : '',
    processed: state ? state.processed : 0,
    total: state ? (state.totalAtStart || 0) : 0,
    summary: state ? (state.summary || {}) : {},
    parked: state ? (state.stuckIds || []).length : 0,
    writeErrors: state ? (state.writeErrors || []).length : 0,
    daysUntilDue: daysUntilDue,
    intervalDays: LUC_MIN_SWEEP_INTERVAL_DAYS,
    scheduleInstalled: scheduleInstalled && reconcileInstalled,
    // The schedule installer lives in a separate paste-in block. Degrade
    // rather than throw if it has not been added yet.
    scheduleAvailable: (typeof lucInstallSchedule === 'function')
  };
}

/** One slice. Returns the same shape lucUiStatus does, plus what happened. */
function lucUiRunSlice() {
  const result = lucRunSlice_(LUC_SLICE_BUDGET_MANUAL_MS);
  const status = lucUiStatus();
  status.lastAction = result.blocked ? 'blocked'
    : result.skipped ? 'notdue'
    : result.done ? 'done' : 'more';
  status.daysUntilDueFromSkip = result.daysUntilDue || null;
  return status;
}

function lucUiReconcileDryRun() {
  const r = lucReconcile_(true);
  return { dryRun: true, toCreate: r.toCreate, perField: r.perField };
}

function lucUiReconcile() {
  const r = lucReconcile_(false);
  return { created: r.created, remaining: r.remaining };
}

/**
 * Forces a new sweep. Expensive -- ~3,546 fetches over several hours -- so
 * the page makes it a two-click action and says so.
 */
function lucUiStartSweep() {
  const state = lucStartSweep();
  const status = lucUiStatus();
  status.lastAction = 'started';
  status.total = state.totalAtStart || 0;
  return status;
}

function lucUiSetSchedule(on) {
  if (typeof lucInstallSchedule !== 'function') {
    throw new Error('The schedule block has not been pasted into LiveUrlChecks.gs yet.');
  }
  if (on) { lucInstallSchedule(); } else { lucRemoveSchedule(); }
  return lucUiStatus();
}


// =========================================================================
// THE PAGE
// =========================================================================
function buildLiveUrlChecksHtml_() {
  return `
    <style>
      body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; }
      h2 { margin-bottom: 8px; }
      h3 { margin: 28px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
      p.sub { color: #666; margin-top: 0; margin-bottom: 12px; font-size: 14px; }
      button { background: #2563eb; color: white; border: none; padding: 12px 18px;
               border-radius: 6px; font-size: 15px; cursor: pointer; margin: 0 8px 8px 0; }
      button.secondary { background: #e5e7eb; color: #111; }
      button.danger { background: #fff; color: #b91c1c; border: 1px solid #f2b8b5; }
      button.armed { background: #b91c1c; color: #fff; border: 1px solid #b91c1c; }
      button:disabled { background: #93c5fd; cursor: default; }
      button.secondary:disabled { background: #f3f4f6; color: #9ca3af; }
      .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
      .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
      .pill.on { background:#dcfce7; color:#166534; }
      .pill.off { background:#f3f4f6; color:#6b7280; }
      .pill.run { background:#dbeafe; color:#1d4ed8; }
      .pill.bad { background:#fee2e2; color:#b91c1c; }
      .bar-bg { background: #e5e7eb; border-radius: 6px; height: 10px; margin-top: 10px; overflow: hidden; }
      .bar-fill { background: #2563eb; height: 10px; width: 0%; transition: width .3s; }
      table.kv { border-collapse: collapse; font-size: 13px; margin-top: 8px; width: 100%; }
      table.kv td { padding: 3px 12px 3px 0; vertical-align: top; }
      table.kv td:first-child { color:#6b7280; white-space: nowrap; width: 40%; }
      #msg { margin-top: 12px; font-size: 14px; color: #444; }
      #msg.err { color: #b91c1c; }
      .note { font-size: 13px; color: #6b7280; margin-top: 6px; }
    </style>

    <h2>Live URL Checks</h2>
    <p class="sub">
      Checks every compliance and located URL we hold &mdash; Transparency Report,
      chtr_index_url, Hazing Policy, Report Form, and the two located_* fields &mdash;
      and writes one row per URL into the <strong>Live URL Checks</strong> table in PAGES.
      A reviewer's verdict is kept until the URL or its HTTP status actually changes.
    </p>

    <h3>Schedule</h3>
    <div class="card" id="scheduleCard">Loading&hellip;</div>

    <h3>Current / last sweep</h3>
    <div class="card" id="sweepCard">Loading&hellip;</div>

    <h3>Run now</h3>
    <p class="sub">
      Keep this tab open while it works. Each press does about four minutes of checking and
      then stops; the page presses again for you until the sweep is finished. Closing the
      tab is safe &mdash; nothing is lost, and pressing Run again later carries on from
      where it stopped.
    </p>
    <p class="sub">
      <strong>Run checks</strong> also picks up any URLs added since the last check, so
      there is nothing to remember to do first.
    </p>
    <button id="runBtn" onclick="runSlice()">Run checks</button>
    <button id="startBtn" class="danger" onclick="armStart()">Start a new sweep</button>
    <div id="msg"></div>

    <script>
      var running = false;
      var startArmed = false;

      function el(id) { return document.getElementById(id); }
      function setMsg(t, isErr) { el('msg').textContent = t || ''; el('msg').className = isErr ? 'err' : ''; }

      function busy(b) {
        running = b;
        el('runBtn').disabled = b;
        el('startBtn').disabled = b;
      }

      function refresh() {
        google.script.run.withSuccessHandler(render).withFailureHandler(onError).lucUiStatus();
      }

      function render(s) {
        // ---- schedule card ----
        var sched = s.scheduleInstalled
          ? '<span class="pill on">Schedule on</span>'
          : '<span class="pill off">Schedule off</span>';
        sched += '<table class="kv">' +
          '<tr><td>Checks for work</td><td>every 4 hours</td></tr>' +
          '<tr><td>Adds rows for new URLs</td><td>daily, about 5am</td></tr>' +
          '<tr><td>Re-checks everything</td><td>every ' + s.intervalDays + ' days</td></tr>' +
          '</table>';
        sched += '<p class="note">Between full sweeps a scheduled run costs one database ' +
          'read and stops, so leaving it on is cheap.</p>';
        if (s.scheduleAvailable) {
          sched += s.scheduleInstalled
            ? '<button class="secondary" onclick="setSchedule(false)">Turn schedule off</button>'
            : '<button onclick="setSchedule(true)">Turn schedule on</button>';
        } else {
          sched += '<p class="note">The scheduling block has not been added to the script yet.</p>';
        }
        el('scheduleCard').innerHTML = sched;

        // ---- sweep card ----
        var body;
        if (!s.hasState) {
          body = '<span class="pill off">Never run</span>' +
            '<p class="note">Press <strong>Start a new sweep</strong> to check everything ' +
            'for the first time.</p>';
        } else {
          var pill = s.status === 'running'
            ? '<span class="pill run">In progress</span>'
            : '<span class="pill on">Finished</span>';
          if (s.writeErrors > 0 || s.parked > 0) pill += ' <span class="pill bad">Needs a look</span>';

          var pct = s.total ? Math.round((s.processed / s.total) * 100) : 0;
          body = pill +
            '<div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
            '<table class="kv">' +
            '<tr><td>URLs checked</td><td>' + s.processed + (s.total ? ' of ' + s.total : '') + '</td></tr>' +
            '<tr><td>Started</td><td>' + (s.startedAt || '&mdash;') + '</td></tr>' +
            (s.finishedAt ? '<tr><td>Finished</td><td>' + s.finishedAt + '</td></tr>' : '') +
            (s.daysUntilDue !== null && s.daysUntilDue > 0
              ? '<tr><td>Next full check</td><td>in ' + s.daysUntilDue + ' days</td></tr>'
              : (s.status !== 'running'
                  ? '<tr><td>Next full check</td><td>due now</td></tr>' : '')) +
            (s.parked ? '<tr><td>Rows set aside</td><td>' + s.parked + '</td></tr>' : '') +
            (s.writeErrors ? '<tr><td>Save failures</td><td>' + s.writeErrors + '</td></tr>' : '') +
            '</table>';

          var keys = Object.keys(s.summary || {});
          if (keys.length) {
            body += '<table class="kv">';
            keys.sort().forEach(function (k) {
              body += '<tr><td>' + k + '</td><td>' + s.summary[k] + '</td></tr>';
            });
            body += '</table>';
          }
        }
        el('sweepCard').innerHTML = body;
      }

      function onError(err) {
        busy(false);
        setMsg('Something went wrong: ' + (err && err.message ? err.message : err), true);
      }

      function runSlice() {
        busy(true);
        setMsg('Checking\\u2026 this takes a few minutes.');
        google.script.run.withSuccessHandler(onSlice).withFailureHandler(onError).lucUiRunSlice();
      }

      function onSlice(s) {
        render(s);
        if (s.lastAction === 'blocked') {
          busy(false);
          setMsg('Another run is already going. Try again in a few minutes.');
        } else if (s.lastAction === 'notdue') {
          busy(false);
          setMsg('Everything was checked recently. The next full check is due in ' +
            (s.daysUntilDueFromSkip !== null ? Math.ceil(s.daysUntilDueFromSkip) : s.intervalDays) +
            ' days. Use "Start a new sweep" if you need one now.');
        } else if (s.lastAction === 'done') {
          busy(false);
          setMsg('Finished \\u2014 everything has been checked.');
        } else {
          // Not done. Keep going rather than making someone press repeatedly.
          setMsg('Checked ' + s.processed + (s.total ? ' of ' + s.total : '') + '\\u2026 continuing.');
          google.script.run.withSuccessHandler(onSlice).withFailureHandler(onError).lucUiRunSlice();
        }
      }

      // Two clicks, not a browser dialog. A modal blocks the whole page and
      // is easy to dismiss without reading; an armed button states the cost
      // and stays visible until it is used or the page is refreshed.
      function armStart() {
        if (!startArmed) {
          startArmed = true;
          el('startBtn').className = 'armed';
          el('startBtn').textContent = 'Press again to re-check all URLs (takes hours)';
          setMsg('This re-checks every URL we hold from scratch. Press the red button again to confirm, or refresh the page to cancel.');
          return;
        }
        startArmed = false;
        el('startBtn').className = 'danger';
        el('startBtn').textContent = 'Start a new sweep';
        busy(true);
        setMsg('Starting\\u2026');
        google.script.run.withSuccessHandler(function (s) {
          render(s);
          setMsg('Started. ' + (s.total || 0) + ' URLs to check \\u2014 press "Run checks", or leave it to the schedule.');
          busy(false);
        }).withFailureHandler(onError).lucUiStartSweep();
      }

      function setSchedule(on) {
        busy(true);
        setMsg(on ? 'Turning the schedule on\\u2026' : 'Turning the schedule off\\u2026');
        google.script.run.withSuccessHandler(function (s) {
          render(s);
          busy(false);
          setMsg(on ? 'Schedule is on.' : 'Schedule is off.');
        }).withFailureHandler(onError).lucUiSetSchedule(on);
      }

      refresh();
    </script>
  `;
}