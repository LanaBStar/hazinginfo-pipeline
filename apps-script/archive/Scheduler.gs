/**
 * HazingInfo Data Checks -- Scheduler.gs  (FILE 3 OF 3)
 * -----------------------------------------------------------------------
 * Runs the Link Liveness + CHTR Date Checker on a schedule instead of
 * requiring someone to open the web app and press "Run Check".
 *
 * WHAT THIS FILE OWNS
 *   - the quarterly trigger that starts a sweep
 *   - the self-chaining trigger that carries a sweep across Apps Script's
 *     6-minute-per-execution cap
 *   - the run lock (so a scheduled run and a human pressing Run Check can
 *     never process the same records twice at the same time)
 *   - sweep state (one JSON blob in Script Properties)
 *   - the completion / failure emails
 *
 * WHAT IT DOES *NOT* OWN
 *   - how a record is actually checked. All of that stays in
 *     LinkChecker.gs (checkBatch_, interpretResponse_, extractDate_,
 *     writeLivenessResultsBack_, ...). This file only decides *when* to
 *     call runLivenessSlice_ and what to do with what it returns.
 *
 * WHY A SWEEP NEEDS MORE THAN ONE EXECUTION
 *   One Apps Script execution is capped at 6 minutes. A full sweep of the
 *   Data Checks view is ~1,500 records x up to 3 URLs each, which is far
 *   more than 6 minutes of network time. So a sweep is made of many short
 *   "slices": each slice works for a few minutes, saves its progress, and
 *   schedules the next slice a minute later. The sweep ends when Airtable
 *   reports no records left to check.
 *
 * HOW PROGRESS IS TRACKED (and why it is not Airtable's offset token)
 *   The old version paged through Airtable with its `offset` pagination
 *   token, saved in Script Properties between runs. That token expires,
 *   and an expired token forced a restart from record 1. With a human
 *   watching that was merely annoying. Unattended, a restart loop could
 *   run all day without anyone noticing.
 *
 *   Instead, progress now lives in the data itself. Every checked record
 *   gets `Link Last Checked` = today. A sweep freezes a cutoff date when
 *   it starts and asks Airtable, every slice, for records where
 *   `Link Last Checked` is blank or older than that cutoff. Checking a
 *   record removes it from that set. There is no cursor to expire, no
 *   token to lose, and an interrupted sweep resumes correctly no matter
 *   how long the gap was.
 *
 * SETUP (in addition to the setup notes in LinkChecker.gs)
 *   1. Add this file to the same Apps Script project (Insert > Script,
 *      name it Scheduler).
 *   2. Deploy > Manage deployments > edit > Execute as: **Me**.
 *      Trigger creation from the web app's buttons only works if the web
 *      app executes as the script owner.
 *   3. Open the web app, Link Checker tab, and press "Turn schedule on".
 *      (Or run installLivenessSchedule() once from the editor.)
 *   4. Optional: Project Settings > Script Properties >
 *        NOTIFY_EMAIL = where sweep emails should go.
 *      If unset, they go to the account that owns the script.
 *
 * COST: still $0. No AI credits, no paid services.
 * -----------------------------------------------------------------------
 */

// ---- Schedule shape ----------------------------------------------------
// Apps Script has no native "quarterly" trigger, only monthly. So we
// install a monthly trigger and have livenessQuarterlyStart() return
// immediately in the 8 months we don't want. Changing the cadence is a
// one-line edit here -- e.g. [0,6] for twice a year, or [0,1,2,...,11]
// for monthly -- with no trigger surgery required.
const SWEEP_MONTHS = [0, 3, 6, 9];   // Jan, Apr, Jul, Oct (JS months are 0-based)
const SWEEP_START_DAY = 1;           // day of month
const SWEEP_START_HOUR = 2;          // 2am in the script's timezone

// ---- Chaining / safety rails ------------------------------------------
const CHAIN_DELAY_MINUTES = 1;       // Apps Script's practical minimum for .after()
const RETRY_DELAY_MINUTES = 10;      // back off this long after a slice throws

