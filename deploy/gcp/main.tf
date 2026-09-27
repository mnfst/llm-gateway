locals {
  suffix          = random_id.suffix.hex
  name_prefix     = "${var.service_name}-${local.suffix}"
  database_name   = "manifest"
  database_user   = "manifest"
  service_account = "${substr(var.service_name, 0, 23)}-${local.suffix}"
  database_url    = "postgresql://${local.database_user}:${urlencode(random_password.database.result)}@/${local.database_name}?host=${urlencode("/cloudsql/${google_sql_database_instance.manifest.connection_name}")}"
  managed_secret_ids = {
    database_url            = "${local.name_prefix}-database-url"
    better_auth_secret      = "${local.name_prefix}-better-auth-secret"
    manifest_encryption_key = "${local.name_prefix}-encryption-key"
  }
  managed_secret_values = {
    database_url            = local.database_url
    better_auth_secret      = random_id.better_auth_secret.hex
    manifest_encryption_key = random_id.manifest_encryption_key.hex
  }
}

resource "google_project_service" "required" {
  for_each = toset([
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

resource "random_id" "suffix" {
  byte_length = 3
}

resource "random_id" "better_auth_secret" {
  byte_length = 32
}

resource "random_id" "manifest_encryption_key" {
  byte_length = 32
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "google_service_account" "manifest" {
  account_id   = local.service_account
  display_name = "Manifest Cloud Run"

  depends_on = [google_project_service.required]
}

resource "google_sql_database_instance" "manifest" {
  name                = "${var.service_name}-postgres-${local.suffix}"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.database_deletion_protection

  settings {
    tier              = var.database_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_autoresize   = true

    backup_configuration {
      enabled    = true
      start_time = "03:00"
    }
  }

  depends_on = [google_project_service.required["sqladmin.googleapis.com"]]
}

resource "google_sql_database" "manifest" {
  name     = local.database_name
  instance = google_sql_database_instance.manifest.name
}

resource "google_sql_user" "manifest" {
  name     = local.database_user
  instance = google_sql_database_instance.manifest.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "managed" {
  for_each = local.managed_secret_ids

  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "managed" {
  for_each = local.managed_secret_values

  secret      = google_secret_manager_secret.managed[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret_iam_member" "managed" {
  for_each = google_secret_manager_secret.managed

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.manifest.email}"
}

resource "google_project_iam_member" "cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.manifest.email}"
}

resource "google_storage_bucket" "recordings" {
  name                        = "${local.name_prefix}-recordings"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true

  depends_on = [google_project_service.required["storage.googleapis.com"]]
}

resource "google_storage_bucket_iam_member" "recordings" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.manifest.email}"
}

resource "google_cloud_run_v2_service" "manifest" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.manifest.email
    max_instance_request_concurrency = 20

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.manifest.connection_name]
      }
    }

    volumes {
      name = "recordings"
      gcs {
        bucket        = google_storage_bucket.recordings.name
        read_only     = false
        mount_options = ["uid=65532", "gid=65532", "file-mode=0660", "dir-mode=0770"]
      }
    }

    containers {
      image = var.image_url

      ports {
        container_port = 2099
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "BIND_ADDRESS"
        value = "0.0.0.0"
      }

      env {
        name  = "MANIFEST_MODE"
        value = "selfhosted"
      }

      env {
        name  = "DB_POOL_MAX"
        value = "10"
      }

      env {
        name  = "AUTH_DB_POOL_MAX"
        value = "5"
      }

      env {
        name  = "REQUEST_RECORDING_STORAGE"
        value = "filesystem"
      }

      env {
        name  = "REQUEST_RECORDING_FILESYSTEM_PATH"
        value = "/data/request-recordings"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["database_url"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "BETTER_AUTH_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["better_auth_secret"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "MANIFEST_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["manifest_encryption_key"].secret_id
            version = "latest"
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      volume_mounts {
        name       = "recordings"
        mount_path = "/data/request-recordings"
      }

      startup_probe {
        http_get {
          path = "/api/v1/health"
          port = 2099
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 12
      }

      liveness_probe {
        http_get {
          path = "/api/v1/health"
          port = 2099
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].env,
    ]
  }

  depends_on = [
    google_sql_database.manifest,
    google_sql_user.manifest,
    google_project_iam_member.cloudsql_client,
    google_secret_manager_secret_iam_member.managed,
    google_secret_manager_secret_version.managed,
    google_storage_bucket_iam_member.recordings,
    google_project_service.required["run.googleapis.com"],
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.manifest.location
  name     = google_cloud_run_v2_service.manifest.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "terraform_data" "set_runtime_urls" {
  triggers_replace = [
    google_cloud_run_v2_service.manifest.uri,
    google_storage_bucket.recordings.name,
  ]

  provisioner "local-exec" {
    command = "gcloud run services update ${google_cloud_run_v2_service.manifest.name} --project ${var.project_id} --region ${var.region} --update-env-vars 'BETTER_AUTH_URL=${google_cloud_run_v2_service.manifest.uri},REQUEST_RECORDING_STORAGE=filesystem,REQUEST_RECORDING_FILESYSTEM_PATH=/data/request-recordings' --quiet"
  }

  depends_on = [
    google_cloud_run_v2_service.manifest,
    google_cloud_run_v2_service_iam_member.public,
  ]
}
