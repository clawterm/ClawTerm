import { defineConfig } from "vitepress";

const sidebar = [
  {
    text: "Getting started",
    items: [
      { text: "Installation & updates", link: "/getting-started/installation" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Configuration", link: "/reference/configuration" },
      { text: "Keybindings", link: "/reference/keybindings" },
    ],
  },
  {
    text: "Features",
    items: [{ text: "Worktrees", link: "/features/worktrees" }],
  },
  {
    text: "Contributing",
    items: [
      { text: "Architecture", link: "/architecture" },
      { text: "Development", link: "/development" },
    ],
  },
];

export default defineConfig({
  title: "ClawTerm",
  description: "A terminal for managing AI coding agents.",
  // Pages site is /clawterm/, docs nest at /clawterm/docs/.
  base: "/clawterm/docs/",
  cleanUrls: true,
  lastUpdated: true,

  // The marketing landing and screenshots live alongside the docs source.
  // Skip them so VitePress doesn't try to render or copy them.
  srcExclude: [
    "README.md",
    "index.html",
    "robots.txt",
    "sitemap.xml",
    "screenshots/**",
    "favicon.*",
  ],
  // Source files cross-link to repo-root paths (../README.md, ../RELEASING,
  // ../../src-tauri/...) that exist on disk but aren't part of the docs site.
  // The links work on GitHub and in editors; they resolve to 404s here.
  ignoreDeadLinks: true,

  sitemap: {
    hostname: "https://clawterm.github.io/clawterm/docs/",
  },

  themeConfig: {
    siteTitle: "ClawTerm Docs",
    nav: [
      { text: "Home", link: "https://clawterm.github.io/clawterm/" },
      { text: "GitHub", link: "https://github.com/clawterm/clawterm" },
    ],
    sidebar: {
      "/": sidebar,
    },
    socialLinks: [{ icon: "github", link: "https://github.com/clawterm/clawterm" }],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/clawterm/clawterm/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3] },
    docFooter: { prev: "← Previous", next: "Next →" },
  },
});
