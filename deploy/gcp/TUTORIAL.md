# Deploy Manifest on GCP

<walkthrough-tutorial-duration duration="15"></walkthrough-tutorial-duration>

This walkthrough deploys Manifest on Google Cloud with Cloud Run, Cloud SQL for PostgreSQL, a private Cloud Storage bucket mounted for request recordings, and Secret Manager. DeployStack asks for a few settings, writes `terraform.tfvars`, and runs Terraform in the selected project.

## Prerequisites

<walkthrough-project-billing-setup></walkthrough-project-billing-setup>

Pick the Google Cloud project you want to deploy into and make sure billing is enabled. This stack creates paid resources, including Cloud SQL.

## Enable required APIs

<walkthrough-enable-apis apis="iam.googleapis.com,run.googleapis.com,sqladmin.googleapis.com,secretmanager.googleapis.com,storage.googleapis.com"></walkthrough-enable-apis>

```bash
gcloud services enable \
  iam.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com
```

## Run the installer

DeployStack reads `<walkthrough-editor-open-file filePath="deploy/gcp/deploystack.json">deploystack.json</walkthrough-editor-open-file>`, prompts for project, region, service name, image, and sizing, then runs Terraform.

```bash
deploystack install
```

The first deploy usually takes 10-15 minutes because Cloud SQL needs time to provision. The Terraform config also patches `BETTER_AUTH_URL` to the final Cloud Run URL after the service is created. Request recordings are written through a Cloud Storage volume mount at `/data/request-recordings`; the Cloud Run service account receives object read/write/delete access only for that bucket.

## Open Manifest

```bash
terraform output service_url
terraform output recording_bucket
```

Open the URL and create the first account. The first account becomes the admin.

To verify the deployment:

```bash
curl -sSf "$(terraform output -raw health_check_url)"
```

## Tearing it down

```bash
deploystack uninstall
```

Cloud SQL deletion protection is enabled by default. Set `database_deletion_protection=false` and apply before uninstalling. The recording bucket also protects stored objects from accidental deletion: export or delete its contents before uninstalling, or keep the bucket and remove it from Terraform state if the recordings must survive the rest of the stack.

## You're done

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>
