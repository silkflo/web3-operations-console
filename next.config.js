// next.config.js
//
// Next 16 writes AGENTS.md and CLAUDE.md into the repository root on every
// `next dev` unless this is disabled. They are generated tooling notes, not
// project documentation, so they are kept out of a public repository.

/** @type {import('next').NextConfig} */
module.exports = {
  agentRules: false,
};
