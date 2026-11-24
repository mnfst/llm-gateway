import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TEST_API_KEY } from './helpers';

describe('Custom Providers (e2e)', () => {
  let app: INestApplication;
  const agentName = 'test-agent';
  const headers = { 'x-api-key': TEST_API_KEY };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  let createdId: string;

  it('GET /custom-providers returns empty array initially', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('POST /custom-providers creates a custom provider', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Groq',
        base_url: 'https://api.groq.com/openai/v1',
        apiKey: 'gsk_test_key_12345',
        models: [
          {
            model_name: 'llama-3.1-70b',
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
          {
            model_name: 'llama-3.1-8b',
          },
        ],
      })
      .expect(201);

    expect(res.body.name).toBe('Groq');
    expect(res.body.base_url).toBe('https://api.groq.com/openai/v1');
    expect(res.body.has_api_key).toBe(true);
    expect(res.body.models).toHaveLength(2);
    expect(res.body.id).toBeDefined();
    createdId = res.body.id;
  });

  it('GET /custom-providers lists the created provider', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Groq');
  });

  it('GET /available-models includes custom provider models', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const customModels = res.body.filter((m: { provider: string }) =>
      m.provider.startsWith('custom:'),
    );
    expect(customModels.length).toBe(2);

    const llama70b = customModels.find(
      (m: { display_name?: string }) => m.display_name === 'llama-3.1-70b',
    );
    expect(llama70b).toBeDefined();
    expect(llama70b.provider_display_name).toBe('Groq');
  });

  it('PUT /custom-providers/:id updates name and base_url', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/routing/${agentName}/custom-providers/${createdId}`)
      .set(headers)
      .send({
        name: 'Groq Updated',
        base_url: 'https://api.groq.com/openai/v2',
      })
      .expect(200);

    expect(res.body.name).toBe('Groq Updated');
    expect(res.body.base_url).toBe('https://api.groq.com/openai/v2');
    expect(res.body.id).toBe(createdId);
    expect(res.body.models).toHaveLength(2);
  });

  it('PUT /custom-providers/:id updates models', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/routing/${agentName}/custom-providers/${createdId}`)
      .set(headers)
      .send({
        models: [
          { model_name: 'new-model', input_price_per_million_tokens: 1.0 },
        ],
      })
      .expect(200);

    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0].model_name).toBe('new-model');
  });

  it('PUT /custom-providers/:id returns 404 for unknown id', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/routing/${agentName}/custom-providers/nonexistent-id`)
      .set(headers)
      .send({ name: 'X' })
      .expect(404);
  });

  it('PUT /custom-providers/:id rejects duplicate name', async () => {
    // Create a second provider
    const res2 = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Other Provider',
        base_url: 'https://api.example.com/v1',
        models: [{ model_name: 'model-x' }],
      })
      .expect(201);

    // Try to rename it to the same name as the first provider
    await request(app.getHttpServer())
      .put(`/api/v1/routing/${agentName}/custom-providers/${res2.body.id}`)
      .set(headers)
      .send({ name: 'Groq Updated' })
      .expect(409);

    // Cleanup the second provider
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${res2.body.id}`)
      .set(headers)
      .expect(200);
  });

  it('GET /available-models reflects updated custom models', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const customModels = res.body.filter((m: { provider: string }) =>
      m.provider.startsWith('custom:'),
    );
    expect(customModels.length).toBe(1);
    expect(customModels[0].display_name).toBe('new-model');
  });

  // Restore original models for subsequent tests
  it('PUT /custom-providers/:id restores original models', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/routing/${agentName}/custom-providers/${createdId}`)
      .set(headers)
      .send({
        name: 'Groq',
        base_url: 'https://api.groq.com/openai/v1',
        models: [
          {
            model_name: 'llama-3.1-70b',
            input_price_per_million_tokens: 0.59,
            output_price_per_million_tokens: 0.79,
          },
          { model_name: 'llama-3.1-8b' },
        ],
      })
      .expect(200);
  });

  it('POST /custom-providers rejects duplicate name', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Groq',
        base_url: 'https://api.example.com/v1',
        models: [{ model_name: 'test' }],
      })
      .expect(409);
  });

  it('POST /custom-providers validates input', async () => {
    // Missing name
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        base_url: 'https://api.example.com/v1',
        models: [{ model_name: 'test' }],
      })
      .expect(400);

    // Empty models
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Test',
        base_url: 'https://api.example.com/v1',
        models: [],
      })
      .expect(400);
  });

  it('DELETE /custom-providers/:id removes the provider', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${createdId}`)
      .set(headers)
      .expect(200);

    // Verify it's gone
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .expect(200);

    expect(res.body).toHaveLength(0);
  });

  it('GET /available-models no longer includes custom models after delete', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const customModels = res.body.filter((m: { provider: string }) =>
      m.provider.startsWith('custom:'),
    );
    expect(customModels.length).toBe(0);
  });

  it('DELETE /custom-providers/:id returns 404 for unknown id', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/nonexistent-id`)
      .set(headers)
      .expect(404);
  });

  it('POST /custom-providers persists api_kind="anthropic" when requested', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Azure Claude',
        base_url: 'https://my-azure.openai.azure.com',
        api_kind: 'anthropic',
        apiKey: 'sk-ant-test',
        models: [{ model_name: 'claude-sonnet-4-5' }],
      })
      .expect(201);

    expect(res.body.api_kind).toBe('anthropic');

    const list = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .expect(200);
    const created = list.body.find((p: { name: string }) => p.name === 'Azure Claude');
    expect(created.api_kind).toBe('anthropic');

    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${res.body.id}`)
      .set(headers)
      .expect(200);
  });

  it('POST /custom-providers defaults api_kind to "openai" when omitted', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'No Kind',
        base_url: 'https://api.example.com/v1',
        models: [{ model_name: 'm' }],
      })
      .expect(201);
    expect(res.body.api_kind).toBe('openai');
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${res.body.id}`)
      .set(headers)
      .expect(200);
  });

  it('POST /custom-providers rejects unknown api_kind', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Bogus',
        base_url: 'https://api.example.com/v1',
        api_kind: 'google',
        models: [{ model_name: 'm' }],
      })
      .expect(400);
  });

  it('POST /custom-providers works without API key (local provider)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Local OpenAI-compatible',
        base_url: 'http://localhost:8000/v1',
        models: [{ model_name: 'my-model' }],
      })
      .expect(201);

    expect(res.body.name).toBe('Local OpenAI-compatible');
    expect(res.body.has_api_key).toBe(false);

    // Cleanup
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${res.body.id}`)
      .set(headers)
      .expect(200);
  });

  it('stores null prices for models without pricing info', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'No Prices',
        base_url: 'http://localhost:9000/v1',
        models: [{ model_name: 'unknown-cost-model' }],
      })
      .expect(201);

    // Verify models in response don't have default 0 prices
    expect(res.body.models[0].input_price_per_million_tokens).toBeUndefined();
    expect(res.body.models[0].output_price_per_million_tokens).toBeUndefined();

    // Verify available-models returns null prices
    const modelsRes = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const customModel = modelsRes.body.find(
      (m: { display_name?: string }) => m.display_name === 'unknown-cost-model',
    );
    expect(customModel).toBeDefined();
    expect(customModel.input_price_per_token).toBeNull();
    expect(customModel.output_price_per_token).toBeNull();
    expect(customModel.quality_score).toBe(2);

    // Cleanup
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${res.body.id}`)
      .set(headers)
      .expect(200);
  });

  it('stores explicit 0 prices as 0 (not null)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/routing/${agentName}/custom-providers`)
      .set(headers)
      .send({
        name: 'Free Provider',
        base_url: 'http://localhost:9001/v1',
        models: [{
          model_name: 'free-model',
          input_price_per_million_tokens: 0,
          output_price_per_million_tokens: 0,
        }],
      })
      .expect(201);

    expect(res.body.models[0].input_price_per_million_tokens).toBe(0);
    expect(res.body.models[0].output_price_per_million_tokens).toBe(0);

    // Verify available-models returns 0 prices (not null)
    const modelsRes = await request(app.getHttpServer())
      .get(`/api/v1/routing/${agentName}/available-models`)
      .set(headers)
      .expect(200);

    const customModel = modelsRes.body.find(
      (m: { display_name?: string }) => m.display_name === 'free-model',
    );
    expect(customModel).toBeDefined();
    expect(Number(customModel.input_price_per_token)).toBe(0);
    expect(Number(customModel.output_price_per_token)).toBe(0);

    // Cleanup
    await request(app.getHttpServer())
      .delete(`/api/v1/routing/${agentName}/custom-providers/${res.body.id}`)
      .set(headers)
      .expect(200);
  });

  describe('connections', () => {
    const server = () => app.getHttpServer();
    let id: string;
    let key: string;

    const connectionsOf = async () => {
      const res = await request(server()).get('/api/v1/providers').set(headers).expect(200);
      const group = res.body.providers.find((p: { provider: string }) => p.provider === key);
      return (group?.connections ?? [])
        .filter((c: { is_active: boolean }) => c.is_active)
        .sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority)
        .map((c: { label: string; key_prefix: string | null }) => [c.label, c.key_prefix]);
    };

    beforeAll(async () => {
      const res = await request(server())
        .post(`/api/v1/routing/${agentName}/custom-providers`)
        .set(headers)
        .send({
          name: 'Pooled Gateway',
          base_url: 'https://pooled.example.com/v1',
          apiKey: 'sk-account-a',
          models: [{ model_name: 'pooled-model' }],
        })
        .expect(201);
      id = res.body.id;
      key = `custom:${id}`;
    });

    it('adds a second labeled connection through the provider connect endpoint', async () => {
      await request(server())
        .post(`/api/v1/routing/${agentName}/providers`)
        .set(headers)
        .send({ provider: key, apiKey: 'sk-account-b', label: 'Account B' })
        .expect(201);

      expect(await connectionsOf()).toEqual([
        ['Default', 'sk-accou'],
        ['Account B', 'sk-accou'],
      ]);
    });

    it('updates the primary connection after it was renamed, without adding a row', async () => {
      await request(server())
        .patch(`/api/v1/providers/${encodeURIComponent(key)}/keys/Default`)
        .set(headers)
        .send({ newLabel: 'Account A' })
        .expect(200);

      await request(server())
        .put(`/api/v1/routing/${agentName}/custom-providers/${id}`)
        .set(headers)
        .send({ apiKey: 'sk-rot1-account-a' })
        .expect(200);
      await request(server())
        .post(`/api/v1/routing/${agentName}/providers`)
        .set(headers)
        .send({ provider: key, apiKey: 'sk-rot2-account-a' })
        .expect(201);

      expect(await connectionsOf()).toEqual([
        ['Account A', 'sk-rot2-'],
        ['Account B', 'sk-accou'],
      ]);
    });

    it('rejects a connection for a custom provider that does not exist', async () => {
      await request(server())
        .post(`/api/v1/routing/${agentName}/providers`)
        .set(headers)
        .send({
          provider: 'custom:00000000-0000-4000-8000-000000000000',
          apiKey: 'sk-x',
          label: 'Nope',
        })
        .expect(404);
    });

    it('removes one connection by label and keeps the provider', async () => {
      await request(server())
        .delete(`/api/v1/providers/${encodeURIComponent(key)}`)
        .query({ label: 'Account B' })
        .set(headers)
        .expect(200);

      expect(await connectionsOf()).toEqual([['Account A', 'sk-rot2-']]);
    });

    it('deleting the custom provider removes every connection', async () => {
      await request(server())
        .post(`/api/v1/routing/${agentName}/providers`)
        .set(headers)
        .send({ provider: key, apiKey: 'sk-account-c', label: 'Account C' })
        .expect(201);
      await request(server())
        .delete(`/api/v1/routing/${agentName}/custom-providers/${id}`)
        .set(headers)
        .expect(200);

      expect(await connectionsOf()).toEqual([]);
    });
  });
});
