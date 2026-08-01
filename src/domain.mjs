/**
 * Domain normalisation and matching.
 *
 * Rank tracking lives or dies on "is this result mine?", so the rules here are
 * deliberately explicit rather than a loose `includes()` check:
 *   - "example.com" must NOT match "notexample.com" or "example.com.evil.net"
 *   - "example.com" SHOULD match "www.example.com" (www is cosmetic)
 *   - subdomains (blog.example.com) match only when the project opts in
 */

/** Strip scheme, path, port, and a leading `www.` from whatever the user typed. */
export function normalizeDomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split('/')[0].split('?')[0].split('#')[0]; // path/query/fragment
  s = s.split('@').pop(); // userinfo
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/\.$/, ''); // fully-qualified trailing dot
  s = s.replace(/^www\./, '');
  return s;
}

/** Hostname of a result URL, normalised the same way as a project domain. */
export function hostnameOf(url) {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}

/**
 * Does `url` belong to `domain`?
 * @param {string} url            result URL from the SERP
 * @param {string} domain         project domain (any format)
 * @param {boolean} matchSubdomains  also count blog.example.com as a match
 */
export function urlMatchesDomain(url, domain, matchSubdomains = true) {
  const host = hostnameOf(url);
  const target = normalizeDomain(domain);
  if (!host || !target) return false;
  if (host === target) return true;
  if (matchSubdomains && host.endsWith('.' + target)) return true;
  return false;
}

/** True when the string looks like a plausible registrable domain. */
export function isValidDomain(input) {
  const d = normalizeDomain(input);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) && d.length <= 253;
}
