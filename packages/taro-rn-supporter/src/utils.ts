import * as helper from '@tarojs/helper'
import * as fs from 'fs'
import { isEmpty, merge } from 'lodash'
import { networkInterfaces } from 'os'
import * as path from 'path'

import { Config, RNConfig } from './types/index'

// 编译config
let GLOBAL_CONFIG: Config = {}
let FROM_TARO = false
let RN_CONFIG: RNConfig = {}

function getProjectConfig () {
  if (!isEmpty(GLOBAL_CONFIG)) return GLOBAL_CONFIG
  const fileName = `${process.cwd()}/config/index.js`
  if (fs.existsSync(fileName)) {
    GLOBAL_CONFIG = require(`${process.cwd()}/config/index`)(merge)
    return GLOBAL_CONFIG
  } else {
    console.warn('缺少项目基本配置')
    GLOBAL_CONFIG = {}
    return GLOBAL_CONFIG
  }
}

function getRNConfig () {
  if (!isEmpty(RN_CONFIG)) return RN_CONFIG

  const config = getProjectConfig()
  if (config.rn) {
    RN_CONFIG = config.rn
  } else {
    RN_CONFIG = {}
  }
  return RN_CONFIG
}

function setFromRunner (fromTaro: boolean) {
  FROM_TARO = fromTaro
}

function isTaroRunner () {
  return FROM_TARO
}

function isRegExp (string) {
  return string.startsWith('^') || string.endsWith('$')
}

