# Contributing

Thanks for your interest in ClawTerm! This project is open source under the MIT License — anyone can fork, modify, and use it. Contributions to this repository go through PR review by the maintainer.

## Setup

```bash
git clone https://github.com/clawterm/clawterm.git
cd clawterm
npm install
npm run tauri dev
```

Requires [Rust](https://rustup.rs/) (stable) and [Node.js](https://nodejs.org/) 18+. macOS needs Xcode CLI tools (`xcode-select --install`).

## Workflow

1. Branch off `main` — one feature or fix per PR
2. Run `npm run preflight` before pushing (lint, format, test, typecheck)
3. Open a PR using the [pull request template](.github/PULL_REQUEST_TEMPLATE.md)
4. A maintainer will review — all PRs require approval before merge

## Reporting bugs

Use the [bug report template](https://github.com/clawterm/clawterm/issues/new?template=bug_report.yml). Include your ClawTerm version, OS, and steps to reproduce.

## Suggesting features

Use the [feature request template](https://github.com/clawterm/clawterm/issues/new?template=feature_request.yml). Describe the problem you're solving and your proposed approach.

## Review process

All code changes go through PR review. The `CODEOWNERS` file assigns reviewers automatically. CI must pass (lint, format, test, typecheck) before a PR can be merged.

## License

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
