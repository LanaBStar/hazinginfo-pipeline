/**
 * app.js -- jobs/05-review/app/pages: the review app's static UI (Phase 7b, Section 11).
 *
 * One incident (or, for a zero-incident "fast"-tier report, the whole document) per
 * screen. The original document (PDF.js canvas for PDFs, a sanitized-HTML iframe for
 * HTML) is the ground-truth surface, with anchored quotes pre-highlighted from
 * validation.json's offsets; the extracted-text panel is navigation only, never the
 * evidence a reviewer compares against. Keyboard-driven: Approve/Fix/Reject/Escalate.
 * Talks only to the Worker API (config.js's workerBaseUrl) -- never writes catalog
 * rows, never touches R2 directly.
 */
(function () {
  "use strict";

  const API = window.HAZINGINFO_REVIEW_CONFIG.workerBaseUrl;
  const el = (id) => document.getElementById(id);

  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  let queue = [];
  let current = null; // { item, docDir, incidentIndex, manifest, incidentsJson, validation, fileHash, extractedText, existingReview }
  let pdfDoc = null;
  let pdfPageNum = 1;

  // ---------- API ----------

  async function fetchJson(path, opts) {
    const res = await fetch(API + path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);
    return body;
  }

  // ---------- helpers ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  function boolText(b) {
    return b === true ? "yes" : b === false ? "no" : "unknown";
  }
  function getPathValue(obj, path) {
    return path.split(".").reduce((n, k) => (n == null ? null : n[k]), obj);
  }
  function setSubmitStatus(msg, kind) {
    const node = el("submit-status");
    node.textContent = msg;
    node.className = kind || "";
  }

  /** Whitespace-tolerant regex built from a verbatim quote -- used for the review
   * UI's best-effort visual highlighting only. The archive's real, authoritative
   * anchoring (whether this quote is trustworthy at all) is validate.py/lib/quotes.py
   * (and its TS port) -- this function never decides tier or acceptance, it only
   * decides where to draw a highlight box. */
  function buildQuoteRegex(quoteText) {
    const words = quoteText.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(escaped.join("\\s+"));
  }

  // ---------- queue ----------

  async function loadQueue() {
    el("loading-state").hidden = false;
    el("empty-state").hidden = true;
    el("review-screen").hidden = true;
    queue = await fetchJson("/api/queue");
    renderQueueSummary();
    if (queue.length === 0) {
      el("loading-state").hidden = true;
      el("empty-state").hidden = false;
      current = null;
      return;
    }
    await loadCurrentItem();
  }

  function renderQueueSummary() {
    const counts = queue.reduce((acc, item) => {
      acc[item.tier] = (acc[item.tier] || 0) + 1;
      return acc;
    }, {});
    el("queue-summary").textContent =
      `${queue.length} waiting — fast ${counts.fast || 0} · standard ${counts.standard || 0} · flagged ${counts.flagged || 0}`;
  }

  async function loadCurrentItem() {
    const item = queue[0];
    const idxParam = item.incidentIndex === null ? "document" : String(item.incidentIndex);
    const doc = await fetchJson(`/api/document?doc_dir=${encodeURIComponent(item.docDir)}&incident_index=${idxParam}`);
    current = { item, ...doc };
    pdfDoc = null;
    pdfPageNum = 1;
    el("loading-state").hidden = true;
    el("review-screen").hidden = false;
    await renderReviewScreen();
  }

  // ---------- review screen ----------

  async function renderReviewScreen() {
    const { item } = current;
    el("institution-name").textContent = `${item.institutionSlug} (${item.unitid}, ${item.scrapeYear})`;
    const tierBadge = el("tier-badge");
    tierBadge.textContent = item.tier;
    tierBadge.className = `badge badge-${item.tier}`;
    el("escalated-badge").hidden = item.status !== "escalated_pending";
    el("position-indicator").textContent = `${queue.length} remaining`;
    el("btn-fix").disabled = item.incidentIndex === null;

    renderFields();
    renderNavText(current.extractedText);
    hideCorrectionForm();
    setSubmitStatus("", null);
    await renderOriginal();
  }

  function currentIncident() {
    if (current.item.incidentIndex === null) return null;
    return current.incidentsJson.incidents[current.item.incidentIndex];
  }
  function currentValidationEntry() {
    if (current.item.incidentIndex === null) return current.validation.document;
    return current.validation.incidents.find((i) => i.index === current.item.incidentIndex);
  }

  function quoteFieldHtml(label, quote, anchor) {
    if (!quote || !quote.text) {
      return `<div class="field"><h3>${label}</h3><p class="quote-meta">not provided</p></div>`;
    }
    const anchorClass = anchor && anchor.anchored ? "anchor-ok" : "anchor-bad";
    const anchorLabel = anchor ? (anchor.anchored ? `anchored (${Math.round(anchor.similarity * 100)}%)` : "NOT ANCHORED") : "";
    return `<div class="field">
      <h3>${label}</h3>
      <p class="quote-text">&ldquo;${escapeHtml(quote.text)}&rdquo;</p>
      <p class="quote-meta">page ${quote.page ?? "—"} · <span class="${anchorClass}">${anchorLabel}</span></p>
    </div>`;
  }

  function renderFields() {
    const wrap = el("incident-fields");
    if (current.item.incidentIndex === null) {
      const doc = current.incidentsJson.document;
      const anchor = current.validation.document.zero_incidents_quote;
      wrap.innerHTML =
        `<h2>Zero-incident report</h2>` +
        `<p class="quote-meta">No incidents were extracted from this document. Approving confirms the zero-incidents statement is genuine and anchored.</p>` +
        quoteFieldHtml("Zero incidents statement", doc.zero_incidents_quote, anchor);
      return;
    }
    const inc = currentIncident();
    const v = currentValidationEntry();
    const sanctionsHtml = (inc.sanction_quotes || [])
      .map((s, i) => quoteFieldHtml(`Sanction ${i + 1}`, s, (v.quotes.sanction_quotes || [])[i]))
      .join("");
    wrap.innerHTML = [
      quoteFieldHtml("Organization", inc.organization_quote, v.quotes.organization_quote),
      quoteFieldHtml("Description", inc.description_quote, v.quotes.description_quote),
      quoteFieldHtml("Findings", inc.findings_quote, v.quotes.findings_quote),
      sanctionsHtml,
      quoteFieldHtml("Incident date", inc.dates.incident_quote, v.quotes.incident_quote),
      `<div class="field"><h3>Alcohol / drugs</h3><p>alcohol: ${boolText(inc.alcohol_involved)} &middot; drugs: ${boolText(inc.drugs_involved)}</p></div>`,
      `<div class="field"><h3>Dates</h3><p>start ${inc.dates.incident_start ?? "—"} &middot; end ${inc.dates.incident_end ?? "—"} &middot; investigation ${inc.dates.investigation_initiated ?? "—"} &middot; resolved ${inc.dates.resolved ?? "—"}</p></div>`,
      v.flagged_reasons && v.flagged_reasons.length
        ? `<div class="field"><h3>Flagged reasons</h3><p>${v.flagged_reasons.map(escapeHtml).join(", ")}</p></div>`
        : "",
    ].join("");
  }

  function renderNavText(text) {
    el("nav-text").textContent = text && text.length ? text : "(no extracted text -- this document has no text layer)";
  }

  // ---------- original document: PDF ----------

  function collectQuotesForPage(pageNum) {
    const quotes = [];
    if (current.item.incidentIndex === null) {
      const q = current.incidentsJson.document.zero_incidents_quote;
      if (q && q.text && (q.page == null || q.page === pageNum)) quotes.push(q);
      return quotes;
    }
    const inc = currentIncident();
    const candidates = [inc.organization_quote, inc.description_quote, inc.findings_quote, inc.dates.incident_quote].concat(
      inc.sanction_quotes || []
    );
    for (const q of candidates) {
      if (q && q.text && (q.page == null || q.page === pageNum)) quotes.push(q);
    }
    return quotes;
  }

  async function renderPdf(url) {
    el("pdf-container").hidden = false;
    el("html-container").hidden = true;
    pdfDoc = await window.pdfjsLib.getDocument(url).promise;
    el("pdf-no-text-note").hidden = current.extractedText.trim().length > 0;

    const firstQuotePage =
      current.item.incidentIndex === null
        ? current.incidentsJson.document.zero_incidents_quote?.page
        : currentIncident()?.description_quote?.page;
    pdfPageNum = Math.min(Math.max(firstQuotePage || 1, 1), pdfDoc.numPages);
    await renderPdfPage();
  }

  async function renderPdfPage() {
    const page = await pdfDoc.getPage(pdfPageNum);
    // Render at a scale chosen so the canvas's *intrinsic* pixel size already fits
    // its container -- deliberately not relying on CSS (max-width: 100%) to shrink
    // the canvas after the fact. The highlight layer's boxes are positioned in the
    // canvas's intrinsic pixel space (from PDF.js's own text-item transforms); if the
    // browser then rescales the canvas visually via CSS without rescaling the layer
    // the same way, the two drift apart and highlights land in the wrong place.
    // Keeping both at a 1:1 intrinsic-to-CSS-pixel ratio avoids that class of bug
    // entirely, rather than trying to keep two independently-scaled elements in sync.
    const containerWidth = el("pdf-canvas-wrap").clientWidth || 600;
    const unscaledWidth = page.getViewport({ scale: 1 }).width;
    const scale = Math.min(2.5, Math.max(0.5, (containerWidth - 16) / unscaledWidth));
    const viewport = page.getViewport({ scale });
    const canvas = el("pdf-canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    el("pdf-page-indicator").textContent = `page ${pdfPageNum} / ${pdfDoc.numPages}`;
    await highlightPdfPage(page, viewport);
  }

  async function highlightPdfPage(page, viewport) {
    const layer = el("pdf-highlight-layer");
    layer.innerHTML = "";
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    if (current.extractedText.trim().length === 0) return; // scanned: nothing to highlight, page image speaks for itself

    const textContent = await page.getTextContent();
    const items = textContent.items;
    let concat = "";
    const map = [];
    for (let ii = 0; ii < items.length; ii++) {
      const str = items[ii].str || "";
      for (let ci = 0; ci < str.length; ci++) {
        concat += str[ci];
        map.push([ii, ci]);
      }
      concat += " ";
      map.push([ii, str.length]);
    }

    for (const quote of collectQuotesForPage(pdfPageNum)) {
      const re = buildQuoteRegex(quote.text);
      if (!re) continue;
      const m = re.exec(concat);
      if (!m) continue;
      drawPdfHighlight(items, map, m.index, m.index + m[0].length, viewport, layer);
    }
  }

  function drawPdfHighlight(items, map, start, end, viewport, layer) {
    const itemIdxs = new Set();
    for (let i = start; i < end && i < map.length; i++) itemIdxs.add(map[i][0]);
    for (const itemIdx of itemIdxs) {
      const item = items[itemIdx];
      if (!item || !item.str) continue;
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]);
      // item.width is already in PDF user-space units (unscaled by the item's own
      // font-size transform) -- only the viewport's scale applies. Using
      // Math.hypot(tx[0], tx[1]) here double-counts the font-size scaling already
      // baked into `tx` (item.transform composed with viewport.transform), producing
      // wildly oversized boxes (thousands of px on a ~500px-wide page).
      const widthPx = item.width * viewport.scale;
      const box = document.createElement("div");
      box.className = "pdf-highlight-box";
      box.style.left = `${tx[4]}px`;
      box.style.top = `${tx[5] - fontHeight}px`;
      box.style.width = `${widthPx}px`;
      box.style.height = `${fontHeight * 1.15}px`;
      layer.appendChild(box);
    }
  }

  async function changePdfPage(delta) {
    if (!pdfDoc) return;
    const next = pdfPageNum + delta;
    if (next < 1 || next > pdfDoc.numPages) return;
    pdfPageNum = next;
    await renderPdfPage();
  }

  // ---------- original document: sanitized HTML ----------

  /** Fetched (not <iframe src=...>'d) so it can be injected via `srcdoc` -- combined
   * with `sandbox="allow-same-origin"` and no `allow-scripts`, srcdoc content takes on
   * the *parent* page's origin, which is what lets this code read/highlight
   * `iframe.contentDocument` afterward while still blocking every script the archived
   * page might contain (there is no allow-scripts token, so none run). */
  async function renderHtml(url) {
    el("pdf-container").hidden = true;
    el("html-container").hidden = false;
    const res = await fetch(url);
    const html = await res.text();
    const frame = el("html-frame");
    frame.srcdoc = html;
    await new Promise((resolve) => {
      frame.onload = resolve;
    });
    highlightHtmlFrame();
  }

  function highlightHtmlFrame() {
    const frame = el("html-frame");
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    for (const quote of collectQuotesForPage(null)) {
      highlightTextInDocument(doc, quote.text);
    }
  }

  function highlightTextInDocument(doc, quoteText) {
    const re = buildQuoteRegex(quoteText);
    if (!re) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let concat = "";
    const map = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || "";
      for (let i = 0; i < text.length; i++) {
        concat += text[i];
        map.push([nodes.length, i]);
      }
      nodes.push(node);
    }
    const m = re.exec(concat);
    if (!m) return;
    wrapRangeInMarks(nodes, map, m.index, m.index + m[0].length, doc);
  }

  function wrapRangeInMarks(nodes, map, start, end, doc) {
    let i = start;
    while (i < end) {
      const [nodeIdx] = map[i];
      let j = i;
      while (j < end && map[j][0] === nodeIdx) j++;
      const node = nodes[nodeIdx];
      const startChar = map[i][1];
      const endChar = map[j - 1][1] + 1;
      wrapTextNodeRange(node, startChar, endChar, doc);
      i = j;
    }
  }

  function wrapTextNodeRange(node, startChar, endChar, doc) {
    const parent = node.parentNode;
    if (!parent) return;
    const text = node.nodeValue;
    const before = text.slice(0, startChar);
    const match = text.slice(startChar, endChar);
    const after = text.slice(endChar);
    const mark = doc.createElement("mark");
    mark.className = "quote-highlight";
    mark.textContent = match;
    const frag = doc.createDocumentFragment();
    if (before) frag.appendChild(doc.createTextNode(before));
    frag.appendChild(mark);
    if (after) frag.appendChild(doc.createTextNode(after));
    parent.replaceChild(frag, node);
  }

  async function renderOriginal() {
    const originalUrl = `${API}/api/original?doc_dir=${encodeURIComponent(current.item.docDir)}`;
    if (current.manifest.content_type === "application/pdf") {
      await renderPdf(originalUrl);
    } else {
      await renderHtml(originalUrl);
    }
  }

  // ---------- correction / reject forms ----------

  function hideCorrectionForm() {
    el("correction-form").hidden = true;
    el("correction-form").innerHTML = "";
  }

  function showCorrectionForm() {
    const inc = currentIncident();
    if (!inc) {
      setSubmitStatus("Zero-incident reports can't be corrected -- reject instead to send back for re-extraction.", "error");
      return;
    }
    const form = el("correction-form");
    form.hidden = false;
    form.innerHTML = `
      <h3>Correct fields (only changed fields are recorded)</h3>
      <div class="correction-row">
        <div><label>Organization text</label><input data-path="organization_quote.text" value="${escapeAttr(inc.organization_quote?.text ?? "")}"></div>
        <div><label>page</label><input data-path="organization_quote.page" value="${inc.organization_quote?.page ?? ""}"></div>
      </div>
      <div class="correction-row">
        <div><label>Description text</label><input data-path="description_quote.text" value="${escapeAttr(inc.description_quote?.text ?? "")}"></div>
        <div><label>page</label><input data-path="description_quote.page" value="${inc.description_quote?.page ?? ""}"></div>
      </div>
      <div class="correction-row">
        <div><label>Findings text</label><input data-path="findings_quote.text" value="${escapeAttr(inc.findings_quote?.text ?? "")}"></div>
        <div><label>page</label><input data-path="findings_quote.page" value="${inc.findings_quote?.page ?? ""}"></div>
      </div>
      <div><label>Incident-date quote text</label><input data-path="dates.incident_quote.text" value="${escapeAttr(inc.dates.incident_quote?.text ?? "")}"></div>
      <div class="correction-row">
        <div><label>Alcohol involved</label>
          <select data-path="alcohol_involved">
            <option value="">(unchanged)</option>
            <option value="true" ${inc.alcohol_involved === true ? "selected" : ""}>yes</option>
            <option value="false" ${inc.alcohol_involved === false ? "selected" : ""}>no</option>
          </select>
        </div>
        <div><label>Drugs involved</label>
          <select data-path="drugs_involved">
            <option value="">(unchanged)</option>
            <option value="true" ${inc.drugs_involved === true ? "selected" : ""}>yes</option>
            <option value="false" ${inc.drugs_involved === false ? "selected" : ""}>no</option>
          </select>
        </div>
      </div>
      <div class="correction-row">
        <div><label>Incident start (YYYY-MM-DD)</label><input data-path="dates.incident_start" value="${inc.dates.incident_start ?? ""}"></div>
        <div><label>Incident end</label><input data-path="dates.incident_end" value="${inc.dates.incident_end ?? ""}"></div>
      </div>
      <div class="correction-row">
        <div><label>Investigation initiated</label><input data-path="dates.investigation_initiated" value="${inc.dates.investigation_initiated ?? ""}"></div>
        <div><label>Resolved</label><input data-path="dates.resolved" value="${inc.dates.resolved ?? ""}"></div>
      </div>
      <div id="correction-actions">
        <button id="correction-submit" class="btn btn-fix">Submit correction</button>
        <button id="correction-cancel" class="btn">Cancel (Esc)</button>
      </div>
    `;
    el("correction-submit").onclick = submitCorrectionForm;
    el("correction-cancel").onclick = hideCorrectionForm;
  }

  function submitCorrectionForm() {
    const inc = currentIncident();
    const corrections = {};
    el("correction-form")
      .querySelectorAll("[data-path]")
      .forEach((input) => {
        const path = input.dataset.path;
        const value = input.value;
        const original = getPathValue(inc, path);
        const originalStr = original === null || original === undefined ? "" : String(original);
        if (value !== "" && value !== originalStr) corrections[path] = value;
      });
    if (Object.keys(corrections).length === 0) {
      setSubmitStatus("No fields changed -- nothing to correct.", "error");
      return;
    }
    submitDecision("corrected", { corrections });
  }

  function showRejectForm() {
    const form = el("correction-form");
    form.hidden = false;
    form.innerHTML = `
      <h3>Reject: reason</h3>
      <select id="reject-reason">
        <option value="not_hazing">not_hazing</option>
        <option value="duplicate">duplicate</option>
        <option value="segmentation_error">segmentation_error</option>
        <option value="extraction_error" selected>extraction_error</option>
      </select>
      <div id="correction-actions">
        <button id="reject-submit" class="btn btn-reject">Confirm reject</button>
        <button id="reject-cancel" class="btn">Cancel (Esc)</button>
      </div>
    `;
    el("reject-submit").onclick = () => submitDecision("rejected", { rejection_reason: el("reject-reason").value });
    el("reject-cancel").onclick = hideCorrectionForm;
  }

  // ---------- decisions ----------

  function buildReviewPayload(decision, extra) {
    extra = extra || {};
    const now = new Date().toISOString();
    const item = current.item;
    // "reviewer" here is a placeholder -- the Worker overwrites it with the resolved
    // Cloudflare Access identity (or the DEV_MODE stub) before calling ingestReview,
    // so a review can never be filed under a spoofed name (see worker/src/index.ts).
    const decisionBlock = {
      decision,
      rejection_reason: extra.rejection_reason ?? null,
      corrections: extra.corrections ?? null,
      reviewer: "reviewer",
      reviewed_at: now,
    };

    if (current.existingReview) {
      // This item already has a first review (an unresolved escalation) -- the new
      // decision becomes its second_review, per Section 10.
      return { ...current.existingReview, second_review: decisionBlock };
    }
    return {
      schema_version: 1,
      extraction_ref: { file_hash: current.fileHash, incident_index: item.incidentIndex },
      tier: item.tier,
      second_review: null,
      ...decisionBlock,
    };
  }

  async function submitDecision(decision, extra) {
    const payload = buildReviewPayload(decision, extra);
    setSubmitStatus("Submitting…", null);
    setDecisionButtonsDisabled(true);
    try {
      await fetchJson("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_dir: current.item.docDir, review: payload }),
      });
      setSubmitStatus(`Recorded: ${decision}.`, "ok");
      await loadQueue();
    } catch (e) {
      setSubmitStatus(e.message, "error");
    } finally {
      setDecisionButtonsDisabled(false);
    }
  }

  /** btn-fix's disabled state is controlled by renderReviewScreen alone (doc-level
   * zero-incident items can't be corrected) -- deliberately not touched here, so the
   * re-render loadQueue() triggers on success doesn't get clobbered by this function
   * unconditionally re-enabling it for whatever item comes next. */
  function setDecisionButtonsDisabled(disabled) {
    ["btn-approve", "btn-reject", "btn-escalate"].forEach((id) => {
      el(id).disabled = disabled;
    });
  }

  // ---------- keyboard / chrome ----------

  function toggleHelp() {
    el("help-overlay").hidden = !el("help-overlay").hidden;
  }
  function closeHelp() {
    el("help-overlay").hidden = true;
  }

  document.addEventListener("keydown", (e) => {
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) {
      if (e.key === "Escape") {
        hideCorrectionForm();
        e.target.blur();
      }
      return;
    }
    if (e.key === "?") {
      toggleHelp();
      return;
    }
    if (e.key === "Escape") {
      hideCorrectionForm();
      closeHelp();
      return;
    }
    if (!current) return;
    switch (e.key.toLowerCase()) {
      case "a":
        submitDecision("approved");
        break;
      case "f":
        showCorrectionForm();
        break;
      case "x":
        showRejectForm();
        break;
      case "e":
        submitDecision("escalated");
        break;
      case "arrowleft":
        changePdfPage(-1);
        break;
      case "arrowright":
        changePdfPage(1);
        break;
      default:
        break;
    }
  });

  el("help-toggle").onclick = toggleHelp;
  el("help-overlay").onclick = (e) => {
    if (e.target.id === "help-overlay") closeHelp();
  };
  el("btn-approve").onclick = () => submitDecision("approved");
  el("btn-fix").onclick = showCorrectionForm;
  el("btn-reject").onclick = showRejectForm;
  el("btn-escalate").onclick = () => submitDecision("escalated");
  el("pdf-prev-page").onclick = () => changePdfPage(-1);
  el("pdf-next-page").onclick = () => changePdfPage(1);

  loadQueue().catch((e) => {
    el("loading-state").textContent = `Failed to load queue: ${e.message}`;
  });
})();
