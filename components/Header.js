// components/Header.js
//
// Standalone portfolio navigation.
//
// This console is deployed on its own origin (web3.flo-portfolio.com), so the
// links are ordinary same-tab cross-origin anchors rather than the portfolio's
// internal router. "Projects" stays marked as the current section because the
// console is one of the portfolio's projects.

import React from "react";

const PORTFOLIO = "https://flo-portfolio.com";

const LINKS = [
  { label: "Home", href: `${PORTFOLIO}/about` },
  { label: "Skills", href: `${PORTFOLIO}/skills` },
  { label: "Projects", href: `${PORTFOLIO}/projects`, current: true },
  { label: "Contact", href: `${PORTFOLIO}/contact` },
];

const Header = () => (
  <nav className="site-nav" aria-label="Portfolio navigation">
    {LINKS.map(({ label, href, current }) => (
      <a
        key={label}
        className="site-nav-item"
        href={href}
        aria-current={current ? "page" : undefined}
      >
        {label}
      </a>
    ))}
  </nav>
);

export default Header;
