// backend/src/chain/provider.js
//
// The one place an ethers provider is constructed, and the reason this file
// exists at all.
//
// Ethers v6 defaults are wrong for a single small VPS in front of a metered
// public RPC:
//
//   FetchRequest.timeout = 300_000     five minutes per logical call
//   MAX_ATTEMPTS = 12                  twelve HTTP attempts on a 429, with
//                                      exponential backoff between them
//
// Measured against a stub returning `429 Monthly capacity limit exceeded`, a
// single `getBlockNumber()` took 248 seconds and made 12 HTTP attempts. Nginx
// gives up at 30, so the visitor saw a 504 while the process kept retrying for
// another three and a half minutes — with three endpoints doing it at once,
// every fifteen seconds.
//
// Passing a network as the second constructor argument does NOT pin it: unless
// `staticNetwork` is set, ethers still issues `eth_chainId`, and its bootstrap
// loop retries that forever at 1s intervals while console.logging. Setting
// `staticNetwork` removes both the extra call and the loop.

const { ethers } = require("ethers");

/**
 * Builds a JsonRpcProvider with a strict timeout and no internal retry storm.
 *
 * Retries are the application's job, not the transport's: the indexer backs off
 * deliberately (bounded, jittered, and it stops), while an API request must
 * fail fast so the caller can serve cached data instead.
 *
 * @param {Object} input
 * @param {string} input.rpcUrl       Credential-bearing; never logged from here.
 * @param {number} input.chainId
 * @param {number} input.timeoutMs    Hard per-HTTP-request bound.
 * @param {number} [input.maxAttempts] Total HTTP attempts per call. 1 = none.
 */
const createProvider = ({ rpcUrl, chainId, timeoutMs, maxAttempts = 1 }) => {
  if (!rpcUrl) {
    return null;
  }

  const connection = new ethers.FetchRequest(rpcUrl);

  connection.timeout = timeoutMs;
  connection.setThrottleParams({ maxAttempts: Math.max(1, maxAttempts) });

  const network = ethers.Network.from(chainId);

  return new ethers.JsonRpcProvider(connection, network, {
    // No eth_chainId round-trip, and no unbounded network-bootstrap loop.
    staticNetwork: network,
  });
};

module.exports = { createProvider };
