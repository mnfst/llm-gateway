# Deploy Manifest on Easypanel

This guide deploys Manifest on Easypanel with the public Manifest Docker image and an Easypanel PostgreSQL service.

Easypanel is a good fit for Manifest because it can run Docker image services, proxy web apps with HTTPS, and provision PostgreSQL in the same project. The template files in [`template/`](template/) are ready to submit to the upstream Easypanel template catalog.

## Prerequisites

- A self-hosted Easypanel instance.
- A project with a server destination.
- A domain or generated Easypanel domain for the app.

This stack runs on infrastructure you control through Easypanel. Your server, storage, and bandwidth costs depend on your provider.

## Template Deploy

If Manifest is available in your Easypanel template catalog:

1. Open your Easypanel project.
2. Choose **Templates**.
3. Search for **Manifest**.
4. Keep the default image `manifestdotbuild/manifest:6` unless you need to pin another version.
5. Deploy the template.

The template provisions Manifest, PostgreSQL, a persistent request-recording volume, generated secrets, and a domain proxy on port `2099`.

## Manual Deploy

Until the template is accepted upstream, create the services manually.

Create a PostgreSQL service:

1. Open your Easypanel project.
2. Click **Create Service**.
3. Choose **Postgres**.
4. Name it `manifest-db`.
5. Generate and save a strong password.

Create the Manifest app service:

1. Click **Create Service**.
2. Choose **App**.
3. Set source type to **Docker image**.
4. Use image `manifestdotbuild/manifest:6`.
5. Set the proxy port to `2099`.
6. Add your domain and mark it as the primary domain.

Set the Manifest environment:

```env
PORT=2099
BIND_ADDRESS=0.0.0.0
DATABASE_URL=postgresql://postgres:<postgres-password>@$(PROJECT_NAME)_manifest-db:5432/$(PROJECT_NAME)
BETTER_AUTH_SECRET=<openssl-rand-hex-32>
MANIFEST_ENCRYPTION_KEY=<different-openssl-rand-hex-32>
BETTER_AUTH_URL=https://$(PRIMARY_DOMAIN)
MANIFEST_MODE=selfhosted
NODE_ENV=production
SEED_DATA=false
DB_POOL_MAX=10
AUTH_DB_POOL_MAX=5
REQUEST_RECORDING_STORAGE=filesystem
REQUEST_RECORDING_FILESYSTEM_PATH=/data/request-recordings
MANIFEST_TELEMETRY_DISABLED=0
```

Generate secrets locally:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Use an alphanumeric or hex PostgreSQL password in `DATABASE_URL`. If your password contains URL-reserved characters such as `@`, `:`, `/`, `%`, or `#`, percent-encode them before pasting the connection string.

Add an app volume named `recordings`, mount it at `/data/request-recordings`, then deploy the app.

## Open Manifest

Open the Easypanel domain and create the first admin account. Fresh installs redirect to `/setup`; the first account you create becomes the admin.

Verify the deployment:

```bash
curl -fsS https://<your-easypanel-domain>/api/v1/health
```

Before publishing a template, smoke test the full first-run flow:

1. Confirm the app starts without crash loops.
2. Confirm PostgreSQL migrations complete.
3. Confirm `/api/v1/health` returns OK.
4. Open `/setup` on the Easypanel domain.
5. Create the first admin account.
6. Log out and log back in on the same domain.
7. Restart the app and confirm the account still exists.

## What Gets Provisioned

- Manifest Docker image `manifestdotbuild/manifest:6`.
- PostgreSQL service.
- Generated or manually configured session and encryption secrets.
- HTTPS domain proxy to Manifest port `2099`.

## Production notes

- Back up the PostgreSQL service through Easypanel or your server provider.
- Use a real HTTPS domain before enabling OAuth providers.
- Keep `BETTER_AUTH_SECRET` and `MANIFEST_ENCRYPTION_KEY` as separate values.
- Set `MANIFEST_TELEMETRY_DISABLED=1` to disable anonymous self-hosted telemetry.
- If you deploy more than one Manifest replica, lower database pool sizes or upgrade PostgreSQL connection capacity.

Relevant Easypanel docs:

- [Easypanel App Service](https://easypanel.io/docs/services/app)
- [Easypanel Services](https://easypanel.io/docs/services)
- [Easypanel templates repository](https://github.com/easypanel-io/templates)
