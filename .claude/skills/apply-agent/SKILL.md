```markdown
# apply-agent Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches the core development patterns and conventions used in the `apply-agent` TypeScript codebase. You'll learn how to structure files, write and organize code, follow commit conventions, and run or write tests in alignment with the repository's established practices. While no specific framework is detected, the codebase emphasizes clarity, consistency, and maintainability.

## Coding Conventions

### File Naming

- Use **camelCase** for file names.
  - Example: `applyAgent.ts`, `userProfile.ts`

### Import Style

- Mixed import styles are used, including both named and default imports.
  - Example:
    ```typescript
    import applyAgent from './applyAgent';
    import { AgentConfig } from './types';
    ```

### Export Style

- Prefer **default exports** for modules.
  - Example:
    ```typescript
    const applyAgent = () => { /* ... */ };
    export default applyAgent;
    ```

### Commit Messages

- Use **Conventional Commits** with the `feat` prefix for new features.
  - Example:  
    ```
    feat: add support for multiple agent profiles
    ```

### Example File Structure

```
src/
  applyAgent.ts
  agentConfig.ts
  utils/
    parseInput.ts
tests/
  applyAgent.test.ts
```

## Workflows

### Feature Development

**Trigger:** When adding a new feature or functionality  
**Command:** `/feature`

1. Create a new TypeScript file using camelCase naming.
2. Implement the feature, using default exports for modules.
3. Import dependencies using mixed import styles as appropriate.
4. Write a corresponding test file named `[feature].test.ts`.
5. Commit your changes using the conventional commit format:
    ```
    feat: [short description of the feature]
    ```
6. Push your branch and open a pull request.

### Testing

**Trigger:** When verifying code correctness or adding new tests  
**Command:** `/test`

1. Locate or create a test file matching `*.test.ts`.
2. Write tests for your feature or module.
3. Run the test suite using the project's test runner (framework is unknown; check project scripts or documentation).
4. Ensure all tests pass before merging.

## Testing Patterns

- Test files are named using the pattern `*.test.ts`.
- The specific testing framework is **unknown**, but standard TypeScript testing practices apply.
- Example test file:
    ```typescript
    import applyAgent from '../src/applyAgent';

    describe('applyAgent', () => {
      it('should process input correctly', () => {
        // test implementation
      });
    });
    ```

## Commands

| Command    | Purpose                                   |
|------------|-------------------------------------------|
| /feature   | Start a new feature development workflow  |
| /test      | Run or add tests for the codebase         |
```
