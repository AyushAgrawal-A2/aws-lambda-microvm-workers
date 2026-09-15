import assert from "node:assert/strict";
import type http from "node:http";
import { describe, it } from "node:test";

import { extractCredentials, isHookPath, selectBaseProtocol } from "@/proxy";

function request(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe("extractCredentials", () => {
  it("reads token and port from Lambda subprotocols and strips them", () => {
    const credentials = extractCredentials(
      request({
        "sec-websocket-protocol":
          "lambda-microvms, lambda-microvms.authentication.abc.def, lambda-microvms.port.9000, custom",
      }),
    );
    assert.equal(credentials.token, "abc.def");
    assert.equal(credentials.port, 9000);
    assert.deepEqual(credentials.remainingProtocols, ["custom"]);
    assert.equal(credentials.baseOffered, true);
  });

  it("falls back to headers and the default port", () => {
    const credentials = extractCredentials(request({ "x-aws-proxy-auth": "tok" }));
    assert.equal(credentials.token, "tok");
    assert.equal(credentials.port, 8080);
    assert.equal(credentials.baseOffered, false);
  });
});

describe("selectBaseProtocol", () => {
  it("injects the base protocol into a 101 without one", () => {
    const head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";
    assert.match(selectBaseProtocol(head), /Sec-WebSocket-Protocol: lambda-microvms\r\n\r\n$/u);
  });

  it("leaves non-101 responses and explicit selections alone", () => {
    const notFound = "HTTP/1.1 404 Not Found\r\n\r\n";
    assert.equal(selectBaseProtocol(notFound), notFound);
    const chosen = "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Protocol: custom\r\n\r\n";
    assert.equal(selectBaseProtocol(chosen), chosen);
  });
});

describe("isHookPath", () => {
  it("blocks the lifecycle hook prefix only", () => {
    assert.equal(isHookPath("/aws/lambda-microvms/runtime/v1/suspend"), true);
    assert.equal(isHookPath("/ws"), false);
    assert.equal(isHookPath("/health"), false);
  });
});
