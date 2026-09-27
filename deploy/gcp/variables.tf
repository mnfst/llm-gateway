variable "project_id" {
  description = "Google Cloud project ID to deploy Manifest into."
  type        = string
}

variable "region" {
  description = "Google Cloud region for Cloud Run and Cloud SQL."
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name. Use lowercase letters, numbers, and hyphens."
  type        = string
  default     = "manifest"

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$", var.service_name))
    error_message = "service_name must be 1-40 characters, start with a letter, end with a letter or number, and contain only lowercase letters, numbers, or hyphens."
  }
}

variable "image_url" {
  description = "Manifest container image to deploy."
  type        = string
  default     = "docker.io/manifestdotbuild/manifest:6"
}

variable "database_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances. Keep this low for the starter deploy."
  type        = number
  default     = 1
}

variable "database_deletion_protection" {
  description = "Protect the Cloud SQL instance from terraform destroy."
  type        = bool
  default     = true
}
