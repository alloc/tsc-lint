#!/usr/bin/env node
import createDebug from 'debug'
import ignore from 'ignore'
import { cyan, gray, red, yellow } from 'nanocolors'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { dedent, parallel, select } from 'radashi'
import { GlobOptions, globSync } from 'tinyglobby'
import * as tsconfck from 'tsconfck'

const cwd = process.cwd()
const debug = createDebug('tsc-lint')
const gitIgnore = ignore()

let tscPath: string | undefined

findUp(cwd, (dir, files) => {
  debug(`Looking for gitignore${tscPath ? '' : ' or tsc binary'} in ${dir}`)

  if (!tscPath && files.includes('node_modules')) {
    const potentialTscPath = path.join(dir, 'node_modules/.bin/tsc')
    if (fileExists(potentialTscPath)) {
      tscPath = potentialTscPath
      debug(`Found tsc binary at ${tscPath}`)
    }
  }

  if (files.includes('.gitignore')) {
    const gitIgnorePath = path.join(dir, '.gitignore')

    let patterns = readFileSync(gitIgnorePath, 'utf8').split('\n')
    if (dir !== cwd) {
      // For gitignore files from ancestors, ignore any patterns with a leading "/" since those will
      // usually only apply within the ancestor directory.
      patterns = patterns.map(pattern => {
        if (pattern[0] === '#' || /^\s*$/.test(pattern)) {
          return pattern
        }
        let prefix = ''
        if (pattern[0] === '!') {
          prefix = '!'
          pattern = pattern.slice(1)
        }
        if (pattern[0] === '/') {
          return ''
        }
        return prefix + pattern
      })
    }

    if (debug.enabled) {
      debug(`Ignoring paths from ${gitIgnorePath}`)
      debug(
        select(patterns, pattern =>
          pattern && pattern[0] !== '#' ? `  ${pattern}` : undefined
        ).join('\n')
      )
    }

    gitIgnore.add(patterns)
  }
})

if (!tscPath) {
  console.error('tsc-lint: tsc binary not found')
  process.exit(1)
}

const { positionals: args, values: options } = util.parseArgs({
  allowPositionals: true,
  options: {
    ignore: {
      type: 'string',
      multiple: true,
      short: 'i',
    },
    help: {
      type: 'boolean',
    },
  },
})

if (options.help) {
  console.log(dedent`
    Usage: tsc-lint [...directories]

    Options:
    -i, --ignore <path>  Ignore paths matching the given pattern
  `)
  process.exit(0)
}

const globOptions: GlobOptions = (() => {
  const ignoredPaths = new Set(options.ignore)
  ignoredPaths.add('**/node_modules/**')
  return {
    ignore: [...ignoredPaths],
    dot: true,
  }
})()

for (const gitIgnorePath of globSync('**/.gitignore', globOptions)) {
  // Skip the root gitignore, which is already added.
  if (gitIgnorePath === '.gitignore') {
    continue
  }
  // Skip if the gitignore file is ignored.
  if (gitIgnore.ignores(gitIgnorePath)) {
    continue
  }

  const dir = path.dirname(gitIgnorePath)
  const patterns = readFileSync(gitIgnorePath, 'utf8')
    .split('\n')
    .map(line => {
      if (line[0] === '#' || /^\s*$/.test(line)) {
        return line
      }
      let prefix = ''
      if (line[0] === '!') {
        prefix = '!'
        line = line.slice(1)
      }
      if (line[0] === '/') {
        line = '/' + path.join(dir, line.slice(1))
      } else {
        line = path.join(dir, '**', line)
      }
      return prefix + line
    })

  if (debug.enabled) {
    debug(`Ignoring paths from ${gitIgnorePath}`)
    debug(
      select(patterns, pattern =>
        pattern && pattern[0] !== '#' ? `  ${pattern}` : undefined
      ).join('\n')
    )
  }

  gitIgnore.add(patterns)
}

const rootDirs = args.length > 0 ? args : ['.']

const tsconfigPaths = rootDirs
  .flatMap(cwd => {
    return globSync('**/tsconfig.json', {
      ...globOptions,
      absolute: true,
      cwd,
    })
  })
  .filter(tsconfig => {
    if (gitIgnore.ignores(path.relative(cwd, tsconfig))) {
      debug(`Skipped by .gitignore file: ${tsconfig}`)
      return false
    }
    return true
  })

type TsConfig = {
  path: string
  dir: string
  files: string[]
  noEmit: boolean
}

