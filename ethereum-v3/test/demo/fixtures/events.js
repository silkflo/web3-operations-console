// ethereum-v3/test/demo/fixtures/events.js
//
// Event-log fixtures shaped exactly like the loader's normalizeLog output.
//
// The values mirror the real deployed demo where relevant, so a fixture test
// failing means the reconstruction logic changed — not that the chain moved.

const hash = (seed) => `0x${String(seed).repeat(64).slice(0, 64)}`;

const FACTORY = "0xbddD01aE6B2899c507DD540E6437552006f008eA";

const SPLITS = {
  creator: "0x0B8a5aAA27477dB7799e89b8a60266322406cf32",
  bonus: "0x36aCdDAc008630dB5e4BE3821D0776F88461ef39",
  settlement: "0xa017f14f28CfC85AA0a61D505647C75c392E26D3",
};

// Participant addresses exist only inside fixtures, never in expected output.
const P = [
  "0xDE84E7BDe4B724aDC4076Bef5BC15e029b596127",
  "0xe02d3c6F4CAAb7764617A3115904786402D9057a",
  "0x15f04516EbBFeA6418a35Df341e03308a6565AB5",
  "0x4387647F28fD0F29324339327528FB15c56A08e5",
];

const created = (splitAddress, title, block, seed) => ({
  eventName: "SplitCreated",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(seed),
  args: { splitAddress, title, index: 0n },
});

const joined = (participant, round, count, block, seed) => ({
  eventName: "ParticipantJoined",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(seed),
  args: { participant, round: BigInt(round), participantCount: BigInt(count) },
});

const funded = (round, amount, block, seed) => ({
  eventName: "Funded",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(seed),
  args: {
    manager: FACTORY,
    round: BigInt(round),
    amount,
    roundPoolTotal: amount,
  },
});

const finalized = (round, total, count, per, remainder, block, seed) => ({
  eventName: "DistributionFinalized",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(seed),
  args: {
    round: BigInt(round),
    totalDistributed: total,
    participantCount: BigInt(count),
    amountPerParticipant: per,
    remainderRemaining: remainder,
  },
});

const withdrawn = (participant, amount, remaining, block, seed) => ({
  eventName: "Withdrawal",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(seed),
  args: { participant, amount, remainingClaimable: remaining },
});

const SHARE = 333333333333333n;

/** Funded, finalized, one of three claims withdrawn — the real demo state. */
const creatorRevenueShare = {
  reads: {
    address: SPLITS.creator,
    title: "Creator Revenue Share",
    version: "3.0.0",
    round: 2n,
    participantCount: 0n,
    balanceWei: 666666666666667n,
    roundPoolWei: 1n,
    totalClaimableWei: 666666666666666n,
  },
  creation: created(SPLITS.creator, "Creator Revenue Share", 11585256, 1),
  events: {
    joined: [
      joined(P[0], 1, 1, 11585257, 2),
      joined(P[1], 1, 2, 11585258, 3),
      joined(P[2], 1, 3, 11585259, 4),
    ],
    funded: [funded(1, 1000000000000000n, 11585274, 5)],
    finalized: [
      finalized(1, 999999999999999n, 3, SHARE, 1n, 11585275, 6),
    ],
    withdrawn: [withdrawn(P[0], SHARE, 0n, 11585276, 7)],
  },
};

/** Participants joined, never funded. */
const productTeamBonus = {
  reads: {
    address: SPLITS.bonus,
    title: "Product Team Bonus",
    version: "3.0.0",
    round: 1n,
    participantCount: 4n,
    balanceWei: 0n,
    roundPoolWei: 0n,
    totalClaimableWei: 0n,
  },
  creation: created(SPLITS.bonus, "Product Team Bonus", 11585260, 8),
  events: {
    joined: [
      joined(P[0], 1, 1, 11585262, 9),
      joined(P[1], 1, 2, 11585263, "a"),
      joined(P[2], 1, 3, 11585265, "b"),
      joined(P[3], 1, 4, 11585267, "c"),
    ],
    funded: [],
    finalized: [],
    withdrawn: [],
  },
};

/** Created, nobody has joined. */
const freshSplit = {
  reads: {
    address: SPLITS.settlement,
    title: "Fresh Split",
    version: "3.0.0",
    round: 1n,
    participantCount: 0n,
    balanceWei: 0n,
    roundPoolWei: 0n,
    totalClaimableWei: 0n,
  },
  creation: created(SPLITS.settlement, "Fresh Split", 11585268, "d"),
  events: { joined: [], funded: [], finalized: [], withdrawn: [] },
};

/** Joined and funded, awaiting finalization. */
const fundedNotFinalized = {
  reads: {
    address: SPLITS.settlement,
    title: "Funded Not Finalized",
    version: "3.0.0",
    round: 1n,
    participantCount: 3n,
    balanceWei: 1000000000000000n,
    roundPoolWei: 1000000000000000n,
    totalClaimableWei: 0n,
  },
  creation: created(SPLITS.settlement, "Funded Not Finalized", 11585268, "e"),
  events: {
    joined: [
      joined(P[0], 1, 1, 11585269, "f"),
      joined(P[1], 1, 2, 11585271, 1),
      joined(P[2], 1, 3, 11585272, 2),
    ],
    funded: [funded(1, 1000000000000000n, 11585273, 3)],
    finalized: [],
    withdrawn: [],
  },
};

/** Everyone withdrew: no claims outstanding, only dust left. */
const fullyWithdrawn = {
  reads: {
    address: SPLITS.creator,
    title: "Fully Withdrawn",
    version: "3.0.0",
    round: 2n,
    participantCount: 0n,
    balanceWei: 1n,
    roundPoolWei: 1n,
    totalClaimableWei: 0n,
  },
  creation: created(SPLITS.creator, "Fully Withdrawn", 11585256, 4),
  events: {
    joined: [
      joined(P[0], 1, 1, 11585257, 5),
      joined(P[1], 1, 2, 11585258, 6),
      joined(P[2], 1, 3, 11585259, 7),
    ],
    funded: [funded(1, 1000000000000000n, 11585274, 8)],
    finalized: [finalized(1, 999999999999999n, 3, SHARE, 1n, 11585275, 9)],
    withdrawn: [
      withdrawn(P[0], SHARE, 0n, 11585276, "a"),
      withdrawn(P[1], SHARE, 0n, 11585277, "b"),
      withdrawn(P[2], SHARE, 0n, 11585278, "c"),
    ],
  },
};

module.exports = {
  FACTORY,
  SPLITS,
  PARTICIPANTS: P,
  SHARE,
  creatorRevenueShare,
  productTeamBonus,
  freshSplit,
  fundedNotFinalized,
  fullyWithdrawn,
};
