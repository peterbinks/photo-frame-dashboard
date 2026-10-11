// iCloud Shared Albums (public website). Two link formats exist:
//   old  https://www.icloud.com/sharedalbum/#B1d5oqs3q2iqS4D   → "sharedstreams" API (stream)
//   new  https://photos.icloud.com/shared/album/<shortGUID> → CloudKit public share (cloudkit)
// Both are read with the same anonymous endpoints the iCloud web pages use.
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TARGET_EDGE = 1280;

/**
 * Shared-album link (either format) or bare token → { kind: 'stream' | 'cloudkit', token }, else null.
 * Bare tokens: 15-ish base62 starting with A/B = old stream; longer base64url = CloudKit share GUID.
 */
export function parseAlbumLink(input) {
  const s = String(input || '').trim();
  let m = s.match(/^https?:\/\/(?:www\.)?photos\.icloud\.com\/shared\/album\/([A-Za-z0-9_-]{16,64})\/?(?:[?#].*)?$/);
  if (m) return { kind: 'cloudkit', token: m[1] };
  m = s.match(/^https?:\/\/(?:www\.)?icloud\.com\/sharedalbum\/(?:[a-z-]+\/)?#([A-Za-z0-9]{10,})\s*$/);
  if (m) return { kind: 'stream', token: m[1] };
  if (/^[AB][A-Za-z0-9]{9,17}$/.test(s)) return { kind: 'stream', token: s };
  if (/^[A-Za-z0-9_-]{20,64}$/.test(s)) return { kind: 'cloudkit', token: s };
  return null;
}

/** Initial partition host from the token; Apple redirects (330) to the right one if it differs. */
export function initialHost(token) {
  const n = token[0] === 'A' ? B62.indexOf(token[1]) : B62.indexOf(token[1]) * 62 + B62.indexOf(token[2]);
  return 'p' + (n < 10 ? '0' + n : n) + '-sharedstreams.icloud.com';
}

async function post(host, token, path, body, fetchImpl) {
  let h = host;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetchImpl('https://' + h + '/' + token + '/sharedstreams/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    if (res.status === 330) {
      let next = res.headers.get('X-Apple-MMe-Host');
      if (!next) { try { next = (await res.json())['X-Apple-MMe-Host']; } catch { /* fall through */ } }
      if (!next || next === h) throw new Error('iCloud redirect without a host');
      h = next;
      continue;
    }
    if (res.status === 404) throw new Error('Album not found — is "Public Website" turned on for it?');
    if (!res.ok) throw new Error('iCloud HTTP ' + res.status);
    return { host: h, data: await res.json() };
  }
  throw new Error('Too many iCloud redirects');
}

/** Closest derivative with a long edge ≥ 1280px (else the biggest). Videos are skipped. */
export function pickDerivative(photo) {
  if (photo.mediaAssetType === 'video') return null;
  let best = null, bestEdge = 0, biggest = null, biggestEdge = 0;
  for (const key of Object.keys(photo.derivatives || {})) {
    const d = photo.derivatives[key];
    if (!d || !d.checksum || (d.state && d.state !== 'available')) continue;
    const edge = Math.max(+d.width || 0, +d.height || 0) || +key || 0;
    if (edge > biggestEdge) { biggest = d; biggestEdge = edge; }
    if (edge >= TARGET_EDGE && (!best || edge < bestEdge)) { best = d; bestEdge = edge; }
  }
  return best || biggest;
}

/**
 * Album listing → { name, host, photos: [view shape], checksums: {guid: checksum} }.
 * albumId goes into each photo's /api/photo/<albumId>/<guid> URL.
 * members: [{id, name}] used to attribute contributors to a family member. Photo dates stay ISO
 * timestamps: the frame turns them into local dates (no timezone math in the Worker).
 */
export async function fetchAlbum(token, albumId, { members, fetchImpl = fetch }) {
  const { host, data } = await post(initialHost(token), token, 'webstream', { streamCtag: null }, fetchImpl);
  const byName = new Map();
  for (const m of members || []) byName.set(String(m.name).toLowerCase(), m.id);
  const photos = [];
  const checksums = {};
  for (const p of data.photos || []) {
    const d = pickDerivative(p);
    if (!d || !p.photoGuid) continue;
    const w = +d.width || +p.width || 0, h = +d.height || +p.height || 0;
    const first = String(p.contributorFirstName || '').trim();
    const when = p.dateCreated || p.batchDateCreated || '';
    checksums[p.photoGuid] = d.checksum;
    photos.push({
      id: p.photoGuid,
      url: '/api/photo/' + albumId + '/' + p.photoGuid,
      o: h > w ? 'p' : 'l',
      w, h,
      date: when,
      place: String(p.caption || '').trim() || String(data.streamName || '').trim() || 'Shared album',
      from: byName.get(first.toLowerCase()) || byName.get(first.split(/\s+/)[0].toLowerCase()) || null,
      by: first,
      tag: p.batchGuid || p.photoGuid,
      album: albumId,
    });
  }
  return { name: data.streamName || 'Shared album', host, photos, checksums };
}

/** Fresh (short-lived) CDN URLs for the given photo guids → {checksum: url}. */
export async function fetchAssetUrls(host, token, guids, fetchImpl = fetch) {
  const { data } = await post(host, token, 'webasseturls', { photoGuids: guids }, fetchImpl);
  const out = {};
  for (const [checksum, it] of Object.entries(data.items || {})) {
    if (it && it.url_location && it.url_path) out[checksum] = 'https://' + it.url_location + it.url_path;
  }
  return out;
}

// ------------------------------------------------------------------ new links (CloudKit)
// resolve (no auth) → anonymous token + database partition + zone → query the album's
// CPLAssetAndMasterByAddedDate index page by page → per photo, a lookup gives a short-lived
// pre-signed JPEG URL. The resolve response also names the album owner (name + email): only the
// fields below are ever read from it, nothing else is kept, logged or returned.
const CK_RESOLVE = 'https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve';
const CK_SHARED = '/database/1/com.apple.photos.cloud/production/shared/records/';
const CK_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://photos.icloud.com' };
const PAGE_RECORDS = 200; // records per query page; each photo is 2 records (CPLMaster + CPLAsset)
// Only the fields the dashboard needs: keeps a page small (CPU on the Worker). No download URLs
// here; /api/photo looks each one up when it is first shown.
const LIST_KEYS = ['itemType', 'masterRef', 'assetDate', 'addedDate', 'assetBatchId', 'isHidden', 'resJPEGMedWidth', 'resJPEGMedHeight', 'resOriginalWidth', 'resOriginalHeight'];
const sessions = new Map(); // share GUID → { zoneID, partition, token, expires, name }

function ckError(message, extra) { return Object.assign(new Error(message), extra || {}); }

/** Resolve a share GUID → session. Throws a readable error for missing / private albums. */
export async function resolveCloudAlbum(guid, fetchImpl = fetch) {
  const res = await fetchImpl(CK_RESOLVE + '?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=' + encodeURIComponent(guid), {
    method: 'POST', headers: CK_HEADERS, body: JSON.stringify({ shortGUIDs: [{ value: guid }] }),
  });
  if (!res.ok) throw ckError('iCloud HTTP ' + res.status);
  const r = ((await res.json()).results || [])[0] || {};
  if (r.serverErrorCode === 'NOT_FOUND') throw ckError('Album not found — check the link (is it still shared?)');
  const a = r.anonymousPublicAccess;
  if (r.requireAppleLogin || !a || !a.token) throw ckError('This album isn’t public — turn on "Public Website" in the album’s sharing options');
  if (r.serverErrorCode) throw ckError('iCloud error: ' + r.serverErrorCode);
  const partition = String(a.databasePartition || '').replace(/:443$/, '').replace(/\/+$/, '');
  if (!/^https:\/\/p\d+-ckdatabasews\.icloud\.com$/.test(partition) || !r.zoneID || !r.zoneID.zoneName) throw ckError('Unexpected iCloud response');
  const ttl = +a.tokenTTL > 0 ? +a.tokenTTL : 600000;
  const title = r.share && r.share.fields && r.share.fields['cloudkit.title'];
  return {
    zoneID: { zoneName: r.zoneID.zoneName, ownerRecordName: r.zoneID.ownerRecordName, zoneType: r.zoneID.zoneType },
    partition, token: a.token,
    expires: Date.now() + Math.max(30000, ttl - 120000), // renew 2 min before Apple's TTL
    name: (title && String(title.value || '').trim()) || 'Shared album',
  };
}

async function cloudSession(guid, fetchImpl, force) {
  const s = sessions.get(guid);
  if (!force && s && s.expires > Date.now()) return s;
  const fresh = await resolveCloudAlbum(guid, fetchImpl);
  sessions.set(guid, fresh);
  return fresh;
}
/** Drop cached sessions (tests). */
export function forgetCloudSessions() { sessions.clear(); }

async function ckPost(s, guid, op, body, fetchImpl) {
  const url = s.partition + CK_SHARED + op + '?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=' + encodeURIComponent(guid) +
    '&publicAccessAuthToken=' + encodeURIComponent(s.token);
  const res = await fetchImpl(url, { method: 'POST', headers: CK_HEADERS, body: JSON.stringify(body) });
  if (res.status === 401 || res.status === 403 || res.status === 421) throw ckError('iCloud token rejected', { auth: true });
  if (!res.ok) throw ckError('iCloud HTTP ' + res.status);
  return res.json();
}
// Run with a session; on an auth failure re-resolve once (tokens live ~20 min).
async function withSession(guid, fetchImpl, fn) {
  try { return await fn(await cloudSession(guid, fetchImpl, false)); } catch (e) {
    if (!e.auth) throw e;
    return fn(await cloudSession(guid, fetchImpl, true));
  }
}

function listBody(zoneID, start) {
  return {
    query: {
      recordType: 'CPLAssetAndMasterByAddedDate',
      filterBy: [
        { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { value: 'ASCENDING', type: 'STRING' } },
        { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { value: start, type: 'INT64' } },
      ],
    },
    zoneID, resultsLimit: PAGE_RECORDS, desiredKeys: LIST_KEYS,
  };
}

const val = (f, k) => (f && f[k] ? f[k].value : undefined);
function isVideo(itemType) { return /movie|video|mpeg|avi|m4v/i.test(String(itemType || '')); }

/**
 * CPLAsset + CPLMaster records → photos in the view shape, plus refs[id] = { r: recordName, f: field }
 * telling /api/photo which record/rendition to look up. Prefers the asset's own (edited) medium
 * JPEG, else the master's; skips videos and hidden photos.
 */
export function mapCloudRecords(assets, masters, albumId, albumName) {
  const photos = [], refs = {};
  for (const rec of assets) {
    const f = rec.fields || {};
    if (val(f, 'isHidden')) continue;
    const masterName = val(f, 'masterRef') && val(f, 'masterRef').recordName;
    const m = masters.get(masterName);
    if (!m || isVideo(val(m, 'itemType'))) continue;
    let ref, w, h;
    if (val(f, 'resJPEGMedWidth')) { ref = { r: rec.recordName, f: 'resJPEGMedRes' }; w = val(f, 'resJPEGMedWidth'); h = val(f, 'resJPEGMedHeight'); }
    else if (val(m, 'resJPEGMedWidth')) { ref = { r: masterName, f: 'resJPEGMedRes' }; w = val(m, 'resJPEGMedWidth'); h = val(m, 'resJPEGMedHeight'); }
    else if (/jpeg|png/i.test(String(val(m, 'itemType')))) { ref = { r: masterName, f: 'resOriginalRes' }; w = val(m, 'resOriginalWidth'); h = val(m, 'resOriginalHeight'); }
    else continue;
    const when = +val(f, 'assetDate') || +val(f, 'addedDate');
    refs[rec.recordName] = ref;
    photos.push({
      id: rec.recordName,
      url: '/api/photo/' + albumId + '/' + encodeURIComponent(rec.recordName),
      o: +h > +w ? 'p' : 'l',
      w: +w || 0, h: +h || 0,
      date: when ? new Date(when).toISOString() : '',
      place: albumName,
      from: null, by: '',
      tag: val(f, 'assetBatchId') || rec.recordName,
      album: albumId,
    });
  }
  return { photos, refs };
}

/**
 * New-format album → { name, photos, refs, complete }. maxPages bounds the subrequests one call
 * may make (Workers free plan: 50 per request); complete is false if the album was cut short.
 */
export async function fetchCloudAlbum(guid, albumId, { fetchImpl = fetch, maxPages = 40 } = {}) {
  return withSession(guid, fetchImpl, async (s) => {
    const masters = new Map(), assets = [];
    let start = 0, complete = false;
    for (let page = 0; page < maxPages; page++) {
      const d = await ckPost(s, guid, 'query', listBody(s.zoneID, start), fetchImpl);
      let n = 0;
      for (const rec of d.records || []) {
        if (rec.deleted || rec.serverErrorCode) continue;
        if (rec.recordType === 'CPLMaster') masters.set(rec.recordName, rec.fields || {});
        else if (rec.recordType === 'CPLAsset') { assets.push(rec); n++; }
      }
      if (!n || !d.continuationMarker) { complete = true; break; }
      start += n;
    }
    const { photos, refs } = mapCloudRecords(assets, masters, albumId, s.name);
    return { name: s.name, photos, refs, complete };
  });
}

/** Unix expiry (`e=` seconds) of a pre-signed iCloud URL, in ms; null if absent. */
export function urlExpiry(url) {
  const m = String(url).match(/[?&]e=(\d{9,11})(?:&|$)/);
  return m ? +m[1] * 1000 : null;
}

/** Fresh download URL for one photo (ref from mapCloudRecords) → { url, expires }. */
export async function cloudPhotoUrl(guid, ref, fetchImpl = fetch) {
  return withSession(guid, fetchImpl, async (s) => {
    const d = await ckPost(s, guid, 'lookup', { records: [{ recordName: ref.r }], zoneID: s.zoneID, desiredKeys: [ref.f] }, fetchImpl);
    const rec = (d.records || [])[0];
    const asset = rec && !rec.serverErrorCode && val(rec.fields, ref.f);
    if (!asset || !asset.downloadURL) throw ckError('Photo not found in the album');
    const url = asset.downloadURL.split('${f}').join('photo.jpg');
    return { url, expires: urlExpiry(url) || Date.now() + 10 * 60000 };
  });
}
