# Deploy Manifest on Koyeb

This guide deploys the public Manifest Docker image to a Koyeb Web Service. The deploy button pre-fills the image, HTTP port, and runtime settings, but you must create PostgreSQL and a private S3-compatible recording bucket separately and replace the placeholder secrets before deploying.

## Prerequisites

- A Koyeb account.
- A Koyeb PostgreSQL Database Service.
- Two random 32+ character secrets for Manifest.
- A private S3-compatible bucket and credentials limited to reading, writing, and deleting its objects.

This deployment creates paid resources if your selected Koyeb service or database plan is not free.

## Create PostgreSQL

In Koyeb, create a PostgreSQL Database Service in the same region you plan to use for Manifest. After it is ready, open the database connection details and copy the connection string.

Manifest uses TLS to connect to Koyeb Postgres, so include `sslmode=require` in the connection string. If the copied URL has no query string, append `?sslmode=require`. If it already has query parameters, append `&sslmode=require`.

## Generate secrets

Generate separate values for session signing and at-rest provider credential encryption:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

## Deploy Manifest

Open the Koyeb deploy link:

```text
https://app.koyeb.com/deploy?type=docker&image=docker.io%2Fmanifestdotbuild%2Fmanifest%3A6&name=manifest&service_type=web&ports=2099%3Bhttp%3B%2F&env%5BPORT%5D=2099&env%5BDATABASE_URL%5D=postgres%3A%2F%2FUSER%3APASSWORD%40HOST%2FDB%3Fsslmode%3Drequire&env%5BBETTER_AUTH_SECRET%5D=replace-with-openssl-rand-hex-32&env%5BMANIFEST_ENCRYPTION_KEY%5D=replace-with-different-openssl-rand-hex-32&env%5BBETTER_AUTH_URL%5D=https%3A%2F%2F%7B%7B+KOYEB_PUBLIC_DOMAIN+%7D%7D&env%5BMANIFEST_MODE%5D=selfhosted&env%5BBIND_ADDRESS%5D=0.0.0.0&env%5BDB_POOL_MAX%5D=8&env%5BAUTH_DB_POOL_MAX%5D=4&env%5BREQUEST_RECORDING_STORAGE%5D=s3&env%5BREQUEST_RECORDING_S3_BUCKET%5D=replace-with-private-bucket&env%5BREQUEST_RECORDING_S3_ENDPOINT%5D=https%3A%2F%2Fs3.example.com&env%5BREQUEST_RECORDING_S3_REGION%5D=us-east-1&env%5BREQUEST_RECORDING_S3_ACCESS_KEY_ID%5D=replace-with-limited-access-key&env%5BREQUEST_RECORDING_S3_SECRET_ACCESS_KEY%5D=replace-with-secret-key&env%5BREQUEST_RECORDING_S3_FORCE_PATH_STYLE%5D=false
```

In the deploy form:

- Replace `DATABASE_URL` with your Koyeb Postgres connection string.
- Replace `BETTER_AUTH_SECRET` with the first generated secret.
- Replace `MANIFEST_ENCRYPTION_KEY` with the second generated secret.
- Replace `REQUEST_RECORDING_S3_BUCKET`, `REQUEST_RECORDING_S3_ENDPOINT`, `REQUEST_RECORDING_S3_REGION`, `REQUEST_RECORDING_S3_ACCESS_KEY_ID`, and `REQUEST_RECORDING_S3_SECRET_ACCESS_KEY` with your private bucket settings. Leave the endpoint blank only for AWS S3.
- Leave `BETTER_AUTH_URL` as `https://{{ KOYEB_PUBLIC_DOMAIN }}`.
- Leave `PORT`, `MANIFEST_MODE`, `BIND_ADDRESS`, `DB_POOL_MAX`, `AUTH_DB_POOL_MAX`, and `REQUEST_RECORDING_STORAGE=s3` unchanged for a single-instance deploy. Set `REQUEST_RECORDING_S3_FORCE_PATH_STYLE=true` only if your object-storage provider requires path-style URLs.

The button deploys `docker.io/manifestdotbuild/manifest:6` and exposes port `2099` over HTTP.

## Open Manifest

After the deployment is live, open the public Koyeb domain and create the first account. The first account becomes the admin.

To verify the deployment:

```bash
curl -sSf https://<your-koyeb-domain>/api/v1/health
```

## Tearing it down

Delete the Koyeb resources when you are done:

- The Manifest Koyeb Web Service.
- The Koyeb PostgreSQL Database Service.

Deleting only the web service leaves the database running. The external recording bucket is managed separately; export and delete it through its provider if it is no longer needed.

Koyeb Volumes are currently public preview, restricted to specific regions and paid instance types, and local to one instance. This template therefore uses external S3-compatible storage for production-grade recording durability instead of a Koyeb Volume.

Relevant Koyeb docs:

- [Deploy to Koyeb button](https://www.koyeb.com/docs/build-and-deploy/deploy-to-koyeb-button)
- [Koyeb environment variables](https://www.koyeb.com/docs/build-and-deploy/environment-variables)
- [Koyeb Volumes](https://www.koyeb.com/docs/reference/volumes)