// The watchdog. A slice schedules its own successor BEFORE doing any work,
// far enough out that it cannot collide with the current execution.
// Reason: exceeding Apps Script's 6-minute cap does not throw -- the
// execution is killed outright, so no catch block runs and no "schedule
// the next slice" line is ever reached. Scheduling afterwards means one
// timeout silently ends the sweep with no error and no email. Scheduling
// beforehand means the worst a timeout can cost is the in-flight batch
// and one wait, because the successor is already booked.
const WATCHDOG_DELAY_MINUTES = 8;    // must exceed the 6-minute execution cap
const MAX_CONSECUTIVE_ERRORS = 3;    // then give up on the sweep and email
const MAX_SLICES_PER_SWEEP = 250;    // backstop against any unforeseen loop
const MAX_STUCK_RECORDS = 50;        // records that fail to write; see below
const ABANDONED_AFTER_HOURS = 12;    // a "running" sweep this stale is treated as dead

// How long a slice is allowed to *start* new work. A batch already in
// flight always finishes, so the real worst case is this budget PLUS one
// whole batch.
//
// These are deliberately small. UrlFetchApp offers no way to cap how long
// an individual request may take -- there is no timeout parameter, and
// fetchAll retries failed requests internally on its own schedule. So the
// duration of one batch is genuinely not under our control, and the only
// lever we have is to keep the budget low and the batches small enough
// that budget + one worst-case batch still lands under 6 minutes.
const SLICE_BUDGET_SCHEDULED_MS = 60000; // 1 min -- unattended
const SLICE_BUDGET_MANUAL_MS = 30000;    // 30 s  -- keeps the web UI feeling live

const PROP_SWEEP_STATE = 'livenessSweepState';
const PROP_NOTIFY_EMAIL = 'NOTIFY_EMAIL';

// ---- Test mode ---------------------------------------------------------
// Two optional Script Properties that shrink a sweep so the *scheduling*
// machinery can be exercised in minutes instead of an hour, on 20 records
// instead of the whole view. Both are unset in normal operation and both
// are no-ops when unset. A sweep run with either of them set is stamped
// testMode:true in its state and its emails are prefixed [TEST], so a
// shrunken run can never be mistaken for a real quarterly sweep.
//
//   TEST_MAX_RECORDS   stop the sweep after this many records
//   TEST_SLICE_SECONDS shorten each slice, to force the chain to kick in
const PROP_TEST_MAX_RECORDS = 'TEST_MAX_RECORDS';
const PROP_TEST_SLICE_SECONDS = 'TEST_SLICE_SECONDS';

const HANDLER_QUARTERLY = 'livenessQuarterlyStart';
const HANDLER_CHAIN = 'livenessChainRun';

function testOverrides_() {
  const props = PropertiesService.getScriptProperties();
  const maxRecords = parseInt(props.getProperty(PROP_TEST_MAX_RECORDS) || '0', 10);
  const sliceSeconds = parseInt(props.getProperty(PROP_TEST_SLICE_SECONDS) || '0', 10);
  return {
    active: !!(maxRecords || sliceSeconds),
    maxRecords: maxRecords > 0 ? maxRecords : 0,
    sliceMs: sliceSeconds > 0 ? sliceSeconds * 1000 : 0
  };
}

// -------------------------------------------------------------------------
// TEST HELPERS -- run these from the editor's function dropdown
// -------------------------------------------------------------------------

/**
 * STEP 1. Proves triggers actually fire under your account and that the
 * script can send you mail -- the two things most likely to be blocked by
 * a missing authorization, and the two you cannot find out about by
 * pressing Run. Touches no Airtable data at all.
 *
 * Run it, then wait about a minute for the email.
 */
function testTriggerPlumbing() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'testTriggerPlumbingFired') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('testTriggerPlumbingFired')
    .timeBased()
    .after(60 * 1000)
    .create();
  Logger.log('Test trigger scheduled. Expect an email at ' + notifyRecipient_() + ' within ~2 minutes.');
  return 'Scheduled. Watch for an email at ' + notifyRecipient_() + '.';
}

