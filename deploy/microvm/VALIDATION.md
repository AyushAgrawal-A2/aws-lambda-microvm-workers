# First run on AWS Lambda MicroVMs: validation checklist

The local gateway encodes a reading of the MicroVMs documentation. Each item
below is an assumption the docs do not settle. Run through them once on a real
MicroVM; every answer either confirms the gateway or names the line to change.

Setup: publish the image (`pnpm worker:publish`), create the image with
`deploy/microvm/hooks.json`, run one MicroVM with a short idle policy
(`maxIdleDurationSeconds: 60`), and point the controller at it with
`MICROVM_BACKEND=aws`.

## 1. Does an open, silent WebSocket count as traffic?

Connect, send nothing for longer than `maxIdleDurationSeconds`, watch
`get-microvm`.

- Stays `RUNNING`: the platform counts the open socket. The 30 s client
  heartbeat is then only for keepalive through intermediaries.
- Goes `SUSPENDED`: only frames count. Keep the heartbeat well under the idle
  window. This is what the gateway assumes (`apps/local-gateway/src/proxy.ts`,
  `onTraffic`).

## 2. What happens to an open WebSocket when the MicroVM suspends?

Trigger `suspend-microvm` with a client connected and the worker's `/suspend`
hook draining.

- Client receives close 1001 `going away`: the hook's drain is doing its job
  and the proxy forwards the close.
- Client sees 1006 or a hang: the proxy cut the socket before the close frame.
  Lower `DRAIN_TIMEOUT` is not the answer; the client reconnect path covers it,
  but note the observed code in this file.

## 3. Where does the agent call the hooks from?

Log `peer` in `worker/src/hooks.rs` (it is already in the rejection warning)
and read CloudWatch after `/run`.

- Loopback: set `HOOKS_LOOPBACK_ONLY=1` in the image environment variables and
  rebuild. Hooks are then unreachable to endpoint clients.
- Any other address: leave it unset. Record the address here so a future
  allowlist can use it.

## 4. Does the proxy retry a 503 on upgrade during drain?

Open a new WebSocket while `/suspend` is in progress (the worker answers 503).

- The connection eventually succeeds after resume: the proxy retries or holds.
- The client sees the 503: the client's backoff reconnect handles it. Either
  way, no change is needed, but the answer decides whether the gateway should
  hold upgrades during `SUSPENDING` (it does today) or pass the 503 through.

## 5. Maximum token lifetime

Call `create-microvm-auth-token` with a large `--expiration-in-minutes`.

- Record the maximum accepted. `MICROVM_TOKEN_MINUTES` must stay below it;
  the client refreshes on every reconnect regardless.

## 6. Digest-pinned `FROM` in the artifact Dockerfile

`create-microvm-image` with the zip produced by `pnpm worker:publish`, whose
Dockerfile is `FROM <ecr image>@sha256:...`.

- Build reaches `CREATED`: pinning works; keep it.
- Build fails on the `FROM` line: fall back to a tag in
  `scripts/publish-microvm-image.sh` and note the loss of reproducibility.

## 7. Resume latency and the first frame

Let the MicroVM suspend, then send one exec frame and time the reply.

- Record the number. The web client's reconnect backoff starts at 1 s; if
  resume routinely takes longer than the first WebSocket handshake timeout the
  client should open the socket only after `get-microvm` reports `RUNNING`.

## Recording results

Put the date, region, and each answer under the matching heading and commit
this file. When an answer contradicts the gateway, open the referenced file in
the same change.
