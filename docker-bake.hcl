variable "IMAGE_PREFIX" { default = "june" }
variable "IMAGE_TAG" { default = "local" }
variable "SOURCE_URL" { default = "https://github.com/PepsiCo24/JUNE-Commerce-Platform" }
variable "NEXT_PUBLIC_ASSET_HOST" { default = "" }

group "default" {
  targets = ["api", "worker", "web", "migrate"]
}

# Bake shares the expensive workspace build across all four targets.
target "common" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64"]
  args = { NEXT_PUBLIC_ASSET_HOST = NEXT_PUBLIC_ASSET_HOST }
  labels = {
    "org.opencontainers.image.source" = SOURCE_URL
    "org.opencontainers.image.revision" = IMAGE_TAG
  }
}

target "api" {
  inherits = ["common"]
  target = "api"
  tags = ["${IMAGE_PREFIX}/api:${IMAGE_TAG}"]
}
target "worker" {
  inherits = ["common"]
  target = "worker"
  tags = ["${IMAGE_PREFIX}/worker:${IMAGE_TAG}"]
}
target "web" {
  inherits = ["common"]
  target = "web"
  tags = ["${IMAGE_PREFIX}/web:${IMAGE_TAG}"]
}
target "migrate" {
  inherits = ["common"]
  target = "migrate"
  tags = ["${IMAGE_PREFIX}/migrate:${IMAGE_TAG}"]
}
