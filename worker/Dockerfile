# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f worker/Dockerfile .
#
# Stages:
#   builder  - compiles the worker
#   runtime  - the image used both by the local dev gateway (microvm-worker:dev)
#              and, pushed to ECR for linux/arm64, as the FROM of the Lambda
#              MicroVM image (see scripts/publish-microvm-image.sh)
#
# The runtime base is distroless because the worker links no OpenSSL. If TLS
# ever moves inside the worker, switch it to
# public.ecr.aws/lambda/microvms:al2023-minimal, which ships the
# snapshot-safe OpenSSL that Lambda MicroVMs require.

FROM rust:1.98-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml rustfmt.toml ./
COPY proto ./proto
COPY worker ./worker
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p worker && cp target/release/worker /worker

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=builder /worker /app/worker
ENV WS_ADDR=0.0.0.0:8080
ENV RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/app/worker"]
