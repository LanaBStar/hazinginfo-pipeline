// jobs/05-review/app/pages/config.js -- the only file that needs editing between
// environments (local dev vs. a real deploy). Pages and the Worker are two separate
// Cloudflare projects with different origins, so the UI needs to know where to send
// API calls.
window.HAZINGINFO_REVIEW_CONFIG = {
  // Local dev default: `wrangler dev` (jobs/05-review/app/worker) on 8787.
  // Real deploy: point this at the deployed Worker's route/subdomain.
  workerBaseUrl: "http://localhost:8787",
};