function testTriggerPlumbingFired() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'testTriggerPlumbingFired') ScriptApp.deleteTrigger(t);
  });
  notify_('[TEST] Trigger plumbing works',
    '<p>A time-based trigger fired on its own and this script was able to email you. ' +
    'That is everything the scheduled sweep depends on outside of Airtable.</p>' +
    '<p>Nothing in Airtable was touched. Safe to move on to startTestSweep().</p>');
}

/**
 * STEP 2. Runs a real but deliberately small sweep: 60 records in
 * one-batch slices, so the chain has to hand off twice. Everything is
 * real -- real URL checks, real writes to the TESTER base, real chained
 * triggers, real completion email -- just small.
 *
 * Why 60 and 1: the slice budget is checked AFTER each batch of
 * LIVENESS_RECORDS_PER_RUN (20) records, so a 1-second budget means
 * exactly one batch per slice. 60 records is therefore three slices, two
 * of them driven by chained triggers. A cap of 20 would fit in a single
 * execution and never exercise the chain at all -- which is the whole
 * point of this test.
 *
 * IMPORTANT: let this first execution finish in the editor. An execution
 * started with the Run button is tied to the editor session and is
 * CANCELLED if you close the tab. The chained slices that follow are
 * time-driven triggers and do not care about the browser -- those are the
 * ones you can walk away from.
 *
 * Run endTestMode() afterwards to go back to full-size sweeps.
 */
function startTestSweep() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_TEST_MAX_RECORDS, '60');
  props.setProperty(PROP_TEST_SLICE_SECONDS, '1');
  resetLivenessSweep();
  const state = startLivenessSweep_('schedule');
  return 'Test sweep started: ' + state.totalAtStart + ' records, one batch per slice. ' +
    'Let this run finish, then watch Executions for chained livenessChainRun slices, ' +
    'or wait for the [TEST] email at ' + notifyRecipient_() + '.';
}

/** Clears the test overrides. Sweeps go back to full size after this. */
function endTestMode() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_TEST_MAX_RECORDS);
  props.deleteProperty(PROP_TEST_SLICE_SECONDS);
  Logger.log('Test mode off. Sweeps are full size again.');
  return 'Test mode off.';
}

/**
 * STEP 3 (optional). A full-size sweep started right now, ignoring the
 * month check -- the real thing, on demand. This is what the October 1
 * trigger will do. Expect it to run for roughly an hour in the
 * background. Make sure endTestMode() has been run first.
 */
function runFullSweepNow() {
  const t = testOverrides_();
  if (t.active) {
    throw new Error('Test mode is still on (max ' + t.maxRecords + ' records). ' +
      'Run endTestMode() first if you want a genuinely full sweep.');
  }
  const existing = readSweepState_();
  if (existing && existing.status === 'running' && !sweepLooksAbandoned_(existing)) {
    throw new Error('A sweep is already running (' + existing.processed + '/' +
      existing.totalAtStart + '). Let it finish, or press Reset sweep in the web app.');
  }
  resetLivenessSweep();
  const state = startLivenessSweep_('schedule');
  return 'Full sweep started: ' + state.totalAtStart + ' records to check.';
}

// -------------------------------------------------------------------------
// SCHEDULE INSTALL / REMOVE / STATUS
// -------------------------------------------------------------------------

/**
 * Installs (or reinstalls) the recurring trigger that starts a sweep.
 * Safe to run repeatedly -- it clears its own old trigger first, so it
 * can never stack up duplicates.
 */
function installLivenessSchedule() {
  removeLivenessSchedule();
  ScriptApp.newTrigger(HANDLER_QUARTERLY)
    .timeBased()
    .onMonthDay(SWEEP_START_DAY)
    .atHour(SWEEP_START_HOUR)
    .create();
  Logger.log('Liveness schedule installed: day ' + SWEEP_START_DAY + ' at ~' +
    SWEEP_START_HOUR + ':00, acting only in months ' + SWEEP_MONTHS.join(','));
  return livenessScheduleStatus();
}

/**
 * Removes the recurring trigger AND any pending chain trigger. Use this
 * to stop a runaway sweep: deleting the chain trigger is what actually
 * halts an in-progress sweep, since each slice is what schedules the next.
 */
