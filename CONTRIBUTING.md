# Contributing to Reflect Memory

Thanks for your interest in contributing. This guide covers how to report issues, suggest features, and submit code.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/van-reflect/Reflect-Memory/issues) with:

- A clear, descriptive title
- Steps to reproduce the bug
- Expected vs. actual behavior
- Environment details (Node version, OS, SDK version)
- Relevant logs or error messages

Check existing issues first to avoid duplicates.

## Suggesting Features

Open a [GitHub Issue](https://github.com/van-reflect/Reflect-Memory/issues) or start a [Discussion](https://github.com/van-reflect/Reflect-Memory/discussions) with:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Development Setup

```bash
git clone https://github.com/van-reflect/Reflect-Memory.git
cd Reflect-Memory
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```
REFLECT_API_KEY=your_api_key_here
```

Get an API key at [reflectmemory.com](https://reflectmemory.com).

## Code Style

- **TypeScript** is the primary language. All new code should be written in TypeScript.
- Use strict typing, avoid `any` where possible.
- Do not add comments that merely narrate what the code does. Comments should explain *why*, not *what*.
- No AI-generated comments, no boilerplate comment blocks.
- Use `const` over `let` when the variable is not reassigned.
- Keep functions small and focused.

## Pull Request Process

1. Fork the repo and create a branch from `main`.
2. Make your changes in a focused, single-purpose branch.
3. Write or update tests if applicable.
4. Make sure the build passes and there are no lint errors.
5. Open a PR against `main` with:
   - A clear title describing the change
   - A summary of what changed and why
   - Links to any related issues
6. A maintainer will review your PR. Be responsive to feedback.

### PR Tips

- Keep PRs small. Smaller PRs get reviewed faster.
- One logical change per PR.
- Rebase on `main` before opening if your branch is behind.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you agree to uphold a respectful, inclusive environment.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
