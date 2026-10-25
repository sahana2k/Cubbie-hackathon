import { config } from "../config";
import { createDemoApi } from "./demo";
import { createHttpApi } from "./http";
import { createLocalApi } from "./local";
import type { Api } from "./types";

const { apiUrl, wsUrl, localApi } = config();
export const api: Api = localApi && apiUrl ? createLocalApi(apiUrl) : apiUrl && wsUrl ? createHttpApi(apiUrl, wsUrl) : createDemoApi();
export type { Api, TaskDraft } from "./types";
