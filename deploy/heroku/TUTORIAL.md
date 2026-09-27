# Deploy Manifest on Heroku

This guide deploys Manifest to a Heroku Cedar container-stack app with one web dyno and a Heroku Postgres Essential-0 database.

## Prerequisites

- A Heroku account with billing enabled.
- Permission to create apps, add-ons, and config vars.
- A private S3-compatible bucket and credentials limited to that bucket's objects.

This stack creates paid resources. Heroku no longer provides free dynos or free Heroku Postgres plans.

## Deploy

Open the Heroku deploy link and choose an app name:

```text
https://www.heroku.com/deploy?template=https://github.com/mnfst/llm-gateway
```

Heroku dyno filesystems are ephemeral, so request recordings must use external object storage. Before deploying, create a private S3-compatible bucket and an access key that can read, write, and delete its objects.

When Heroku asks for configuration, enter the public URL for the app name you chose:

```text
https://<your-app-name>.herokuapp.com
```

Also provide the recording bucket values:

- `REQUEST_RECORDING_S3_BUCKET`: private bucket name.
- `REQUEST_RECORDING_S3_ENDPOINT`: custom endpoint, or blank for AWS S3.
- `REQUEST_RECORDING_S3_REGION`: signing region, such as `us-east-1`.
- `REQUEST_RECORDING_S3_ACCESS_KEY_ID`: limited access key.
- `REQUEST_RECORDING_S3_SECRET_ACCESS_KEY`: matching secret key.

Heroku generates the session and encryption secrets, provisions Postgres as `DATABASE_URL`, builds `Dockerfile.heroku`, and starts the web dyno.

## What Gets Provisioned

- Heroku app on the `container` stack.
- One `basic` web dyno.
- Heroku Postgres `essential-0`.
- Runtime config for Manifest self-hosting, Postgres TLS, and conservative connection pools.
- Durable S3-compatible storage configuration for request recordings.

## Open Manifest

Open the deployed app and create the first admin account. Fresh installs redirect to `/setup`; the first account you create becomes the admin.

Check health:

```bash
curl -fsS https://<your-app-name>.herokuapp.com/api/v1/health
```

View logs:

```bash
heroku logs --tail -a <your-app-name>
```

## Tearing it down

Destroy the app when testing is done to stop billing:

```bash
heroku apps:destroy -a <your-app-name>
```

The external recording bucket is not part of the Heroku app. Keep it for recovery, or export and delete it separately when it is no longer needed.

## Notes

- Heroku sets `PORT` automatically, so the template does not pin a port.
- `PGSSLMODE=no-verify` enables TLS for Heroku Postgres without editing the managed `DATABASE_URL`.
- `DB_POOL_MAX=8` and `AUTH_DB_POOL_MAX=4` leave headroom under the Essential-0 connection limit. Increase them only after moving to a larger Postgres plan.
- Do not store recordings on the dyno filesystem; Heroku discards it whenever a dyno stops or restarts.

Relevant Heroku docs:

- [Deploy to Heroku Button](https://devcenter.heroku.com/articles/heroku-button)
- [app.json schema](https://devcenter.heroku.com/articles/app-json-schema)
- [Building Docker Images with heroku.yml](https://devcenter.heroku.com/articles/build-docker-images-heroku-yml)
- [Using Amazon S3 from Heroku](https://devcenter.heroku.com/articles/s3)
