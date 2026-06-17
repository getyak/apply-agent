// Purpose: enforce Conventional Commits with project-specific scopes.
// When to edit: when a new top-level area emerges (new app, new domain).
// Used by: commitlint CLI (locally via lefthook commit-msg, or in CI).

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'perf',
        'docs',
        'test',
        'chore',
        'ci',
        'build',
        'style',
        'revert',
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        // Top-level areas — aligned with .github/labels.yml scope:* labels.
        'api',
        'agents',
        'web',
        'extension',
        'infra',
        'eval',
        'prompts',
        'docs',
        'ci',
        'deps',
        // Sub-areas (optional, finer-grained).
        'harness',
        'coordinator',
        'resume',
        'jobmatch',
        'interview',
        'appprep',
        'trend',
        'db',
        'redis',
        'minio',
      ],
    ],
    'scope-empty': [2, 'never'],
    'subject-case': [2, 'always', ['sentence-case', 'lower-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'body-leading-blank': [1, 'always'],
    'footer-leading-blank': [1, 'always'],
  },
  prompt: {
    questions: {
      scope: {
        description:
          'Scope of this change (api/agents/web/extension/infra/eval/prompts/docs/ci/...)',
      },
    },
  },
};