const tsconfigs = select(
  await Promise.all(
    tsconfigPaths.map(tsconfigPath => tsconfck.parse(tsconfigPath))
  ),
  ({ tsconfig, tsconfigFile }): TsConfig | undefined => {
    const tsconfigDir = path.dirname(tsconfigFile)
    if (tsconfig.files) {
      const files = (tsconfig.files as string[])
        .map(file => path.resolve(tsconfigDir, file))
        .filter(
          file => path.basename(file) !== 'tsconfig.json' && fileExists(file)
        )

      if (files.length > 0) {
        return {
          path: tsconfigFile,
          dir: tsconfigDir,
          files,
          noEmit: tsconfig.compilerOptions?.noEmit,
        }
      }

      debug(`Skipped tsconfig with no files: ${tsconfigFile}`)
      return
    }

    if (tsconfig.include?.length === 0) {
      debug(`Skipped tsconfig with no files: ${tsconfigFile}`)
      return
    }

    const exclude: string[] = tsconfig.exclude ?? [
      '**/node_modules',
      '**/bower_components',
      '**/jspm_packages',
    ]

    const files = globSync(tsconfig.include ?? '**/*', {
      cwd: tsconfigDir,
      absolute: true,
      ignore: [...exclude, '**/tsconfig.json'],
      dot: true,
    })

    if (files.length > 0) {
      return {
        path: tsconfigFile,
        dir: tsconfigDir,
        files,
        noEmit: tsconfig.compilerOptions?.noEmit,
      }
    }

    debug(`Skipped tsconfig with no files: ${tsconfigFile}`)
  }
)

console.log(`🔍 Found ${yellow(tsconfigs.length)} tsconfig files.`)

const nodeModulesDir = path.resolve(tscPath, '../..')
const tscOutputDir = path.join(nodeModulesDir, '.tsc-lint')

// Sort deeper tsconfigs first.
tsconfigs.sort((a, b) => a.path.length - b.path.length)

const checkedFiles = new Set<string>()
const runCheck = (tsconfig: TsConfig) => {
  // Filter out files already covered by a deeper tsconfig.
  const files = select(
    tsconfig.files,
    file => path.relative(cwd, file),
    file => {
      if (checkedFiles.has(file)) {
        return false
      }
      checkedFiles.add(file)
      return true
    }
  )

  return new Promise<void>((resolve, reject) => {
    // Handle cases where a package depends on a different TypeScript version.
    let ownTscPath: string | undefined
    findUp(tsconfig.dir, (dir, files) => {
      if (files.includes('node_modules')) {
        const tscPath = path.join(dir, 'node_modules/.bin/tsc')
        if (fileExists(tscPath)) {
          ownTscPath = tscPath
          return true
        }
      }
    })

    const tscArgs = ['--project', tsconfig.path, '--outDir', tscOutputDir]
    if (!tsconfig.noEmit) {
      tscArgs.push('--declaration', '--emitDeclarationOnly')
    }

    const child = spawn(ownTscPath ?? tscPath!, tscArgs, {
      stdio: ['ignore', 'pipe', 'inherit'],
    })

    let buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      buffer += data
    })

    child.on('error', reject)
    child.on('close', code => {
      const errors =
        code !== 0
          ? Array.from(
              buffer.matchAll(/^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)
            ).filter(([, file]) => files.includes(file))
          : []

      if (errors.length > 0) {
        process.exitCode = 1
        console.log(
          '\n🔻 ' +
            `Found ${red(errors.length)} error${errors.length === 1 ? '' : 's'} with ` +
            cyan(path.relative(cwd, tsconfig.path))
        )
        for (const [, file, line, column, code, message] of errors) {
          console.log(
            '\n' +
              cyan(file) +
              ':' +
              yellow(line) +
              ':' +
              yellow(column) +
              ' - ' +
              red('error') +
              ' ' +
              gray(code) +
              '\n  ' +
              message
          )
        }
      } else {
        console.log(
          '\n✨ ' +
            `Found ${gray(0)} errors with ` +
            gray(path.relative(cwd, tsconfig.path))
        )
      }
      resolve()
    })
  })
}

await parallel({ limit: cpus().length }, tsconfigs, runCheck).catch(error => {
  const { errors } = error as AggregateError
  for (const error of errors) {
    console.error(error)
  }
  process.exit(1)
})

function fileExists(path: string) {
  try {
    const stats = statSync(path)
    return stats.isFile() || stats.isSymbolicLink()
  } catch (error) {
    return false
  }
}

function findUp(
  dir: string,
  callback: (dir: string, files: string[]) => boolean | void
) {
  const { root } = path.parse(dir)
  while (true) {
    if (callback(dir, readdirSync(dir))) {
      return
    }
    if (dir === root) {
      return
    }
    dir = path.dirname(dir)
  }
}
