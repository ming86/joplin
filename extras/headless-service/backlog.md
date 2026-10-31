# Deferred observations

Decision: 2026-09-21. At the user's request these observations are backlog items,
not prerequisites for beginning or delivering Phase 5. The accepted local Phase 3
and Phase 4 workflows remain accepted. Deferred does not mean tested or passed.

| ID | Observation | Current observation and eventual check |
| --- | --- | --- |
| B01 | Encrypted/locked-note UI behavior | Unobserved. Later use a safe disposable fixture; never change existing E2EE keys merely to manufacture one. |
| B02 | Physical mobile device behavior | Desktop and phone-sized browser emulation passed. Actual hardware remains unobserved. |
| B03 | Deployed HTTPS | Local loopback routes passed. Actual ingress, Secure-cookie operation and the clipper's remote HTTPS route remain unobserved. Never expose the raw Data API. |
| B04 | Actual PWA installation/relaunch | Manifest, icons and responsive UI exist. Installation/relaunch on the selected platform remains unobserved. |

The browser remains thin. This deferral adds no offline replication, persistent
browser drafts, full resource rendering, SSO or stronger concurrent-write guarantee.
Phase 5 retains separate tests for account isolation and worker lifecycle; those
are not a repetition of these deferred UI/device/deployment observations.
