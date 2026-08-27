# Changelog

## 1.0.0 (2026-08-27)


### Features

* Add application outcome history ([35cc711](https://github.com/getyak/apply-agent/commit/35cc711be4d00ede0bce499d88c8a8abf8834373))
* Add Career Graph import review ([0691bcf](https://github.com/getyak/apply-agent/commit/0691bcf7edf209fdf292fcc36e2235cc1bc96b78))
* Add reproducible Career Graph compiler profiles ([30859c2](https://github.com/getyak/apply-agent/commit/30859c228b4c8a08723afb12956fe27266ff8484))
* Add stable resume publication history ([87dec4e](https://github.com/getyak/apply-agent/commit/87dec4eeb03ccbf01940118df6a5242aacfe5612))
* **agents,api:** Wire LangGraphAGUIAdapter + gateway pass-through [PR2/4] ([f8f6f9f](https://github.com/getyak/apply-agent/commit/f8f6f9f8c2517389987593c254fb1b3c0b8502c6))
* **api,agents:** Propagate X-Relay-Locale through prepare-from-jd → agent ([01a5e5b](https://github.com/getyak/apply-agent/commit/01a5e5b14f3c3814cd428142e00aeb0dbc7589ac))
* **api,agents:** Propagate X-Relay-Locale through prepare-from-jd → agent + 2 fixes ([c399418](https://github.com/getyak/apply-agent/commit/c399418de18e0716a07ace2678995b0e425be42e))
* **api:** X-Relay-Locale 单一真理源 + Round-12 audit 修复 ([314d8a0](https://github.com/getyak/apply-agent/commit/314d8a029b6c9e65cd32ef9d5d8ad2af335c6742))
* Calibrate Career Graph artifacts ([05fb0f6](https://github.com/getyak/apply-agent/commit/05fb0f605a3385d385439974a2ce53f152970485))
* Close out 6-track MVP — TrendAgent + dual-track UI + 8 chain scorecards ≥99 ([#27](https://github.com/getyak/apply-agent/issues/27)) ([3181ffd](https://github.com/getyak/apply-agent/commit/3181ffdf390241c42a2a82960d2f0da279ce3ca9))
* Deliver review-gated resume artifacts ([a7b3dfc](https://github.com/getyak/apply-agent/commit/a7b3dfcbd60f73f2d7ecc7dcd1daeb8e17c73199))
* **dock:** Chat-agent system + Manus-style live UX ([3bdd30f](https://github.com/getyak/apply-agent/commit/3bdd30fb86a82569d49a862443d11a5c0d2e12b5))
* **dock:** Inline reasoning lane + tool input/output detail across agents/api/web ([720e23a](https://github.com/getyak/apply-agent/commit/720e23a85045b483560c182bf5e575549f2ec03f))
* **dock:** Multi-session + / command palette + reply_locale enforcement ([#26](https://github.com/getyak/apply-agent/issues/26)) ([19b07b6](https://github.com/getyak/apply-agent/commit/19b07b6aa378f0c6135acf54ea1efd875a0c997a))
* **dock:** SSE stream resume — 3-layer cursor + retry + expired UX ([#28](https://github.com/getyak/apply-agent/issues/28)) ([60203a3](https://github.com/getyak/apply-agent/commit/60203a36d5873ab37b16f2727bb06785d4cdbba3))
* Full-stack MVP — API layer, frontend integration, infra & CI/CD ([a874272](https://github.com/getyak/apply-agent/commit/a874272eb2094a5b9837c2cdc85e57234d094a32))
* Full-stack MVP — API, frontend, infra & CI/CD ([ad01a4e](https://github.com/getyak/apply-agent/commit/ad01a4edf28bfd3a970991e84551023d4d64a3dc))
* Full-stack MVP — infra, agents, API, web (Vantage UI + vibe chat + applications kanban) ([#7](https://github.com/getyak/apply-agent/issues/7)) ([c36e1d7](https://github.com/getyak/apply-agent/commit/c36e1d7a181eda042bd7b11821982c37ab8ae5f2))
* Harden recoverable application workflows ([9325b00](https://github.com/getyak/apply-agent/commit/9325b000f7030bd21cc0a75a92b73a101b4b7ed8))
* Résumé editor + async pipeline (publish, export, dock真问真答) ([#12](https://github.com/getyak/apply-agent/issues/12)) ([3950049](https://github.com/getyak/apply-agent/commit/39500493fa07381fa6f576b6086644feb141df7e))
* Secure remote career MCP delivery ([66ea11f](https://github.com/getyak/apply-agent/commit/66ea11f6494c808618092f9ec2a80c68e4eedbc9))
* Ship recoverable Codex career workflows ([3adc43b](https://github.com/getyak/apply-agent/commit/3adc43bba66ee5104faee2b4a0f83864083aef97))


### Bug Fixes

* Add bun-types type declaration for tsc typecheck ([8d5e1fd](https://github.com/getyak/apply-agent/commit/8d5e1fdd341cb55d6ee89e8b666f44c7f39cdc51))
* **api+agents:** Unified error envelope on auth/422 + redis fail-open [round 21] ([45bf705](https://github.com/getyak/apply-agent/commit/45bf7052e76fd78d5d1312c52b153b2ed36d2428))
* **api:** Route auth middleware errors through unified envelope ([4cefc5a](https://github.com/getyak/apply-agent/commit/4cefc5af544686c06ec509a0ee38fee41fa1d07b))
* Calibrate Office artifact rendering ([9a1f9ea](https://github.com/getyak/apply-agent/commit/9a1f9eaf87ea64b64710fa996572bce13108a630))
* **dock:** Answer "查看简历版本" inline instead of routing to update + jump card ([a76aacb](https://github.com/getyak/apply-agent/commit/a76aacbbcbf34831cdf0acee0b9fccaa6b86a05d))
* Resolve CI pipeline issues — path mismatches, missing scripts, action version bumps ([31304e0](https://github.com/getyak/apply-agent/commit/31304e081948a565059402ddc08ee4f5909c3cc3))
* Resolve CI pipeline issues — path mismatches, missing scripts, action version bumps ([cd35ea6](https://github.com/getyak/apply-agent/commit/cd35ea693c4fbf5465a28f9551920c57a14d3da3))
* **round-12 audit:** Resume Studio + dock heartbeat + i18n locale 全栈 ([c4626ad](https://github.com/getyak/apply-agent/commit/c4626ad6f97627c01a5f6b0b9587d5f2f8afd7e8))
* Strip shell proxy vars before agents construct httpx clients ([5e44ed5](https://github.com/getyak/apply-agent/commit/5e44ed53062c471b59eb19fa70d351f9391e4f2f))


### Documentation

* Self-improving agent-loop test harness + 2026-06-30 runs ([eb3bd87](https://github.com/getyak/apply-agent/commit/eb3bd87eb064574d6419749282673038523cdcea))
