import { defineConfig } from "vite-plus";
import config from "./vite.config.ts";

export default defineConfig({ ...config, test: { ...config.test, globalSetup: [] } });
