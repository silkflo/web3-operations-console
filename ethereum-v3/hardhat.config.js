// ethereum-v3/hardhat.config.js

require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config();

const {
  SEPOLIA_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
  COINMARKETCAP_API_KEY,
} = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      metadata: {
        bytecodeHash: "ipfs",
      },
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
      // Enable for mainnet forking tests if needed
      // forking: {
      //   url: SEPOLIA_RPC_URL || "",
      // },
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
      chainId: 11155111,
      verify: {
        etherscan: {
          apiKey: ETHERSCAN_API_KEY || "",
        },
      },
    },
  },

  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: COINMARKETCAP_API_KEY || "",
    token: "ETH",
    outputFile: process.env.GAS_REPORT_FILE || "gas-report.txt",
    noColors: true,
  },

  mocha: {
    timeout: 100000,
    reporter: "spec",
    color: true,
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