function removeLivenessSchedule() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === HANDLER_QUARTERLY || fn === HANDLER_CHAIN) {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('Liveness schedule removed (recurring + any pending chain trigger).');
  return livenessScheduleStatus();
}

function livenessScheduleStatus() {
  let recurring = false;
  let chainPending = false;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === HANDLER_QUARTERLY) recurring = true;
    if (t.getHandlerFunction() === HANDLER_CHAIN) chainPending = true;
  });
  return {
    recurringInstalled: recurring,
    chainPending: chainPending,
    monthsLabel: SWEEP_MONTHS.map(m => MONTH_NAMES_[m]).join(', '),
    dayOfMonth: SWEEP_START_DAY,
    hour: SWEEP_START_HOUR,
    timezone: Session.getScriptTimeZone()
  };
}

const MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// -------------------------------------------------------------------------
// TRIGGER ENTRY POINTS
// -------------------------------------------------------------------------

/**
 * Fires monthly; does real work only in the months listed in SWEEP_MONTHS.
 */
function livenessQuarterlyStart() {
  const month = new Date().getMonth();
  if (SWEEP_MONTHS.indexOf(month) === -1) {
    Logger.log('Not a sweep month (' + MONTH_NAMES_[month] + ') -- nothing to do.');
    return;
  }

  const existing = readSweepState_();

  // A sweep someone started by hand and then walked away from stays marked
  // "running" forever -- nothing schedules its next slice, because manual
  // runs are driven by the open browser tab. Without this, one abandoned
  // manual run would block every future quarterly sweep. If nothing has
  // touched a running sweep in ABANDONED_AFTER_HOURS, close it out and
  // start fresh rather than refusing to run.
  if (existing && existing.status === 'running' && sweepLooksAbandoned_(existing)) {
    finishSweep_(existing, 'aborted',
      'No slice ran for over ' + ABANDONED_AFTER_HOURS + ' hours, so this sweep was ' +
      'treated as abandoned and closed out to make room for the ' + MONTH_NAMES_[month] +
      ' sweep. Most likely a manual run whose browser tab was closed partway through.');
  }

  const stillRunning = readSweepState_();
  if (stillRunning && stillRunning.status === 'running') {
    // The previous sweep never finished and is still active. Do not start
    // a second one on top of it -- two sweeps would fight over the same
    // records and both would report wrong totals. Say so loudly instead.
    notify_('Liveness sweep NOT started -- previous sweep still running',
      '<p>The ' + MONTH_NAMES_[month] + ' sweep was due to start, but the sweep begun on <b>' +
      esc_(stillRunning.startedAt) + '</b> is still marked as running (' +
      stillRunning.processed + ' of ' + stillRunning.totalAtStart + ' records processed, ' +
      stillRunning.slices + ' slices).</p>' +
      '<p>No new sweep was started. Either let the existing one finish, or open the ' +
      'Link Checker tab and press <b>Reset sweep</b> to clear it, then start a new one.</p>');
    return;
  }

  startLivenessSweep_('schedule');
}

/**
 * The self-chaining continuation. Each slice schedules exactly one of
 * these, and this deletes itself on the way in, so chain triggers can
 * never accumulate toward Apps Script's 20-trigger-per-script limit.
 */
function livenessChainRun() {
  deleteChainTriggers_();
  runScheduledSlice_();
}

// -------------------------------------------------------------------------
// SWEEP LIFECYCLE
// -------------------------------------------------------------------------

/**
 * Begins a new sweep: freezes the cutoff date, counts how much work there
 * is, writes fresh state, then runs the first slice immediately.
 */
