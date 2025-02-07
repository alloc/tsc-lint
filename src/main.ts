#!/usr/bin/env node
import createDebug from 'debug'
import ignore from 'ignore'
import { cyan } from 'nanocolors'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { parallel, select } from 'radashi'
import { GlobOptions, globSync } from 'tinyglobby'

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

const { positionals, values } = util.parseArgs({
  allowPositionals: true,
  options: {
    ignore: {
      type: 'string',
      multiple: true,
      short: 'i',
    },
  },
})

const globOptions: GlobOptions = (() => {
  const ignoredPaths = new Set(values.ignore)
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

const rootDirs = positionals.length > 0 ? positionals : ['.']

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

const nodeModulesDir = path.dirname(tscPath)
const tscOutputDir = path.join(nodeModulesDir, '.tsc-lint')

parallel({ limit: cpus().length }, tsconfigPaths, tsconfigPath => {
  return new Promise<void>((resolve, reject) => {
    const tsconfigDir = path.dirname(tsconfigPath)
    console.log(cyan(`◌ Using ./${path.relative(cwd, tsconfigPath)}`))

    // Handle cases where a package depends on a different TypeScript version.
    let ownTscPath: string | undefined
    findUp(tsconfigDir, (dir, files) => {
      if (files.includes('node_modules')) {
        const tscPath = path.join(dir, 'node_modules/.bin/tsc')
        if (fileExists(tscPath)) {
          ownTscPath = tscPath
          return true
        }
      }
    })

    const child = spawn(
      ownTscPath ?? tscPath!,
      [
        '--project',
        tsconfigPath,
        '--outDir',
        tscOutputDir,
        '--declaration',
        '--emitDeclarationOnly',
      ],
      {
        stdio: ['ignore', 'inherit', 'pipe'],
      }
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => {
      process.stderr.write(data)
    })

    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        process.exitCode = 1
      }
      resolve()
    })
  })
}).catch(error => {
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
