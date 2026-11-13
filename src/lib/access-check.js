'use strict';
// True only when the address answers with a redirect to a Cloudflare Access login.
// Used before anything that carries workbook text is uploaded or pushed.
async function guarded(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'SchoolInfoSheetDeploy/1.0' } });
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com/i.test(loc)) return { ok: true, seen: `login redirect (${res.status})` };
    return { ok: false, seen: `HTTP ${res.status}${loc ? ' to ' + loc.slice(0, 80) : ''}` };
  } catch (e) {
    return { ok: false, seen: 'no answer (' + (e.cause && e.cause.code || e.message) + ')' };
  }
}

module.exports = { guarded };
