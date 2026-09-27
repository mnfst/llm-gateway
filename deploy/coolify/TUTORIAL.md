# Deploy Manifest on Coolify

This guide deploys Manifest on Coolify as a Docker Compose service stack with a Manifest web service and a private PostgreSQL container.

Coolify is the best next candidate for a real one-click template because its one-click services are curated Docker Compose templates. Until Manifest is accepted into the Coolify service catalog, use the Compose file in this directory as a user-defined service.

## Prerequisites

- A Coolify instance or Coolify Cloud account.
- A server destination configured in Coolify.
- A domain or wildcard domain configured for Coolify's proxy.

This stack runs on infrastructure you control through Coolify. Your server, storage, and bandwidth costs depend on your provider.

## Deploy

1. In Coolify, open your project.
2. Click **New Resource**.
3. Choose **Docker Compose Empty** or a user-defined service stack.
4. Paste the contents of [`docker-compose.yml`](docker-compose.yml).
5. Save the service.
6. Confirm Coolify generated values for `SERVICE_URL_MANIFEST_2099`, `SERVICE_PASSWORD_POSTGRES`, `SERVICE_HEX_64_AUTH`, and `SERVICE_HEX_64_ENCRYPTION`.
7. Deploy.

The Compose file uses Coolify magic environment variables so the app URL, Postgres password, Better Auth secret, and Manifest encryption key are generated and stay stable between deployments.

## Open Manifest

After deployment, open the generated Manifest URL and create the first admin account. Fresh installs redirect to `/setup`; the first account you create becomes the admin.

To verify the deployment:

```bash
curl -sSf https://<your-coolify-domain>/api/v1/health
```

## What Gets Provisioned

- Manifest Docker image `manifestdotbuild/manifest:6`.
- PostgreSQL 16 container.
- Persistent Docker volume for PostgreSQL data.
- Persistent Docker volume for compressed request recordings at `/data/request-recordings`.
- Generated session, encryption, database password, and public URL values.

## Production notes

- Keep both the PostgreSQL and request-recording volumes backed up through Coolify or your server provider. PostgreSQL dumps do not include recording objects.
- Use a real domain with HTTPS before enabling OAuth or email-based login flows.
- If you later publish Manifest as an official Coolify one-click service, this Compose file is the starting point for the upstream service template.

Relevant Coolify docs:

- [Coolify services](https://coolify.io/docs/services/introduction)
- [Coolify Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)
- [Coolify environment variables](https://coolify.io/docs/knowledge-base/environment-variables)
