import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseUrl = process.env.MANIFEST_BASE_URL;

if (!baseUrl) {
  throw new Error('MANIFEST_BASE_URL is required');
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let responseBody;

  try {
    responseBody = JSON.parse(text);
  } catch {
    assert.fail(`${path} returned non-JSON response: ${text}`);
  }

  return { status: response.status, body: responseBody, text };
}

function assertAuthenticationRequired(path, result) {
  assert.equal(
    result.status,
    401,
    `${path} returned HTTP ${result.status} instead of 401: ${result.text}`,
  );
  assert.equal(
    result.body?.error?.type,
    'auth_error',
    `${path} did not return the gateway authentication error: ${result.text}`,
  );
  assert.equal(
    typeof result.body?.error?.message,
    'string',
    `${path} did not return an authentication error message: ${result.text}`,
  );
  assert.ok(
    result.body.error.message.trim().length > 0,
    `${path} returned an empty authentication error message: ${result.text}`,
  );
}

test('GET /v1/models remains available', async () => {
  const result = await request('/v1/models');

  assertAuthenticationRequired('/v1/models', result);
});

test('POST /v1/chat/completions remains available', async () => {
  const result = await request('/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    },
  });

  assertAuthenticationRequired('/v1/chat/completions', result);
});

test('POST /v1/responses remains available', async () => {
  const result = await request('/v1/responses', {
    method: 'POST',
    body: {
      model: 'auto',
      input: 'hello',
    },
  });

  assertAuthenticationRequired('/v1/responses', result);
});

test('POST /v1/messages remains available', async () => {
  const result = await request('/v1/messages', {
    method: 'POST',
    body: {
      model: 'auto',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    },
  });

  assertAuthenticationRequired('/v1/messages', result);
});
