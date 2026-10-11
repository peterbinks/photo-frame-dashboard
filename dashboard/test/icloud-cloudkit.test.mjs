// New-format iCloud shared albums (CloudKit). All fixtures are synthetic.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCloudAlbum, cloudPhotoUrl, mapCloudRecords, urlExpiry, resolveCloudAlbum, forgetCloudSessions } from '../src/icloud.js';

const GUID = '0abCDefGhijk_LmnoPqrs-Tu';
const ZONE = { zoneName: 'SharedCollection-TEST', ownerRecordName: '_owner', zoneType: 'REGULAR_CUSTOM_ZONE' };
const PII = { name: 'Jane Example', email: 'jane@example.com' };

const resolveBody = (extra = {}) => ({
  results: [{
    zoneID: ZONE,
    share: {
      fields: { 'cloudkit.title': { value: 'Home Frame', type: 'STRING' } },
      owner: { userIdentity: { nameComponents: { givenName: 'Jane', familyName: 'Example' }, lookupInfo: { emailAddress: PII.email } } },
    },
    ownerIdentity: { nameComponents: { givenName: 'Jane', familyName: 'Example' }, lookupInfo: { emailAddress: PII.email } },
    anonymousPublicAccess: { token: 'tok-1', tokenTTL: 1200000, databasePartition: 'https://p42-ckdatabasews.icloud.com:443', resolvedPartitionNumber: 42 },
    requireAppleLogin: false,
    ...extra,
  }],
});
const master = (name, fields) => ({ recordName: name, recordType: 'CPLMaster', fields });
const asset = (name, masterName, fields = {}) => ({
  recordName: name, recordType: 'CPLAsset',
  fields: { masterRef: { value: { recordName: masterName, zoneID: ZONE }, type: 'REFERENCE' }, assetDate: { value: Date.UTC(2025, 2, 14, 7, 51), type: 'TIMESTAMP' }, isHidden: { value: 0 }, ...fields },
});
const v = (value) => ({ value });
const jpegMaster = (w, h) => ({ itemType: v('public.heic'), resJPEGMedWidth: v(w), resJPEGMedHeight: v(h) });

// Album: 5 items over 2 pages (the second page holds a master the first page's asset needs)
const PAGE1 = [
  master('M1+/a', jpegMaster(1536, 2048)), master('M2', jpegMaster(2048, 1536)), master('MV', { itemType: v('com.apple.quicktime-movie'), resJPEGMedWidth: v(720), resJPEGMedHeight: v(1280) }),
  asset('A1-0000-0000', 'M1+/a'),
  asset('A2-0000-0000', 'M2', { resJPEGMedWidth: v(1500), resJPEGMedHeight: v(1000), assetBatchId: v('BATCH') }), // edited
  asset('AV-0000-0000', 'MV'),
];
const PAGE2 = [
  master('M3', jpegMaster(1000, 800)), master('M4', { itemType: v('public.jpeg'), resOriginalWidth: v(640), resOriginalHeight: v(480) }),
  asset('A3-0000-0000', 'M3', { isHidden: v(1) }),
  asset('A4-0000-0000', 'M4'),
];

function fakeApple({ failFirstQuery = false } = {}) {
  const log = [];
  let resolves = 0, queries = 0;
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = JSON.parse(opts.body);
    log.push({ host: u.host, op: u.pathname.split('/').pop(), token: u.searchParams.get('publicAccessAuthToken'), body });
    assert.equal(opts.headers.Origin, 'https://photos.icloud.com');
    if (u.pathname.endsWith('/public/records/resolve')) {
      resolves++;
      const b = resolveBody();
      b.results[0].anonymousPublicAccess.token = 'tok-' + resolves;
      return Response.json(b);
    }
    assert.equal(u.host, 'p42-ckdatabasews.icloud.com');
    assert.equal(u.searchParams.get('remapEnums'), 'true');
    if (u.pathname.endsWith('/shared/records/query')) {
      queries++;
      if (failFirstQuery && queries === 1) return new Response('{}', { status: 401 });
      const start = body.query.filterBy.find((f) => f.fieldName === 'startRank').fieldValue.value;
      assert.ok(Array.isArray(body.desiredKeys) && body.desiredKeys.indexOf('resJPEGMedRes') < 0);
      return Response.json(start === 0 ? { records: PAGE1, continuationMarker: 'more' } : start === 3 ? { records: PAGE2 } : { records: [] });
    }
    if (u.pathname.endsWith('/shared/records/lookup')) {
      const name = body.records[0].recordName, key = body.desiredKeys[0];
      return Response.json({ records: [{ recordName: name, recordType: 'CPLMaster', fields: { [key]: { value: { downloadURL: 'https://cvws-h2.icloud-content.com/B/AbC/${f}?o=1&e=1791741043&x=2', size: 10 } } } }] });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, log, counts: () => ({ resolves, queries }) };
}

