/**
 * Reviewer identity, resolved from the Access JWT. Once this Worker's route is behind
 * a Cloudflare Access application (not done this phase -- deploy is local/test-only,
 * confirmed with the user), Access verifies the request at the edge before it ever
 * reaches this Worker and forwards the verified identity in the
 * `Cf-Access-Jwt-Assertion` header. We only
 * decode that header's payload (base64url) to read the `email` claim -- we do NOT
 * verify its signature ourselves, because the whole point of Access is that it already
 * did, and a Worker re-implementing JWKS verification is exactly the kind of
 * hand-rolled auth code this project should avoid.
 *
 * IMPORTANT: decoding without verifying is only safe when Access is actually in front
 * of this Worker's route. Until a real deploy adds that Access application (a
 * dashboard/Zero Trust configuration step, not something in this repo), this header
 * cannot be trusted from an arbitrary caller -- that's exactly why DEV_MODE exists and
 * must never be "true" outside local dev / the smoke check.
 */

export interface ReviewerIdentity {
  reviewer: string;
  devMode: boolean;
}

interface AccessEnv {
  DEV_MODE?: string;
  DEV_REVIEWER?: string;
}

function decodeAccessEmail(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { email?: string };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export class NoReviewerIdentityError extends Error {}

export function resolveReviewer(request: Request, env: AccessEnv): ReviewerIdentity {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const email = decodeAccessEmail(jwt);
    if (email) return { reviewer: email, devMode: false };
  }
  if (env.DEV_MODE === "true") {
    return { reviewer: env.DEV_REVIEWER || "dev-reviewer", devMode: true };
  }
  throw new NoReviewerIdentityError(
    "no Cloudflare Access identity on this request, and DEV_MODE is not enabled -- " +
      "this route must sit behind Cloudflare Access before a real deploy"
  );
}
