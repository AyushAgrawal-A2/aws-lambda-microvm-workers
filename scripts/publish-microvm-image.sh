#!/usr/bin/env bash
# Publishes the worker as a Lambda MicroVM image source.
#
#   1. builds worker/Dockerfile (runtime stage) for linux/arm64 and pushes it to ECR
#   2. resolves the pushed digest
#   3. writes a one-line Dockerfile (FROM <ecr image>@<digest>) into a zip
#   4. uploads the zip to S3 if S3_BUCKET is set, and prints the Lambda commands
#
# The zip is a few hundred bytes; it exists only because the MicroVMs API takes
# its code artifact from S3. All real content is the ECR image.
#
# Required:
#   ECR_REPOSITORY   e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/microvm-worker
# Optional:
#   IMAGE_TAG        default: short git sha
#   AWS_REGION       default: region parsed from ECR_REPOSITORY
#   S3_BUCKET        upload the zip to s3://$S3_BUCKET/$S3_KEY
#   S3_KEY           default: microvm/worker-<tag>.zip
#   DRY_RUN=1        build only (no push, no upload); digest is left unresolved
#
# Needs Docker buildx with arm64 support: on Linux hosts without it run
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ECR_REPOSITORY:?set ECR_REPOSITORY to the full ECR repository URI}"
default_tag() {
  local sha
  sha="$(git rev-parse --short HEAD 2>/dev/null)" || { date +%Y%m%d%H%M%S; return; }
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "${sha}-dirty"
  else
    echo "$sha"
  fi
}
IMAGE_TAG="${IMAGE_TAG:-$(default_tag)}"
AWS_REGION="${AWS_REGION:-$(sed -E 's#^[0-9]+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com/.*#\1#' <<<"$ECR_REPOSITORY")}"
S3_KEY="${S3_KEY:-microvm/worker-${IMAGE_TAG}.zip}"
DRY_RUN="${DRY_RUN:-0}"
registry="${ECR_REPOSITORY%%/*}"
image="${ECR_REPOSITORY}:${IMAGE_TAG}"
out=dist/microvm
rm -rf "$out" && mkdir -p "$out"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry run: building $image for linux/arm64 without pushing"
  docker buildx build --platform linux/arm64 --target runtime -t "$image" -f worker/Dockerfile .
  image_ref="$image"
else
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$registry"
  docker buildx build --platform linux/arm64 --target runtime -t "$image" --push -f worker/Dockerfile .
  digest="$(docker buildx imagetools inspect "$image" --format '{{.Manifest.Digest}}')"
  image_ref="${ECR_REPOSITORY}@${digest}"
fi

sed "s#__IMAGE_REF__#${image_ref}#" deploy/microvm/Dockerfile.template > "$out/Dockerfile"
(cd "$out" && zip -q -j "worker-${IMAGE_TAG}.zip" Dockerfile)
echo "image:    $image_ref"
echo "artifact: $out/worker-${IMAGE_TAG}.zip"

if [[ "$DRY_RUN" == "1" || -z "${S3_BUCKET:-}" ]]; then
  echo "set S3_BUCKET to upload, then run create-microvm-image / update-microvm-image (see README)"
  exit 0
fi

aws s3 cp "$out/worker-${IMAGE_TAG}.zip" "s3://${S3_BUCKET}/${S3_KEY}" --region "$AWS_REGION"
cat <<MSG
uploaded: s3://${S3_BUCKET}/${S3_KEY}

first time:
  aws lambda-microvms create-microvm-image --name worker \\
    --code-artifact uri=s3://${S3_BUCKET}/${S3_KEY} \\
    --base-image-arn arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1 \\
    --build-role-arn <build role arn> --cpu-configurations architecture=arm64 \\
    --hooks "\$(cat deploy/microvm/hooks.json)"

new version:
  aws lambda-microvms update-microvm-image --image-identifier worker \\
    --code-artifact uri=s3://${S3_BUCKET}/${S3_KEY} \\
    --base-image-arn arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1 \\
    --build-role-arn <build role arn>
MSG