beforeEach(() => forgetCloudSessions());

test('lists every page, maps photos, skips videos/hidden, prefers edited renditions', async () => {
  const apple = fakeApple();
  const a = await fetchCloudAlbum(GUID, 1, { fetchImpl: apple.fetchImpl });
  assert.equal(a.name, 'Home Frame');
  assert.equal(a.complete, true);
  assert.deepEqual(apple.log.map((l) => l.op), ['resolve', 'query', 'query']);
  assert.deepEqual(apple.log.filter((l) => l.op === 'query').map((l) => l.body.query.filterBy[1].fieldValue.value), [0, 3]);
  assert.deepEqual(a.photos.map((p) => p.id), ['A1-0000-0000', 'A2-0000-0000', 'A4-0000-0000']);
  assert.deepEqual(a.photos[0], { id: 'A1-0000-0000', url: '/api/photo/1/A1-0000-0000', o: 'p', w: 1536, h: 2048, date: '2025-03-14T07:51:00.000Z', place: 'Home Frame', from: null, by: '', tag: 'A1-0000-0000', album: 1 });
  assert.deepEqual([a.photos[1].w, a.photos[1].h, a.photos[1].o, a.photos[1].tag], [1500, 1000, 'l', 'BATCH']);
  assert.deepEqual(a.refs, {
    'A1-0000-0000': { r: 'M1+/a', f: 'resJPEGMedRes' },
    'A2-0000-0000': { r: 'A2-0000-0000', f: 'resJPEGMedRes' },
    'A4-0000-0000': { r: 'M4', f: 'resOriginalRes' },
  });
  // The album owner's identity from the resolve response never reaches the output
  const out = JSON.stringify(a);
  assert.ok(out.indexOf(PII.email) < 0 && out.indexOf('Jane') < 0 && out.indexOf('tok-') < 0);
});

test('maxPages caps subrequests and marks the listing partial', async () => {
  const apple = fakeApple();
  const a = await fetchCloudAlbum(GUID, 0, { fetchImpl: apple.fetchImpl, maxPages: 1 });
  assert.equal(a.complete, false);
  assert.equal(apple.counts().queries, 1);
  assert.deepEqual(a.photos.map((p) => p.id), ['A1-0000-0000', 'A2-0000-0000']);
});

test('session is reused, and re-resolved when Apple rejects the token', async () => {
  const apple = fakeApple({ failFirstQuery: true });
  await fetchCloudAlbum(GUID, 0, { fetchImpl: apple.fetchImpl });
  assert.equal(apple.counts().resolves, 2);
  const queryTokens = apple.log.filter((l) => l.op === 'query').map((l) => l.token);
  assert.deepEqual(queryTokens, ['tok-1', 'tok-2', 'tok-2']);
  const { url, expires } = await cloudPhotoUrl(GUID, { r: 'M1+/a', f: 'resJPEGMedRes' }, apple.fetchImpl);
  assert.equal(apple.counts().resolves, 2); // cached session reused for the lookup
  const lookup = apple.log[apple.log.length - 1];
  assert.deepEqual(lookup.body, { records: [{ recordName: 'M1+/a' }], zoneID: ZONE, desiredKeys: ['resJPEGMedRes'] });
  assert.equal(url, 'https://cvws-h2.icloud-content.com/B/AbC/photo.jpg?o=1&e=1791741043&x=2');
  assert.equal(expires, 1791741043000);
});

test('resolve errors are readable; odd partitions are refused', async () => {
  const reply = (body) => async () => Response.json(body);
  await assert.rejects(resolveCloudAlbum(GUID, reply({ results: [{ serverErrorCode: 'NOT_FOUND', reason: 'Cannot resolve shortGUID' }] })), /not found/i);
  await assert.rejects(resolveCloudAlbum(GUID, reply({ results: [{ zoneID: ZONE, requireAppleLogin: true }] })), /Public Website/);
  const evil = resolveBody();
  evil.results[0].anonymousPublicAccess.databasePartition = 'https://attacker.example';
  await assert.rejects(resolveCloudAlbum(GUID, reply(evil)), /Unexpected/);
  const s = await resolveCloudAlbum(GUID, reply(resolveBody()));
  assert.deepEqual(Object.keys(s).sort(), ['expires', 'name', 'partition', 'token', 'zoneID']);
  assert.equal(s.partition, 'https://p42-ckdatabasews.icloud.com');
  assert.ok(s.expires > Date.now() + 15 * 60000 && s.expires < Date.now() + 20 * 60000);
});

test('URL expiry parsing and mapping of an empty album', () => {
  assert.equal(urlExpiry('https://x/B/y/photo.jpg?o=1&e=1791741043'), 1791741043000);
  assert.equal(urlExpiry('https://x/y?o=1'), null);
  assert.deepEqual(mapCloudRecords([], new Map(), 0, 'A'), { photos: [], refs: {} });
});