function startLivenessSweep_(startedBy) {
  const pat = requirePat_();
  const tz = Session.getScriptTimeZone();
  const cutoff = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const test = testOverrides_();

  // Counted once, at the start. This is what makes the progress bar
  // honest -- the old UI divided by a hardcoded 1500.
  let total = countRecordsToCheck_(pat, cutoff);
  if (test.maxRecords) total = Math.min(total, test.maxRecords);

  const state = {
    sweepId: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    startedAt: new Date().toISOString(),
    startedBy: startedBy,
    cutoffDate: cutoff,
    totalAtStart: total,
    processed: 0,
    checked: 0,
    slices: 0,
    consecutiveErrors: 0,
    lastError: '',
    lastSliceAt: '',
    lastFetchSig: '',      // stall guard, see runLivenessSlice_ in LinkChecker.gs
    lastFetchRepeats: 0,
    sliceCompleted: true,  // watchdog bookkeeping; see runScheduledSlice_
    timeouts: 0,
    failCounts: {},        // recordId -> consecutive write failures
    stuckIds: [],          // records given up on; reported in the final email
    summary: { chtrLinkStatus: {}, reportFormLinkStatus: {}, hazingPolicyLinkStatus: {}, chtrDateCheck: {} },
    writeErrors: [],
    status: 'running',
    testMode: test.active,
    testMaxRecords: test.maxRecords,
    finishedAt: '',
    endNote: ''
  };
  writeSweepState_(state, { newSweep: true });
  Logger.log('Sweep started by ' + startedBy + '. Cutoff ' + cutoff + ', ' + total +
    ' records to check.' + (test.active ? ' TEST MODE.' : ''));

  clearLegacyOffsetProperties_();

  if (startedBy === 'schedule') runScheduledSlice_();
  return state;
}

/**
 * One scheduled slice: take the lock, do a slice of work, then either
 * chain the next slice, finish the sweep, or back off after an error.
 */
function runScheduledSlice_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // Something else (a manual run, or an overrunning previous slice) is
    // holding the lock. Try again shortly rather than running in parallel.
    Logger.log('Slice skipped -- another run holds the lock. Rescheduling.');
    scheduleNextSlice_(CHAIN_DELAY_MINUTES);
    return;
  }

  try {
    const state = readSweepState_();
    if (!state || state.status !== 'running') {
      Logger.log('No running sweep -- chain stopping.');
      return;
    }

    // Did the previous slice get killed rather than finishing? If so it
    // never got to schedule anything, and only the watchdog got us here.
    // Worth counting and reporting -- a sweep quietly losing a batch per
    // slice to timeouts should not look identical to a healthy one.
    if (state.sliceCompleted === false) {
      state.timeouts = (state.timeouts || 0) + 1;
      Logger.log('Previous slice did not finish (execution killed, most likely the ' +
        '6-minute cap). Resumed by watchdog. Timeouts this sweep: ' + state.timeouts);
    }

    if (state.slices >= MAX_SLICES_PER_SWEEP) {
      finishSweep_(state, 'aborted',
        'Hit the ' + MAX_SLICES_PER_SWEEP + '-slice safety limit without finishing. ' +
        'This should not happen in normal operation and suggests records are not ' +
        'leaving the "needs checking" set after being written.');
      return;
    }

    // Book the successor FIRST. If this execution is killed by the
    // 6-minute cap, nothing below this line runs -- so this trigger is
    // the only thing that can resume the sweep. It gets replaced with a
    // one-minute chain on the normal path a few lines down.
    scheduleNextSlice_(WATCHDOG_DELAY_MINUTES);
    state.sliceCompleted = false;
    writeSweepState_(state);

    let result;
    try {
      result = runLivenessSlice_(state, testOverrides_().sliceMs || SLICE_BUDGET_SCHEDULED_MS);
    } catch (err) {
      state.sliceCompleted = true;
      handleSliceError_(state, err);
      return;
    }

    if (result.superseded) {
      Logger.log('Slice stopped: its sweep was reset or replaced while it was running. ' +
        'Not scheduling a successor -- the newer sweep has its own.');
      return;
    }

    state.sliceCompleted = true;
    state.consecutiveErrors = 0;
    state.lastError = '';
    writeSweepState_(state);

    if (result.done) {
      finishSweep_(state, 'complete', '');   // deletes the watchdog
    } else {
      scheduleNextSlice_(CHAIN_DELAY_MINUTES); // replaces the watchdog
    }
  } finally {
    lock.releaseLock();
  }
}

