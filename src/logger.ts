import { createConsola } from "consola";
import { config } from "./config";

export const logger = createConsola({
  level: config.debug ? 4 : 3, // 4 = debug, 3 = info
  formatOptions: {
    date: false,
  },
});
