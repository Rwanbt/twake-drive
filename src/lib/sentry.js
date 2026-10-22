import * as Sentry from '@sentry/react'
import { useEffect } from 'react'
import {
  Routes,
  useLocation,
  useNavigationType,
  createRoutesFromChildren,
  matchRoutes
} from 'react-router-dom'

import appMetadata from '@/lib/appMetadata'

// The Sentry DSN is opt-in and is injected at build time. It must never be
// baked into the bundle: a self-hosted deployment would otherwise report its
// errors, and the context they carry, to a third party the operator never
// chose. Without an explicit DSN, Sentry stays disabled and nothing leaves
// the deployment.
const sentryDsn =
  typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : ''

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV,
    release: appMetadata.version,
    integrations: [
      // We also want to capture the `console.error` to, among other things,
      // report the logs present in the `try/catch
      Sentry.captureConsoleIntegration({ levels: ['error'] }),
      Sentry.reactRouterV6BrowserTracingIntegration({
        useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes
      })
    ],
    tracesSampleRate: 0.1,
    // React log these warnings(bad Proptypes), in a console.error,
    // it is not relevant to report this type of information to Sentry
    ignoreErrors: [/^Warning: /]
  })
}

export const SentryRoutes = Sentry.withSentryReactRouterV6Routing(Routes)
