import * as fs from 'fs'
import { listStrictNullCheckEligibleFiles, getCheckedFiles } from './getStrictNullCheckEligibleFiles'
import { ErrorCounter } from './errorCounter'
import {isPrintHelp} from "../cli";
import * as ts from 'typescript';
import * as path from 'path'

const tsConfigPath = process.argv[2]
const tsConfigAltPath = process.argv[3] || tsConfigPath;
const srcRoot = path.dirname(tsConfigPath)

await tryAutoAddStrictNulls()

if (isPrintHelp() || !tsConfigPath) {
  console.log('Usage: npm run auto-add -- <your_project_path>/tsconfig.strictNullChecks.json [<your_project_path>/tsconfig.json]')
  console.log(`Optionally specify an alternate tsconfig.json file to use to get better functionality I'll document later.`)
  process.exit(0);
}

async function tryAutoAddStrictNulls() {
  let hasAddedFile = true
  const checkedFiles = await getCheckedFiles(tsConfigPath, srcRoot)

  const errorCounter = new ErrorCounter(tsConfigAltPath)

  // As long as auto-add adds a file, it's possible there's a new file that
  // depends on one of the newly-added files that can now be strict null checked
  while (hasAddedFile) {
    hasAddedFile = false

    const eligibleFiles = await listStrictNullCheckEligibleFiles(srcRoot, checkedFiles, tsConfigAltPath)
    console.log(`Found ${eligibleFiles.length} eligible files`)

    errorCounter.start()
    for (let i = 0; i < eligibleFiles.length; i++) {
      const relativeFilePath = path.relative(srcRoot, eligibleFiles[i])
      console.log(`Trying to auto add '${relativeFilePath}' (file ${i+1}/${eligibleFiles.length})`)

      const errorCount = await errorCounter.tryCheckingFile(relativeFilePath)
      if (errorCount === 0) {
        console.log(`👍`)
        addFileToConfig(relativeFilePath)
        hasAddedFile = true
      }
      else {
        console.log(`💥 - In ${relativeFilePath} found ${errorCount} error(s)`)
      }

      // const output = await errorCounter.tryCheckingFile2(relativeFilePath);
      // if (output !== '') {
      //   console.log('👍')
      //   addFileToConfig(relativeFilePath)
      //   hasAddedFile = true
      // } else {
      //   console.log(`💥 - In ${relativeFilePath} found ${output}`)
      // }
      // No point in trying to whitelist the file twice, regardless or success or failure
      checkedFiles.add(eligibleFiles[i])
    }
    errorCounter.end()
  }
}

function addFileToConfig(relativeFilePath: string) {
  const configPath = path.resolve(tsConfigPath);
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const tsconfig = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(configPath)
  ).raw;
  const _path = `./${relativeFilePath}`
  const excludeIndex = tsconfig.exclude.indexOf(_path)
  if (excludeIndex >= 0) {
    tsconfig.exclude.splice(excludeIndex, 1)
  } else {
    tsconfig.files = Array.from(new Set((tsconfig.files ?? []).concat(`./${relativeFilePath}`).sort()))
  }
  fs.writeFileSync(tsConfigPath, JSON.stringify(tsconfig, null, 2))
}
