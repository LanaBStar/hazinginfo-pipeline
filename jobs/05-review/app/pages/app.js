/**
 * app.js -- jobs/05-review/app/pages: the review app's static UI (Section 11).
 *
 * One incident (or, for a zero-incident report, the whole document) per screen. The
 * original document (PDF.js canvas for PDFs, a sanitized-HTML iframe for HTML) is the
 * ground-truth surface; raw fields are best-effort highlighted by direct text search
 * (there is no page-anchored quote/offset in v3.0 -- every raw field is captured
 * verbatim by the AI but carries no position hint, so this is cosmetic only, never the
 * evidence a reviewer relies on). The extracted-text panel is navigation only.
 * Keyboard-driven: Approve/Fix/Reject. Talks only to the Worker API (config.js's
 * workerBaseUrl) -- never writes catalog rows, never touches R2 directly.
 */
(function () {
  "use strict";

  const API = window.HAZINGINFO_REVIEW_CONFIG.workerBaseUrl;
  const el = (id) => document.getElementById(id);

  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const TEXT_FIELDS = [
    ["organization_name_raw", "Organization name (raw)"],
    ["organization_name_normalized", "Organization name (normalized)"],
    ["description_raw", "Description"],
    ["findings_raw", "Findings"],
    ["sanctions_raw", "Sanctions"],
  ];
  const ENUM_FIELDS = [
    ["alcohol_involved", "Alcohol involved", ["Yes", "No", "Not specified"]],
    ["drugs_involved", "Drugs involved", ["Yes", "No", "Not specified"]],
    ["determination_status", "Determination status", ["Pending", "Determined hazing", "Dismissed", "Not specified"]],
  ];
  const DATE_PRECISIONS = ["Year", "Day", "Academic year", "Academic term", "Month", "Unknown"];
  const DATE_TRIPLES = [
    ["Incident start", "dates.incident_start_raw", "dates.incident_start_normalized", "dates.incident_start_precision"],
    ["Incident end", "dates.incident_end_raw", "dates.incident_end_normalized", "dates.incident_end_precision"],
  ];
  const DATE_PAIRS = [
    ["Investigation start", "dates.investigation_start_date_raw", "dates.investigation_start_date"],
    ["Investigation end", "dates.investigation_end_date_raw", "dates.investigation_end_date"],
    ["Notice date", "dates.notice_date_raw", "dates.notice_date"],
  ];
  const ORGANIZATION_TYPES = [
    "Fraternity",
    "Sorority",
    "Institution Athletic Team",
    "Club Sport",
    "Honor/Leadership Society",
    "Academic/Professional Club",
    "Performing/Spirit Group",
    "Military/Cadet Organization",
    "General Interest/Social Club",
    "Religious/Faith-Based Organization",
    "Orientation/Mentorship Program",
    "Unrecognized Organization",
  ];

  let queue = [];
  let current = null; // { item, manifest, incidentsJson, validation, fileHash, extractedText, existingReview }
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
  function getPathValue(obj, path) {
    return path.split(".").reduce((n, k) => (n == null ? null : n[k]), obj);
  }
  function setSubmitStatus(msg, kind) {
    const node = el("submit-status");
    node.textContent = msg;
    node.className = kind || "";
  }
  function confidenceClass(c) {
    if (c === null) return "";
    if (c >= 0.75) return "confidence-high";
    if (c >= 0.4) return "confidence-mid";
    return "confidence-low";
  }

  /** Whitespace-tolerant regex built from a raw text field -- used for the review UI's
   * best-effort visual highlighting only. There is no authoritative anchoring in v3.0
   * (that machinery was retired along with the old tier system): this function only
   * ever decides where to draw a cosmetic highlight box, never whether a field is
   * trustworthy. */
  function buildTextRegex(text) {
    if (!text) return null;
    const words = text.trim().split(/\s+/).filter(Boolean);
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
    el("queue-summary").textContent = `${queue.length} waiting for review`;
    if (queue.length === 0) {
      el("loading-state").hidden = true;
      el("empty-state").hidden = false;
      current = null;
      return;
    }
    await loadCurrentItem();
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
    const confBadge = el("confidence-badge");
    if (item.extractionConfidence === null) {
      confBadge.hidden = true;
    } else {
      confBadge.hidden = false;
      confBadge.textContent = `confidence ${Math.round(item.extractionConfidence * 100)}%`;
      confBadge.className = `badge ${confidenceClass(item.extractionConfidence)}`;
    }
    el("position-indicator").textContent = `${queue.length} remaining`;
    el("btn-fix").disabled = item.incidentIndex === null;
    el("org-review-panel").hidden = item.incidentIndex === null;
    resetOrgReviewPanel();

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

  function fieldHtml(label, value) {
    return `<div class="field"><h3>${label}</h3><p>${value === null || value === "" ? "<span class=\"muted\">not provided</span>" : escapeHtml(value)}</p></div>`;
  }

  function renderFields() {
    const wrap = el("incident-fields");
    if (current.item.incidentIndex === null) {
      const doc = current.incidentsJson.document;
      wrap.innerHTML =
        `<h2>Zero-incident report</h2>` +
        `<p class="quote-meta">No incidents were extracted from this document. Approving confirms the zero-incidents statement is genuine.</p>` +
        fieldHtml("Zero incidents statement", doc.zero_incidents_statement);
      return;
    }
    const inc = currentIncident();
    const rows = [];
    rows.push(fieldHtml("Organization type", inc.organization_type));
    for (const [path, label] of TEXT_FIELDS) rows.push(fieldHtml(label, getPathValue(inc, path)));
    for (const [path, label] of ENUM_FIELDS) rows.push(fieldHtml(label, getPathValue(inc, path)));
    for (const [label, rawPath, normPath, precPath] of DATE_TRIPLES) {
      rows.push(
        `<div class="field"><h3>${label}</h3><p>${escapeHtml(getPathValue(inc, rawPath) || "—")} ` +
          `&middot; normalized ${escapeHtml(getPathValue(inc, normPath) ?? "—")} ` +
          `&middot; precision ${escapeHtml(getPathValue(inc, precPath))}</p></div>`
      );
    }
    for (const [label, rawPath, normPath] of DATE_PAIRS) {
      rows.push(
        `<div class="field"><h3>${label}</h3><p>${escapeHtml(getPathValue(inc, rawPath) || "—")} ` +
          `&middot; normalized ${escapeHtml(getPathValue(inc, normPath) ?? "—")}</p></div>`
      );
    }
    if (inc.flags && inc.flags.length) {
      rows.push(
        `<div class="field field-flags"><h3>Flags</h3><ul>${inc.flags
          .map((f) => `<li><strong>${escapeHtml(f.flag_type)}</strong> (${escapeHtml(f.field_name)})${f.note ? `: ${escapeHtml(f.note)}` : ""}</li>`)
          .join("")}</ul></div>`
      );
    }
    wrap.innerHTML = rows.join("");
  }

  function renderNavText(text) {
    el("nav-text").textContent = text && text.length ? text : "(no extracted text -- this document has no text layer)";
  }

  // ---------- raw-text fields eligible for highlighting ----------

  function collectRawTextsForHighlight() {
    if (current.item.incidentIndex === null) {
      const stmt = current.incidentsJson.document.zero_incidents_statement;
      return stmt ? [stmt] : [];
    }
    const inc = currentIncident();
    return [inc.description_raw, inc.findings_raw, inc.sanctions_raw].filter(Boolean);
  }

  // ---------- original document: PDF ----------

  async function renderPdf(url) {
    el("pdf-container").hidden = false;
    el("html-container").hidden = true;
    pdfDoc = await window.pdfjsLib.getDocument(url).promise;
    el("pdf-no-text-note").hidden = current.extractedText.trim().length > 0;
    pdfPageNum = 1;
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

    for (const text of collectRawTextsForHighlight()) {
      const re = buildTextRegex(text);
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
    for (const text of collectRawTextsForHighlight()) {
      highlightTextInDocument(doc, text);
    }
  }

  function highlightTextInDocument(doc, text) {
    const re = buildTextRegex(text);
    if (!re) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let concat = "";
    const map = [];
    let node;
    while ((node = walker.nextNode())) {
      const nodeText = node.nodeValue || "";
      for (let i = 0; i < nodeText.length; i++) {
        concat += nodeText[i];
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

  // ---------- organization review panel ----------

  function initOrgReviewTypeOptions() {
    const select = el("org-review-type");
    select.innerHTML =
      `<option value="">(no change)</option>` +
      ORGANIZATION_TYPES.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("");
  }

  function resetOrgReviewPanel() {
    el("org-review-decision").value = "approved";
    el("org-review-type").value = "";
    el("org-review-type").disabled = true;
  }

  function currentOrganizationReview() {
    if (current.item.incidentIndex === null) return null;
    const decision = el("org-review-decision").value;
    return {
      decision,
      corrected_organization_type: decision === "corrected" ? el("org-review-type").value || null : null,
    };
  }

  el("org-review-decision").onchange = () => {
    el("org-review-type").disabled = el("org-review-decision").value !== "corrected";
  };

  // ---------- correction / reject forms ----------

  function hideCorrectionForm() {
    el("correction-form").hidden = true;
    el("correction-form").innerHTML = "";
  }

  function textInputRow(path, label, value) {
    return `<div><label>${label}</label><input data-path="${path}" value="${escapeAttr(value ?? "")}"></div>`;
  }
  function textAreaRow(path, label, value) {
    return `<div><label>${label}</label><textarea data-path="${path}" rows="2">${escapeHtml(value ?? "")}</textarea></div>`;
  }
  function selectRow(path, label, options, value) {
    const opts = options
      .map((o) => `<option value="${escapeAttr(o)}" ${o === value ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("");
    return `<div><label>${label}</label><select data-path="${path}"><option value="">(unchanged)</option>${opts}</select></div>`;
  }

  function showCorrectionForm() {
    const inc = currentIncident();
    if (!inc) {
      setSubmitStatus("Zero-incident reports can't be corrected -- reject instead to send back for re-extraction.", "error");
      return;
    }
    const form = el("correction-form");
    form.hidden = false;
    const rows = [];
    rows.push(textInputRow("organization_name_raw", "Organization name (raw)", inc.organization_name_raw));
    rows.push(textInputRow("organization_name_normalized", "Organization name (normalized)", inc.organization_name_normalized));
    rows.push(textAreaRow("description_raw", "Description", inc.description_raw));
    rows.push(textAreaRow("findings_raw", "Findings", inc.findings_raw));
    rows.push(textAreaRow("sanctions_raw", "Sanctions", inc.sanctions_raw));
    for (const [path, label, options] of ENUM_FIELDS) {
      rows.push(selectRow(path, label, options, getPathValue(inc, path)));
    }
    for (const [label, rawPath, normPath, precPath] of DATE_TRIPLES) {
      rows.push(
        `<div class="correction-row">` +
          textInputRow(rawPath, `${label} (raw)`, getPathValue(inc, rawPath)) +
          textInputRow(normPath, `${label} (normalized, YYYY-MM-DD)`, getPathValue(inc, normPath)) +
          `</div>` +
          selectRow(precPath, `${label} precision`, DATE_PRECISIONS, getPathValue(inc, precPath))
      );
    }
    for (const [label, rawPath, normPath] of DATE_PAIRS) {
      rows.push(
        `<div class="correction-row">` +
          textInputRow(rawPath, `${label} (raw)`, getPathValue(inc, rawPath)) +
          textInputRow(normPath, `${label} (normalized, YYYY-MM-DD)`, getPathValue(inc, normPath)) +
          `</div>`
      );
    }
    form.innerHTML =
      `<h3>Correct fields (only changed fields are recorded)</h3>` +
      rows.join("") +
      `<div><label>Correction type (applies to every changed field above)</label>
        <select id="correction-type-select">
          <option value="Extraction error">Extraction error</option>
          <option value="Minor cleanup">Minor cleanup</option>
        </select>
      </div>
      <div id="correction-actions">
        <button id="correction-submit" class="btn btn-fix">Submit correction</button>
        <button id="correction-cancel" class="btn">Cancel (Esc)</button>
      </div>`;
    el("correction-submit").onclick = submitCorrectionForm;
    el("correction-cancel").onclick = hideCorrectionForm;
  }

  function submitCorrectionForm() {
    const inc = currentIncident();
    const correctionType = el("correction-type-select").value;
    const corrections = [];
    el("correction-form")
      .querySelectorAll("[data-path]")
      .forEach((input) => {
        const path = input.dataset.path;
        const value = input.value;
        const original = getPathValue(inc, path);
        const originalStr = original === null || original === undefined ? "" : String(original);
        if (value !== "" && value !== originalStr) {
          corrections.push({
            field_name: path,
            original_value: original === null || original === undefined ? null : String(original),
            corrected_value: value,
            correction_type: [correctionType],
          });
        }
      });
    if (corrections.length === 0) {
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
    const item = current.item;
    // "reviewer" here is a placeholder -- the Worker overwrites it with the resolved
    // Cloudflare Access identity (or the DEV_MODE stub) before calling ingestReview(),
    // so a review can never be filed under a spoofed name (see worker/src/index.ts).
    return {
      schema_version: 2,
      extraction_ref: { file_hash: current.fileHash, incident_index: item.incidentIndex },
      decision,
      rejection_reason: extra.rejection_reason ?? null,
      corrections: extra.corrections ?? [],
      organization_review: currentOrganizationReview(),
      reviewer: "reviewer",
      reviewed_at: new Date().toISOString(),
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
    ["btn-approve", "btn-reject"].forEach((id) => {
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
  el("pdf-prev-page").onclick = () => changePdfPage(-1);
  el("pdf-next-page").onclick = () => changePdfPage(1);

  initOrgReviewTypeOptions();
  loadQueue().catch((e) => {
    el("loading-state").textContent = `Failed to load queue: ${e.message}`;
  });
})();
