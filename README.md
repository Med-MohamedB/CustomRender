# CustomRender

CustomRender smooths Discord rendering by throttling large DOM update bursts. It temporarily hides newly added nodes, then reveals them over multiple animation frames. This spreads heavy UI work across time, reduces hitching during navigation, and can lower the chance of UI stalls or crashes on slower machines. It is designed to be safe at startup, waits for `#app-mount`, and never touches core nodes like HTML, HEAD, or BODY.

## Authors

- [jx5_](https://github.com/livingcarefully) - Discord ID: 1024297429127933952
- [m7i1](https://github.com/Med-MohamedB) - Discord ID: 741416289423065088

## Contributors

- [livingcarefully](https://github.com/livingcarefully) - Discord ID: 1024297429127933952
- [Med-MohamedB](https://github.com/Med-MohamedB) - Discord ID: 741416289423065088

## Tech Stack

- Language: TypeScript
- Build: Vencord dev build
- Editor: VS Code

## How It Works

- Observes DOM changes under `#app-mount` using `MutationObserver`.
- New elements get a temporary class that hides them.
- A queue reveals elements over multiple `requestAnimationFrame` ticks.
- Each frame is limited by `maxOpsPerFrame` and `frameBudgetMs`.
- If the queue becomes too large, everything is revealed to avoid blank screens.
- You can skip elements with `data-dom-vsync-ignore`.

## Settings Guide

### active
Turns throttling on or off. If you disable it, all pending elements are revealed immediately.

### startDelayMs
Delay after Discord is ready before throttling starts. This helps avoid slowing the initial UI load.

### frameBudgetMs
Maximum CPU time per frame spent revealing elements. Lower values reduce impact on FPS but reveal content more slowly.

### maxOpsPerFrame
Maximum number of elements revealed per frame. Higher values show content faster but can cause spikes.

### indicator
Shows a small status dot near the top-right toolbar. Click it to toggle the plugin.

## Recommended Settings

### Low-end PCs / laptops
- startDelayMs: 1500-2000
- frameBudgetMs: 2-4
- maxOpsPerFrame: 50-100

### Mid-range PCs
- startDelayMs: 1000-1500
- frameBudgetMs: 5-8
- maxOpsPerFrame: 150-300

### High-end PCs
- startDelayMs: 800-1200
- frameBudgetMs: 8-12
- maxOpsPerFrame: 250-500

## Tips

- If the UI feels too slow to appear, increase `maxOpsPerFrame` or `frameBudgetMs`.
- If you still see stutter, lower `maxOpsPerFrame` and keep `frameBudgetMs` small.
- Leave `startDelayMs` above 800 to avoid interfering with Discord startup.

## Screenshot
![1](screenshots/Screenshot_2.png)
