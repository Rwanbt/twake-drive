// A source WindowProxy alone is insufficient: the containing app can navigate
// to a different origin while a reference to its window survives.
// Trust only the exact origin supplied by the Document Server at initialization.
export function isTrustedHostMessage(event, host, expectedOrigin) {
  return (
    typeof expectedOrigin === 'string' &&
    expectedOrigin.length > 0 &&
    event?.source === host &&
    event.origin === expectedOrigin
  )
}
