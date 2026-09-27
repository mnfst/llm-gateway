# Deploy Manifest on DigitalOcean

This deploys Manifest on DigitalOcean App Platform with a web service, Dev PostgreSQL database, and a user-provided DigitalOcean Space for durable request recordings. The deploy link uses DigitalOcean's Deploy to DigitalOcean flow, which reads `.do/deploy.template.yaml` from the public repository.

## Prerequisites

- A DigitalOcean account with billing enabled.
- Access to App Platform in the selected region.
- A private DigitalOcean Space and a limited Read/Write/Delete access key for that Space.

This setup creates paid resources, including an App Platform service, Dev PostgreSQL database, and Space.

App Platform has no persistent volumes and its deploy template cannot create scoped Spaces credentials. Before deploying, create a private Space and a limited access key in the DigitalOcean control panel. Record the Space name, region endpoint such as `https://nyc3.digitaloceanspaces.com`, access key, and secret key.

## Deploy

Open the DigitalOcean deploy link:

```text
https://cloud.digitalocean.com/apps/new?repo=https://github.com/mnfst/llm-gateway/tree/main
```

DigitalOcean prompts for the missing secret values before deployment. Generate and paste separate values for:

```bash
openssl rand -hex 32
```

Use one generated value for `BETTER_AUTH_SECRET` and another for `MANIFEST_ENCRYPTION_KEY`. Also provide:

- `REQUEST_RECORDING_S3_BUCKET`: your Space name.
- `REQUEST_RECORDING_S3_ENDPOINT`: `https://<space-region>.digitaloceanspaces.com`.
- `REQUEST_RECORDING_S3_ACCESS_KEY_ID`: the limited Spaces access key.
- `REQUEST_RECORDING_S3_SECRET_ACCESS_KEY`: its secret.

Keep `REQUEST_RECORDING_S3_REGION=us-east-1` and `REQUEST_RECORDING_S3_FORCE_PATH_STYLE=false`; DigitalOcean's AWS SDK guidance uses the endpoint to select the actual Space region.

## Open Manifest

After App Platform finishes deploying, open the app URL and create the first account. The first account becomes the admin.

To verify the deployment, open:

```text
https://<your-app-url>/api/v1/health
```

## Notes

DigitalOcean's deploy button supports public repositories and Dev Databases. For production data, upgrade the Dev Database to a managed database from the DigitalOcean App Platform settings.

The template appends `uselibpqcompat=true` to DigitalOcean's PostgreSQL URL so Node `pg` handles the platform's `sslmode=require` connection string correctly.

Request recordings are private objects in your Space. App Platform's local filesystem is ephemeral, so do not remove the S3 variables unless recording persistence is intentionally disabled.

Deleting the App Platform app does not delete the Space. Export any recordings you need, then remove the Space separately if it is no longer used.

Relevant DigitalOcean docs:

- [Deploy to DigitalOcean button](https://docs.digitalocean.com/products/app-platform/how-to/add-deploy-do-button/)
- [App Platform app spec](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
- [Bindable environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/#using-bindable-variables-within-environment-variables)
- [Create a Space](https://docs.digitalocean.com/products/spaces/how-to/create/)
- [Manage Spaces access](https://docs.digitalocean.com/products/spaces/how-to/manage-access/)