function isRelativePath (filePath) {
  return filePath.match(/^\.?\.\//)
}

function escapeRegExp (string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getAliasTarget (key, isKeyRegExp) {
  const regExpPattern = isKeyRegExp ? key : `^${escapeRegExp(key)}(/.*|)$`
  return new RegExp(regExpPattern)
}

function getAlias () {
  const config = getProjectConfig()
  const rnConfig = config.rn || {}
  let alias = {}
  if (rnConfig.alias) {
    alias = rnConfig.alias
  } else if (config.alias) {
    alias = config.alias
  }

  alias['@tarojs/components'] = '@tarojs/components-rn'
  alias['@tarojs/taro'] = '@tarojs/taro-rn'
  return alias
}

// [ [/xyz$/, '/abc/path/to/file.js'], ['xyz', '/abc/path/to/file.js'] ]
function normalizeAlias () {
  const alias = getAlias()
  const aliasKeys = Object.keys(alias)
  return aliasKeys.map(key => {
    const isKeyRegExp = isRegExp(key)
    return [getAliasTarget(key, isKeyRegExp), alias[key]]
  })
}

// Refrence https://webpack.js.org/configuration/resolve/#resolvealias
function resolvePathFromAlias (moduleName) {
  let newModuleName = moduleName
  const aliasPairs = normalizeAlias()
  aliasPairs.find(([regExp, aliasValue]) => {
    const execResult = regExp.exec(moduleName)
    if (execResult === null) {
      return false
    }
    const [, restPath] = execResult
    let modulePath = aliasValue
    if (isRelativePath(aliasValue)) {
      modulePath = path.resolve(process.cwd(), aliasValue)
    }
    newModuleName = path.join(modulePath, restPath) // fix window path
    return true
  })
  return newModuleName
}

// lookup modulePath if the file path exist
// import './a.scss'; import './app'; import '/app'; import 'app'; import 'C:\\\\app';
function lookup (modulePath, platform, isDirectory = false) {
  const extensions = ([] as string[]).concat(helper.JS_EXT, helper.TS_EXT, helper.CSS_EXT)
  const omitExtensions = ([] as string[]).concat(helper.JS_EXT, helper.TS_EXT)
  const ext = path.extname(modulePath).toLowerCase()
  const extMatched = !!extensions.find(e => e === ext)
  // when platformExt is empty string('') it means find modulePath itself
  const platformExts = [`.${platform}`, '.rn', '']
  // include ext
  if (extMatched) {
    for (const plat of platformExts) {
      const platformModulePath = modulePath.replace(ext, `${plat}${ext}`)
      if (fs.existsSync(platformModulePath)) {
        return platformModulePath
      }
    }
  }
  // handle some omit situations
  for (const plat of platformExts) {
    for (const omitExt of omitExtensions) {
      const platformModulePath = `${modulePath}${plat}${omitExt}`
      if (fs.existsSync(platformModulePath)) {
        return platformModulePath
      }
    }
  }
  // it is lookup in directory and the file path not exists, then return origin module path
  if (isDirectory) {
    return path.dirname(modulePath) // modulePath.replace(/\/index$/, '')
  }
  // handle the directory index file
  const moduleIndexPath = path.join(modulePath, 'index')
  return lookup(moduleIndexPath, platform, true)
}

/**
 * 处理平台优先级文件
 * @param {Object} context
 * @param {string} [context.originModulePath] 当前模块文件的路径
 * @param {string} moduleName 当前模块引入的模块名
 * @param {string} platform 编译的平台 ios/android
 */
function resolveExtFile ({ originModulePath }, moduleName, platform) {
  // ignore node_modules except include config
  if (originModulePath.indexOf('node_modules') > -1 && !includes(originModulePath)) {
    return moduleName
  }
  let modulePath = ''
  const currentPath = path.dirname(originModulePath)
  if (path.isAbsolute(moduleName)) {
    modulePath = moduleName
  } else if (isRelativePath(moduleName)) {
    modulePath = path.resolve(currentPath, moduleName)
  } else {
    // import node modules file like `import _ from 'lodash'`
    // TODO: it is not rigorous, because in the project files directory may be have mutiple node_modules not just project root directory.
    // to fix it may be need a lookup algorithm.
    const tempPath = path.join(process.cwd(), 'node_modules', moduleName)
    if (includes(tempPath)) {
      modulePath = tempPath
    }
  }

  if (modulePath) {
    // return the file path if it exists, otherwise return to the original path
    return lookup(modulePath, platform)
  }
  return moduleName
}

function includes (filePath: string): boolean {
  const config = getRNConfig()
  const include = config?.resolve?.include || []
  if (!include.length) return false

  filePath = filePath.replace(/\\/g, '/')

  const res = include.find(item => filePath.includes(`node_modules/${item}`))
  return Boolean(res)
}

// 获取resolver 需要过滤的文件
function getBlockList (){
  const regExp: Array<RegExp> = []
  const config = getProjectConfig()
  const srcDir = config?.sourceRoot ?? 'src'
  const path = `${process.cwd()}/${srcDir}/app.config`
  const configPath = helper.resolveMainFilePath(path)
  const appConfig = helper.readConfig(configPath)
  if( appConfig?.pages?.length === 1 && !!appConfig?.rn?.singleMode){
    regExp.push(/@tarojs\/router-rn/)
  }
  return regExp
}

export {
  getBlockList,
  getProjectConfig,
  getRNConfig,
  includes,
  isRelativePath,
  isTaroRunner,
  resolveExtFile,
  resolvePathFromAlias,
  setFromRunner }

export function getOpenHost () {
  let result
  const interfaces = networkInterfaces()
  for (const devName in interfaces) {
    const isEnd = interfaces[devName]?.some(item => {
      // 取IPv4, 不为127.0.0.1的内网ip
      if (['IPv4', 4, '4'].includes(item.family) && item.address !== '127.0.0.1' && !item.internal) {
        result = item.address
        return true
      }
      return false
    })
    // 若获取到ip, 结束遍历
    if (isEnd) {
      break
    }
  }
  return result
}

export const PLAYGROUNDREPO = 'https://github.com/wuba/taro-playground'

export const PLAYGROUNDINFO = `use [Taro Playground App](${PLAYGROUNDREPO}) to scan`

export const isWin = /^win/.test(process.platform)
