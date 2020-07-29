import path from "path"
import openurl from "better-opn"
import fs from "fs-extra"
import compression from "compression"
import express from "express"
import { createServer as createSecureServer } from "https"
import chalk from "chalk"
import { match as reachMatch } from "@reach/router/lib/utils"
import onExit from "signal-exit"
import report from "gatsby-cli/lib/reporter"

import telemetry from "gatsby-telemetry"

import { detectPortInUseAndPrompt } from "../utils/detect-port-in-use-and-prompt"
import { getConfigFile } from "../bootstrap/get-config-file"
import { preferDefault } from "../bootstrap/prefer-default"
import { IProgram } from "./types"
import { IPreparedUrls, prepareUrls } from "../utils/prepare-urls"
import { getSslCert } from "../utils/get-ssl-cert"

interface IMatchPath {
  path: string
  matchPath: string
}

interface IServeProgram extends IProgram {
  prefixPaths: boolean
}

onExit(() => {
  telemetry.trackCli(`SERVE_STOP`)
})

const readMatchPaths = async (
  program: IServeProgram
): Promise<IMatchPath[]> => {
  const filePath = path.join(program.directory, `.cache`, `match-paths.json`)
  let rawJSON = `[]`
  try {
    rawJSON = await fs.readFile(filePath, `utf8`)
  } catch (error) {
    report.warn(error)
    report.warn(
      `Could not read ${chalk.bold(
        `match-paths.json`
      )} from the .cache directory`
    )
    report.warn(
      `Client-side routing will not work correctly. Maybe you need to re-run ${chalk.bold(
        `gatsby build`
      )}?`
    )
  }
  return JSON.parse(rawJSON) as IMatchPath[]
}

const matchPathRouter = (
  matchPaths: IMatchPath[],
  options: {
    root: string
  }
) => (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void => {
  const { url } = req
  if (req.accepts(`html`)) {
    const matchPath = matchPaths.find(
      ({ matchPath }) => reachMatch(matchPath, url) !== null
    )
    if (matchPath) {
      return res.sendFile(
        path.join(matchPath.path, `index.html`),
        options,
        err => {
          if (err) {
            next()
          }
        }
      )
    }
  }
  return next()
}

module.exports = async (program: IServeProgram): Promise<void> => {
  telemetry.trackCli(`SERVE_START`)
  telemetry.startBackgroundUpdate()
  let { prefixPaths, port, open, host } = program
  port = typeof port === `string` ? parseInt(port, 10) : port

  const { configModule } = await getConfigFile(
    program.directory,
    `gatsby-config`
  )
  const config = preferDefault(configModule)

  const { pathPrefix: configPathPrefix } = config || {}

  const pathPrefix = prefixPaths && configPathPrefix ? configPathPrefix : `/`

  const root = path.join(program.directory, `public`)

  const app = express()
  const router = express.Router()

  app.use(telemetry.expressMiddleware(`SERVE`))

  router.use(compression())
  router.use(express.static(`public`, { dotfiles: `allow` }))
  const matchPaths = await readMatchPaths(program)
  router.use(matchPathRouter(matchPaths, { root }))
  router.use((req, res, next) => {
    if (req.accepts(`html`)) {
      return res.status(404).sendFile(`404.html`, { root })
    }
    return next()
  })
  app.use(function (
    _: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    res.header(`Access-Control-Allow-Origin`, `*`)
    res.header(
      `Access-Control-Allow-Headers`,
      `Origin, X-Requested-With, Content-Type, Accept`
    )
    next()
  })
  app.use(pathPrefix, router)

  function printInstructions(appName: string, urls: IPreparedUrls): void {
    console.log()
    console.log(`You can now view ${chalk.bold(appName)} in the browser.`)
    console.log()

    if (urls.lanUrlForTerminal) {
      console.log(
        `  ${chalk.bold(`Local:`)}            ${urls.localUrlForTerminal}`
      )
      console.log(
        `  ${chalk.bold(`On Your Network:`)}  ${urls.lanUrlForTerminal}`
      )
    } else {
      console.log(`  ${urls.localUrlForTerminal}`)
    }
  }

  const startListening = async (): Promise<void> => {
    const listeningListener = (): void => {
      const urls = prepareUrls(
        program.https ? `https` : `http`,
        program.host,
        port
      )
      printInstructions(
        program.sitePackageJson.name || `(Unnamed package)`,
        urls
      )
      if (open) {
        report.info(`Opening browser...`)
        Promise.resolve(openurl(urls.localUrlForBrowser)).catch(() =>
          report.warn(`Browser not opened because no browser was found`)
        )
      }
    }

    if (program.https) {
      // In order to enable custom ssl, --cert-file --key-file and -https flags must all be
      // used together
      if ((program[`cert-file`] || program[`key-file`]) && !program.https) {
        report.error(
          `for custom ssl --https, --cert-file, and --key-file must be used together`
        )
      }
      const sslHost =
        program.host === `0.0.0.0` || program.host === `::`
          ? `localhost`
          : program.host

      const ssl = await getSslCert({
        name: sslHost,
        caFile: program[`ca-file`],
        certFile: program[`cert-file`],
        keyFile: program[`key-file`],
        directory: program.directory,
      })

      if (ssl) {
        const httpsServer = createSecureServer(ssl, app)
        httpsServer.listen({ port, host }, listeningListener)
      } else {
        report.error(`error getting ssl certs`)
      }
    } else {
      app.listen(port, host, listeningListener)
    }
  }

  try {
    port = await detectPortInUseAndPrompt(port)
    await startListening()
  } catch (e) {
    if (e.message === `USER_REJECTED`) {
      return
    }

    throw e
  }
}
