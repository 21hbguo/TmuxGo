export function shouldResumeFromContinuity(enabled: boolean, resumeOnReconnect: boolean, resumeOnNewDevice: boolean, hasLocalSession: boolean) {
  return enabled && (hasLocalSession ? resumeOnReconnect : resumeOnNewDevice)
}