function handleSliceError_(state, err) {
  state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
  state.lastError = String(err && err.message ? err.message : err);
  writeSweepState_(state);
  Logger.log('Slice error (' + state.consecutiveErrors + '): ' + state.lastError);

  if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    finishSweep_(state, 'aborted',
      'Gave up after ' + state.consecutiveErrors + ' consecutive failures. Last error: ' +
      state.lastError);
    return;
  }

  notify_('Liveness sweep hit an error (retrying in ' + RETRY_DELAY_MINUTES + ' min)',
    '<p>Failure ' + state.consecutiveErrors + ' of ' + MAX_CONSECUTIVE_ERRORS +
    '. The sweep has <b>not</b> been abandoned -- it will retry automatically.</p>' +
    '<p>Progress so far: ' + state.processed + ' of ' + state.totalAtStart + ' records.</p>' +
    '<p><b>Error:</b></p><pre>' + esc_(state.lastError) + '</pre>');

  scheduleNextSlice_(RETRY_DELAY_MINUTES);
}

function finishSweep_(state, status, note) {
  // "There is nothing left matching the filter" is not the same as "it
  // worked". If every record got parked because nothing would save, the
  // loop also ends with nothing left -- and calling that a completed
  // sweep would be the most misleading thing this script could do,
  // because it's exactly the email nobody reads carefully.
  const stuck = (state.stuckIds || []).length;
  if (status === 'complete' && state.totalAtStart > 0 && state.processed === 0) {
    status = 'aborted';
    note = note || ('Not one of the ' + state.totalAtStart + ' records saved back to Airtable. ' +
      'Check the write errors below -- most likely the PAT lost write access, or a field ' +
      'the script writes no longer accepts the values it sends.');
  } else if (status === 'complete' && stuck) {
    note = note || (stuck + ' of ' + state.totalAtStart + ' records were skipped because they ' +
      'would not save back to Airtable. Their check results were discarded, not stored.');
  }

  state.status = status;
  state.finishedAt = new Date().toISOString();
  state.endNote = note || '';
  if (!writeSweepState_(state)) {
    Logger.log('Not emailing: this sweep was superseded before it finished.');
    return;
  }
  deleteChainTriggers_();
  emailSweepSummary_(state);
  Logger.log('Sweep ' + status + '. ' + state.processed + ' records processed.');
}

function scheduleNextSlice_(delayMinutes) {
  deleteChainTriggers_();
  ScriptApp.newTrigger(HANDLER_CHAIN)
    .timeBased()
    .after(Math.max(1, delayMinutes) * 60 * 1000)
    .create();
}

function deleteChainTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === HANDLER_CHAIN) ScriptApp.deleteTrigger(t);
  });
}

// -------------------------------------------------------------------------
// SWEEP STATE
// -------------------------------------------------------------------------

function sweepLooksAbandoned_(state) {
  const stamp = state.lastSliceAt || state.startedAt;
  if (!stamp) return true;
  const age = Date.now() - new Date(stamp).getTime();
  if (isNaN(age)) return true;
  return age > ABANDONED_AFTER_HOURS * 60 * 60 * 1000;
}

function readSweepState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_SWEEP_STATE);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * True if `state` still refers to the sweep currently stored. A slice
 * runs for minutes; in that time someone can press Reset sweep, or start
 * a new sweep, and the slice would otherwise finish and write its now
 * meaningless totals over the top of the newer one.
 *
 * startedAt is the epoch token -- an ISO timestamp with milliseconds,
 * set once when the sweep begins and never changed.
 */
function sweepStillCurrent_(state) {
  const live = readSweepState_();
  return !!live && !!state && live.startedAt === state.startedAt;
}

/**
 * Saves sweep state, unless this slice has been superseded.
 * Returns false if the write was refused, which the caller should treat
 * as "stop working, someone else owns this now".
 *
 * Pass {newSweep: true} for the very first write of a sweep, which by
 * definition has nothing to match against.
 */
