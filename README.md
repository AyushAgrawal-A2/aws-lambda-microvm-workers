# aws-lambda-microvm-workers

A Rust WebSocket worker that runs inside an AWS Lambda MicroVM, started on
demand when a browser client needs one, suspended when idle, and terminated
when done. The wire format is Protobuf over binary WebSocket frames.

```
apps/web            Vite + React client (session flow, Lambda subprotocols)
apps/controller     session API: run / token / terminate MicroVMs (local or AWS backend)
apps/local-gateway  local stand-in for the Lambda MicroVMs data plane (Docker)
packages/proto      TypeScript generated from proto/worker.proto
worker/             Rust worker: /ws, /health, and the Lambda lifecycle hooks
deploy/microvm/     Dockerfile template, hooks, and IAM policy for the Lambda MicroVM image
```

## Local development

Two flows. Both need `pnpm install`, `pnpm proto`, and Node 26 (`nvm use`).

**Direct** — one worker process, no MicroVM lifecycle:

```bash
pnpm dev            # cargo run worker on :8080 + Vite on :5173
```

**MicroVM emulation** — the browser opens a session, the controller asks the
gateway to run a worker container, and the socket goes through the gateway
with the same subprotocols and `X-aws-proxy-auth` semantics Lambda uses. Idle
containers are paused (suspend) and unpaused on the next frame (auto-resume).

```bash
pnpm worker:image   # builds microvm-worker:dev (once, and after worker changes)
pnpm dev:microvm    # gateway :4590 + controller :4600 + Vite :5173
```

Useful knobs for the controller: `MICROVM_MAX_IDLE_SECONDS` (default 900),
`MICROVM_SUSPENDED_SECONDS` (1800), `MICROVM_MAX_DURATION_SECONDS` (14400).
Set `MICROVM_MAX_IDLE_SECONDS=5` to watch suspend and resume in the UI.

The gateway binds `127.0.0.1` (`GATEWAY_HOST`) because its control API starts
containers, and it only ever runs `WORKER_IMAGE`. Both the gateway and the
controller refuse mutations without a JSON content type, which stops a page on
another origin from creating MicroVMs through your browser, and both reject
`Host` headers other than localhost, which stops DNS rebinding. When calling
them by hand, send `-H 'content-type: application/json'` even on `DELETE`.
Both cap what they will hold (`GATEWAY_MAX_MICROVMS`, `MICROVM_MAX_SESSIONS`,
default 8); the controller reconciles sessions against the backend every 30
seconds so MicroVMs that idled out or died stop counting. Containers get a MicroVM-like
baseline (`GATEWAY_VM_MEMORY=2g`, `GATEWAY_VM_CPUS=1`, `GATEWAY_VM_PIDS=512`),
drop all capabilities, and run read-only. Lifecycle hooks are never proxied to
the endpoint; the gateway calls them directly like the Lambda agent does.

**Floci** emulates only the MicroVMs control plane (no endpoints, tokens, or
suspend/resume). Use it to exercise the controller's `aws` backend against the
real SDK shapes; see `compose.yaml` for the environment to set.

## Deploying to Lambda MicroVMs

Before the first real run, work through `deploy/microvm/VALIDATION.md`: it
lists the platform behaviors the local gateway assumes and what to change if
AWS disagrees.

The MicroVMs API only takes its code artifact from S3, so the application
image lives in ECR and the S3 zip is a one-line Dockerfile pointing at it by
digest. One script does the whole thing:

```bash
ECR_REPOSITORY=<account>.dkr.ecr.<region>.amazonaws.com/microvm-worker \
S3_BUCKET=<bucket> pnpm worker:publish
```

It builds `worker/Dockerfile` for linux/arm64, pushes it, writes
`FROM <image>@sha256:...` into `dist/microvm/worker-<tag>.zip`, uploads the
zip, and prints the `create-microvm-image` / `update-microvm-image` command to
run next. Hook configuration is in `deploy/microvm/hooks.json`; the build
role needs `deploy/microvm/build-role-policy.json` (S3 read, ECR pull, logs)
with `lambda.amazonaws.com` as the trusted principal. `DRY_RUN=1` builds
without pushing or uploading.

Then run the controller with `MICROVM_BACKEND=aws` and
`MICROVM_IMAGE_ARN=<image arn>`; the web client needs no changes.

## Checks and tests

```bash
pnpm check      # prettier, rustfmt, tsc, oxlint (type-aware), clippy -D warnings, unit tests
pnpm fix        # apply every available autofix
pnpm test       # unit tests: gateway, web client, worker (cargo test)
pnpm test:e2e   # full lifecycle through the gateway; needs Docker and microvm-worker:dev
```

The e2e suite starts a gateway and a controller on free ports, opens a session
the way the browser does (Lambda subprotocols), checks idle suspend, token
refresh with auto-resume, blocked hook paths, termination, and that a worker
whose container dies is reaped.

## Worker runtime notes

- Hooks share the traffic port. Set `HOOKS_LOOPBACK_ONLY=1` on the image once
  it is confirmed that the Lambda agent calls them from loopback; the local
  gateway calls them over the Docker bridge, so leave it unset locally.
- `/suspend` and `/terminate` close every client socket with code 1001 and wait
  up to two seconds for them to drain before answering, so close frames are on
  the wire before the checkpoint. Clients reconnect with backoff and the first
  frame auto-resumes the MicroVM.
- Nothing unique is generated before `/run`; see the note at the top of
  `worker/src/main.rs` for why that matters with snapshots.
