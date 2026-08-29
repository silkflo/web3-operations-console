// lib/contract-intelligence/format.js
//
// Shared display formatting for the Web3 console and the intelligence answers.
//
// CommonJS on purpose: the Next.js page imports it through webpack's interop,
// and the Hardhat/Mocha suite requires it directly. Tests therefore exercise the
// real implementation rather than a copy of it.

const WEI_PER_ETH = 1000000000000000000n;

/** Below this, a balance is division dust rather than a meaningful amount. */
const DUST_THRESHOLD_WEI = 1000n;

/** `0xbddD01aE…008eA` -> `0xbddD…008eA` */
const abbreviateAddress = (address) =>
  typeof address === "string" && address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-5)}`
    : address || "";

/** `0x47b4…3901` for a 32-byte transaction hash. */
const abbreviateHash = (hash) =>
  typeof hash === "string" && hash.length > 14
    ? `${hash.slice(0, 10)}…${hash.slice(-6)}`
    : hash || "";

/**
 * Formats wei at 6 decimal places, rounded rather than truncated.
 *
 * Dust is reported separately so callers can mute it: an equal split of a round
 * that does not divide evenly leaves a wei or two behind, which is correct
 * contract behaviour but noise in a headline figure.
 */
const formatEth = (wei) => {
  if (typeof wei !== "bigint") {
    return { text: "—", dust: false, zero: true };
  }

  if (wei === 0n) {
    return { text: "0 ETH", dust: false, zero: true };
  }

  if (wei < DUST_THRESHOLD_WEI) {
    return { text: `${wei.toString()} wei dust`, dust: true, zero: false };
  }

  // Round to 6 decimal places: (wei * 1e6 + 5e17) / 1e18
  const scaled = (wei * 1000000n + WEI_PER_ETH / 2n) / WEI_PER_ETH;

  if (scaled === 0n) {
    return { text: "< 0.000001 ETH", dust: false, zero: false };
  }

  const whole = scaled / 1000000n;
  const fraction = (scaled % 1000000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");

  return {
    text: fraction ? `${whole}.${fraction} ETH` : `${whole} ETH`,
    dust: false,
    zero: false,
  };
};

/** Convenience: just the display string. */
const formatEthText = (wei) => formatEth(wei).text;

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];

const numberWord = (value) =>
  Number.isInteger(value) && value >= 0 && value < NUMBER_WORDS.length
    ? NUMBER_WORDS[value]
    : String(value);

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

module.exports = {
  WEI_PER_ETH,
  DUST_THRESHOLD_WEI,
  abbreviateAddress,
  abbreviateHash,
  formatEth,
  formatEthText,
  numberWord,
  plural,
};