function writeSweepState_(state, opts) {
  if (!(opts && opts.newSweep) && !sweepStillCurrent_(state)) {
    Logger.log('Refusing to save: this slice belongs to a sweep that has since been ' +
      'reset or replaced. Discarding its progress rather than overwriting the current one.');
    return false;
  }

  // A Script Property value is capped at 9KB. writeErrors and stuckIds are
  // the only two fields that can grow, so both are trimmed here rather
  // than at every call site -- a sweep that silently stopped saving its
  // own progress because one field got long would be a nasty bug.
  if (state.writeErrors && state.writeErrors.length > 25) {
    const dropped = state.writeErrors.length - 25;
    state.writeErrors = state.writeErrors.slice(0, 25);
    state.writeErrorsTruncated = dropped;
  }
  if (state.stuckIds && state.stuckIds.length > MAX_STUCK_RECORDS) {
    state.stuckIds = state.stuckIds.slice(0, MAX_STUCK_RECORDS);
  }
  PropertiesService.getScriptProperties()
    .setProperty(PROP_SWEEP_STATE, JSON.stringify(state));
  return true;
}

/**
 * Clears sweep state and cancels the pending chain trigger.
 *
 * What this CANNOT do is stop an execution that is already running --
 * Apps Script gives no way to kill one from code. That slice keeps going
 * for up to six more minutes, and it holds the script lock the whole
 * time, so a sweep started immediately afterwards will find the lock
 * taken and have to wait for it. The superseded-sweep check in
 * writeSweepState_ is what stops that orphan from writing its stale
 * totals over the new sweep when it eventually finishes.
 *
 * If you want a clean restart: reset, then check Executions for anything
 * still Running, and wait for it to clear before starting again.
 */
function resetLivenessSweep() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_SWEEP_STATE);
  deleteChainTriggers_();
  clearLegacyOffsetProperties_();

  const running = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === HANDLER_CHAIN).length;
  Logger.log('Sweep state cleared and chain triggers deleted (' + running + ' removed). ' +
    'Any execution already in flight will keep running until it ends on its own, ' +
    'but it can no longer write over the next sweep.');
  return { cleared: true };
}

/**
 * One-time cleanup of the Script Properties the old offset-based version
 * used. Harmless to call repeatedly; kept so an upgraded project doesn't
 * leave confusing stale keys behind in Project Settings.
 */
function clearLegacyOffsetProperties_() {
  const props = PropertiesService.getScriptProperties();
  ['checkOffset', 'checkSummary', 'checkedCount', 'processedCount', 'writeErrors']
    .forEach(k => props.deleteProperty(k));
}

// -------------------------------------------------------------------------
// EMAIL
// -------------------------------------------------------------------------

function notifyRecipient_() {
  const override = PropertiesService.getScriptProperties().getProperty(PROP_NOTIFY_EMAIL);
  return (override && override.trim()) || Session.getEffectiveUser().getEmail();
}

function notify_(subject, htmlBody) {
  try {
    MailApp.sendEmail({
      to: notifyRecipient_(),
      subject: '[HazingInfo Link Check] ' + subject,
      htmlBody: htmlBody +
        '<hr><p style="color:#666;font-size:12px">Sent by the HazingInfo Data Checks ' +
        'Apps Script project. Change the recipient with the NOTIFY_EMAIL script property.</p>'
    });
  } catch (e) {
    // Never let a mail failure take down a sweep.
    Logger.log('Could not send notification email: ' + e);
  }
}

