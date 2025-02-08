# tsc-lint

Run `tsc` on multiple tsconfigs in parallel. Your `tsconfig.json` files are discovered automatically, and `.gitignore` files are respected. The `--emitDeclarationOnly` option is added for you, and `node_modules/.tsc-lint` is used as the output directory.

**Note:** [Project references][1] are not supported.

<img src="https://raw.githubusercontent.com/alloc/tsc-lint/main/.github/screenshot.png" alt="tsc-lint screenshot" />

```sh
pnpm add tsc-lint -D
```

Update your project's `package.json` to add a `lint` script.

```json
{
  "scripts": {
    "lint": "tsc-lint"
  }
}
```

By default, the working directory is searched for `tsconfig.json` files. You can pass one or more different directories as an argument, and those will be searched instead.

```sh
# Lint only your ./test/ folder.
pnpm lint test
```

### noEmit vs emitDeclarationOnly

If your project is consumed by other projects (e.g. a library), you **should not** have `noEmit` in your `tsconfig.json` files. The emit step is critical for catching certain errors, which is why `tsc-lint` uses the `--emitDeclarationOnly` option instead.

If you _are_ using `noEmit`, that will be detected and `tsc-lint` will avoid the emit step.

## Options

```sh
tsc-lint --help
```

## Troubleshooting

```sh
# Enable debug logging.
DEBUG="tsc-lint" pnpm lint
```

[1]: https://www.typescriptlang.org/docs/handbook/project-references.html
