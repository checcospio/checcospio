'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checcospio-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.PORT = '0';
process.env.SESSION_SECRET = 'unit-test-session-secret-with-more-than-32-characters';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-only-password-123';

const { app, db } = require('../server');

test('site, API, sessions and SQLite behave as expected', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /IN ARRIVO!/);
  assert.match(html, /Acquisti, carrello e pagamenti sono disattivati/);
  assert.doesNotMatch(html, /addCart|checkout/i);
  assert.match(home.headers.get('content-security-policy'), /open\.spotify\.com/);

  for (const privateFile of ['/server.js', '/schema.sql', '/.env.example']) {
    const response = await fetch(`${baseUrl}${privateFile}`);
    assert.equal(response.status, 404, `${privateFile} must not be public`);
  }
  assert.equal((await fetch(`${baseUrl}/uploads/missing-file.png`)).status, 404);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count > 0,
    true
  );

  const paymentStatus = await fetch(`${baseUrl}/api/payments/status`);
  assert.deepEqual(await paymentStatus.json(), {
    checkoutEnabled: false,
    status: 'coming_soon',
  });
  const webhook = await fetch(`${baseUrl}/api/payments/stripe-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(webhook.status, 503);
  assert.equal((await webhook.json()).checkoutEnabled, false);
  assert.equal((await fetch(`${baseUrl}/api/checkout`, { method: 'POST' })).status, 404);

  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  assert.equal(csrfResponse.status, 200);
  const csrfCookie = csrfResponse.headers.get('set-cookie').split(';')[0];
  const csrfToken = (await csrfResponse.json()).csrfToken;
  const rejectedLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: csrfCookie },
    body: JSON.stringify({ username: 'test-admin', password: 'wrong-password' }),
  });
  assert.equal(rejectedLogin.status, 403);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfCookie,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  const sessionCookie = login.headers.get('set-cookie').split(';')[0];

  const unauthorized = await fetch(`${baseUrl}/api/admin/products`);
  assert.equal(unauthorized.status, 401);
  const created = await fetch(`${baseUrl}/api/admin/products`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie,
      'x-csrf-token': loginData.csrfToken,
    },
    body: JSON.stringify({
      name: 'Test track',
      category: 'digital',
      price_cents: 199,
      published: true,
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).id > 0, true);

  const invalidProduct = await fetch(`${baseUrl}/api/admin/products`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie,
      'x-csrf-token': loginData.csrfToken,
    },
    body: JSON.stringify({
      name: 'Bad price',
      category: 'digital',
      price_cents: -1,
    }),
  });
  assert.equal(invalidProduct.status, 400);

  const publicProducts = await fetch(`${baseUrl}/api/products`);
  assert.equal(publicProducts.status, 200);
  assert.equal((await publicProducts.json()).length, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count > 0,
    true
  );
});
