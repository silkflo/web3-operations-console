// ethereum-v3/frontend/config.js
//
// Central Web3 configuration for the portfolio demo.
//
// The factory address is NOT written here by hand. It comes from
// demo-deployment.json, which is generated from the committed deployment
// manifest (ethereum-v3/deployments/sepolia-demo-v1.json) by:
//
//   cd ethereum-v3 && npm run sync:frontend
//
// Page components must import from this module — never hardcode an address.

import demoDeployment from "./demo-deployment.json";

/** Raw generated deployment record. */
export const DEMO_DEPLOYMENT = demoDeployment;

/** Address of the active portfolio-demo factory, or null before first deploy. */
export const FACTORY_ADDRESS = demoDeployment.factoryAddress;

/** "not-deployed" until a real factory exists and the manifest is synced. */
export const DEMO_STATUS = demoDeployment.status || "not-deployed";

/** True once a real factory has been deployed and the manifest synced. */
export const IS_DEMO_DEPLOYED =
  DEMO_STATUS === "deployed" && Boolean(demoDeployment.factoryAddress);

/** Human-readable reason shown while the demo is not deployed. */
export const DEMO_STATUS_NOTE = demoDeployment.statusNote || "";

export const FACTORY_VERSION = demoDeployment.factoryVersion;

export const SEPOLIA_CHAIN_ID = demoDeployment.chainId || 11155111;
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

export const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

/** Label shown in the UI so the demo is never mistaken for production. */
export const ENVIRONMENT_LABEL = "Sepolia Testnet · Portfolio Demo";

/**
 * Label reserved for any participant list that has NOT joined on-chain.
 *
 * Retained as a guard: the seeded environment now has real participants, but if
 * a future surface ever renders a designed-but-unjoined address list, it must
 * use this exact wording rather than improvising one. Participant counts must
 * always come from a live contract read, never from a static list.
 */
export const SCENARIO_PARTICIPANTS_LABEL =
  "Scenario design participants — not joined on-chain.";

/**
 * Public read-only RPC used by the portfolio.
 *
 * This does NOT contain the private Alchemy deployment key — visitors can
 * inspect the demo without connecting a wallet.
 *
 * Override at build time with NEXT_PUBLIC_SEPOLIA_RPC_URL.
 */
export const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ||
  "https://ethereum-sepolia-rpc.publicnode.com";
