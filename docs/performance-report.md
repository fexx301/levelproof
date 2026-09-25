# Performance and accessibility evidence

## Historical headed desktop measurement

An earlier local browser pass used headed Chrome 153 on a MacBook-class M4 Pro,
1512×900 at DPR 2. During an eight-second replay sample it observed about
120 FPS, approximately 9.3 ms p95 frame time, and no frame above 33 ms or long
startup task in that sample. This is historical, not a measurement of the
current build. The current automated suite forces SwiftShader, so its much
lower frame rate below is not directly comparable. A fresh ordinary-GPU
measurement on the current build remains outstanding.

The production build currently separates React, validation, Three.js core, and
Three.js renderer chunks. The largest generated JavaScript chunks in the last
local build were approximately 374 KB for the renderer, 219 KB for React, and
203 KB for Three.js core before compression. Chunking improves cache isolation;
it is not a claim of lower total download size or faster startup without a
fresh production measurement.

## Still to measure

- [x] Five cold and five warm production-preview startup samples on local Chromium/SwiftShader; results below.
- [ ] Repeat startup measurements against the deployed CDN/build on an ordinary GPU-backed desktop.
- [ ] Safari.
- [ ] Real phone hardware.
- [ ] Lower-powered laptop.
- [ ] Repeated theme/replay cycles with memory/resource-growth inspection.
- [ ] Production backend latency and error rate.

## Initial 2026-09-23 local production-preview sample

Measured by `e2e/performance.e2e.ts` against the built app served by Vite
preview. Chromium 153.0.8010.12 used Playwright SwiftShader, a 1280×720
viewport, DPR 1. Five fresh browser contexts provided cold samples; each was
reloaded once in the same context for its warm sample. The server was local,
not Vercel/CDN. “Scene controls ready” is a proxy: a visible canvas, enabled
Frame level control, and a live WebGL2 context. It does not measure pointer
latency or frame pacing.

| Metric | Cold median (range) | Warm median (range) |
| --- | ---: | ---: |
| First contentful paint | 170 ms (84–456 ms; 4/5 samples reported) | 912 ms (868–1,184 ms; 5/5) |
| Scene canvas visible | 184 ms | 535 ms |
| Scene controls-ready proxy | 184 ms | 535 ms |
| JavaScript transfer | 279,896 B | 1,800 B |
| Total resource transfer | 338,477 B | 2,100 B |

No resource returned an HTTP error. Three startup long tasks were observed,
55–56 ms each. The slower warm reload timing is recorded as observed; this
sample is small and the software-rendered local browser is not representative
of a typical GPU-backed user device. The per-run JSON is in ignored Playwright
`test-results/` output and can be regenerated with
`npm run test:e2e -- --grep 'five cold and warm'`.

An earlier eight-test, two-worker interaction suite re-ran the benchmark at
`2026-09-23T02:57:20Z`: cold FCP median 464 ms (5/5 reported; 224–472 ms),
warm FCP median 908 ms (4/5 reported; 904–948 ms), scene-ready medians 81 ms
cold and 528 ms warm, one 76 ms long task, and no failed resources. Because
the interaction browsers were running concurrently, these numbers are not
pooled into the isolated figures above; the difference shows that the
software-browser result is sensitive to host/test load.

## Final serial run: 2026-09-23

The final command was `npm run test:e2e -- --workers=1`. It rebuilt the
production app and ran Chromium 153.0.8010.12 with SwiftShader at 1280×720,
DPR 1. Five fresh browser contexts provided cold samples, each followed by one
reload for its warm sample. No resource request failed.

| Metric | Cold median (range) | Warm median (range) |
| --- | ---: | ---: |
| First contentful paint | 88 ms (84–576 ms; 5/5) | 964 ms (936–972 ms; 5/5) |
| Scene canvas visible | 113.3 ms | 570.2 ms |
| Scene controls-ready proxy | 113.6 ms | 570.3 ms |
| JavaScript transfer | 282,234 B | 1,800 B |
| Total resource transfer | 340,966 B | 2,100 B |

Four startup long tasks of 57–59 ms were observed. The cold FCP range is wide,
and warm FCP remained slower than cold in this small sample; both are recorded
without inferring a cause. The per-run JSON is in ignored Playwright output and
can be regenerated with `npm run test:e2e -- --grep 'five cold and warm'`.

The same run recorded a replay at `2026-09-23T04:25:26Z`: 55 frames in
8,135.9 ms (6.76 observed FPS), median frame interval 150 ms, p95 166.7 ms,
maximum 416.7 ms, and 53 frames above 33 ms. The witness reached move 4 of 7.
Because SwiftShader is explicitly enabled, this is not an ordinary GPU frame
rate. It does not establish performance readiness; a current hardware-backed
sustained replay measurement is still required.

## Accessibility checks to repeat

- [x] Core prompt → preview → approval → manual-play keyboard path at
  390×844; focus ring, movement-control bounds, and no horizontal page
  overflow are asserted in Playwright.
- [ ] Complete keyboard audit of scene selection, replay, repair, recovery,
  save/share, and every important focus transition.
- [ ] Screen-reader pass for compile, approval, failure, and recovery
  announcements. The app exposes `status`/`alert` roles and browser tests
  assert key statuses, but that is not a screen-reader test.
- [ ] Browser reduced-motion emulation while playing and paused. Animation
  behavior has automated unit coverage; no OS preference was changed.
- [ ] Confirm no essential verdict is communicated only by color.
- [x] Essential controls remained operable without horizontal overflow at the
  tested narrow browser viewport. This is not a real-device test.

Viewport resizing is useful supplementary evidence, not a real-device test.
