import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { issueToken, pruneExpiredTokens, revokeTokens, verifyToken } from "@/tokens";

describe("tokens", () => {
  it("accepts a fresh token for its own MicroVM and port", () => {
    const { token } = issueToken("mvm-a", 30, [{ allPorts: {} }]);
    assert.equal(verifyToken(token, "mvm-a", 8080), true);
  });

  it("rejects tokens for another MicroVM, unknown tokens, and missing tokens", () => {
    const { token } = issueToken("mvm-a", 30, [{ allPorts: {} }]);
    assert.equal(verifyToken(token, "mvm-b", 8080), false);
    assert.equal(verifyToken("not-a-token", "mvm-a", 8080), false);
    assert.equal(verifyToken(undefined, "mvm-a", 8080), false);
  });

  it("enforces port rules", () => {
    const single = issueToken("mvm-a", 30, [{ port: 9000 }]).token;
    assert.equal(verifyToken(single, "mvm-a", 9000), true);
    assert.equal(verifyToken(single, "mvm-a", 8080), false);
    const ranged = issueToken("mvm-a", 30, [{ range: { startPort: 8000, endPort: 8100 } }]).token;
    assert.equal(verifyToken(ranged, "mvm-a", 8080), true);
    assert.equal(verifyToken(ranged, "mvm-a", 8101), false);
  });

  it("prunes expired tokens in bulk", () => {
    issueToken("mvm-p", -1, [{ allPorts: {} }]);
    issueToken("mvm-p", -1, [{ allPorts: {} }]);
    const live = issueToken("mvm-p", 30, [{ allPorts: {} }]).token;
    assert.equal(pruneExpiredTokens() >= 2, true);
    assert.equal(verifyToken(live, "mvm-p", 8080), true);
  });

  it("expires and revokes", () => {
    const expired = issueToken("mvm-a", -1, [{ allPorts: {} }]).token;
    assert.equal(verifyToken(expired, "mvm-a", 8080), false);
    const { token } = issueToken("mvm-c", 30, [{ allPorts: {} }]);
    revokeTokens("mvm-c");
    assert.equal(verifyToken(token, "mvm-c", 8080), false);
  });
});
