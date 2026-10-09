// The smallest game, as its own Worker: the kit's committed JavaScript, one alert rule, and no
// secrets but the key the smoke hands in. A game's real `src/index.ts` reads the same, wrapped in
// its own name. The smoke driver (`index.mjs`) points workerd at this file.
import { createWorker } from "../dist/index.js";

export default createWorker({ game: "smoke", alerts: { server_error: "critical" } });
