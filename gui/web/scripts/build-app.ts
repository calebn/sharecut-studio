#!/usr/bin/env node
import { build } from "vite";
import { forbidStoryModules } from "./check-bundle-no-stories.ts";

await build({ plugins: [forbidStoryModules()] });
