# tsc-lint

Run `tsc` on multiple tsconfigs in parallel. Your `tsconfig.json` files are discovered automatically, and `.gitignore` files are respected. The `--emitDeclarationOnly` option is added for you, and `node_modules/.tsc-lint` is used as the output directory.

**Note:** [Project references][1] are not supported.

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

Importantly, you **must not** have `noEmit` in your `tsconfig.json` files. The emit step is critical for catching certain errors, which is why `tsc-lint` uses the `--emitDeclarationOnly` option instead.

Finally, I should mention how the `tsc` output is processed. When a compiler error is reported, `tsc-lint` will rewrite the error's file path to be relative to the working directory. This allows you to click into the file from your terminal, even if the error comes from a nested tsconfig.

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