function emailSweepSummary_(state) {
  const ok = state.status === 'complete';
  const failedWrites = (state.writeErrors || []).length;
  const stuck = (state.stuckIds || []).length;

  // state.processed counts records Airtable accepted a write for. In a
  // pathological run (a write that reports success but doesn't stick) a
  // record can be attempted more than once, so clamp the headline number
  // rather than mailing "finished: 80 of 40 records".
  const shown = state.totalAtStart
    ? Math.min(state.processed, state.totalAtStart)
    : state.processed;

  const prefix = state.testMode ? '[TEST] ' : '';
  const subject = prefix + (ok
    ? (failedWrites || stuck
        ? 'Sweep finished with problems (' + shown + ' records)'
        : 'Sweep finished cleanly (' + shown + ' records)')
    : 'Sweep ABORTED after ' + shown + ' records');

  const parts = [];
  if (state.testMode) {
    parts.push('<p style="background:#fef3c7;border:1px solid #fcd34d;padding:10px;border-radius:6px">' +
      '<b>This was a test sweep, not a real one.</b> It was capped at ' +
      state.testMaxRecords + ' records. Run <code>endTestMode()</code> to go back to full sweeps.</p>');
  }
  parts.push('<h2>' + (ok ? 'Link check sweep finished' : 'Link check sweep aborted') + '</h2>');
  if (state.endNote) {
    parts.push('<p style="background:#fee;border:1px solid #f99;padding:10px;border-radius:6px">' +
      esc_(state.endNote) + '</p>');
  }
  parts.push('<table cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
    row_('Started', state.startedAt + ' (' + state.startedBy + ')') +
    row_('Finished', state.finishedAt) +
    row_('Records processed', shown + ' of ' + state.totalAtStart + ' found at start' +
      (state.processed > shown ? ' (' + state.processed + ' write attempts)' : '')) +
    row_('Records with at least one URL', String(state.checked)) +
    row_('Slices (executions)', String(state.slices) +
      (state.timeouts ? ' (' + state.timeouts + ' hit the 6-minute cap and were resumed)' : '')) +
    '</table>');

  const sum = state.summary || {};
  parts.push('<h3>Results</h3>');
  parts.push('<table cellpadding="6" style="border-collapse:collapse;font-size:14px">');
  parts.push(summaryRows_('CHTR link', sum.chtrLinkStatus));
  parts.push(summaryRows_('Report Form link', sum.reportFormLinkStatus));
  parts.push(summaryRows_('Hazing Policy link', sum.hazingPolicyLinkStatus));
  parts.push(summaryRows_('CHTR date check', sum.chtrDateCheck));
  parts.push('</table>');

  if (stuck) {
    parts.push('<h3 style="color:#b45309">' + stuck + ' record(s) skipped</h3>');
    parts.push('<p>These records were fetched, checked, and then failed to save back to ' +
      'Airtable more than once, so the sweep stopped retrying them to avoid looping. ' +
      'Their results were lost, not saved. Record IDs:</p><pre>' +
      esc_(state.stuckIds.join('\n')) + '</pre>');
  }

  if (failedWrites) {
    parts.push('<h3 style="color:#b91c1c">' + failedWrites + ' write batch(es) failed</h3>');
    parts.push('<p>Airtable rejected these writes. Every record in an affected batch failed, ' +
      'not just one -- including records whose check went fine.</p>');
    state.writeErrors.forEach(we => {
      parts.push('<div style="background:#fee;border:1px solid #f99;border-radius:6px;padding:10px;margin-top:8px">' +
        '<p><b>Institutions:</b> ' + esc_(we.institutions) + '</p>' +
        '<p><b>Airtable said:</b></p><pre>' + esc_(we.airtableError) + '</pre></div>');
    });
    if (state.writeErrorsTruncated) {
      parts.push('<p><i>' + state.writeErrorsTruncated +
        ' further write error(s) were not recorded (storage limit). See the ' +
        'Apps Script execution log for the full list.</i></p>');
    }
  }

  notify_(subject, parts.join(''));
}

function summaryRows_(label, obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return row_(label, '(none)');
  const body = keys.sort().map(k => esc_(k) + ': <b>' + obj[k] + '</b>').join('<br>');
  return row_(label, body);
}

function row_(k, v) {
  return '<tr><td style="border:1px solid #ddd"><b>' + esc_(k) + '</b></td>' +
    '<td style="border:1px solid #ddd">' + v + '</td></tr>';
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -------------------------------------------------------------------------
// CALLED FROM THE WEB APP (see buildLivenessHtml_ in LinkChecker.gs)
// -------------------------------------------------------------------------

function getLivenessStatusForUi() {
  const state = readSweepState_();
  return {
    schedule: livenessScheduleStatus(),
    sweep: state,
    notifyTo: notifyRecipient_()
  };
}

function startLivenessSweepFromUi() {
  const existing = readSweepState_();
  if (existing && existing.status === 'running') return existing;
  return startLivenessSweep_('manual');
}